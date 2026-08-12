/**
 * Vercel serverless entrypoint.
 *
 * One plain function, with `vercel.json` rewriting every `/api/*` request to
 * it. The obvious-looking alternative — a catch-all filename like
 * `api/[...path].js` — does not work under a custom `buildCommand`: Vercel
 * reads it as a single dynamic segment literally named `...path`, so `/api/x`
 * reaches the function but `/api/auth/login` returns the platform's own 404.
 * A rewrite has no such subtlety and keeps the original URL intact.
 *
 * Vercel runs this file as a function and hands it the raw Node request, so we
 * just pass it to the same Express app the local server uses — one codebase,
 * no second implementation to keep in sync.
 *
 * The important difference from `npm start` is the database connection.
 * Serverless functions are frozen and thawed between requests, and a new
 * connection per invocation would exhaust the Atlas connection limit within
 * minutes. So the promise is cached on globalThis, which survives across
 * invocations that reuse the same warm instance.
 */

import mongoose from 'mongoose';
import { createApp } from '../server/src/app.js';

const cache = (globalThis.__splitwise ??= { conn: null, promise: null });

async function connect() {
  if (cache.conn) return cache.conn;

  if (!cache.promise) {
    const uri = process.env.MONGODB_URI;
    if (!uri) throw new Error('MONGODB_URI is not set in the Vercel project settings');

    mongoose.set('strictQuery', true);
    cache.promise = mongoose
      .connect(uri, {
        // Keep the pool small: many concurrent lambdas each holding a big pool
        // is the usual way to hit Atlas's connection cap.
        maxPoolSize: 5,
        serverSelectionTimeoutMS: 10_000,
        // Don't buffer commands while disconnected — fail fast instead of
        // holding the request open until the function times out.
        bufferCommands: false,
      })
      .then((m) => {
        cache.conn = m;
        return m;
      })
      .catch((err) => {
        // Clear it so the next invocation retries rather than reusing a
        // permanently rejected promise.
        cache.promise = null;
        throw err;
      });
  }

  return cache.promise;
}

const app = createApp();

export default async function handler(req, res) {
  try {
    await connect();
  } catch (err) {
    console.error('[vercel] database connection failed:', err.message);
    return res.status(503).json({ error: 'Database unavailable, please try again' });
  }

  // Vercel's runtime has already read and parsed the request body, so the
  // stream is spent. express.json() would sit waiting for data that will never
  // arrive. `_body` is body-parser's own flag for "already handled" — setting it
  // makes the middleware pass through and use what's here.
  if (req.body !== undefined && typeof req.body === 'object' && !Buffer.isBuffer(req.body)) {
    req._body = true;
  }

  return app(req, res);
}
