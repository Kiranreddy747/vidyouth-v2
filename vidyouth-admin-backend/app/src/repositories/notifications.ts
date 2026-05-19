/**
 * notification_templates repository — PRD §10.3. Per-type Email/SMS/Push
 * channels, {{variable}} substitution, preview. Self-ensured + seeded.
 */

import { query } from '../db/pg.js';

export class NotFoundError extends Error {
  constructor() { super('not_found'); this.name = 'NotFoundError'; }
}

/** Variables the WYSIWYG editor supports (PRD §10.3). */
export const SUPPORTED_VARS = [
  'user_name', 'topic_name', 'cert_id', 'cert_download_url',
  'session_date', 'amount', 'org_name',
] as const;

let ensured = false;
async function ensureSchema(): Promise<void> {
  if (ensured) return;
  await query(`CREATE TABLE IF NOT EXISTS notification_templates (
    key TEXT PRIMARY KEY, name TEXT NOT NULL,
    email_subject TEXT, email_html TEXT, email_enabled BOOLEAN NOT NULL DEFAULT TRUE,
    sms_body TEXT, sms_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    push_title TEXT, push_body TEXT, push_enabled BOOLEAN NOT NULL DEFAULT FALSE,
    updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(), updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW())`);
  await query(`INSERT INTO notification_templates (key, name, email_subject, email_html, sms_body) VALUES
    ('welcome','Welcome','Welcome to Vidyouth, {{user_name}}',
     '<p>Hi {{user_name}}, welcome to Vidyouth!</p>','Welcome to Vidyouth, {{user_name}}!'),
    ('cert_issued','Certificate Issued','Your {{topic_name}} certificate is ready',
     '<p>Congratulations {{user_name}}! Download: {{cert_download_url}}</p>',
     'Your {{topic_name}} certificate ({{cert_id}}) is ready.'),
    ('payment_receipt','Payment Receipt','Payment received: {{amount}}',
     '<p>We received {{amount}} from {{user_name}}.</p>','Vidyouth: payment of {{amount}} received.')
   ON CONFLICT (key) DO NOTHING`);
  ensured = true;
}

export async function listTemplates(): Promise<Record<string, unknown>[]> {
  await ensureSchema();
  return (await query(`SELECT * FROM notification_templates ORDER BY key`)).rows;
}

export async function getTemplate(key: string): Promise<Record<string, unknown> | null> {
  await ensureSchema();
  return (await query(
    `SELECT * FROM notification_templates WHERE key = $1`, [key])).rows[0] ?? null;
}

export interface TemplatePatch {
  name?: string | undefined;
  emailSubject?: string | undefined; emailHtml?: string | undefined;
  emailEnabled?: boolean | undefined;
  smsBody?: string | undefined; smsEnabled?: boolean | undefined;
  pushTitle?: string | undefined; pushBody?: string | undefined;
  pushEnabled?: boolean | undefined;
}

/** Upsert by key — creating a new notification type or editing one. */
export async function upsertTemplate(
  key: string, p: TemplatePatch, adminId: string,
): Promise<Record<string, unknown>> {
  await ensureSchema();
  await query(
    `INSERT INTO notification_templates (key, name) VALUES ($1, $2)
     ON CONFLICT (key) DO NOTHING`,
    [key, p.name ?? key]);
  const map: Record<string, unknown> = {
    name: p.name, email_subject: p.emailSubject, email_html: p.emailHtml,
    email_enabled: p.emailEnabled, sms_body: p.smsBody, sms_enabled: p.smsEnabled,
    push_title: p.pushTitle, push_body: p.pushBody, push_enabled: p.pushEnabled,
  };
  const sets: string[] = ['updated_by = $2']; const params: unknown[] = [key, adminId];
  for (const [c, v] of Object.entries(map)) {
    if (v === undefined) continue;
    params.push(v); sets.push(`${c} = $${params.length}`);
  }
  const r = await query(
    `UPDATE notification_templates SET ${sets.join(', ')}, updated_at = NOW()
     WHERE key = $1 RETURNING *`, params);
  if (!r.rows[0]) throw new NotFoundError();
  return r.rows[0];
}

function render(tpl: string | null, data: Record<string, string>): string {
  if (!tpl) return '';
  return tpl.replace(/\{\{\s*(\w+)\s*\}\}/g, (_m, name: string) =>
    Object.prototype.hasOwnProperty.call(data, name) ? data[name]! : `{{${name}}}`);
}

const SMS_LIMIT = 160;

export async function previewTemplate(
  key: string, sample: Record<string, string>,
): Promise<{
  email: { subject: string; html: string; enabled: boolean };
  sms: { body: string; length: number; overflow: boolean; enabled: boolean };
  push: { title: string; body: string; enabled: boolean };
}> {
  await ensureSchema();
  const t = await getTemplate(key);
  if (!t) throw new NotFoundError();
  const data: Record<string, string> = {};
  for (const v of SUPPORTED_VARS) data[v] = sample[v] ?? `<${v}>`;
  const sms = render(t.sms_body as string | null, data);
  return {
    email: {
      subject: render(t.email_subject as string | null, data),
      html: render(t.email_html as string | null, data),
      enabled: t.email_enabled as boolean,
    },
    sms: {
      body: sms, length: sms.length,
      overflow: sms.length > SMS_LIMIT, enabled: t.sms_enabled as boolean,
    },
    push: {
      title: render(t.push_title as string | null, data),
      body: render(t.push_body as string | null, data),
      enabled: t.push_enabled as boolean,
    },
  };
}
