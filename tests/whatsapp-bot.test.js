import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startTestServer, stopTestServer, apiRequest, getBaseUrl } from './testHelper.js';
import pool, { closePool } from '../src/config/db.js';
import whatsappClient from '../src/integrations/whatsapp/services/whatsappClient.js';
import ActivityService from '../src/services/activityService.js';

describe('WhatsApp Business Bot Integration Tests', () => {
  const alphaPhone = '2348011112222';
  const betaPhone = '2348033334444';

  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await stopTestServer();
    await closePool();
  });

  beforeEach(() => {
    whatsappClient.clearMockHistory();
  });

  describe('1. Webhook Handshake Verification (GET /webhook)', () => {
    it('should verify handshake and return hub.challenge on matching token', async () => {
      const verifyToken = process.env.WHATSAPP_VERIFY_TOKEN || 'digital_watchdog_meta_verify_token_2026';
      const challenge = 'random_meta_challenge_str_88319';

      const res = await fetch(
        `${getBaseUrl()}/api/v1/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=${verifyToken}&hub.challenge=${challenge}`
      );

      assert.equal(res.status, 200);
      const body = await res.text();
      assert.equal(body, challenge);
    });

    it('should return 403 Forbidden on invalid verify token', async () => {
      const res = await fetch(
        `${getBaseUrl()}/api/v1/integrations/whatsapp/webhook?hub.mode=subscribe&hub.verify_token=WRONG_TOKEN&hub.challenge=test`
      );

      assert.equal(res.status, 403);
    });
  });

  describe('2. Identity Linker & Unknown User Onboarding', () => {
    it('should prompt an unregistered phone number to register', async () => {
      const randomPhone = `234809${Math.floor(1000000 + Math.random() * 9000000)}`;

      const res = await apiRequest('/api/v1/integrations/whatsapp/mock-incoming', {
        method: 'POST',
        body: {
          from: randomPhone,
          text: 'Hello, I want to create a contract'
        }
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.replies.length >= 1);

      const reply = res.data.data.replies[0];
      assert.match(reply.text, /Welcome to Digital Watchdog/i);
      assert.match(reply.text, /REGISTER: \[Your Name\]/i);
    });

    it('should allow unknown user to self-register via WhatsApp (REGISTER: ...)', async () => {
      const uniqueSuffix = crypto.randomBytes(3).toString('hex');
      const newPhone = `234808${Math.floor(1000000 + Math.random() * 9000000)}`;
      const fullName = `Emeka Okafor ${uniqueSuffix}`;
      const businessName = `Okafor Heavy Machinery ${uniqueSuffix} Ltd`;
      const rcNumber = `RC-${uniqueSuffix.toUpperCase()}`;

      const res = await apiRequest('/api/v1/integrations/whatsapp/mock-incoming', {
        method: 'POST',
        body: {
          from: newPhone,
          text: `REGISTER: ${fullName}, ${businessName}, ${rcNumber}`
        }
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);

      // Verify user and business were inserted in MySQL database
      const [users] = await pool.query('SELECT * FROM users WHERE phone = ?', [`+${newPhone}`]);
      assert.equal(users.length, 1);
      assert.equal(users[0].full_name, fullName);

      const [bizs] = await pool.query('SELECT * FROM businesses WHERE name = ?', [businessName]);
      assert.equal(bizs.length, 1);
      assert.equal(bizs[0].rc_number, rcNumber);

      const reply = res.data.data.replies[0];
      assert.match(reply.text, new RegExp(fullName));
      assert.match(reply.text, /verified and registered/i);
    });
  });

  describe('3. Status Inquiries & Command Menu', () => {
    it('should return active deals when known user sends STATUS or /deals', async () => {
      const res = await apiRequest('/api/v1/integrations/whatsapp/mock-incoming', {
        method: 'POST',
        body: {
          from: alphaPhone,
          text: 'STATUS'
        }
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.data.replies.length >= 1);

      const reply = res.data.data.replies[0];
      assert.match(reply.text, /Active Transactions/i);
    });

    it('should return command options when user sends /help', async () => {
      const res = await apiRequest('/api/v1/integrations/whatsapp/mock-incoming', {
        method: 'POST',
        body: {
          from: alphaPhone,
          text: '/help'
        }
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      const reply = res.data.data.replies[0];
      assert.match(reply.text, /Digital Watchdog Assistant/i);
      assert.ok(reply.buttons && reply.buttons.length >= 2);
    });
  });

  describe('4. Deal Initiation via Chat & Two-Party Acceptance', () => {
    let createdDealId = null;
    let dealVersionId = null;
    let dealRef = null;

    it('Step 1: /deal create prompts for deal details and sets session state', async () => {
      const res = await apiRequest('/api/v1/integrations/whatsapp/mock-incoming', {
        method: 'POST',
        body: {
          from: alphaPhone,
          text: '/deal create'
        }
      });

      assert.equal(res.status, 200);
      const reply = res.data.data.replies[0];
      assert.match(reply.text, /Initiate New Escrow Agreement/i);
      assert.match(reply.text, /\[Title\], \[Counterparty Phone\], \[Amount\] \[Currency\]/i);
    });

    it('Step 2: Submitting details creates deal, seeds deliverables, and dispatches invite to partner', async () => {
      const dealTitle = `500 Metric Tonnes Granite Rock ${Date.now()}`;
      const amount = '7500000 NGN';

      const res = await apiRequest('/api/v1/integrations/whatsapp/mock-incoming', {
        method: 'POST',
        body: {
          from: alphaPhone,
          text: `${dealTitle}, ${betaPhone}, ${amount}`
        }
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);

      // Verify creator received confirmation
      const creatorReply = res.data.data.replies.find(r => r.to === alphaPhone);
      assert.ok(creatorReply);
      assert.match(creatorReply.text, /Created!/i);
      assert.match(creatorReply.text, /7,500,000/);

      // Verify counterparty received WhatsApp invitation with buttons
      const inviteMsg = res.data.data.replies.find(r => r.to === betaPhone);
      assert.ok(inviteMsg, 'Counterparty should receive WhatsApp invite');
      assert.match(inviteMsg.text, /New Escrow Contract Invitation/i);
      assert.ok(inviteMsg.buttons && inviteMsg.buttons.length >= 1);

      const acceptBtn = inviteMsg.buttons.find(b => b.id.startsWith('ACCEPT_DEAL_'));
      assert.ok(acceptBtn, 'Should include [Accept Terms] button');

      const parts = acceptBtn.id.split('_');
      createdDealId = parts[2];
      dealVersionId = parts[3];

      // Check deal in MySQL
      const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [createdDealId]);
      assert.equal(deals.length, 1);
      dealRef = deals[0].reference_no;

      // Verify starter deliverables were seeded
      const [obs] = await pool.query('SELECT * FROM obligations WHERE deal_id = ?', [createdDealId]);
      assert.equal(obs.length, 2, 'Should have seeded 2 starter obligations');
    });

    it('Step 3: Counterparty taps [Accept Terms] -> Deal transitions to ACTIVE', async () => {
      assert.ok(createdDealId);

      const res = await apiRequest('/api/v1/integrations/whatsapp/mock-incoming', {
        method: 'POST',
        body: {
          from: betaPhone,
          payload: `ACCEPT_DEAL_${createdDealId}_${dealVersionId}`
        }
      });

      assert.equal(res.status, 200);

      // Verify deal status in DB is active
      const [deals] = await pool.query('SELECT status FROM deals WHERE id = ?', [createdDealId]);
      assert.equal(deals[0].status, 'active');

      // Verify alert sent to both parties
      const betaReply = res.data.data.replies.find(r => r.to === betaPhone);
      assert.match(betaReply.text, /You accepted the terms/i);

      const alphaAlert = res.data.data.replies.find(r => r.to === alphaPhone);
      assert.ok(alphaAlert, 'Creator should be alerted of deal activation');
      assert.match(alphaAlert.text, /is now ACTIVE!/i);
    });
  });

  describe('5. Evidence & Photo Ingestion', () => {
    it('should ingest uploaded waybill photo and link to active deliverable', async () => {
      // 1. Upload photo as Alpha Supplies
      const uploadRes = await apiRequest('/api/v1/integrations/whatsapp/mock-incoming', {
        method: 'POST',
        body: {
          from: alphaPhone,
          type: 'image',
          media: {
            id: 'mock_waybill_media_id_77812',
            filename: 'signed_waybill_batch_1.jpg',
            caption: 'Truck 14 delivery signed consignment sheet'
          }
        }
      });

      assert.equal(uploadRes.status, 200);
      const choiceReply = uploadRes.data.data.replies.find(r => r.to === alphaPhone);
      assert.ok(choiceReply);
      assert.match(choiceReply.text, /Which active deliverable would you like to attach this photo to/i);
      assert.ok(choiceReply.buttons && choiceReply.buttons.length >= 1);

      const chosenBtn = choiceReply.buttons[0];

      // 2. User taps chosen deliverable button
      const attachRes = await apiRequest('/api/v1/integrations/whatsapp/mock-incoming', {
        method: 'POST',
        body: {
          from: alphaPhone,
          payload: chosenBtn.id
        }
      });

      assert.equal(attachRes.status, 200);
      assert.equal(attachRes.data.success, true);

      const confirmReply = attachRes.data.data.replies.find(r => r.to === alphaPhone);
      assert.match(confirmReply.text, /Evidence Certified on Ledger!/i);

      // Check evidence record in DB
      const [records] = await pool.query('SELECT * FROM evidence_records ORDER BY created_at DESC LIMIT 1');
      assert.ok(records.length > 0);
      assert.equal(records[0].verification_tier, 'submitted');
    });
  });

  describe('6. Payment Notice & 1-Click Confirmation', () => {
    it('should allow supplier to confirm receipt in 1-click via CONFIRM_PAYMENT button', async () => {
      // Seed a test payment in 'reported' status
      const [deals] = await pool.query("SELECT id, creator_business_id, counterparty_business_id FROM deals WHERE status = 'active' LIMIT 1");
      assert.ok(deals.length > 0);
      const deal = deals[0];

      const paymentId = crypto.randomUUID();
      const refNo = `PAY-${Math.floor(100000 + Math.random() * 900000)}`;
      const payerId = deal.counterparty_business_id || deal.creator_business_id;
      const recipientId = deal.creator_business_id;

      await pool.query(
        `INSERT INTO payment_records (id, deal_id, reference_no, expected_amount, reported_amount, currency, payer_business_id, recipient_business_id, status, created_at)
         VALUES (?, ?, ?, 2500000, 2500000, 'NGN', ?, ?, 'reported', NOW())`,
        [paymentId, deal.id, refNo, payerId, recipientId]
      );

      // Alpha confirms payment
      const res = await apiRequest('/api/v1/integrations/whatsapp/mock-incoming', {
        method: 'POST',
        body: {
          from: alphaPhone,
          payload: `CONFIRM_PAYMENT_${deal.id}_${paymentId}`
        }
      });

      assert.equal(res.status, 200);
      const reply = res.data.data.replies.find(r => r.to === alphaPhone);
      assert.match(reply.text, /confirmed! Escrow funds credited on ledger/i);

      // Verify payment status updated in MySQL
      const [updated] = await pool.query('SELECT status FROM payment_records WHERE id = ?', [paymentId]);
      assert.equal(updated[0].status, 'confirmed');
    });
  });

  describe('7. Standard Meta Webhook Ingestion (POST /webhook)', () => {
    it('should acknowledge Meta incoming webhook with HTTP 200 immediately', async () => {
      const metaPayload = {
        object: 'whatsapp_business_account',
        entry: [
          {
            id: 'mock_biz_id',
            changes: [
              {
                value: {
                  messaging_product: 'whatsapp',
                  contacts: [{ profile: { name: 'Ibrahim' }, wa_id: alphaPhone }],
                  messages: [
                    {
                      from: alphaPhone,
                      id: 'wamid.HBgLMjM0ODAxMTExMjIyMhUCMR...',
                      timestamp: String(Math.floor(Date.now() / 1000)),
                      type: 'text',
                      text: { body: 'STATUS' }
                    }
                  ]
                },
                field: 'messages'
              }
            ]
          }
        ]
      };

      const res = await apiRequest('/api/v1/integrations/whatsapp/webhook', {
        method: 'POST',
        body: metaPayload
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.status, 'ok');

      // Allow background message processing to complete before connection pool closes
      await new Promise(r => setTimeout(r, 100));
    });
  });
});
