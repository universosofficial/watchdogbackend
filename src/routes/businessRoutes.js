import { Router } from 'express';
import {
  getCurrentBusiness,
  updateCurrentBusiness,
  listMembers,
  inviteMember
} from '../controllers/businessController.js';
import { authenticate, requireBusiness } from '../middleware/auth.js';

const router = Router();

// All business routes require authenticated token with active business context
router.use(authenticate, requireBusiness);

router.get('/me', getCurrentBusiness);
router.put('/me', updateCurrentBusiness);
router.get('/members', listMembers);
router.post('/members', inviteMember);

export default router;
