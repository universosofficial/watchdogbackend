import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { startTestServer, stopTestServer, apiRequest } from './testHelper.js';
import pool from '../src/config/db.js';
import bcrypt from 'bcryptjs';
import crypto from 'crypto';

describe('NUBAN Bank Identity Anchor & Settlement Enforcement Tests', () => {
  let serverInfo;
  let testSellerToken;
  let testSellerUserId;
  let testSellerBizId;
  let testBuyerToken;
  let testBuyerBizId;
  let testDealId;

  const validAccountNumber = '0123456789'; // Resolves to 'GABRIEL OTEMU' in mock
  const corporateAccountNumber = '0112233445'; // Resolves to 'APEX STRUCTURAL SUPPLIES LTD' in mock
  const muleAccountNumber = '9999999999'; // Resolves to 'MUSA IBRAHIM' in mock
  const gtbCode = '058';

  before(async () => {
    process.env.USE_MOCK_VERIFICATION = 'true';
    serverInfo = await startTestServer();

    const passwordHash = await bcrypt.hash('Password123!', 10);
    const now = new Date();

    // 1. Create Test Seller User (Gabriel Otemu)
    testSellerUserId = crypto.randomUUID();
    testSellerBizId = crypto.randomUUID();
    const sellerPhone = '+234805' + Math.floor(1000000 + Math.random() * 9000000);

    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, account_type, phone, country_code, default_currency, active_persona, is_id_verified, phone_verified_at)
       VALUES (?, ?, ?, 'Gabriel Otemu', 'individual', ?, 'NG', 'NGN', 'seller', 1, ?)`,
      [testSellerUserId, `gabriel.${Date.now()}@test.ng`, passwordHash, sellerPhone, now]
    );

    await pool.query(
      `INSERT INTO businesses (id, name, entity_type, country_code, verification_status, business_tier, trust_score, trust_status)
       VALUES (?, 'Otemu Trading Ventures', 'individual', 'NG', 'verified', 'tier_2', 50, 'provisional')`,
      [testSellerBizId]
    );

    await pool.query(
      `INSERT INTO business_members (id, business_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
      [crypto.randomUUID(), testSellerBizId, testSellerUserId, now]
    );

    // Login seller
    const sellerLogin = await apiRequest('/api/v1/auth/login-phone', {
      method: 'POST',
      body: { phone: sellerPhone, password: 'Password123!' }
    });
    testSellerToken = sellerLogin.data?.data?.token;

    // 2. Create Test Buyer User (Folake Balogun)
    const buyerUserId = crypto.randomUUID();
    testBuyerBizId = crypto.randomUUID();
    const buyerPhone = '+234806' + Math.floor(1000000 + Math.random() * 9000000);

    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, account_type, phone, country_code, default_currency, active_persona, is_id_verified, phone_verified_at)
       VALUES (?, ?, ?, 'Folake Balogun', 'corporate', ?, 'NG', 'NGN', 'buyer', 1, ?)`,
      [buyerUserId, `folake.${Date.now()}@test.ng`, passwordHash, buyerPhone, now]
    );

    await pool.query(
      `INSERT INTO businesses (id, name, entity_type, country_code, verification_status, business_tier, trust_score, trust_status)
       VALUES (?, 'Balogun Construction Ltd', 'corporate', 'NG', 'verified', 'tier_3', 90, 'safe')`,
      [testBuyerBizId]
    );

    await pool.query(
      `INSERT INTO business_members (id, business_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', ?)`,
      [crypto.randomUUID(), testBuyerBizId, buyerUserId, now]
    );

    // Login buyer
    const buyerLogin = await apiRequest('/api/v1/auth/login-phone', {
      method: 'POST',
      body: { phone: buyerPhone, password: 'Password123!' }
    });
    testBuyerToken = buyerLogin.data?.data?.token;

    // 3. Buyer creates a deal with this seller
    const dealRes = await apiRequest('/api/v1/deals', {
      method: 'POST',
      token: testBuyerToken,
      body: {
        title: 'NUBAN Settlement Enforced Deal',
        amount: 250000,
        currency: 'NGN',
        counterparty_phone: sellerPhone
      }
    });
    testDealId = dealRes.data?.data?.id;
  });

  after(async () => {
    await stopTestServer();
  });

  it('1. GET /api/v1/verification/banks returns supported CBN banks list', async () => {
    const res = await apiRequest('/api/v1/verification/banks', { method: 'GET' });
    assert.equal(res.status, 200);
    assert.equal(res.data?.success, true);
    assert.ok(Array.isArray(res.data?.data?.banks));
    const gtb = res.data.data.banks.find(b => b.code === '058');
    assert.ok(gtb, 'GTBank should be in supported list');
  });

  it('2. Third-Party Mule Test: Profile name "Gabriel Otemu" + Bank Name "MUSA IBRAHIM" returns HTTP 400 mismatch error', async () => {
    const res = await apiRequest('/api/v1/verification/bank', {
      method: 'POST',
      token: testSellerToken,
      body: {
        accountNumber: muleAccountNumber,
        bankCode: gtbCode,
        bankName: 'Guaranty Trust Bank'
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.data?.success, false);
    assert.match(res.data?.error?.message, /Account Name Mismatch/i);
    assert.match(res.data?.error?.message, /MUSA IBRAHIM/i);

    // Verify rejection logged in bank_verification_logs
    const [logs] = await pool.query(
      'SELECT status, resolved_name FROM bank_verification_logs WHERE business_id = ? AND account_number = ?',
      [testSellerBizId, muleAccountNumber]
    );
    assert.equal(logs.length, 1);
    assert.equal(logs[0].status, 'mismatch_rejected');
    assert.equal(logs[0].resolved_name, 'MUSA IBRAHIM');
  });

  it('3. Valid Match Test: Profile name "Gabriel Otemu" + Bank Name "OTEMU GABRIEL" passes and locks account', async () => {
    const res = await apiRequest('/api/v1/verification/bank', {
      method: 'POST',
      token: testSellerToken,
      body: {
        accountNumber: validAccountNumber,
        bankCode: gtbCode,
        bankName: 'Guaranty Trust Bank'
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.data?.success, true);
    assert.equal(res.data?.data?.bank_anchor?.verified_account_name, 'GABRIEL OTEMU');
    assert.equal(res.data?.data?.bank_anchor?.is_bank_verified, true);

    // Verify businesses table is updated
    const [biz] = await pool.query(
      'SELECT is_bank_verified, verified_account_number, verified_account_name, bank_code, trust_status FROM businesses WHERE id = ?',
      [testSellerBizId]
    );
    assert.equal(biz[0].is_bank_verified, 1);
    assert.equal(biz[0].verified_account_number, validAccountNumber);
    assert.equal(biz[0].verified_account_name, 'GABRIEL OTEMU');
    assert.equal(biz[0].bank_code, gtbCode);
    assert.equal(biz[0].trust_status, 'safe');
  });

  it('4. Corporate Match Test: flags corporate, checks business name, passes if matched', async () => {
    // Create a corporate user + business
    const corpUserId = crypto.randomUUID();
    const corpBizId = crypto.randomUUID();
    const corpPhone = '+234803' + Math.floor(1000000 + Math.random() * 9000000);
    const passwordHash = await bcrypt.hash('Password123!', 10);

    await pool.query(
      `INSERT INTO users (id, email, password_hash, full_name, account_type, phone, country_code, default_currency, active_persona, is_id_verified, phone_verified_at)
       VALUES (?, ?, ?, 'Gabriel Otemu', 'corporate', ?, 'NG', 'NGN', 'seller', 1, NOW())`,
      [corpUserId, `director.${Date.now()}@apex.ng`, passwordHash, corpPhone]
    );

    await pool.query(
      `INSERT INTO businesses (id, name, entity_type, country_code, verification_status, business_tier, trust_score, trust_status)
       VALUES (?, 'Apex Structural Supplies Ltd', 'corporate', 'NG', 'verified', 'tier_3', 60, 'provisional')`,
      [corpBizId]
    );

    await pool.query(
      `INSERT INTO business_members (id, business_id, user_id, role, created_at)
       VALUES (?, ?, ?, 'owner', NOW())`,
      [crypto.randomUUID(), corpBizId, corpUserId]
    );

    const corpLogin = await apiRequest('/api/v1/auth/login-phone', {
      method: 'POST',
      body: { phone: corpPhone, password: 'Password123!' }
    });
    const corpToken = corpLogin.data?.data?.token;

    // Anchor corporate account (resolves to 'APEX STRUCTURAL SUPPLIES LTD')
    const res = await apiRequest('/api/v1/verification/bank', {
      method: 'POST',
      token: corpToken,
      body: {
        accountNumber: corporateAccountNumber,
        bankCode: gtbCode,
        bankName: 'Guaranty Trust Bank'
      }
    });

    assert.equal(res.status, 200);
    assert.equal(res.data?.success, true);
    assert.equal(res.data?.data?.bank_anchor?.is_corporate_account, true);
    assert.equal(res.data?.data?.bank_anchor?.verified_account_name, 'APEX STRUCTURAL SUPPLIES LTD');
  });

  it('5. Deal Readout injects seller verified settlementDetails', async () => {
    const res = await apiRequest(`/api/v1/deals/${testDealId}`, {
      method: 'GET',
      token: testBuyerToken
    });

    assert.equal(res.status, 200);
    assert.ok(res.data?.data?.settlementDetails);
    assert.equal(res.data?.data?.settlementDetails?.isBankVerified, true);
    assert.equal(res.data?.data?.settlementDetails?.accountNumber, validAccountNumber);
    assert.equal(res.data?.data?.settlementDetails?.verifiedBeneficiary, 'GABRIEL OTEMU');
    assert.match(res.data?.data?.settlementDetails?.warning, /ONLY to this verified beneficiary/i);
  });

  it('6. Deal Settlement Enforcement Test: Attempting to record payment to unauthorized account returns validation error', async () => {
    const unauthorizedAccount = '0987654321';

    const res = await apiRequest(`/api/v1/deals/${testDealId}/payments`, {
      method: 'POST',
      token: testBuyerToken,
      body: {
        reported_amount: 50000,
        currency: 'NGN',
        reference_no: 'TRF-TEST-MULE-ATTEMPT',
        destination_account_number: unauthorizedAccount,
        destination_bank_name: 'Access Bank',
        notes: 'Trying to pay another account'
      }
    });

    assert.equal(res.status, 400);
    assert.equal(res.data?.success, false);
    assert.equal(res.data?.error?.code, 'UNAUTHORIZED_DESTINATION_ACCOUNT');
    assert.match(res.data?.error?.message, /Unauthorized destination account number/i);
  });

  it('7. Deal Settlement Success: Recording payment to the exact verified beneficiary account succeeds', async () => {
    const res = await apiRequest(`/api/v1/deals/${testDealId}/payments`, {
      method: 'POST',
      token: testBuyerToken,
      body: {
        reported_amount: 50000,
        currency: 'NGN',
        reference_no: 'TRF-TEST-LEGIT',
        destination_account_number: validAccountNumber,
        destination_bank_name: 'Guaranty Trust Bank',
        beneficiary_match_confirmed: true,
        notes: 'Legitimate payment to verified anchor'
      }
    });

    assert.equal(res.status, 201);
    assert.equal(res.data?.success, true);
    assert.equal(res.data?.data?.destination_account_number, validAccountNumber);
    assert.equal(res.data?.data?.beneficiary_match_confirmed, true);
  });

  after(async () => {
    await stopTestServer();
  });
});
