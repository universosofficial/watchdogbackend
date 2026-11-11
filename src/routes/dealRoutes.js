import { Router } from 'express';
import {
  createDeal,
  listDeals,
  getDealById,
  getPublicDealPreview,
  updateTerms,
  acceptDeal,
  simulatePartnerAccept,
  verifyAuditChain,
  sendInvitation,
  acceptInvitation,
  getDealActivity,
  completeDeal,
  transitionDealStatus,
  getDashboardSummary
} from '../controllers/dealController.js';
import {
  createObligation,
  listObligations,
  updateObligationStatus,
  extendObligationDeadline
} from '../controllers/obligationController.js';
import {
  uploadEvidence,
  listEvidence,
  downloadEvidence,
  getSignedEvidenceUrl
} from '../controllers/evidenceController.js';
import {
  recordPayment,
  updatePaymentStatus,
  getPaymentSummary
} from '../controllers/paymentController.js';
import {
  recordDelivery,
  updateDeliveryStatus,
  listDeliveries
} from '../controllers/deliveryController.js';
import {
  openDispute,
  respondToDispute,
  resolveDispute,
  listDisputes,
  getDispute
} from '../controllers/disputeController.js';
import { authenticate, requireBusiness } from '../middleware/auth.js';
import { requireDealAccess } from '../middleware/tenant.js';
import { evidenceUpload } from '../middleware/upload.js';
import { idempotency } from '../middleware/idempotency.js';

const router = Router();

// Secure Evidence Download: Accessible via valid HMAC pre-signed link OR authenticated deal participant
router.get('/:dealId/evidence/:evidenceId/download', (req, res, next) => {
  if (req.query.sig && req.query.expires) {
    return downloadEvidence(req, res, next);
  }
  return authenticate(req, res, () => {
    requireDealAccess(req, res, () => {
      downloadEvidence(req, res, next);
    });
  });
});

// Unauthenticated public preview for shared WhatsApp / SMS deal links
router.get('/public/:dealId', getPublicDealPreview);

// All deal routes require authentication and active business context
router.use(authenticate, requireBusiness);

// 1. Root Deal Routes & Counterparty Invitations
router.get('/dashboard/summary', getDashboardSummary);
router.post('/', idempotency(), createDeal);
router.get('/', listDeals);
router.post('/invitations/:token/accept', idempotency(), acceptInvitation);

// 2. Core Deal Lifecycle Routes (Guarded by requireDealAccess)
router.get('/:dealId', requireDealAccess, getDealById);
router.put('/:dealId/terms', requireDealAccess, idempotency(), updateTerms);
router.post('/:dealId/accept', requireDealAccess, idempotency(), acceptDeal);
router.post('/:dealId/simulate-accept', requireDealAccess, idempotency(), simulatePartnerAccept);
router.post('/:dealId/invite', requireDealAccess, sendInvitation);
router.get('/:dealId/activity', requireDealAccess, getDealActivity);
router.get('/:dealId/audit-chain/verify', requireDealAccess, verifyAuditChain);
router.post('/:dealId/complete', requireDealAccess, idempotency(), completeDeal);
router.post('/:dealId/transition', requireDealAccess, idempotency(), transitionDealStatus);

// 3. Obligations Management
router.post('/:dealId/obligations', requireDealAccess, idempotency(), createObligation);
router.get('/:dealId/obligations', requireDealAccess, listObligations);
router.patch('/:dealId/obligations/:obligationId/status', requireDealAccess, updateObligationStatus);
router.patch('/:dealId/obligations/:obligationId/extend-deadline', requireDealAccess, extendObligationDeadline);

// 4. Evidence Upload & Secure Download
router.post('/:dealId/evidence', requireDealAccess, evidenceUpload.single('file'), uploadEvidence);
router.get('/:dealId/evidence', requireDealAccess, listEvidence);
router.get('/:dealId/evidence/:evidenceId/signed-url', requireDealAccess, getSignedEvidenceUrl);
router.get('/:dealId/evidence/:evidenceId/download', downloadEvidence);

// 5. Payment Records Ledger
router.post('/:dealId/payments', requireDealAccess, idempotency(), recordPayment);
router.patch('/:dealId/payments/:paymentId/status', requireDealAccess, updatePaymentStatus);
router.get('/:dealId/payments', requireDealAccess, getPaymentSummary);

// 6. Delivery Records Ledger
router.post('/:dealId/deliveries', requireDealAccess, recordDelivery);
router.patch('/:dealId/deliveries/:deliveryId/status', requireDealAccess, updateDeliveryStatus);
router.get('/:dealId/deliveries', requireDealAccess, listDeliveries);

// 7. Dispute Management
router.post('/:dealId/disputes', requireDealAccess, openDispute);
router.get('/:dealId/disputes', requireDealAccess, listDisputes);
router.get('/:dealId/disputes/:disputeId', requireDealAccess, getDispute);
router.post('/:dealId/disputes/:disputeId/response', requireDealAccess, respondToDispute);
router.post('/:dealId/disputes/:disputeId/resolve', requireDealAccess, resolveDispute);

export default router;
