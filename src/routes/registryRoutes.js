import { Router } from 'express';
import {
  searchRegistry,
  getPublicBlacklist,
  getRegistryStats
} from '../controllers/registryController.js';

const router = Router();

// Public endpoints (no auth required)
router.get('/search', searchRegistry);
router.get('/blacklist', getPublicBlacklist);
router.get('/stats', getRegistryStats);

export default router;
