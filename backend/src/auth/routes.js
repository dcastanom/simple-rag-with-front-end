const express = require('express');
const { rateLimit, ipKeyGenerator } = require('express-rate-limit');
const { hashPassword, verifyPassword } = require('./passwords');
const {
  issueAccessToken,
  issueRefreshToken,
  rotateRefreshToken,
  revokeRefreshToken,
  REFRESH_TOKEN_EXPIRES_DAYS,
} = require('./tokens');
const { requireAuth } = require('./middleware');
const { createUser, findUserByEmail, findUserById } = require('../users');

const router = express.Router();

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const REFRESH_COOKIE_NAME = 'refreshToken';
const REFRESH_COOKIE_MAX_AGE_MS = REFRESH_TOKEN_EXPIRES_DAYS * 24 * 60 * 60 * 1000;

// Tighter than the chat/ingest limiters — this is the actual abuse control
// given open self-signup (no email verification gating account creation).
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: Number(process.env.AUTH_RATE_LIMIT || 10),
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: req => ipKeyGenerator(req.ip),
});

function refreshCookieOptions() {
  return {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/auth',
    maxAge: REFRESH_COOKIE_MAX_AGE_MS,
  };
}

async function issueSession(res, userId) {
  const accessToken = issueAccessToken(userId);
  const refreshToken = await issueRefreshToken(userId);
  res.cookie(REFRESH_COOKIE_NAME, refreshToken, refreshCookieOptions());
  return accessToken;
}

/**
 * @openapi
 * /auth/register:
 *   post:
 *     summary: Create an account
 *     description: Auto-logs in on success — no separate login call needed. Sets the refresh-token cookie.
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, format: password, minLength: 8 }
 *     responses:
 *       201:
 *         description: Account created and logged in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       400:
 *         description: Invalid email, or password shorter than 8 characters
 *       409:
 *         description: Email already registered
 *       429:
 *         description: Rate limit exceeded
 */
router.post('/register', authLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (typeof email !== 'string' || !EMAIL_RE.test(email)) {
    return res.status(400).json({ error: 'Valid email is required' });
  }
  if (typeof password !== 'string' || password.length < 8) {
    return res.status(400).json({ error: 'Password must be at least 8 characters' });
  }

  try {
    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await hashPassword(password);
    const user = await createUser(email, passwordHash);
    const accessToken = await issueSession(res, user.id);

    res.status(201).json({ accessToken, user });
  } catch (err) {
    req.log.error({ err }, 'Registration failed');
    res.status(500).json({ error: 'Registration failed' });
  }
});

/**
 * @openapi
 * /auth/login:
 *   post:
 *     summary: Log in
 *     tags: [Auth]
 *     security: []
 *     requestBody:
 *       required: true
 *       content:
 *         application/json:
 *           schema:
 *             type: object
 *             required: [email, password]
 *             properties:
 *               email: { type: string, format: email }
 *               password: { type: string, format: password }
 *     responses:
 *       200:
 *         description: Logged in
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/AuthResponse'
 *       400:
 *         description: Missing email or password
 *       401:
 *         description: Invalid email or password
 *       429:
 *         description: Rate limit exceeded
 */
router.post('/login', authLimiter, async (req, res) => {
  const { email, password } = req.body;

  if (typeof email !== 'string' || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required' });
  }

  try {
    const user = await findUserByEmail(email);
    const valid = user && (await verifyPassword(password, user.password_hash));
    if (!valid) {
      // Same error for "no such user" and "wrong password" — don't leak which.
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    const accessToken = await issueSession(res, user.id);
    res.json({ accessToken, user: { id: user.id, email: user.email } });
  } catch (err) {
    req.log.error({ err }, 'Login failed');
    res.status(500).json({ error: 'Login failed' });
  }
});

/**
 * @openapi
 * /auth/refresh:
 *   post:
 *     summary: Exchange the refresh cookie for a new access token
 *     description: Rotates the refresh token — the previous one stops working the moment this succeeds.
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       200:
 *         description: New access token issued
 *         content:
 *           application/json:
 *             schema:
 *               type: object
 *               properties:
 *                 accessToken: { type: string }
 *       401:
 *         description: No, invalid, expired, or already-rotated refresh token
 */
router.post('/refresh', async (req, res) => {
  const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (!rawToken) {
    return res.status(401).json({ error: 'No refresh token' });
  }

  try {
    const { userId, rawToken: newRawToken } = await rotateRefreshToken(rawToken);
    res.cookie(REFRESH_COOKIE_NAME, newRawToken, refreshCookieOptions());
    res.json({ accessToken: issueAccessToken(userId) });
  } catch {
    res.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
    res.status(401).json({ error: 'Invalid or expired refresh token' });
  }
});

/**
 * @openapi
 * /auth/logout:
 *   post:
 *     summary: Log out
 *     description: Revokes the current refresh token and clears the cookie.
 *     tags: [Auth]
 *     security: []
 *     responses:
 *       204:
 *         description: Logged out
 */
router.post('/logout', async (req, res) => {
  const rawToken = req.cookies?.[REFRESH_COOKIE_NAME];
  if (rawToken) {
    await revokeRefreshToken(rawToken);
  }
  res.clearCookie(REFRESH_COOKIE_NAME, { path: '/auth' });
  res.status(204).end();
});

/**
 * @openapi
 * /auth/me:
 *   get:
 *     summary: Get the current user
 *     tags: [Auth]
 *     security:
 *       - bearerAuth: []
 *     responses:
 *       200:
 *         description: Current user
 *         content:
 *           application/json:
 *             schema:
 *               $ref: '#/components/schemas/User'
 *       401:
 *         description: Missing or invalid access token
 */
router.get('/me', requireAuth, async (req, res) => {
  const user = await findUserById(req.user.id);
  if (!user) {
    return res.status(401).json({ error: 'User not found' });
  }
  res.json(user);
});

module.exports = { router, authLimiter };
