import { sendError } from '../utils/response.js';

/**
 * 404 Not Found route handler
 */
export function notFoundHandler(req, res) {
  return sendError(
    res,
    `Route ${req.method} ${req.originalUrl} not found`,
    'ROUTE_NOT_FOUND',
    404
  );
}

/**
 * Centralized Application Error Handling Middleware
 */
export function globalErrorHandler(err, req, res, next) {
  console.error('[Application Error]:', {
    name: err.name,
    message: err.message,
    code: err.code,
    stack: process.env.NODE_ENV === 'development' ? err.stack : undefined
  });

  // Handle JSON parse errors from body-parser
  if (err instanceof SyntaxError && err.status === 400 && 'body' in err) {
    return sendError(res, 'Malformed JSON in request body', 'INVALID_JSON', 400);
  }

  // Handle MySQL Duplicate Key Entry (e.g., unique email or reference)
  if (err.code === 'ER_DUP_ENTRY') {
    return sendError(res, 'A record with that unique identifier already exists', 'CONFLICT', 409);
  }

  // Handle operational AppError
  if (err.isOperational) {
    return sendError(res, err.message, err.code, err.statusCode, err.details);
  }

  // Fallback for unhandled unexpected exceptions
  const message = process.env.NODE_ENV === 'production'
    ? 'An unexpected internal server error occurred'
    : err.message;

  return sendError(res, message, 'INTERNAL_SERVER_ERROR', 500);
}
