import { Router } from 'express';
import {
  getVerificationStatus,
  getTrustRadar,
  getSupportedBanks,
  resolveBankAccount,
  anchorBankAccount,
  verifyBiometricLiveness,
  authorizeBiometricStepUp
} from '../controllers/verificationController.js';
import { authenticate, requireBusiness } from '../middleware/auth.js';
import { biometricRateLimiter } from '../middleware/rateLimiter.js';
import { idempotency } from '../middleware/idempotency.js';

const router = Router();

// Public / Supported Banks List for NUBAN
router.get('/banks', getSupportedBanks);

// Public / Authenticated Trust Radar lookup
router.get('/trust-radar', authenticate, getTrustRadar);
router.get('/trust-radar/:businessId', getTrustRadar);

// Authenticated verification endpoints
router.use(authenticate);

// Verification Status (Biometrics, Bank Anchor, Trust Radar)
router.get('/status', getVerificationStatus);

// Verification Form 1: NUBAN Bank Account Resolution & Anchoring
router.post('/bank/resolve', resolveBankAccount);
router.post('/bank', requireBusiness, anchorBankAccount);

// Verification Form 2: Biometric Facial Liveness
router.post('/biometric/liveness', biometricRateLimiter, idempotency(), verifyBiometricLiveness);
router.post('/dojah/liveness', biometricRateLimiter, idempotency(), verifyBiometricLiveness); // Backward-compatible alias

// Verification Form 3: High-Value Deal Biometric Step-Up Authorization (1:1 Face Match)
router.post('/biometric/step-up', biometricRateLimiter, idempotency(), authorizeBiometricStepUp);

export default router;
