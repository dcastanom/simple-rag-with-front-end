const swaggerJsdoc = require('swagger-jsdoc');

const options = {
  definition: {
    openapi: '3.0.3',
    info: {
      title: 'RAG PDF Gemini API',
      version: '1.0.0',
      description:
        'Upload PDFs, embed them with Gemini into pgvector, and ask grounded ' +
        'questions answered by Groq/Llama. Documents are private per ' +
        'authenticated account.',
    },
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT',
        },
      },
      schemas: {
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
          },
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            email: { type: 'string', format: 'email' },
          },
        },
        AuthResponse: {
          type: 'object',
          properties: {
            accessToken: { type: 'string' },
            user: { $ref: '#/components/schemas/User' },
          },
        },
        DocumentSummary: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid', description: 'The ingest job id — use this as docId to scope /chat.' },
            filename: { type: 'string' },
            chunk_count: { type: 'integer', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
          },
        },
        IngestJobStatus: {
          type: 'object',
          properties: {
            id: { type: 'string', format: 'uuid' },
            filename: { type: 'string' },
            status: { type: 'string', enum: ['pending', 'processing', 'done', 'failed'] },
            chunk_count: { type: 'integer', nullable: true },
            error: { type: 'string', nullable: true },
            created_at: { type: 'string', format: 'date-time' },
            updated_at: { type: 'string', format: 'date-time' },
          },
        },
        ChatResponse: {
          type: 'object',
          properties: {
            answer: { type: 'string' },
            sources: { type: 'array', items: { type: 'string' } },
            topSimilarity: { type: 'string' },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
  },
  apis: ['./src/index.js', './src/auth/routes.js'],
};

module.exports = swaggerJsdoc(options);
