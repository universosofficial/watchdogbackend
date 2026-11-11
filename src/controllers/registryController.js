import RegistryService from '../services/registryService.js';
import { sendSuccess } from '../utils/response.js';

export async function searchRegistry(req, res, next) {
  try {
    const { q } = req.query;
    const data = await RegistryService.searchRegistry(q);
    return sendSuccess(res, data, 200);
  } catch (err) {
    next(err);
  }
}

export async function getPublicBlacklist(req, res, next) {
  try {
    const { limit, offset } = req.query;
    const data = await RegistryService.getPublicBlacklist({ limit, offset });
    return sendSuccess(res, data, 200);
  } catch (err) {
    next(err);
  }
}

export async function getRegistryStats(req, res, next) {
  try {
    const data = await RegistryService.getRegistryStats();
    return sendSuccess(res, data, 200);
  } catch (err) {
    next(err);
  }
}
