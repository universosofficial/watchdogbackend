import { describe, it, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'crypto';
import { startTestServer, stopTestServer, apiRequest } from './testHelper.js';
import pool, { closePool } from '../src/config/db.js';
import telegramClient from '../src/integrations/telegram/services/telegramClient.js';
import telegramSession from '../src/integrations/telegram/models/telegramSession.js';

describe('Telegram Business Bot Integration Tests', () => {
  const alphaChatId = '11112222';
  const betaChatId = '33334444';

  before(async () => {
    await startTestServer();
  });

  after(async () => {
    await stopTestServer();
    await closePool();
  });

  beforeEach(() => {
    telegramClient.clearMockHistory();
  });

  describe('1. Identity Linker & Onboarding', () => {
    it('should prompt an unlinked Telegram chat to link or register', async () => {
      const res = await apiRequest('/api/v1/integrations/telegram/mock-incoming', {
        method: 'POST',
        body: {
          chatId: '99998888',
          text: 'Hello, bot'
        }
      });

      assert.equal(res.status, 200);
      assert.ok(res.data.data.replies.length >= 1);
      const reply = res.data.data.replies[0];
      assert.match(reply.text, /Welcome to Digital Watchdog Assistant/i);
      assert.match(reply.text, /LINK: your-email/i);
    });

    it('should allow user to link account via LINK: email command', async () => {
      const newChatId = '55556666';
      const res = await apiRequest('/api/v1/integrations/telegram/mock-incoming', {
        method: 'POST',
        body: {
          chatId: newChatId,
          text: 'LINK: owner@alphasupplies.ng'
        }
      });

      assert.equal(res.status, 200);
      const reply = res.data.data.replies[0];
      assert.match(reply.text, /Account Linked Successfully!/i);
      assert.match(reply.text, /Alpha Supplies/i);
    });
  });

  describe('2. Status & Navigation Commands', () => {
    it('should return command menu and inline buttons on /start or /help', async () => {
      const res = await apiRequest('/api/v1/integrations/telegram/mock-incoming', {
        method: 'POST',
        body: {
          chatId: alphaChatId,
          text: '/help'
        }
      });

      assert.equal(res.status, 200);
      const reply = res.data.data.replies[0];
      assert.match(reply.text, /Digital Watchdog Telegram Assistant/i);
      assert.ok(reply.reply_markup && reply.reply_markup.inline_keyboard.length >= 2);
    });

    it('should return active contracts on /deals or STATUS', async () => {
      const res = await apiRequest('/api/v1/integrations/telegram/mock-incoming', {
        method: 'POST',
        body: {
          chatId: alphaChatId,
          text: 'STATUS'
        }
      });

      assert.equal(res.status, 200);
      const reply = res.data.data.replies[0];
      assert.match(reply.text, /Active Transactions/i);
    });
  });

  describe('3. Deal Creation & Two-Party Acceptance Flow', () => {
    let dealId = null;
    let versionId = null;

    it('Step 1: /deal create prompts for deal details and sets state', async () => {
      const res = await apiRequest('/api/v1/integrations/telegram/mock-incoming', {
        method: 'POST',
        body: {
          chatId: alphaChatId,
          text: '/deal create'
        }
      });

      assert.equal(res.status, 200);
      const reply = res.data.data.replies[0];
      assert.match(reply.text, /Initiate New Escrow Contract/i);
      assert.match(reply.text, /\[Title\], \[Partner Email or Phone\]/i);
    });

    it('Step 2: Submitting details creates contract and sends inline button invite to partner', async () => {
      const uniqueTitle = `Structural Steel Beams ${Date.now()}`;
      const res = await apiRequest('/api/v1/integrations/telegram/mock-incoming', {
        method: 'POST',
        body: {
          chatId: alphaChatId,
          text: `${uniqueTitle}, procurement@betabuilders.ng, 8200000 NGN`
        }
      });

      assert.equal(res.status, 200);

      // Verify creator confirmation
      const creatorMsg = res.data.data.replies.find(r => r.chatId === alphaChatId);
      assert.ok(creatorMsg);
      assert.match(creatorMsg.text, /Created!/i);

      // Verify partner received invite with [Accept Terms] inline button
      const partnerMsg = res.data.data.replies.find(r => r.chatId === betaChatId);
      assert.ok(partnerMsg, 'Partner should receive inline invite');
      assert.match(partnerMsg.text, /New Escrow Contract Invitation/i);

      const acceptBtn = partnerMsg.reply_markup?.inline_keyboard[0][0];
      assert.ok(acceptBtn);
      assert.match(acceptBtn.callback_data, /^ACCEPT_DEAL_/);

      const parts = acceptBtn.callback_data.split('_');
      dealId = parts[2];
      versionId = parts[3];

      // Check DB deal record
      const [deals] = await pool.query('SELECT * FROM deals WHERE id = ?', [dealId]);
      assert.equal(deals.length, 1);
      assert.equal(deals[0].status, 'awaiting_acceptance');
    });

    it('Step 3: Partner clicks [Accept Terms] inline button -> Deal transitions to ACTIVE', async () => {
      assert.ok(dealId);

      const res = await apiRequest('/api/v1/integrations/telegram/mock-incoming', {
        method: 'POST',
        body: {
          chatId: betaChatId,
          callback_data: `ACCEPT_DEAL_${dealId}_${versionId}`
        }
      });

      assert.equal(res.status, 200);

      // Verify deal status in DB is now active
      const [deals] = await pool.query('SELECT status FROM deals WHERE id = ?', [dealId]);
      assert.equal(deals[0].status, 'active');

      const partnerMsg = res.data.data.replies.find(r => r.chatId === betaChatId);
      assert.match(partnerMsg.text, /You accepted terms/i);
    });
  });

  describe('4. Photo Ingestion & Payment Confirmation', () => {
    it('should ingest uploaded photo and attach to active milestone', async () => {
      // 1. Upload photo
      const res = await apiRequest('/api/v1/integrations/telegram/mock-incoming', {
        method: 'POST',
        body: {
          chatId: alphaChatId,
          photo: { file_id: 'mock_tg_photo_10928' },
          caption: 'Signed dispatch waybill'
        }
      });

      assert.equal(res.status, 200);
      const choiceReply = res.data.data.replies.find(r => r.chatId === alphaChatId);
      assert.ok(choiceReply);
      assert.match(choiceReply.text, /Waybill \/ Evidence Received/i);
      assert.ok(choiceReply.reply_markup?.inline_keyboard?.length >= 1);

      const chosenCallback = choiceReply.reply_markup.inline_keyboard[0][0].callback_data;

      // 2. Select deliverable
      const attachRes = await apiRequest('/api/v1/integrations/telegram/mock-incoming', {
        method: 'POST',
        body: {
          chatId: alphaChatId,
          callback_data: chosenCallback
        }
      });

      assert.equal(attachRes.status, 200);
      const confirmReply = attachRes.data.data.replies.find(r => r.chatId === alphaChatId);
      assert.match(confirmReply.text, /Proof Certified on Ledger!/i);
    });

    it('should allow supplier to confirm payment receipt in 1-click via inline callback', async () => {
      const [deals] = await pool.query("SELECT id, creator_business_id, counterparty_business_id FROM deals WHERE status = 'active' LIMIT 1");
      const deal = deals[0];
      const pmtId = crypto.randomUUID();

      await pool.query(
        `INSERT INTO payment_records (id, deal_id, reference_no, expected_amount, reported_amount, currency, payer_business_id, recipient_business_id, status, created_at)
         VALUES (?, ?, 'PAY-TG-1234', 1800000, 1800000, 'NGN', ?, ?, 'reported', NOW())`,
        [pmtId, deal.id, deal.counterparty_business_id, deal.creator_business_id]
      );

      const res = await apiRequest('/api/v1/integrations/telegram/mock-incoming', {
        method: 'POST',
        body: {
          chatId: alphaChatId,
          callback_data: `CONFIRM_PAYMENT_${deal.id}_${pmtId}`
        }
      });

      assert.equal(res.status, 200);
      const reply = res.data.data.replies.find(r => r.chatId === alphaChatId);
      assert.match(reply.text, /Payment receipt confirmed!/i);

      const [updated] = await pool.query('SELECT status FROM payment_records WHERE id = ?', [pmtId]);
      assert.equal(updated[0].status, 'confirmed');
    });
  });
});
