import KycService from '../services/integrations/kycService.js';
import DojahService from '../services/integrations/dojahService.js';
import TrustRadarService from '../services/trustRadarService.js';
import NubanService from '../services/nubanService.js';
import { sendSuccess, sendError } from '../utils/response.js';

/**
 * GET /api/v1/verification/status
 * Returns current verification level, transaction limits, and dual-anchor status
 * (Biometric Face Liveness + NUBAN Bank Settlement Anchor)
 */
export async function getVerificationStatus(req, res, next) {
  try {
    const result = await KycService.getStatus(req.userId, req.businessId);
    let trustRadar = null;
    if (req.businessId) {
      trustRadar = await TrustRadarService.evaluateBusinessTrust(req.businessId);
    }
    return sendSuccess(res, {
      ...result,
      trust_radar: trustRadar
    });
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/verification/banks
 * Returns list of major commercial banks and fintechs with standard CBN 3-digit bank codes
 */
export async function getSupportedBanks(req, res, next) {
  try {
    const banks = await NubanService.getSupportedBanks();
    return sendSuccess(res, { count: banks.length, banks });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/verification/bank/resolve
 * Previews account resolution against Central Bank / NIBSS directory without saving
 */
export async function resolveBankAccount(req, res, next) {
  try {
    const { accountNumber, bankCode, account_number, bank_code } = req.body;
    const targetAccount = accountNumber || account_number;
    const targetBankCode = bankCode || bank_code;

    if (!targetAccount || !targetBankCode) {
      return sendError(res, 'Account number and bank code are required.', 'MISSING_FIELDS', 400);
    }

    const result = await NubanService.resolveBankAccount(targetAccount, targetBankCode, req.user);
    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/verification/bank
 * Resolves account, compares name tokens against registered profile, and anchors details to business
 */
export async function anchorBankAccount(req, res, next) {
  try {
    const { accountNumber, bankCode, bankName, account_number, bank_code, bank_name } = req.body;
    const targetAccount = accountNumber || account_number;
    const targetBankCode = bankCode || bank_code;
    const targetBankName = bankName || bank_name;

    if (!targetAccount || !targetBankCode) {
      return sendError(res, 'Account number and bank code are required.', 'MISSING_FIELDS', 400);
    }

    const result = await NubanService.anchorBankAccount({
      businessId: req.businessId,
      userId: req.userId,
      accountNumber: targetAccount,
      bankCode: targetBankCode,
      bankName: targetBankName
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/verification/biometric/liveness
 * Biometric 3D facial liveness & anti-spoofing verification
 */
export async function verifyBiometricLiveness(req, res, next) {
  try {
    const { selfie_image, id_photo, selfieImageBase64, idPhotoBase64 } = req.body;
    const selfie = selfie_image || selfieImageBase64;
    const idPhoto = id_photo || idPhotoBase64;

    if (!selfie) {
      return sendError(res, 'Selfie snapshot image (Base64) is required for biometric liveness check.', 'MISSING_IMAGE', 400);
    }

    const result = await DojahService.performLivenessCheck({
      selfieImageBase64: selfie,
      idPhotoBase64: idPhoto,
      userId: req.userId,
      businessId: req.businessId
    });

    let trustRadar = null;
    if (req.businessId) {
      trustRadar = await TrustRadarService.evaluateBusinessTrust(req.businessId);
    }

    return sendSuccess(res, {
      ...result,
      trust_radar: trustRadar
    });
  } catch (error) {
    next(error);
  }
}

/**
 * POST /api/v1/verification/biometric/step-up
 * High-profile deal 1:1 biometric facial re-authentication & step-up approval
 */
export async function authorizeBiometricStepUp(req, res, next) {
  try {
    const { live_selfie, selfieImageBase64, deal_id, action, amount } = req.body;
    const selfie = live_selfie || selfieImageBase64;

    if (!selfie) {
      return sendError(res, 'Live facial snapshot image (Base64) is required for step-up verification.', 'MISSING_IMAGE', 400);
    }

    const result = await DojahService.verifyStepUpBiometrics({
      userId: req.userId,
      businessId: req.businessId,
      dealId: deal_id,
      actionType: action || 'high_value_transaction',
      amount,
      liveSelfieBase64: selfie
    });

    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}

/**
 * GET /api/v1/verification/trust-radar/:businessId?
 * Evaluates real-time Trust Radar badge and risk score
 */
export async function getTrustRadar(req, res, next) {
  try {
    const targetBusinessId = req.params.businessId || req.businessId;
    if (!targetBusinessId) {
      return sendError(res, 'Business ID is required to evaluate trust radar', 'MISSING_BUSINESS_ID', 400);
    }

    const result = await TrustRadarService.evaluateBusinessTrust(targetBusinessId);
    return sendSuccess(res, result);
  } catch (error) {
    next(error);
  }
}
