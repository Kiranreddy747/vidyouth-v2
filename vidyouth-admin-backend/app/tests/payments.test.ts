import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, patch, makeSession } from './helpers.js';
import { query } from '../src/db/pg.js';

/** M5 — Payments & Wallet (PRD §9.3/§9.4, §7.6). access_payment_data. */

describe('payments RBAC gate', () => {
  test('no token → 401', async () => {
    assert.equal((await get('/admin/payments/transactions')).status, 401);
  });
  test('student → 403', async () => {
    const { token } = await makeSession('student');
    assert.equal((await get('/admin/payments/transactions', token)).status, 403);
  });
});

describe('wallet + transactions (superadmin)', () => {
  test('transactions list returns {total, transactions, gmvPaise}', async () => {
    const { token } = await makeSession('superadmin');
    const r = await get('/admin/payments/transactions?limit=5', token);
    assert.equal(r.status, 200);
    const b = r.json<{ total: number; transactions: unknown[]; gmvPaise: number }>();
    assert.equal(typeof b.total, 'number');
    assert.equal(typeof b.gmvPaise, 'number');
  });

  test('wallet adjust: credit then over-debit blocked (409)', async () => {
    const { token } = await makeSession('superadmin');
    const { userId } = await makeSession('student');

    const credit = await post(`/admin/wallets/${userId}/adjust`,
      { kind: 'credit', amountPaise: 50000, description: 'test top-up' }, token);
    assert.equal(credit.status, 200);
    assert.equal(credit.json<{ balance_paise: number }>().balance_paise, 50000);

    const over = await post(`/admin/wallets/${userId}/adjust`,
      { kind: 'debit', amountPaise: 999999, description: 'too much' }, token);
    assert.equal(over.status, 409);
    assert.equal(over.json<{ error: string }>().error, 'insufficient_balance');

    const w = await get(`/admin/wallets/${userId}`, token);
    assert.equal(w.status, 200);
    assert.ok(w.json<{ ledger: unknown[] }>().ledger.length >= 1);
  });

  test('refund a captured txn credits the wallet; double refund → 409', async () => {
    const { token } = await makeSession('superadmin');
    const { userId } = await makeSession('student');
    const txn = await query<{ id: string }>(
      `INSERT INTO payment_transactions (user_id, amount_paise, status)
       VALUES ($1, 12000, 'captured') RETURNING id`, [userId]);
    const txnId = txn.rows[0]!.id;

    const r = await post(`/admin/payments/transactions/${txnId}/refund`,
      { reason: 'customer request' }, token);
    assert.equal(r.status, 200);
    assert.equal(r.json<{ status: string }>().status, 'refunded');

    const w = await get(`/admin/wallets/${userId}`, token);
    assert.equal(w.json<{ balance_paise: number }>().balance_paise, 12000);

    const again = await post(`/admin/payments/transactions/${txnId}/refund`,
      { reason: 'again' }, token);
    assert.equal(again.status, 409);
  });

  test('payment config get + patch', async () => {
    const { token } = await makeSession('superadmin');
    const set = await patch('/admin/payments/config',
      { wallet_cap_paise: 5000000, razorpay_mode: 'test' }, token);
    assert.equal(set.status, 200);
    assert.equal(set.json<Record<string, string>>().razorpay_mode, 'test');
    assert.equal((await get('/admin/payments/config', token)).status, 200);
  });
});
