import 'dotenv/config';
import mysql from 'mysql2/promise';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

async function seedDevAccounts() {
  const conn = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || '',
    database: process.env.DB_NAME || 'digital_watchdog_db'
  });

  console.log('[Dev Accounts] Connected to database');

  const passwordHash = await bcrypt.hash('Password123!', 10);
  const now = new Date();

  // 1. Primary Test Account: +2348012345678 (Can be entered as 08012345678 or +2348012345678)
  const phone1 = '+2348012345678';
  const [existing1] = await conn.query('SELECT id FROM users WHERE phone = ?', [phone1]);
  let userId1;

  if (existing1.length > 0) {
    userId1 = existing1[0].id;
    await conn.query(
      `UPDATE users 
       SET password_hash = ?, 
           full_name = 'Dev Tester (Alpha Corp)', 
           account_type = 'corporate',
           phone_verified_at = ?,
           is_id_verified = 1,
           kyc_tier = 'tier_3',
           active_persona = 'buyer',
           country_code = 'NG',
           default_currency = 'NGN'
       WHERE id = ?`,
      [passwordHash, now, userId1]
    );
  } else {
    userId1 = crypto.randomUUID();
    await conn.query(
      `INSERT INTO users (id, email, password_hash, full_name, account_type, phone, country_code, default_currency, active_persona, is_id_verified, phone_verified_at, kyc_tier)
       VALUES (?, 'dev@watchdog.ng', ?, 'Dev Tester (Alpha Corp)', 'corporate', ?, 'NG', 'NGN', 'buyer', 1, ?, 'tier_3')`,
      [userId1, passwordHash, phone1, now]
    );
  }

  // Ensure user1 has an active Tier 3 business
  const [m1] = await conn.query('SELECT business_id FROM business_members WHERE user_id = ?', [userId1]);
  let bizId1;
  if (m1.length > 0) {
    bizId1 = m1[0].business_id;
    await conn.query(
      `UPDATE businesses 
       SET name = 'Alpha Industrial Supplies Ltd',
           entity_type = 'corporate',
           rc_number = 'RC-1029384',
           verification_status = 'verified',
           cac_status = 'verified',
           cac_verified_at = ?,
           business_tier = 'tier_3',
           trust_score = 96,
           trust_status = 'safe',
           reputation_status = 'watchdog_cleared',
           successful_deals_count = 8,
           dispute_count = 0
       WHERE id = ?`,
      [now, bizId1]
    );
    await conn.query(`UPDATE business_members SET role = 'owner' WHERE user_id = ? AND business_id = ?`, [userId1, bizId1]);
  } else {
    bizId1 = crypto.randomUUID();
    await conn.query(
      `INSERT INTO businesses (id, name, entity_type, rc_number, address, country_code, verification_status, cac_status, cac_verified_at, business_tier, trust_score, trust_status, reputation_status, successful_deals_count, dispute_count)
       VALUES (?, 'Alpha Industrial Supplies Ltd', 'corporate', 'RC-1029384', '15 Marina, Victoria Island, Lagos', 'NG', 'verified', 'verified', ?, 'tier_3', 96, 'safe', 'watchdog_cleared', 8, 0)`,
      [bizId1, now]
    );
    await conn.query(
      `INSERT INTO business_members (id, business_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
      [crypto.randomUUID(), bizId1, userId1, now]
    );
  }

  // 2. Counterparty Merchant Account: +2348098765432 (Can be entered as 08098765432 or +2348098765432)
  const phone2 = '+2348098765432';
  const [existing2] = await conn.query('SELECT id FROM users WHERE phone = ?', [phone2]);
  let userId2;

  if (existing2.length > 0) {
    userId2 = existing2[0].id;
    await conn.query(
      `UPDATE users 
       SET password_hash = ?, 
           full_name = 'Prime Contractor (Beta Logistics)', 
           account_type = 'individual',
           phone_verified_at = ?,
           is_id_verified = 1,
           kyc_tier = 'tier_2',
           active_persona = 'seller',
           country_code = 'NG',
           default_currency = 'NGN'
       WHERE id = ?`,
      [passwordHash, now, userId2]
    );
  } else {
    userId2 = crypto.randomUUID();
    await conn.query(
      `INSERT INTO users (id, email, password_hash, full_name, account_type, phone, country_code, default_currency, active_persona, is_id_verified, phone_verified_at, kyc_tier)
       VALUES (?, 'partner@watchdog.ng', ?, 'Prime Contractor (Beta Logistics)', 'individual', ?, 'NG', 'NGN', 'seller', 1, ?, 'tier_2')`,
      [userId2, passwordHash, phone2, now]
    );
  }

  // Ensure user2 has a business
  const [m2] = await conn.query('SELECT business_id FROM business_members WHERE user_id = ?', [userId2]);
  let bizId2;
  if (m2.length > 0) {
    bizId2 = m2[0].business_id;
    await conn.query(
      `UPDATE businesses 
       SET name = 'Beta Freight & Logistics',
           entity_type = 'individual',
           rc_number = 'BN-482910',
           verification_status = 'verified',
           cac_status = 'verified',
           cac_verified_at = ?,
           business_tier = 'tier_2',
           trust_score = 90,
           trust_status = 'safe',
           reputation_status = 'watchdog_cleared',
           successful_deals_count = 5,
           dispute_count = 0
       WHERE id = ?`,
      [now, bizId2]
    );
    await conn.query(`UPDATE business_members SET role = 'owner' WHERE user_id = ? AND business_id = ?`, [userId2, bizId2]);
  } else {
    bizId2 = crypto.randomUUID();
    await conn.query(
      `INSERT INTO businesses (id, name, entity_type, rc_number, address, country_code, verification_status, cac_status, cac_verified_at, business_tier, trust_score, trust_status, reputation_status, successful_deals_count, dispute_count)
       VALUES (?, 'Beta Freight & Logistics', 'individual', 'BN-482910', '42 Airport Road, Ikeja, Lagos', 'NG', 'verified', 'verified', ?, 'tier_2', 90, 'safe', 'watchdog_cleared', 5, 0)`,
      [bizId2, now]
    );
    await conn.query(
      `INSERT INTO business_members (id, business_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
      [crypto.randomUUID(), bizId2, userId2, now]
    );
  }

  console.log('----------------------------------------------------');
  console.log('✅ TEST ACCOUNTS SEEDED SUCCESSFULLY');
  console.log('----------------------------------------------------');
  console.log('Account 1 (Primary / Corporate Admin):');
  console.log('  • Phone:    08012345678 (or +2348012345678)');
  console.log('  • Password: Password123!');
  console.log('  • Business: Alpha Industrial Supplies Ltd');
  console.log('  • Tier:     Tier 3 (RC-Verified Corporate, Trust Score 96 - SAFE)');
  console.log('  • Persona:  Buyer / Seller (Switchable in header dock)');
  console.log('');
  console.log('Account 2 (Counterparty Merchant / Supplier):');
  console.log('  • Phone:    08098765432 (or +2348098765432)');
  console.log('  • Password: Password123!');
  console.log('  • Business: Beta Freight & Logistics');
  console.log('  • Tier:     Tier 2 (ID/BN-Verified Supplier, Trust Score 90 - SAFE)');
  console.log('  • Persona:  Seller / Buyer');
  console.log('----------------------------------------------------');

  await conn.end();
}

seedDevAccounts().catch(err => {
  console.error('[Dev Accounts Seed Error]:', err);
  process.exit(1);
});
