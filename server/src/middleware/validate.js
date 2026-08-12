import { ApiError } from './error.js';

/** Validate `req[source]` against a zod schema, replacing it with the parsed value. */
export const validate =
  (schema, source = 'body') =>
  (req, _res, next) => {
    const result = schema.safeParse(req[source]);
    if (!result.success) {
      const first = result.error.issues[0];
      const path = first.path.join('.');
      return next(
        new ApiError(400, path ? `${path}: ${first.message}` : first.message, {
          issues: result.error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })),
        }),
      );
    }
    // req.query is a getter on Express 5; assigning to a local is safer.
    if (source === 'body') req.body = result.data;
    else req.validated = result.data;
    return next();
  };
