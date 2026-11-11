export const AUTH_COOKIE_NAME = 'dw_token';

/**
 * Attaches a secure, HttpOnly authentication cookie to the response
 */
export function setAuthCookie(res, token) {
  const isProd = process.env.NODE_ENV === 'production';
  
  res.cookie(AUTH_COOKIE_NAME, token, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000 // 7 days
  });
}

/**
 * Clears the authentication cookie upon logout
 */
export function clearAuthCookie(res) {
  const isProd = process.env.NODE_ENV === 'production';
  
  res.clearCookie(AUTH_COOKIE_NAME, {
    httpOnly: true,
    secure: isProd,
    sameSite: isProd ? 'strict' : 'lax',
    path: '/'
  });
}
