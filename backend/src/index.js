require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const cookieParser = require('cookie-parser');
const swaggerUi = require('swagger-ui-express');
const { rateLimit } = require('express-rate-limit');
const pinoHttp = require('pino-http');
const { randomUUID } = require('crypto');
const { logger } = require('./logger');
const swaggerSpec = require('./swagger');
const { requireAuth } = require('./auth/middleware');
const { router: authRouter } = require('./auth/routes');
const { initDb, pool } = require('./db');
const { createIngestJob, getIngestJob, processIngestJob, listDocuments, deleteDocument } = require('./ingest');
const { streamQueryDocuments } = require('./query');

const app = express();

const MAX_UPLOAD_MB = Number(process.env.MAX_UPLOAD_MB || 20);
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_MB * 1024 * 1024 },
});

const allowedOrigins = (process.env.FRONTEND_ORIGIN || '')
  .split(',')
  .map(o => o.trim())
  .filter(Boolean);

// credentials: true is required for the refresh-token cookie to cross the
// frontend/backend origin boundary — that in turn requires an explicit
// origin (can't be "*" per the CORS spec), so unlike the previous pass this
// always needs FRONTEND_ORIGIN set, even in dev.
app.use(cors({
  origin: allowedOrigins.length ? allowedOrigins : 'http://localhost:5173',
  credentials: true,
}));
app.use(express.json());
app.use(cookieParser());
app.use(pinoHttp({
  logger,
  genReqId: req => req.get('x-request-id') || randomUUID(),
}));

const chatLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.CHAT_RATE_LIMIT || 30),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.user.id,
});

