import pool from '../config/db.js';

class TrustRadarService {
  /**
   * Computes Algorithmic Trust Radar status and score for a given business
   * Returns { score: number (0-100), status: 'safe' | 'provisional' | 'unsafe', badge: object, canCreateDeals: boolean, warningBanner: string | null }
   */
  static async evaluateBusinessTrust(businessId) {
    if (!businessId) {
      return {
        score: 50,
        status: 'provisional',
        badge: this.getBadge('provisional'),
        canCreateDeals: true,
        warningBanner: null
      };
    }

    const [bizRows] = await pool.query(
      `SELECT b.*, 
        (SELECT COUNT(*) FROM deals WHERE (creator_business_id = b.id OR counterparty_business_id = b.id) AND status = 'completed') as total_completed_deals,
        (SELECT COUNT(*) FROM disputes disp 
         JOIN deals d ON disp.deal_id = d.id 
         WHERE (d.creator_business_id = b.id OR d.counterparty_business_id = b.id) 
           AND disp.raised_by_business_id != b.id 
           AND disp.status = 'open') as open_disputes_count,
        (SELECT COUNT(*) FROM blacklist_records WHERE business_id = b.id AND status = 'active_default') as active_blacklist_count
       FROM businesses b WHERE b.id = ?`,
      [businessId]
    );

    if (bizRows.length === 0) {
      return {
        score: 50,
        status: 'provisional',
        badge: this.getBadge('provisional'),
        canCreateDeals: true,
        warningBanner: null
      };
    }

    const biz = bizRows[0];
    const completedDeals = parseInt(biz.total_completed_deals || biz.covenants_fulfilled_count || 0, 10);
    const openDisputes = parseInt(biz.open_disputes_count || 0, 10);
    const blacklistDefaults = parseInt(biz.active_blacklist_count || biz.covenants_defaulted_count || 0, 10);
    const isIdVerified = Boolean(biz.is_bank_verified) || Boolean(biz.is_biometric_verified);
    const isDualVerified = Boolean(biz.is_bank_verified) && Boolean(biz.is_biometric_verified);

    let score = 50;
    let status = 'provisional';
    let warningBanner = null;
    let canCreateDeals = true;

    // 1. Critical Disqualifiers (Unsafe)
    if (blacklistDefaults > 0 || openDisputes >= 2 || biz.reputation_status === 'blacklisted') {
      status = 'unsafe';
      score = Math.max(10, 30 - openDisputes * 10 - blacklistDefaults * 15);
      warningBanner = 'CRITICAL ALERT: Counterparty has unresolved defaults or active fraud disputes. Deals and invitations locked.';
      canCreateDeals = false;
    } 
    // 2. Safe / Verified
    else if ((isDualVerified || (isIdVerified && completedDeals >= 1)) && (openDisputes === 0 || openDisputes / Math.max(1, completedDeals) < 0.05)) {
      status = 'safe';
      score = isDualVerified ? Math.min(100, 90 + completedDeals * 2) : Math.min(100, 80 + completedDeals * 2);
      warningBanner = null;
      canCreateDeals = true;
    } 
    // 3. Provisional / Unverified (Default state)
    else {
      status = 'provisional';
      score = isIdVerified ? 70 : (completedDeals > 0 ? 55 + completedDeals * 3 : 50);
      warningBanner = '⚠️ UNVERIFIED SELLER: This supplier has not anchored their settlement bank account or completed 3D facial verification. Settle in milestones; do not release full payments upfront.';
      canCreateDeals = true;
    }

    // Persist calculated status back to database
    await pool.query(
      `UPDATE businesses 
       SET trust_score = ?, trust_status = ?, dispute_count = ?, successful_deals_count = ?
       WHERE id = ?`,
      [score, status, openDisputes, completedDeals, businessId]
    );

    return {
      score,
      status,
      badge: this.getBadge(status),
      openDisputes,
      completedDeals,
      canCreateDeals,
      warningBanner: status === 'provisional' || status === 'unsafe' ? warningBanner : null,
      isDojahVerified: isIdVerified
    };
  }

  static getBadge(status) {
    switch (status) {
      case 'safe':
        return {
          status: 'safe',
          label: 'SAFE / VERIFIED',
          color: '#10B981',
          bg: 'rgba(16, 185, 129, 0.12)',
          icon: '🛡️',
          description: 'Government & Corporate Registry Verified. Clean settlement history.'
        };
      case 'unsafe':
        return {
          status: 'unsafe',
          label: 'UNSAFE / HIGH RISK',
          color: '#EF4444',
          bg: 'rgba(239, 68, 68, 0.12)',
          icon: '⛔',
          description: 'Flagged for contract default or active open dispute. Trade restricted.'
        };
      default:
        return {
          status: 'provisional',
          label: 'PROVISIONAL / UNVERIFIED',
          color: '#F59E0B',
          bg: 'rgba(245, 158, 11, 0.12)',
          icon: '⚠️',
          description: 'Phone verified only. Settlement bank anchor or biometric verification recommended.'
        };
    }
  }
}

export default TrustRadarService;
