import { Router } from 'express';
import {
  initiateCurePeriod,
  resolveCure,
  escalateToBlacklist,
  getRegulatoryDossier
} from '../controllers/enforcementController.js';
import {
  escalateDisputeToWws,
  getWwsEscalationStatus
} from '../controllers/wwsEscalationController.js';
import { authenticate, requireBusiness } from '../middleware/auth.js';
import { requireDealAccess } from '../middleware/tenant.js';

const router = Router();

// Protected enforcement actions on deals
router.use(authenticate, requireBusiness);

router.post('/deals/:dealId/breach', requireDealAccess, initiateCurePeriod);
router.post('/deals/:dealId/resolve-cure', requireDealAccess, resolveCure);
router.post('/deals/:dealId/escalate-blacklist', requireDealAccess, escalateToBlacklist);
router.get('/deals/:dealId/dossier', requireDealAccess, getRegulatoryDossier);

// World Wide Security (WWS) Global Coordination Escalations
router.post('/deals/:dealId/disputes/:disputeId/escalate-wws', requireDealAccess, escalateDisputeToWws);
router.post('/deals/:dealId/escalate-wws', requireDealAccess, escalateDisputeToWws);
router.get('/deals/:dealId/wws-status', requireDealAccess, getWwsEscalationStatus);

export default router;
