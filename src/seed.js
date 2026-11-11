import crypto from 'crypto';
import bcrypt from 'bcryptjs';
import mysql from 'mysql2/promise';
import path from 'path';
import { fileURLToPath } from 'url';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
dotenv.config({ path: path.resolve(__dirname, '../.env') });

const dbConfig = {
  host: process.env.DB_HOST || 'localhost',
  port: parseInt(process.env.DB_PORT || '3306', 10),
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || '',
  database: process.env.DB_NAME || 'digital_watchdog_db',
  multipleStatements: true,
  charset: 'utf8mb4'
};

async function seed() {
  console.log('[Seed] Connecting to database:', dbConfig.database);
  const conn = await mysql.createConnection(dbConfig);

  try {
    await conn.beginTransaction();
    await conn.query('SET FOREIGN_KEY_CHECKS = 0');

    console.log('[Seed] Cleaning up any existing test records...');

    // Clean up previous test seed records safely in correct dependency order
    const testEmails = ['owner@alphasupplies.ng', 'procurement@betabuilders.ng'];
    const testBizNames = ['Alpha Supplies Nigeria Ltd', 'Beta Builders Construction Ltd'];

    const [bizRows] = await conn.query('SELECT id FROM businesses WHERE name IN (?)', [testBizNames]);
    const bizIds = bizRows.map(b => b.id);

    if (bizIds.length > 0) {
      const [deals] = await conn.query(
        'SELECT id FROM deals WHERE creator_business_id IN (?) OR counterparty_business_id IN (?)',
        [bizIds, bizIds]
      );
      const dealIds = deals.map(d => d.id);

      if (dealIds.length > 0) {
        await conn.query('DELETE FROM webhook_deliveries WHERE endpoint_id IN (SELECT id FROM webhook_endpoints WHERE business_id IN (?))', [bizIds]);
        await conn.query('DELETE FROM webhook_endpoints WHERE business_id IN (?)', [bizIds]);
        await conn.query('DELETE FROM activity_logs WHERE deal_id IN (?)', [dealIds]);
        await conn.query('DELETE FROM disputes WHERE deal_id IN (?)', [dealIds]);
        await conn.query('DELETE FROM delivery_records WHERE deal_id IN (?)', [dealIds]);
        await conn.query('DELETE FROM payment_records WHERE deal_id IN (?)', [dealIds]);
        await conn.query('DELETE FROM evidence_records WHERE deal_id IN (?)', [dealIds]);
        await conn.query('DELETE FROM obligations WHERE deal_id IN (?)', [dealIds]);
        await conn.query('DELETE FROM agreement_acceptances WHERE version_id IN (SELECT id FROM agreement_versions WHERE deal_id IN (?))', [dealIds]);
        await conn.query('DELETE FROM agreement_versions WHERE deal_id IN (?)', [dealIds]);
        await conn.query('DELETE FROM deal_invitations WHERE deal_id IN (?)', [dealIds]);
        await conn.query('DELETE FROM deals WHERE id IN (?)', [dealIds]);
      }

      await conn.query('DELETE FROM agreement_acceptances WHERE business_id IN (?)', [bizIds]);
      await conn.query('DELETE FROM business_members WHERE business_id IN (?)', [bizIds]);
      await conn.query('DELETE FROM businesses WHERE id IN (?)', [bizIds]);
    }

    const [testUserRows] = await conn.query('SELECT id FROM users WHERE email IN (?)', [testEmails]);
    const testUserIds = testUserRows.map(u => u.id);
    if (testUserIds.length > 0) {
      await conn.query('DELETE FROM agreement_acceptances WHERE user_id IN (?)', [testUserIds]);
      await conn.query('DELETE FROM dojah_audit_logs WHERE user_id IN (?)', [testUserIds]);
      await conn.query('DELETE FROM business_members WHERE user_id IN (?)', [testUserIds]);
      await conn.query('DELETE FROM users WHERE id IN (?)', [testUserIds]);
    }

    await conn.query('SET FOREIGN_KEY_CHECKS = 1');
    console.log('[Seed] Seeding Users and Businesses...');

    // 1. Password hashing
    const plainPassword = 'Password123!';
    const saltRounds = parseInt(process.env.BCRYPT_ROUNDS || '10', 10);
    const hashedPassword = await bcrypt.hash(plainPassword, saltRounds);

    // 2. Insert Users
    const user1Id = crypto.randomUUID();
    const user2Id = crypto.randomUUID();

    await conn.query(
      `INSERT INTO users (id, email, password_hash, full_name, phone, phone_verified_at, terms_accepted_at, privacy_accepted_at, terms_version, is_biometric_verified, kyc_tier, created_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW(), NOW(), '1.0', TRUE, 'tier_3', NOW())`,
      [user1Id, 'owner@alphasupplies.ng', hashedPassword, 'Ibrahim Chukwuma', '+2348011112222']
    );

    await conn.query(
      `INSERT INTO users (id, email, password_hash, full_name, phone, phone_verified_at, terms_accepted_at, privacy_accepted_at, terms_version, is_biometric_verified, kyc_tier, created_at)
       VALUES (?, ?, ?, ?, ?, NOW(), NOW(), NOW(), '1.0', TRUE, 'tier_3', NOW())`,
      [user2Id, 'procurement@betabuilders.ng', hashedPassword, 'Folake Adeleke', '+2348033334444']
    );

    // 3. Insert Businesses
    const business1Id = crypto.randomUUID();
    const business2Id = crypto.randomUUID();

    await conn.query(
      `INSERT INTO businesses (
        id, name, rc_number, address, verification_status, cac_status,
        business_tier, is_bank_verified, is_biometric_verified,
        bank_name, bank_code, verified_account_number, verified_account_name,
        trust_score, trust_status, created_at
      ) VALUES (?, ?, ?, ?, 'verified', 'verified', 'tier_3', TRUE, TRUE, 'Guaranty Trust Bank', '058', '0123456789', 'ALPHA SUPPLIES NIGERIA LTD', 95, 'safe', NOW())`,
      [
        business1Id,
        'Alpha Supplies Nigeria Ltd',
        'RC-1849204',
        'Plot 14, Commercial Avenue, Ikeja, Lagos State, Nigeria'
      ]
    );

    await conn.query(
      `INSERT INTO businesses (
        id, name, rc_number, address, verification_status, cac_status,
        business_tier, is_bank_verified, is_biometric_verified,
        bank_name, bank_code, verified_account_number, verified_account_name,
        trust_score, trust_status, created_at
      ) VALUES (?, ?, ?, ?, 'verified', 'verified', 'tier_3', TRUE, TRUE, 'Zenith Bank', '057', '0801234567', 'BETA BUILDERS CONSTRUCTION LTD', 92, 'safe', NOW())`,
      [
        business2Id,
        'Beta Builders Construction Ltd',
        'RC-2938471',
        'Kilometer 18, Lekki-Epe Expressway, Lekki Phase 1, Lagos State, Nigeria'
      ]
    );

    // 4. Insert Business Members
    const member1Id = crypto.randomUUID();
    const member2Id = crypto.randomUUID();

    await conn.query(
      `INSERT INTO business_members (id, user_id, business_id, role, created_at)
       VALUES (?, ?, ?, 'owner', NOW())`,
      [member1Id, user1Id, business1Id]
    );

    await conn.query(
      `INSERT INTO business_members (id, user_id, business_id, role, created_at)
       VALUES (?, ?, ?, 'owner', NOW())`,
      [member2Id, user2Id, business2Id]
    );

    // 5. Pre-populate Deal 1 (Draft Deal)
    console.log('[Seed] Seeding Deal 1: Draft Deal...');
    const deal1Id = crypto.randomUUID();
    await conn.query(
      `INSERT INTO deals (id, reference_no, creator_business_id, counterparty_business_id, title, description, amount, currency, status, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', 1, NOW(), NOW())`,
      [
        deal1Id,
        'DW-DEAL-2026-0001-DFT',
        business1Id,
        business2Id,
        'Procurement of High-Grade Granite & Quarry Aggregates (500 MT)',
        'Supply and staged delivery of 500 metric tons of construction-grade crushed granite for the Lekki infrastructure project.',
        4500000.00,
        'NGN'
      ]
    );

    const invitation1Id = crypto.randomUUID();
    const inviteToken = crypto.randomBytes(32).toString('hex');
    await conn.query(
      `INSERT INTO deal_invitations (id, deal_id, invited_email, token, status, expires_at, created_at)
       VALUES (?, ?, ?, ?, 'pending', DATE_ADD(NOW(), INTERVAL 7 DAY), NOW())`,
      [invitation1Id, deal1Id, 'procurement@betabuilders.ng', inviteToken]
    );

    // 6. Pre-populate Deal 2 (Active Deal with Version 1 accepted by both parties)
    console.log('[Seed] Seeding Deal 2: Active Deal with Agreements & Milestones...');
    const deal2Id = crypto.randomUUID();
    await conn.query(
      `INSERT INTO deals (id, reference_no, creator_business_id, counterparty_business_id, title, description, amount, currency, status, current_version, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'active', 1, NOW(), NOW())`,
      [
        deal2Id,
        'DW-DEAL-2026-0002-ACT',
        business1Id,
        business2Id,
        'Supply & Staged Delivery of 2,000 Bags of Elephant Portland Cement Grade 42.5R',
        'Turnkey procurement and staged logistics agreement for 2,000 units of Elephant Portland Cement Grade 42.5R delivered directly to Beta Builders Lekki construction site.',
        17600000.00,
        'NGN'
      ]
    );

    // 7. Agreement Version 1
    const version1Id = crypto.randomUUID();
    const agreementTerms = `DIGITAL B2B COMMODITY SUPPLY & ESCROW VERIFICATION AGREEMENT

Contract Reference: DW-DEAL-2026-0002-ACT
Parties:
1. Alpha Supplies Nigeria Ltd (Supplier / Contractor)
2. Beta Builders Construction Ltd (Buyer / Principal)

Terms and Conditions:
1. SCOPE: Supplier agrees to supply 2,000 bags of genuine Elephant Brand Portland Cement Grade 42.5R (50kg per bag).
2. TOTAL CONTRACT SUM: NGN 17,600,000.00 (Seventeen Million Six Hundred Thousand Naira).
3. MILESTONE STAGING:
   - Milestone 1: 50% mobilization payment (NGN 8,800,000.00) deposited into verified escrow / reported via system.
   - Milestone 2: Supplier dispatches Batch 1 (1,000 bags) within 48 hours of payment acknowledgement.
   - Milestone 3: Offloading, visual and lab QA sampling inspection at buyer's designated site.
   - Milestone 4: Final 50% balance disbursement upon acceptance confirmation of batch 1 and batch 2 completion.
4. AUDIT & DISPUTE JURISDICTION: This digital agreement and cryptographic activity log are binding under the laws of the Federal Republic of Nigeria, subject to the Nigerian Arbitration and Mediation Act 2023.`;

    await conn.query(
      `INSERT INTO agreement_versions (id, deal_id, version_number, terms_text, created_by_business_id, created_at)
       VALUES (?, ?, 1, ?, ?, NOW())`,
      [version1Id, deal2Id, agreementTerms, business1Id]
    );

    // 8. Agreement Acceptances by BOTH parties
    const acceptance1Id = crypto.randomUUID();
    const acceptance2Id = crypto.randomUUID();

    await conn.query(
      `INSERT INTO agreement_acceptances (id, version_id, business_id, user_id, accepted_at, ip_address)
       VALUES (?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 2 HOUR), '197.210.65.12')`,
      [acceptance1Id, version1Id, business1Id, user1Id]
    );

    await conn.query(
      `INSERT INTO agreement_acceptances (id, version_id, business_id, user_id, accepted_at, ip_address)
       VALUES (?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 1 HOUR), '102.89.34.88')`,
      [acceptance2Id, version1Id, business2Id, user2Id]
    );

    // 9. Two Obligations for Deal 2
    console.log('[Seed] Seeding Obligations...');
    const obligation1Id = crypto.randomUUID();
    const obligation2Id = crypto.randomUUID();

    // Obligation 1: Payment Milestone (Completed)
    await conn.query(
      `INSERT INTO obligations (id, deal_id, title, description, responsible_business_id, type, due_date, status, completion_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'payment', DATE_ADD(NOW(), INTERVAL 1 DAY), 'completed', DATE_SUB(NOW(), INTERVAL 45 MINUTE), NOW(), NOW())`,
      [
        obligation1Id,
        deal2Id,
        'Mobilization Advance Milestone Payment (50%)',
        'Beta Builders shall remit 50% contract sum (NGN 8,800,000.00) into verified settlement account prior to loading.',
        business2Id
      ]
    );

    // Obligation 2: Delivery Milestone (In Progress)
    await conn.query(
      `INSERT INTO obligations (id, deal_id, title, description, responsible_business_id, type, due_date, status, completion_date, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'delivery', DATE_ADD(NOW(), INTERVAL 3 DAY), 'in_progress', NULL, NOW(), NOW())`,
      [
        obligation2Id,
        deal2Id,
        'Batch 1 Haulage & On-Site Delivery (1,000 Bags)',
        'Alpha Supplies shall load, transport, and offload the initial 1,000 bags to Beta Builders Lekki construction site.',
        business1Id
      ]
    );

    // 10. Payment Record
    console.log('[Seed] Seeding Payment Record...');
    const payment1Id = crypto.randomUUID();
    await conn.query(
      `INSERT INTO payment_records (id, deal_id, obligation_id, expected_amount, reported_amount, currency, payer_business_id, recipient_business_id, reference_no, status, paid_at, notes, created_at)
       VALUES (?, ?, ?, ?, ?, 'NGN', ?, ?, ?, 'confirmed', DATE_SUB(NOW(), INTERVAL 45 MINUTE), ?, NOW())`,
      [
        payment1Id,
        deal2Id,
        obligation1Id,
        8800000.00,
        8800000.00,
        business2Id,
        business1Id,
        'PAY-TRX-2026-BB-094182',
        'Direct electronic settlement verified by Alpha Supplies finance desk.'
      ]
    );

    // 11. Delivery Record
    console.log('[Seed] Seeding Delivery Record...');
    const delivery1Id = crypto.randomUUID();
    const itemsJson = JSON.stringify([
      {
        item_code: 'CEM-ELE-50KG',
        description: 'Elephant Portland Cement Grade 42.5R (50kg)',
        quantity: 1000,
        unit: 'bags',
        batch_number: 'ECH-2026-B-8821'
      }
    ]);

    await conn.query(
      `INSERT INTO delivery_records (id, deal_id, obligation_id, items_json, dispatch_date, receipt_date, delivery_reference, status, notes, created_at)
       VALUES (?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL 20 MINUTE), NULL, ?, 'dispatched', ?, NOW())`,
      [
        delivery1Id,
        deal2Id,
        obligation2Id,
        itemsJson,
        'WAYBILL-ALPHA-2026-0881',
        'Dispatched from Ikeja Central Depot via 2 flatbed Mack articulated trailers. In transit to Lekki.'
      ]
    );

    // 12. Evidence Record
    console.log('[Seed] Seeding Evidence Record...');
    const evidence1Id = crypto.randomUUID();
    await conn.query(
      `INSERT INTO evidence_records (id, deal_id, obligation_id, submitted_by_business_id, submitted_by_user_id, file_path, file_name, file_size, mime_type, verification_tier, notes, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'verified', ?, NOW())`,
      [
        evidence1Id,
        deal2Id,
        obligation1Id,
        business2Id,
        user2Id,
        'uploads/evidence/2026/10/zenith_bank_deposit_advice_8800000.pdf',
        'zenith_bank_deposit_advice_8800000.pdf',
        312450,
        'application/pdf',
        'Zenith Bank E-Receipt NIBSS Session ID: 99901426101908001294'
      ]
    );

    // 13. Sample Activity Logs
    console.log('[Seed] Seeding Activity Logs...');
    const activityEvents = [
      {
        user: user1Id,
        biz: business1Id,
        event: 'deal.created',
        details: { reference_no: 'DW-DEAL-2026-0002-ACT', initial_amount: 17600000.00, currency: 'NGN' },
        timeOffsetMinutes: 130
      },
      {
        user: user1Id,
        biz: business1Id,
        event: 'agreement.version_published',
        details: { version_number: 1, word_count: 184 },
        timeOffsetMinutes: 125
      },
      {
        user: user1Id,
        biz: business1Id,
        event: 'agreement.accepted',
        details: { version_number: 1, role: 'creator', ip: '197.210.65.12' },
        timeOffsetMinutes: 120
      },
      {
        user: user2Id,
        biz: business2Id,
        event: 'agreement.accepted',
        details: { version_number: 1, role: 'counterparty', ip: '102.89.34.88' },
        timeOffsetMinutes: 60
      },
      {
        user: null,
        biz: null,
        event: 'deal.status_changed',
        details: { from: 'awaiting_acceptance', to: 'active', reason: 'all_parties_signed' },
        timeOffsetMinutes: 59
      },
      {
        user: user2Id,
        biz: business2Id,
        event: 'payment.reported',
        details: { amount: 8800000.00, reference_no: 'PAY-TRX-2026-BB-094182', obligation_id: obligation1Id },
        timeOffsetMinutes: 48
      },
      {
        user: user1Id,
        biz: business1Id,
        event: 'payment.confirmed',
        details: { payment_id: payment1Id, amount: 8800000.00, status: 'confirmed' },
        timeOffsetMinutes: 45
      },
      {
        user: user1Id,
        biz: business1Id,
        event: 'obligation.completed',
        details: { obligation_id: obligation1Id, title: 'Mobilization Advance Milestone Payment (50%)' },
        timeOffsetMinutes: 44
      },
      {
        user: user1Id,
        biz: business1Id,
        event: 'delivery.dispatched',
        details: { delivery_id: delivery1Id, reference: 'WAYBILL-ALPHA-2026-0881', items_count: 1000 },
        timeOffsetMinutes: 20
      }
    ];

    for (const act of activityEvents) {
      await conn.query(
        `INSERT INTO activity_logs (id, deal_id, actor_user_id, actor_business_id, event_type, details_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, DATE_SUB(NOW(), INTERVAL ? MINUTE))`,
        [
          crypto.randomUUID(),
          deal2Id,
          act.user,
          act.biz,
          act.event,
          JSON.stringify(act.details),
          act.timeOffsetMinutes
        ]
      );
    }

    // 14. Webhook Endpoint and sample delivery
    console.log('[Seed] Seeding Webhook Endpoints & Deliveries...');
    const endpointId = crypto.randomUUID();
    await conn.query(
      `INSERT INTO webhook_endpoints (id, business_id, url, secret_key, events_json, is_active, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 1, NOW(), NOW())`,
      [
        endpointId,
        business2Id,
        'https://erp.betabuilders.ng/api/v1/integrations/digital-watchdog',
        'whsec_live_9d28e71649b1a03f48c2e',
        JSON.stringify(['deal.status_changed', 'payment.confirmed', 'delivery.dispatched'])
      ]
    );

    await conn.query(
      `INSERT INTO webhook_deliveries (id, endpoint_id, event_type, payload_json, response_status, response_body, attempt_count, status, created_at)
       VALUES (?, ?, ?, ?, 200, ?, 1, 'success', DATE_SUB(NOW(), INTERVAL 20 MINUTE))`,
      [
        crypto.randomUUID(),
        endpointId,
        'delivery.dispatched',
        JSON.stringify({
          event: 'delivery.dispatched',
          deal_id: deal2Id,
          reference_no: 'DW-DEAL-2026-0002-ACT',
          delivery_reference: 'WAYBILL-ALPHA-2026-0881',
          timestamp: new Date().toISOString()
        }),
        '{"acknowledged": true, "erp_tracking_id": "ERP-TRK-77192"}'
      ]
    );

    await conn.commit();
    console.log('\n======================================================');
    console.log(' SEEDING COMPLETED SUCCESSFULLY!');
    console.log('======================================================');
    console.log('Test Accounts:');
    console.log(' 1. Alpha Supplies Nigeria Ltd');
    console.log('    Email:    owner@alphasupplies.ng');
    console.log('    Password: Password123!');
    console.log('    Role:     owner');
    console.log(' 2. Beta Builders Construction Ltd');
    console.log('    Email:    procurement@betabuilders.ng');
    console.log('    Password: Password123!');
    console.log('    Role:     owner');
    console.log('======================================================\n');
  } catch (err) {
    await conn.rollback();
    console.error('[Seed Error]: Rollback triggered due to error:', err);
    throw err;
  } finally {
    await conn.end();
  }
}

seed()
  .then(() => process.exit(0))
  .catch(() => process.exit(1));