const ingestLimiter = rateLimit({
  windowMs: 60 * 1000,
  limit: Number(process.env.INGEST_RATE_LIMIT || 5),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => req.user.id,
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.get('/docs.json', (req, res) => res.json(swaggerSpec));

/**
 * @openapi
 * /health:
 *   get:
 *     summary: Health check
 *     description: Checks database connectivity. Used by load balancers/orchestrators.
 *     tags: [System]
 *     security: []
 *     responses:
 *       200:
 *         description: Healthy
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 status: { type: string, example: ok }
 *                 memory:
 *                   type: object
 *                   properties:
 *                     rssMb: { type: number }
 *                     heapUsedMb: { type: number }
 *       503:
 *         description: Unhealthy (DB unreachable)
 */
app.get('/health', async (req, res) => {
  const mem = process.memoryUsage();
  const memory = {
    rssMb: Math.round(mem.rss / 1024 / 1024),
    heapUsedMb: Math.round(mem.heapUsed / 1024 / 1024),
  };

  try {
    await pool.query('SELECT 1');
    res.json({ status: 'ok', memory });
  } catch (err) {
    req.log.error({ err }, 'Health check failed');
    res.status(503).json({ status: 'unavailable', memory });
  }
});

app.use('/auth', authRouter);

/**
 * @openapi
 * /ingest:
 *   post:
 *     summary: Ingest a PDF
 *     description: >
 *       Starts a background job that extracts, chunks, and embeds a PDF's
 *       text into the caller's private document set. Returns immediately
 *       with a job id to poll rather than waiting for embedding to finish.
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         multipart/form-data:
 *           schema:
 *             type: object
 *             required: [file]
 *             properties:
 *               file:
 *                 type: string
 *                 format: binary
 *     responses:
 *       202:
 *         description: Ingestion started
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 jobId: { type: string, format: uuid }
 *                 message: { type: string }
 *                 statusUrl: { type: string }
 *       400:
 *         description: No file, wrong field name, non-PDF file, or file too large
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/Error'
 *       401:
 *         description: Missing or invalid access token
 *       429:
 *         description: Rate limit exceeded
 */
app.post('/ingest', requireAuth, ingestLimiter, upload.single('file'), async (req, res) => {
  if (!req.file) {
    return res.status(400).json({ error: 'No file uploaded' });
  }

  if (!req.file.mimetype.includes('pdf')) {
    return res.status(400).json({ error: 'Only PDF files are supported' });
  }

  try {
    const jobId = await createIngestJob(req.file.originalname, req.user.id);

    // Not awaited: processing happens after we respond, so a large PDF
    // doesn't hold the request open past the load balancer's timeout.
    processIngestJob(jobId, req.user.id, req.file.buffer, req.file.originalname).catch(err => {
      req.log.error({ err, jobId }, 'Unhandled error in background ingest job');
    });

    res.status(202).json({
      jobId,
      message: `Ingestion started for "${req.file.originalname}"`,
      statusUrl: `/ingest/${jobId}`,
    });
  } catch (err) {
    req.log.error({ err }, 'Failed to start ingestion');
    res.status(500).json({ error: 'Failed to start ingestion' });
  }
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * @openapi
 * /ingest/{jobId}:
 *   get:
 *     summary: Check an ingest job's status
 *     description: Only the user who started the job can see it — any other user gets 404.
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       200:
 *         description: Job status
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/IngestJobStatus'
 *       400:
 *         description: Invalid job id format
 *       404:
 *         description: Job not found (or belongs to another user)
 */
app.get('/ingest/:jobId', requireAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.jobId)) {
    return res.status(400).json({ error: 'Invalid job id' });
  }

  try {
    const job = await getIngestJob(req.params.jobId, req.user.id);
    if (!job) {
      return res.status(404).json({ error: 'Job not found' });
    }
    res.json(job);
  } catch (err) {
    req.log.error({ err }, 'Failed to fetch ingest job');
    res.status(500).json({ error: 'Failed to fetch ingest job' });
  }
});

/**
 * @openapi
 * /documents:
 *   get:
 *     summary: List ingested documents
 *     description: Returns the caller's successfully ingested documents, most recent first.
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: List of documents
 *         content:
 *           application/json:
 *             schema:
 *               type: array
 *               items:
 *                 $ref: '#/components/schemas/DocumentSummary'
 *       401:
 *         description: Missing or invalid access token
 */
app.get('/documents', requireAuth, async (req, res) => {
  try {
    const documents = await listDocuments(req.user.id);
    res.json(documents);
  } catch (err) {
    req.log.error({ err }, 'Failed to list documents');
    res.status(500).json({ error: 'Failed to list documents' });
  }
});

/**
 * @openapi
 * /documents/{jobId}:
 *   delete:
 *     summary: Delete an ingested document
 *     description: Removes the document's chunks and its ingest job record. Only the owner can delete it.
 *     tags: [Documents]
 *     security:
 *       - bearerAuth: []
 *     parameters:
 *       - in: path
 *         name: jobId
 *         required: true
 *         schema: { type: string, format: uuid }
 *     responses:
 *       204:
 *         description: Deleted
 *       400:
 *         description: Invalid job id format
 *       401:
 *         description: Missing or invalid access token
 *       404:
 *         description: Document not found (or belongs to another user)
 */
app.delete('/documents/:jobId', requireAuth, async (req, res) => {
  if (!UUID_RE.test(req.params.jobId)) {
    return res.status(400).json({ error: 'Invalid job id' });
  }

  try {
    const deleted = await deleteDocument(req.params.jobId, req.user.id);
    if (!deleted) {
      return res.status(404).json({ error: 'Document not found' });
    }
    res.status(204).end();
  } catch (err) {
    req.log.error({ err }, 'Failed to delete document');
    res.status(500).json({ error: 'Failed to delete document' });
  }
});

/**
 * @openapi
 * /chat:
 *   post:
 *     summary: Ask a question grounded in your ingested documents
 *     description: >
 *       Streams the answer as Server-Sent Events rather than one JSON
 *       response: repeated `event: token` frames (each `data:` a
 *       JSON-encoded string fragment) as the answer generates, followed by
 *       one `event: done` frame with sources/similarity, or `event: error`
 *       if generation fails after streaming has already started.
 *     tags: [Chat]
 *     security:
 *       - bearerAuth: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [question]
 *             properties:
 *               question: { type: string }
 *               docId:
 *                 type: string
 *                 format: uuid
 *                 description: >
 *                   Optional — the id of one document (from GET /documents)
 *                   to scope the answer to. Omit to search across all of
 *                   the caller's documents.
 *     responses:
 *       200:
 *         description: text/event-stream of token/done/error frames (see above)
 *         content:
 *           text/event-stream:
 *             schema: { type: string }
 *       400:
 *         description: Missing question, or invalid docId
 *       401:
 *         description: Missing or invalid access token
 *       429:
 *         description: Rate limit exceeded
 */
app.post('/chat', requireAuth, chatLimiter, async (req, res) => {
  const { question, docId } = req.body;

  if (!question || typeof question !== 'string') {
    return res.status(400).json({ error: 'question is required' });
  }

  if (docId !== undefined && docId !== null && !UUID_RE.test(docId)) {
    return res.status(400).json({ error: 'Invalid docId' });
  }

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.flushHeaders();

  try {
    const result = await streamQueryDocuments(question, req.user.id, docId || null, token => {
      res.write(`event: token\ndata: ${JSON.stringify(token)}\n\n`);
    });
    res.write(`event: done\ndata: ${JSON.stringify(result)}\n\n`);
  } catch (err) {
    req.log.error({ err }, 'Query failed');
    res.write(`event: error\ndata: ${JSON.stringify('Query failed')}\n\n`);
  } finally {
    res.end();
  }
});

// Multer errors (e.g. file too large) land here rather than the route handler.
app.use((err, req, res, next) => {
  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return res.status(400).json({ error: `File too large (max ${MAX_UPLOAD_MB}MB)` });
    }
    return res.status(400).json({ error: err.message });
  }
  next(err);
});

const PORT = process.env.PORT || 3000;

initDb().then(() => {
  const server = app.listen(PORT, () => {
    logger.info(`RAG chatbot running on port ${PORT}`);
  });

  const shutdown = signal => {
    logger.info(`${signal} received, shutting down`);
    server.close(async () => {
      await pool.end();
      logger.info('Shutdown complete');
      process.exit(0);
    });
  };

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
});
