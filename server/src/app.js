import express from 'express';
import mongoose from 'mongoose';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import helmet from 'helmet';
import morgan from 'morgan';

import authRoutes from './routes/auth.js';
import userRoutes from './routes/users.js';
import groupRoutes from './routes/groups.js';
import expenseRoutes from './routes/expenses.js';
import settlementRoutes from './routes/settlements.js';
import dashboardRoutes from './routes/dashboard.js';
import recurringRoutes from './routes/recurring.js';
import { errorHandler, notFound } from './middleware/error.js';
import { apiLimiter } from './middleware/rateLimit.js';

/** Build the Express app. Separate from index.js so tests can mount it directly. */
export function createApp() {
  const app = express();

  // Security headers. The API only ever returns JSON, so it needs none of the
  // permissiveness a page needs: deny framing outright (clickjacking on a page
  // with "settle up" buttons is a real risk), forbid MIME sniffing, and drop
  // the `X-Powered-By` banner that advertises the stack.
  app.use(
    helmet({
      contentSecurityPolicy: {
        directives: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      },
      // 180 days, matching what browsers will actually preload.
      hsts: { maxAge: 15_552_000, includeSubDomains: true },
      crossOriginResourcePolicy: { policy: 'same-site' },
    }),
  );
  app.disable('x-powered-by');

  // On Vercel the API and the app share an origin, so the browser sends no
  // Origin header and CORS never applies. In development they're on different
  // ports, so the Vite origin has to be allowed explicitly — with credentials,
  // which rules out the "*" wildcard.
  const allowed = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    cors({
      origin(origin, cb) {
        if (!origin || allowed.includes(origin)) return cb(null, true);
        return cb(new Error(`Origin ${origin} is not allowed`));
      },
      credentials: true,
    }),
  );

  // Vercel terminates TLS upstream; without this Express sees http and would
  // refuse to set the `secure` auth cookie.
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '256kb' }));
  app.use(cookieParser());
  if (process.env.NODE_ENV !== 'test') app.use(morgan('dev'));

  /**
   * Uptime probe. Deliberately mounted before the rate limiter so a monitor
   * polling every 30s can't exhaust anyone's budget, and it takes no auth.
   *
   * It reports the database too: an API that answers while Mongo is unreachable
   * is not actually up, and a monitor that only checks the process would stay
   * green through a total outage. Reads the driver's connection state rather
   * than issuing a query, so it stays cheap enough to poll often.
   */
  app.get('/api/health', async (_req, res) => {
    const started = Date.now();
    let db = 'down';
    let ok = false;

    try {
      // An actual round trip, not `readyState`. That flag can sit on
      // "connecting" while queries are being served perfectly well, so trusting
      // it produces false alarms; a ping answers the only question that
      // matters — will a query work right now?
      await Promise.race([
        mongoose.connection.db.admin().ping(),
        new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 4000)),
      ]);
      db = 'up';
      ok = true;
    } catch (err) {
      db = err.message === 'timeout' ? 'timeout' : 'down';
    }

    res.status(ok ? 200 : 503).json({
      ok,
      db,
      dbLatencyMs: Date.now() - started,
      uptimeSeconds: Math.round(process.uptime()),
      timestamp: new Date().toISOString(),
    });
  });

  app.use('/api', apiLimiter);
  app.use('/api/auth', authRoutes);
  app.use('/api/users', userRoutes);
  app.use('/api/groups', groupRoutes);
  app.use('/api/expenses', expenseRoutes);
  app.use('/api/settlements', settlementRoutes);
  app.use('/api/dashboard', dashboardRoutes);
  app.use('/api/recurring', recurringRoutes);

  app.use(notFound);
  app.use(errorHandler);

  return app;
}
