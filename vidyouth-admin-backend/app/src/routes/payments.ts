/**
 * Payments & Wallet Management (PRD §9.3/§9.4, §7.6 Payment Management).
 * View transactions + GMV, issue refunds, manually adjust wallets, view
 * the ledger, configure wallet limits / Razorpay keys.
 * Gated app.auth → requireAdminPanel → requirePermission('access_payment_data').
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { requireAdminPanel, requirePermission } from '../middleware/rbac.js';
import { recordAudit } from '../services/audit.js';
import * as pay from '../repositories/payments.js';

const idParam = z.object({ id: z.string().uuid() });
const userParam = z.object({ userId: z.string().uuid() });

export async function paymentRoutes(app: FastifyInstance): Promise<void> {
  const gate = {
    preHandler: [app.auth, requireAdminPanel, requirePermission('access_payment_data')],
  };
  const guard = async (reply: import('fastify').FastifyReply, fn: () => Promise<unknown>) => {
    try { return await fn(); }
    catch (e) {
      const n = (e as Error).name;
      if (n === 'NotFoundError') { reply.code(404).send({ error: 'not_found' }); return null; }
      if (n === 'InvalidStateError') {
        reply.code(409).send({ error: (e as Error).message }); return null;
      }
      throw e;
    }
  };

  app.get('/admin/payments/transactions', gate, async (req, reply) => {
    const q = z.object({
      status: z.enum(['pending', 'captured', 'failed', 'refunded']).optional(),
      userId: z.string().uuid().optional(),
      limit: z.coerce.number().int().min(1).max(200).default(50),
      offset: z.coerce.number().int().min(0).default(0),
    }).safeParse(req.query);
    if (!q.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    reply.send(await pay.listTransactions(q.data));
  });

  app.get('/admin/payments/transactions/:id', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const txn = await pay.getTransaction(p.data.id);
    if (!txn) { reply.code(404).send({ error: 'not_found' }); return; }
    reply.send(txn);
  });

  app.post('/admin/payments/transactions/:id/refund', gate, async (req, reply) => {
    const p = idParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({ reason: z.string().min(3).max(300) }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'reason_required' }); return; }
    const u = req.user!;
    const row = await guard(reply, () => pay.refundTransaction(p.data.id, u.sub, b.data.reason));
    if (row) {
      await recordAudit({
        userId: u.sub, action: 'payment.refunded',
        ip: req.ip, userAgent: req.headers['user-agent'],
        meta: { transactionId: p.data.id, reason: b.data.reason }, succeeded: true,
      });
      reply.send(row);
    }
  });

  app.get('/admin/wallets/:userId', gate, async (req, reply) => {
    const p = userParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    reply.send(await pay.getWallet(p.data.userId));
  });

  app.post('/admin/wallets/:userId/adjust', gate, async (req, reply) => {
    const p = userParam.safeParse(req.params);
    if (!p.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const b = z.object({
      kind: z.enum(['credit', 'debit', 'bonus', 'adjustment']),
      amountPaise: z.coerce.number().int().positive(),
      description: z.string().min(1).max(300),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const u = req.user!;
    const row = await guard(reply, () =>
      pay.adjustWallet(p.data.userId, b.data.kind, b.data.amountPaise, b.data.description, u.sub));
    if (row) {
      await recordAudit({
        userId: u.sub, action: 'wallet.adjusted',
        ip: req.ip, userAgent: req.headers['user-agent'],
        meta: { target: p.data.userId, kind: b.data.kind, amountPaise: b.data.amountPaise },
        succeeded: true,
      });
      reply.send(row);
    }
  });

  app.get('/admin/payments/config', gate, async (_q, reply) =>
    reply.send(await pay.getPaymentConfig()));

  app.patch('/admin/payments/config', gate, async (req, reply) => {
    const b = z.object({
      wallet_min_topup_paise: z.coerce.number().int().min(0).optional(),
      wallet_max_topup_paise: z.coerce.number().int().min(0).optional(),
      wallet_cap_paise: z.coerce.number().int().min(0).optional(),
      razorpay_key_id: z.string().max(120).optional(),
      razorpay_mode: z.enum(['test', 'live']).optional(),
    }).safeParse(req.body);
    if (!b.success) { reply.code(400).send({ error: 'invalid_request' }); return; }
    const patch: Record<string, string> = {};
    for (const [k, v] of Object.entries(b.data)) if (v !== undefined) patch[k] = String(v);
    const u = req.user!;
    const cfg = await pay.setPaymentConfig(patch, u.sub);
    await recordAudit({
      userId: u.sub, action: 'payment.config.changed',
      ip: req.ip, userAgent: req.headers['user-agent'],
      meta: { keys: Object.keys(patch) }, succeeded: true,
    });
    reply.send(cfg);
  });
}
