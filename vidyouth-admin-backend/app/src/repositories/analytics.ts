/**
 * analytics repository — PRD §17.3 Admin Analytics + §10.1 Dashboard
 * Widgets. Read-only aggregation over data owned by M1–M9. Every query
 * is defensive (a module's table may not exist yet on a fresh DB), so
 * analytics never 500s — it degrades to zeros, mirroring the foundation
 * dashboard's .catch() pattern.
 */

import { query } from '../db/pg.js';

async function scalar(sql: string, params: unknown[] = []): Promise<number> {
  try {
    const r = await query<{ v: string }>(sql, params);
    return Number(r.rows[0]?.v ?? 0);
  } catch {
    return 0;
  }
}
async function rows(sql: string, params: unknown[] = []): Promise<Record<string, unknown>[]> {
  try {
    return (await query(sql, params)).rows;
  } catch {
    return [];
  }
}

// ── §10.1 Dashboard widgets (full set, from available data) ──
export async function dashboardWidgets(): Promise<Record<string, unknown>> {
  const [
    totalUsers, newUsers24h, activeSessions24h, pendingOrgs,
    gmvToday, gmvWeek, gmvMonth, failedPay24h, certs24h, openJobs,
  ] = await Promise.all([
    scalar(`SELECT COUNT(*)::text v FROM users WHERE deleted_at IS NULL`),
    scalar(`SELECT COUNT(*)::text v FROM users WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '24 hours'`),
    scalar(`SELECT COUNT(*)::text v FROM sessions WHERE revoked_at IS NULL AND created_at >= NOW() - INTERVAL '24 hours'`),
    scalar(`SELECT COUNT(*)::text v FROM organisations WHERE status = 'PENDING'`),
    scalar(`SELECT COALESCE(SUM(amount_paise),0)::text v FROM payment_transactions WHERE status='captured' AND created_at >= date_trunc('day', NOW())`),
    scalar(`SELECT COALESCE(SUM(amount_paise),0)::text v FROM payment_transactions WHERE status='captured' AND created_at >= NOW() - INTERVAL '7 days'`),
    scalar(`SELECT COALESCE(SUM(amount_paise),0)::text v FROM payment_transactions WHERE status='captured' AND created_at >= NOW() - INTERVAL '30 days'`),
    scalar(`SELECT COUNT(*)::text v FROM payment_transactions WHERE status='failed' AND created_at >= NOW() - INTERVAL '24 hours'`),
    scalar(`SELECT COUNT(*)::text v FROM certificates WHERE issued_at >= NOW() - INTERVAL '24 hours'`),
    scalar(`SELECT COUNT(*)::text v FROM jobs WHERE status='open'`),
  ]);
  const byRole = await rows(
    `SELECT role, COUNT(*)::text n FROM users WHERE deleted_at IS NULL GROUP BY role`);
  const usersByRole: Record<string, number> = {};
  for (const r of byRole) usersByRole[r.role as string] = Number(r.n);
  return {
    generatedAt: new Date().toISOString(),
    totalRegisteredUsers: totalUsers,
    usersByRole,
    newUsersLast24h: newUsers24h,
    activeSessionsLast24h: activeSessions24h,
    pendingOrgApprovals: pendingOrgs,
    gmvTodayPaise: gmvToday,
    gmvLast7dPaise: gmvWeek,
    gmvLast30dPaise: gmvMonth,
    failedPaymentsLast24h: failedPay24h,
    certificatesIssuedLast24h: certs24h,
    openJobs,
  };
}

// ── §17.3 Revenue Dashboard ──
export async function revenue(): Promise<Record<string, unknown>> {
  const [today, week, month, byStatus, byDay] = await Promise.all([
    scalar(`SELECT COALESCE(SUM(amount_paise),0)::text v FROM payment_transactions WHERE status='captured' AND created_at >= date_trunc('day', NOW())`),
    scalar(`SELECT COALESCE(SUM(amount_paise),0)::text v FROM payment_transactions WHERE status='captured' AND created_at >= NOW() - INTERVAL '7 days'`),
    scalar(`SELECT COALESCE(SUM(amount_paise),0)::text v FROM payment_transactions WHERE status='captured' AND created_at >= NOW() - INTERVAL '30 days'`),
    rows(`SELECT status, COUNT(*)::text count, COALESCE(SUM(amount_paise),0)::text paise
          FROM payment_transactions GROUP BY status`),
    rows(`SELECT date_trunc('day', created_at)::date::text day,
                 COALESCE(SUM(amount_paise),0)::text paise
          FROM payment_transactions WHERE status='captured'
            AND created_at >= NOW() - INTERVAL '30 days'
          GROUP BY 1 ORDER BY 1`),
  ]);
  return { gmvTodayPaise: today, gmvLast7dPaise: week, gmvLast30dPaise: month, byStatus, dailyLast30d: byDay };
}

