import rateLimit from 'express-rate-limit';

/**
 * Standardized 429 response helper
 */
function createRateLimitHandler(message, code) {
  return (req, res) => {
    res.setHeader('Retry-After', Math.ceil(req.rateLimit.resetTime ? (req.rateLimit.resetTime.getTime() - Date.now()) / 1000 : 60));
    return res.status(429).json({
      success: false,
      error: {
        message,
        code,
        retry_after_seconds: Math.ceil(req.rateLimit.resetTime ? (req.rateLimit.resetTime.getTime() - Date.now()) / 1000 : 60)
      }
    });
  };
}

/**
 * Global API Rate Limiter: General defense against scrapers & DDoS
 */
export const globalRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 300, // 300 requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler(
    'Too many API requests. Please slow down and try again shortly.',
    'GLOBAL_RATE_LIMIT_EXCEEDED'
  )
});

/**
 * Authentication Rate Limiter: Restricts brute-force login attempts
 */
export const authRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler(
    'Too many authentication attempts. Please try again after 15 minutes.',
    'AUTH_RATE_LIMIT_EXCEEDED'
  )
});

/**
 * OTP Delivery Rate Limiter: Protects SMS/WhatsApp delivery costs and prevents enumeration
 */
export const otpRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 6, // 6 OTP requests per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler(
    'Too many verification code requests. Please wait 15 minutes before requesting a new code.',
    'OTP_RATE_LIMIT_EXCEEDED'
  )
});

/**
 * Biometric Rate Limiter: Stops automated dictionary face-swap or credential stuffing
 */
export const biometricRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10, // 10 biometric attempts per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler(
    'Too many biometric verification attempts. Please wait 15 minutes before re-authenticating.',
    'BIOMETRIC_RATE_LIMIT_EXCEEDED'
  )
});

/**
 * Financial & Deal Mutation Limiter: Prevents double-spend and rapid automated state cycling
 */
export const financialRateLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60, // 60 operations per 15 minutes
  standardHeaders: true,
  legacyHeaders: false,
  handler: createRateLimitHandler(
    'Transaction rate threshold exceeded. Please try again in a few moments.',
    'TRANSACTION_RATE_LIMIT_EXCEEDED'
  )
});
