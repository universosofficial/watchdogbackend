/**
 * Standard API Response Wrappers
 */

export class AppError extends Error {
  constructor(message, statusCode = 500, code = 'INTERNAL_ERROR', details = null) {
    super(message);
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = true;
    Error.captureStackTrace(this, this.constructor);
  }
}

/**
 * Standard successful response wrapper: { success: true, data: ... }
 * @param {import('express').Response} res
 * @param {*} data
 * @param {number} [statusCode=200]
 * @param {object} [meta]
 */
export function sendSuccess(res, data = null, statusCode = 200, meta = undefined) {
  const payload = {
    success: true,
    data
  };
  if (meta !== undefined) {
    payload.meta = meta;
  }
  return res.status(statusCode).json(payload);
}

/**
 * Standard error response wrapper: { success: false, error: { message, code } }
 * @param {import('express').Response} res
 * @param {string} message
 * @param {string} [code='INTERNAL_ERROR']
 * @param {number} [statusCode=500]
 * @param {*} [details=null]
 */
export function sendError(res, message, code = 'INTERNAL_ERROR', statusCode = 500, details = null) {
  const payload = {
    success: false,
    error: {
      message,
      code
    }
  };

  if (details && process.env.NODE_ENV === 'development') {
    payload.error.details = details;
  }

  return res.status(statusCode).json(payload);
}
