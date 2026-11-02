'use strict';
/**
 * WORKLY — application entrypoint.
 *
 * Boot order matters:
 *   1. apply schema (idempotent)
 *   2. seed school structure / subjects / revision / quiz (idempotent)
 *   3. import the F1 driver database when it has not been imported yet
 *   4. start serving
 *
 * The process never starts listening on a half-initialised database.
 */
const path = require('node:path');
const fs = require('node:fs');
const express = require('express');

const { init, db } = require('./db');
const seed = require('./seed');
const auth = require('./auth');
const academic = require('./academic');
const f1api = require('./f1-api');

const PUBLIC_DIR = path.join(__dirname, '..', 'public');
const PORT = Number(process.env.PORT) || 3000;
const HOST = process.env.HOST || '0.0.0.0';

const app = express();
app.disable('x-powered-by');

// ───────────────────────────── middleware ───────────────────────────────
app.use(express.json({ limit: '1mb' }));
app.use(express.urlencoded({ extended: false, limit: '1mb' }));

// Security headers that do not depend on any external service. The 3D scene
// loads no third-party scripts, so a tight CSP is safe; images may come from
// Wikimedia Commons (photo system) and are therefore allow-listed for img-src.
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader(
    'Content-Security-Policy',
    [
      "default-src 'self'",
      "script-src 'self'",
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob: https://upload.wikimedia.org https://commons.wikimedia.org",
      "connect-src 'self'",
      "font-src 'self' data:",
      "object-src 'none'",
      "base-uri 'self'",
      "form-action 'self'",
      "frame-ancestors 'self'",
    ].join('; '),
  );
  next();
});

// Resolve the session for every request before any router sees it.
app.use(auth.attachUser);

app.get('/api/health', (req, res) => {
  res.json({ ok: true, app: 'WORKLY', time: new Date().toISOString() });
});

app.use('/api/auth', auth.router);
app.use('/api/f1', f1api.router);
app.use('/api', academic.router);

// Unknown API routes must return JSON, never the SPA shell.
app.use('/api', (req, res) => {
  res.status(404).json({ error: 'Unknown API endpoint.' });
});

// ───────────────────────────── static SPA ───────────────────────────────
if (fs.existsSync(PUBLIC_DIR)) {
  app.use(
    express.static(PUBLIC_DIR, {
      index: false,
      maxAge: process.env.NODE_ENV === 'production' ? '1h' : 0,
      setHeaders(res, filePath) {
        if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-cache');
      },
    }),
  );

  // Client-side routing: any non-API GET returns the shell.
  app.get('*', (req, res, next) => {
    if (req.method !== 'GET') return next();
    const indexFile = path.join(PUBLIC_DIR, 'index.html');
    if (!fs.existsSync(indexFile)) return next();
    res.sendFile(indexFile);
  });
}

// ─────────────────────────── error handling ────────────────────────────
// Multer rejects a file before the route body runs; translate it, do not leak
// the stack trace to the client.
app.use((err, req, res, next) => {
  if (res.headersSent) return next(err);
  if (err && err.name === 'MulterError') {
    const messages = {
      LIMIT_FILE_SIZE: 'That file is larger than the 10 MB limit.',
      LIMIT_FILE_COUNT: 'You can attach at most 5 files.',
      LIMIT_UNEXPECTED_FILE: 'Unexpected file field in the upload.',
    };
    return res.status(400).json({ error: messages[err.code] || 'The upload could not be accepted.' });
  }
  if (err && err.type === 'entity.parse.failed') {
    return res.status(400).json({ error: 'The request body was not valid JSON.' });
  }
  if (err && err.type === 'entity.too.large') {
    return res.status(413).json({ error: 'The request is too large.' });
  }
  console.error('[workly] unhandled error:', err && (err.stack || err.message));
  res.status(500).json({ error: 'Something went wrong. Please try again.' });
});

// ─────────────────────────────── boot ──────────────────────────────────
async function bootstrap() {
  init();

  const seeded = seed.seedAll();
  console.log(
    `[workly] school seeded: ${seeded.classes} classes, ${seeded.subjects} subjects, ` +
      `${seeded.revision} revision topics, ${seeded.quiz} quiz questions`,
  );

  const hasDrivers = db.prepare('SELECT COUNT(*) AS n FROM drivers').get().n > 0;
  if (!hasDrivers) {
    try {
      const { importF1Data } = require('./f1-data');
      const report = await importF1Data();
      console.log(
        `[workly] F1 imported: ${report.driversImported} drivers, ` +
          `${report.seasonsImported} season records, ${report.featuredImported} featured`,
      );
      if (report.discrepancies && report.discrepancies.length) {
        for (const d of report.discrepancies) console.warn(`[workly] F1 discrepancy: ${d}`);
      }
    } catch (err) {
      // A missing dataset must not stop the academic platform from starting.
      console.error(`[workly] F1 import skipped: ${err.message}`);
    }
  }

  return app.listen(PORT, HOST, () => {
    console.log(`[workly] listening on http://${HOST}:${PORT}`);
  });
}

if (require.main === module) {
  bootstrap().catch((err) => {
    console.error('[workly] startup failed:', err && (err.stack || err.message));
    process.exit(1);
  });
}

module.exports = { app, bootstrap };
