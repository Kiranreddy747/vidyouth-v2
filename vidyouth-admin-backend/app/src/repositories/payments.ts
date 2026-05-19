/**
 * payments repository — PRD §9.3 Wallet, §9.4 Razorpay, §7.6 Payment
 * Management. Admin views transactions, issues refunds, manually adjusts
 * wallets, and configures wallet limits / Razorpay keys. Amounts in paise.
 */

import pg from 'pg';
import { pool, query } from '../db/pg.js';

export class NotFoundError extends Error {
  constructor() { super('not_found'); this.name = 'NotFoundError'; }
}
export class InvalidStateError extends Error {
  constructor(public reason: string) { super(reason); this.name = 'InvalidStateError'; }
}

let ensured = false;
async function ensureSchema(): Promise<void> {
  if (ensured) return;
  await query(`CREATE TABLE IF NOT EXISTS platform_settings (
    key TEXT PRIMARY KEY, value TEXT NOT NULL, description TEXT,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS wallets (
    user_id UUID PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
    balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
    bonus_paise BIGINT NOT NULL DEFAULT 0 CHECK (bonus_paise >= 0),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE TABLE IF NOT EXISTS wallet_ledger (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    kind TEXT NOT NULL CHECK (kind IN ('credit','debit','bonus','refund','adjustment')),
    amount_paise BIGINT NOT NULL, description TEXT,
    balance_after_paise BIGINT NOT NULL,
    created_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE INDEX IF NOT EXISTS wallet_ledger_user_idx ON wallet_ledger(user_id, created_at DESC)`);
  await query(`CREATE TABLE IF NOT EXISTS payment_transactions (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    user_id UUID REFERENCES users(id) ON DELETE SET NULL,
    amount_paise BIGINT NOT NULL CHECK (amount_paise >= 0),
    currency TEXT NOT NULL DEFAULT 'INR',
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending','captured','failed','refunded')),
    gateway TEXT NOT NULL DEFAULT 'razorpay', gateway_ref TEXT, description TEXT,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`CREATE INDEX IF NOT EXISTS payment_txn_status_idx ON payment_transactions(status, created_at DESC)`);
  await query(`CREATE INDEX IF NOT EXISTS payment_txn_user_idx ON payment_transactions(user_id, created_at DESC)`);
  ensured = true;
}

// ── Transactions ──
export async function listTransactions(f: {
  status?: string | undefined; userId?: string | undefined;
  limit: number; offset: number;
}): Promise<{ total: number; transactions: Record<string, unknown>[]; gmvPaise: number }> {
  await ensureSchema();
  const clauses: string[] = []; const params: unknown[] = [];
  if (f.status) { params.push(f.status); clauses.push(`status = $${params.length}`); }
  if (f.userId) { params.push(f.userId); clauses.push(`user_id = $${params.length}`); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const [rows, count, gmv] = await Promise.all([
    query(`SELECT * FROM payment_transactions ${where}
           ORDER BY created_at DESC LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, f.limit, f.offset]),
    query<{ n: string }>(`SELECT COUNT(*)::text AS n FROM payment_transactions ${where}`, params),
    query<{ s: string }>(
      `SELECT COALESCE(SUM(amount_paise),0)::text AS s FROM payment_transactions
       ${where ? where + ` AND` : `WHERE`} status = 'captured'`, params),
  ]);
  return {
    total: Number(count.rows[0]?.n ?? 0),
    transactions: rows.rows,
    gmvPaise: Number(gmv.rows[0]?.s ?? 0),
  };
}

export async function getTransaction(id: string): Promise<Record<string, unknown> | null> {
  await ensureSchema();
  const r = await query(`SELECT * FROM payment_transactions WHERE id = $1`, [id]);
  return r.rows[0] ?? null;
}

async function walletConfigCapPaise(): Promise<number | null> {
  const r = await query<{ value: string }>(
    `SELECT value FROM platform_settings WHERE key = 'wallet_cap_paise'`);
  const v = r.rows[0]?.value;
  return v ? Number(v) : null;
}

