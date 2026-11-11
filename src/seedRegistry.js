import pool from './config/db.js';
import crypto from 'crypto';

async function seedRegistry() {
  console.log('[Seed] Seeding Watchdog Registry records...');

  // 1. Update Alpha Supplies to watchdog_cleared
  await pool.query(`
    UPDATE businesses 
    SET reputation_status = 'watchdog_cleared',
        covenants_fulfilled_count = 14,
        covenants_defaulted_count = 0
    WHERE rc_number = 'RC-1849204' OR name LIKE '%Alpha%'
  `);

  // 2. Check if default records exist
  const [existing] = await pool.query('SELECT COUNT(*) AS c FROM blacklist_records');
  if (existing[0].c === 0) {
    const badBizId1 = crypto.randomUUID();
    await pool.query(`
      INSERT INTO businesses (id, name, rc_number, address, verification_status, business_tier, reputation_status, covenants_fulfilled_count, covenants_defaulted_count, blacklisted_at, blacklist_reason)
      VALUES (?, 'Prestige Landmark & Property Developers Ltd', 'RC-2849102', 'Plot 14 Admiralty Way, Lekki Phase 1, Lagos', 'verified', 'tier_3', 'blacklisted', 0, 1, NOW(), 'Unresolved covenant default: failed to allocate title deed or physical beacons after 7-day statutory cure period.')
    `, [badBizId1]);

    const blId1 = crypto.randomUUID();
    await pool.query(`
      INSERT INTO blacklist_records (
        id, business_id, reference_no, business_name, rc_number, director_name, phone,
        deal_amount, currency, covenant_breached, default_summary, cure_period_expired_at,
        reported_to_fccpc, fccpc_dossier_ref, reported_to_police_sfu, reported_to_lasrera,
        reported_to_credit_bureau, status, created_at
      ) VALUES (
        ?, ?, 'DW-2026-0819', 'Prestige Landmark & Property Developers Ltd', 'RC-2849102',
        'Chief O. K. Balogun', '+2348039281740', 18500000.00, 'NGN',
        'Physical Land Allocation & Registered Survey Covenant (Ibeju-Lekki Scheme 2)',
        'Vendor collected ₦18.5M commercial deposit for 2 plots. Failed to deliver registered survey or physical beacon allocation. 7-day cure window expired with zero compliance or refund.',
        DATE_SUB(NOW(), INTERVAL 3 DAY), TRUE, 'FCCPC-DW-2026-819203', TRUE, TRUE, TRUE, 'active_default', DATE_SUB(NOW(), INTERVAL 3 DAY)
      )
    `, [blId1, badBizId1]);

    const badBizId2 = crypto.randomUUID();
    await pool.query(`
      INSERT INTO businesses (id, name, rc_number, address, verification_status, business_tier, reputation_status, covenants_fulfilled_count, covenants_defaulted_count, blacklisted_at, blacklist_reason)
      VALUES (?, 'Apex Continental Auto & Machinery Ltd', 'RC-3920194', 'Ladipo Auto Complex, Mushin, Lagos', 'unverified', 'tier_1', 'blacklisted', 0, 1, NOW(), 'Procurement delivery failure: counterfeit transmission components delivered, refused 7-day refund cure.')
    `, [badBizId2]);

    const blId2 = crypto.randomUUID();
    await pool.query(`
      INSERT INTO blacklist_records (
        id, business_id, reference_no, business_name, rc_number, director_name, phone,
        deal_amount, currency, covenant_breached, default_summary, cure_period_expired_at,
        reported_to_fccpc, fccpc_dossier_ref, reported_to_police_sfu, reported_to_lasrera,
        reported_to_credit_bureau, status, created_at
      ) VALUES (
        ?, ?, 'DW-2026-0412', 'Apex Continental Auto & Machinery Ltd', 'RC-3920194',
        'Emeka J. Nnamdi', '+2348028491023', 9200000.00, 'NGN',
        'Caterpillar Hydraulic Transmission Equipment Delivery Covenant',
        'Supplied non-compliant, uncertified components contrary to verified deal specifications. 7-day cure notice expired without restitution. Escalated to Police SFU.',
        DATE_SUB(NOW(), INTERVAL 12 DAY), TRUE, 'FCCPC-DW-2026-491028', TRUE, FALSE, TRUE, 'active_default', DATE_SUB(NOW(), INTERVAL 12 DAY)
      )
    `, [blId2, badBizId2]);

    console.log('[Seed] Successfully seeded Watchdog Registry with active defaults!');
  } else {
    console.log('[Seed] Watchdog Registry already has default records.');
  }

  process.exit(0);
}

seedRegistry().catch(err => {
  console.error('[Seed Error]:', err);
  process.exit(1);
});
