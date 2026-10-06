import express, { type NextFunction, type Request, type Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import { rateLimit } from 'express-rate-limit';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { DB } from './db.js';
import type { AppConfig } from './config.js';
import { apiRouter } from './routes/api.js';
import { featureRouter } from './routes/features.js';
import { AuthService, authRouter, requireAuth, sessionRoutes } from './security/auth.js';
import { ValidationError } from './types.js';

export function createApp(db: DB, cfg: AppConfig, opts: { clientDist?: string | null } = {}) {
  const app = express();
  const auth = new AuthService(db, cfg);
  app.disable('x-powered-by');
  app.set('trust proxy', cfg.trustProxy);
  app.set('query parser', 'simple');

  app.use(
    helmet({
      contentSecurityPolicy: {
        useDefaults: false,
        directives: {
          defaultSrc: ["'self'"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'", "'unsafe-inline'"],
          imgSrc: ["'self'", 'data:'],
          fontSrc: ["'self'", 'data:'],
          connectSrc: ["'self'"],
          objectSrc: ["'none'"],
          baseUri: ["'self'"],
          formAction: ["'self'"],
          frameAncestors: ["'none'"],
          ...(cfg.cookieSecure ? { upgradeInsecureRequests: [] } : {}),
        },
      },
      hsts: cfg.cookieSecure ? { maxAge: 31_536_000, includeSubDomains: true } : false,
      crossOriginEmbedderPolicy: false,
      referrerPolicy: { policy: 'no-referrer' },
    }),
  );
  app.use((_req, res, next) => {
    res.setHeader('Permissions-Policy', 'camera=(), microphone=(), geolocation=(), payment=(), usb=()');
    next();
  });

  if (cfg.corsOrigins.length) app.use('/api', cors({ origin: cfg.corsOrigins, credentials: true, allowedHeaders: ['content-type', 'x-csrf-token'] }));

  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('Pragma', 'no-cache');
    next();
  });
  app.use('/api', rateLimit({ windowMs: 60_000, limit: cfg.API_RATE_LIMIT_PER_MINUTE, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many requests, slow down.' } }));
  app.use('/api/auth/login', rateLimit({ windowMs: 60_000, limit: 20, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Too many login attempts, slow down.' } }));
  app.use('/api', express.json({ limit: '5mb', strict: true }));

  app.use('/api', authRouter(db, cfg, auth));
  app.use('/api', requireAuth(cfg, auth));
  app.use('/api', sessionRoutes(db, cfg, auth));
  app.use('/api', apiRouter(db));
  app.use('/api', featureRouter(db, cfg));
  app.use('/api', (_req, res) => res.status(404).json({ error: 'Not found.' }));

  const clientDist = opts.clientDist === undefined ? path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../client/dist') : opts.clientDist;
  if (clientDist && fs.existsSync(clientDist)) {
    app.use(express.static(clientDist, { index: false, dotfiles: 'ignore', maxAge: '1h' }));
    app.get(/^(?!\/api).*/, (_req, res) => {
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(path.join(clientDist, 'index.html'));
    });
  }

  app.use(errorHandler);
  const timer = setInterval(() => auth.cleanup(), 10 * 60_000);
  timer.unref();
  return app;
}

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) return;
  if (err instanceof ValidationError) return res.status(400).json({ error: err.message, details: err.details });
  const e = err as { type?: string; status?: number; code?: string; message?: string };
  if (e?.type === 'entity.parse.failed') return res.status(400).json({ error: 'Malformed JSON body.' });
  if (e?.type === 'entity.too.large') return res.status(413).json({ error: 'Request body too large.' });
  if (typeof e?.code === 'string' && e.code.startsWith('SQLITE_CONSTRAINT')) return res.status(400).json({ error: 'The change violates a data integrity rule.' });
  if (e?.status && e.status >= 400 && e.status < 500) return res.status(e.status).json({ error: 'Bad request.' });
  console.error(err);
  res.status(500).json({ error: 'Internal server error.' });
}
