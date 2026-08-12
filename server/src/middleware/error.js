import { SplitError } from '../../../shared/splitEngine.js';

/** Throw this for any expected, user-facing failure. */
export class ApiError extends Error {
  constructor(status, message, details) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.details = details;
  }
}

export const notFound = (req, res) =>
  res.status(404).json({ error: `No route for ${req.method} ${req.originalUrl}` });

/** Wrap an async handler so rejected promises reach the error middleware. */
export const asyncHandler = (fn) => (req, res, next) =>
  Promise.resolve(fn(req, res, next)).catch(next);

// eslint-disable-next-line no-unused-vars -- Express needs the 4-arg signature
export function errorHandler(err, req, res, _next) {
  if (err instanceof ApiError) {
    return res.status(err.status).json({ error: err.message, details: err.details });
  }

  // A bad split is the user's input problem, not a server fault, and the
  // message is already written for them.
  if (err instanceof SplitError || err.name === 'SplitError') {
    return res.status(400).json({ error: err.message, code: err.code, field: err.field });
  }

  if (err.name === 'ValidationError') {
    return res.status(400).json({ error: err.message });
  }
  if (err.name === 'CastError') {
    return res.status(400).json({ error: `Invalid id "${err.value}"` });
  }
  if (err.code === 11000) {
    const field = Object.keys(err.keyPattern ?? {})[0] ?? 'value';
    return res.status(409).json({ error: `That ${field} is already taken` });
  }

  // Errors thrown by middleware (body-parser's 413 for an oversized payload,
  // malformed JSON's 400) carry their own status. Without this they'd surface
  // as a 500, which reads as "our fault" when it isn't.
  const status = err.status ?? err.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) {
    const message =
      status === 413
        ? 'That request is too large'
        : err.type === 'entity.parse.failed'
          ? 'The request body was not valid JSON'
          : err.message;
    return res.status(status).json({ error: message });
  }

  console.error('[unhandled]', err);
  return res.status(500).json({ error: 'Something went wrong on our end' });
}
