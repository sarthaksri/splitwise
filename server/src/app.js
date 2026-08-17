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

  // Vercel terminates TLS upstream; without this Express sees http and would
  // refuse to set the `secure` auth cookie. Set before anything that inspects
  // the request's origin or protocol.
  app.set('trust proxy', 1);

  /*
   * CORS.
   *
   * Same-origin requests are worked out from the request itself rather than
   * from configuration. Browsers send an `Origin` header on same-origin POSTs
   * too — not only cross-origin ones — so a deployment where the app and API
   * share a domain still goes through this check. Assuming otherwise is what
   * made production reject its own login form.
   *
   * Deriving it also means preview deployments and custom domains work with no
   * environment variable to keep in sync. CLIENT_ORIGIN stays for genuinely
   * cross-origin callers, such as the Vite dev server on another port.
   */
  const allowed = (process.env.CLIENT_ORIGIN || 'http://localhost:5173')
    .split(',')
    .map((o) => o.trim())
    .filter(Boolean);

  app.use(
    cors((req, cb) => {
      const origin = req.headers.origin;

      // No Origin at all: curl, a health probe, a same-origin GET.
      if (!origin) return cb(null, { origin: true, credentials: true });

      // Behind Vercel's proxy `host` is the internal name, so prefer the
      // forwarded one — otherwise same-origin never matches in production.
      const host = req.headers['x-forwarded-host'] ?? req.headers.host;
      let sameOrigin = false;
      try {
        sameOrigin = new URL(origin).host === host;
      } catch {
        sameOrigin = false;
      }

      // Refuse by omitting the CORS headers, which is what lets the browser
      // block it. Throwing here turns a routine rejection into a 500.
      return cb(null, {
        origin: sameOrigin || allowed.includes(origin),
        credentials: true,
      });
    }),
  );

  // 256kb everywhere: a JSON expense is a few hundred bytes and a scanned
  // bill's text a few thousand, so nothing legitimate comes close. Receipt
  // photos are read in the browser and never uploaded, which is what let this
  // go back to a single small limit.
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
