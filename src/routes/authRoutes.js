import { Router } from 'express';
import { 
  register, 
  login, 
  loginPhone,
  getCurrentUser, 
  updateUserProfile,
  uploadUserAvatar,
  removeUserAvatar,
  switchBusiness,
  switchPersona,
  requestOtp,
  registerPhone,
  verifyPhoneRegistration,
  forgotPasswordRequestOtp,
  forgotPasswordReset,
  logout
} from '../controllers/authController.js';
import { authenticate } from '../middleware/auth.js';
import { avatarUpload } from '../middleware/upload.js';
import { authRateLimiter, otpRateLimiter } from '../middleware/rateLimiter.js';

const router = Router();

// Public auth routes with rate limiting
router.post('/register', authRateLimiter, register);
router.post('/login', authRateLimiter, login);
router.post('/login-phone', authRateLimiter, loginPhone);

// Phone-First Onboarding & Password Recovery (Guarded by strict OTP limiter)
router.post('/request-otp', otpRateLimiter, requestOtp);
router.post('/register-phone', otpRateLimiter, registerPhone);
router.post('/verify-phone-registration', authRateLimiter, verifyPhoneRegistration);

// Password Reset endpoints (supporting both canonical and alias names)
router.post('/reset-password', authRateLimiter, forgotPasswordReset);
router.post('/forgot-password/request-otp', otpRateLimiter, forgotPasswordRequestOtp);
router.post('/forgot-password/reset', authRateLimiter, forgotPasswordReset);

// Authenticated user profile, dynamic persona switching & tenant switching
router.get('/me', authenticate, getCurrentUser);
router.put('/me', authenticate, updateUserProfile);
router.post('/avatar', authenticate, avatarUpload.single('avatar'), uploadUserAvatar);
router.delete('/avatar', authenticate, removeUserAvatar);
router.post('/switch-persona', authenticate, switchPersona);
router.post('/switch-business', authenticate, switchBusiness);
router.post('/logout', logout);

export default router;