// ── §17.3 User Growth ──
export async function userGrowth(): Promise<Record<string, unknown>> {
  const [total, b2c, org, byDay] = await Promise.all([
    scalar(`SELECT COUNT(*)::text v FROM users WHERE deleted_at IS NULL`),
    scalar(`SELECT COUNT(*)::text v FROM users WHERE deleted_at IS NULL AND organisation_id IS NULL`),
    scalar(`SELECT COUNT(*)::text v FROM users WHERE deleted_at IS NULL AND organisation_id IS NOT NULL`),
    rows(`SELECT date_trunc('day', created_at)::date::text day, COUNT(*)::text n
          FROM users WHERE deleted_at IS NULL AND created_at >= NOW() - INTERVAL '30 days'
          GROUP BY 1 ORDER BY 1`),
  ]);
  const active = await scalar(
    `SELECT COUNT(*)::text v FROM users WHERE deleted_at IS NULL AND is_active = TRUE`);
  return {
    totalUsers: total, b2cUsers: b2c, orgUsers: org,
    activationRatePct: total ? Math.round((active / total) * 100) : 0,
    newByDayLast30d: byDay,
  };
}

// ── §17.3 Certificate Issuance ──
export async function certificates(): Promise<Record<string, unknown>> {
  const [total, active, revoked, byDay, byTopic] = await Promise.all([
    scalar(`SELECT COUNT(*)::text v FROM certificates`),
    scalar(`SELECT COUNT(*)::text v FROM certificates WHERE status='active'`),
    scalar(`SELECT COUNT(*)::text v FROM certificates WHERE status='revoked'`),
    rows(`SELECT date_trunc('day', issued_at)::date::text day, COUNT(*)::text n
          FROM certificates WHERE issued_at >= NOW() - INTERVAL '30 days'
          GROUP BY 1 ORDER BY 1`),
    rows(`SELECT course_name, COUNT(*)::text n FROM certificates
          GROUP BY course_name ORDER BY n DESC LIMIT 10`),
  ]);
  return { total, active, revoked, issuedByDayLast30d: byDay, topCourses: byTopic };
}

// ── §17.3 Wallet Analytics ──
export async function wallet(): Promise<Record<string, unknown>> {
  const [balance, bonus, ledgerByKind] = await Promise.all([
    scalar(`SELECT COALESCE(SUM(balance_paise),0)::text v FROM wallets`),
    scalar(`SELECT COALESCE(SUM(bonus_paise),0)::text v FROM wallets`),
    rows(`SELECT kind, COUNT(*)::text count, COALESCE(SUM(amount_paise),0)::text paise
          FROM wallet_ledger GROUP BY kind`),
  ]);
  return { totalBalancePaise: balance, totalBonusPaise: bonus, ledgerByKind };
}

// ── §17.3 Content + Vendor (from available data) ──
export async function content(): Promise<Record<string, unknown>> {
  const [sectors, topics, activeTopics, avgPrice] = await Promise.all([
    scalar(`SELECT COUNT(*)::text v FROM content_sectors`),
    scalar(`SELECT COUNT(*)::text v FROM content_topics`),
    scalar(`SELECT COUNT(*)::text v FROM content_topics WHERE is_active = TRUE`),
    scalar(`SELECT COALESCE(ROUND(AVG(price_inr)),0)::text v FROM content_topics WHERE price_inr > 0`),
  ]);
  return { sectors, topics, activeTopics, avgTopicPriceInr: avgPrice };
}

export async function vendors(): Promise<Record<string, unknown>> {
  const [total, active, batches, byStatus] = await Promise.all([
    scalar(`SELECT COUNT(*)::text v FROM vendors`),
    scalar(`SELECT COUNT(*)::text v FROM vendors WHERE is_active = TRUE`),
    scalar(`SELECT COUNT(*)::text v FROM offline_batches`),
    rows(`SELECT status, COUNT(*)::text n FROM offline_batches GROUP BY status`),
  ]);
  return { totalVendors: total, activeVendors: active, totalBatches: batches, batchesByStatus: byStatus };
}