async function applyWalletDelta(
  client: pg.PoolClient, userId: string, kind: string,
  deltaPaise: number, description: string | null, adminId: string,
): Promise<{ balance_paise: number; bonus_paise: number }> {
  await client.query(
    `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`, [userId]);
  const cur = await client.query<{ balance_paise: string; bonus_paise: string }>(
    `SELECT balance_paise, bonus_paise FROM wallets WHERE user_id = $1 FOR UPDATE`, [userId]);
  let balance = Number(cur.rows[0]!.balance_paise);
  let bonus = Number(cur.rows[0]!.bonus_paise);
  if (kind === 'bonus') bonus += deltaPaise;
  else balance += deltaPaise;
  if (balance < 0 || bonus < 0) throw new InvalidStateError('insufficient_balance');
  const cap = await walletConfigCapPaise();
  if (cap !== null && balance + bonus > cap) throw new InvalidStateError('wallet_cap_exceeded');
  await client.query(
    `UPDATE wallets SET balance_paise = $2, bonus_paise = $3, updated_at = NOW()
     WHERE user_id = $1`, [userId, balance, bonus]);
  await client.query(
    `INSERT INTO wallet_ledger
       (user_id, kind, amount_paise, description, balance_after_paise, created_by)
     VALUES ($1,$2,$3,$4,$5,$6)`,
    [userId, kind, deltaPaise, description, balance + bonus, adminId]);
  return { balance_paise: balance, bonus_paise: bonus };
}

export async function adjustWallet(
  userId: string, kind: 'credit' | 'debit' | 'bonus' | 'adjustment',
  amountPaise: number, description: string, adminId: string,
): Promise<{ balance_paise: number; bonus_paise: number }> {
  await ensureSchema();
  const u = await query(`SELECT 1 FROM users WHERE id = $1 AND deleted_at IS NULL`, [userId]);
  if (!u.rows[0]) throw new NotFoundError();
  const delta = kind === 'debit' ? -Math.abs(amountPaise) : Math.abs(amountPaise);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const res = await applyWalletDelta(client, userId, kind, delta, description, adminId);
    await client.query('COMMIT');
    return res;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

export async function getWallet(userId: string): Promise<{
  balance_paise: number; bonus_paise: number; ledger: Record<string, unknown>[];
}> {
  await ensureSchema();
  await query(`INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT DO NOTHING`, [userId]);
  const w = await query<{ balance_paise: string; bonus_paise: string }>(
    `SELECT balance_paise, bonus_paise FROM wallets WHERE user_id = $1`, [userId]);
  const ledger = await query(
    `SELECT kind, amount_paise, description, balance_after_paise, created_at
     FROM wallet_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 20`, [userId]);
  return {
    balance_paise: Number(w.rows[0]?.balance_paise ?? 0),
    bonus_paise: Number(w.rows[0]?.bonus_paise ?? 0),
    ledger: ledger.rows,
  };
}

export async function refundTransaction(
  id: string, adminId: string, reason: string,
): Promise<Record<string, unknown>> {
  await ensureSchema();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const t = await client.query<{
      id: string; user_id: string | null; amount_paise: string; status: string;
    }>(`SELECT id, user_id, amount_paise, status FROM payment_transactions
        WHERE id = $1 FOR UPDATE`, [id]);
    const txn = t.rows[0];
    if (!txn) { throw new NotFoundError(); }
    if (txn.status !== 'captured') throw new InvalidStateError('not_refundable');
    await client.query(
      `UPDATE payment_transactions SET status = 'refunded', updated_at = NOW() WHERE id = $1`, [id]);
    if (txn.user_id) {
      await applyWalletDelta(client, txn.user_id, 'refund',
        Number(txn.amount_paise), `Refund: ${reason}`, adminId);
    }
    const updated = await client.query(
      `SELECT * FROM payment_transactions WHERE id = $1`, [id]);
    await client.query('COMMIT');
    return updated.rows[0]!;
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}

// ── Payment config (platform_settings) ──
const CONFIG_KEYS = [
  'wallet_min_topup_paise', 'wallet_max_topup_paise', 'wallet_cap_paise',
  'razorpay_key_id', 'razorpay_mode',
] as const;

export async function getPaymentConfig(): Promise<Record<string, string | null>> {
  await ensureSchema();
  const r = await query<{ key: string; value: string }>(
    `SELECT key, value FROM platform_settings WHERE key = ANY($1)`, [CONFIG_KEYS as unknown as string[]]);
  const out: Record<string, string | null> = {};
  for (const k of CONFIG_KEYS) out[k] = null;
  for (const row of r.rows) out[row.key] = row.value;
  return out;
}

export async function setPaymentConfig(
  patch: Record<string, string>, adminId: string,
): Promise<Record<string, string | null>> {
  await ensureSchema();
  for (const [k, v] of Object.entries(patch)) {
    if (!(CONFIG_KEYS as readonly string[]).includes(k)) continue;
    await query(
      `INSERT INTO platform_settings (key, value, updated_by, updated_at)
       VALUES ($1,$2,$3,NOW())
       ON CONFLICT (key) DO UPDATE
         SET value = EXCLUDED.value, updated_by = EXCLUDED.updated_by, updated_at = NOW()`,
      [k, String(v), adminId]);
  }
  return getPaymentConfig();
}
