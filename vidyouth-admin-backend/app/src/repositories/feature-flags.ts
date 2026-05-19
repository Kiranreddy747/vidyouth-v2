/**
 * feature_flags repository. This service OWNS the feature_flags table
 * (see database/migrations/001_feature_flags.sql). Backs PRD §10.2.
 */

import { query } from '../db/pg.js';

export interface FeatureFlagRecord {
  key: string;
  enabled: boolean;
  label: string;
  description: string | null;
  updated_by: string | null;
  created_at: Date;
  updated_at: Date;
}

const COLUMNS = `key, enabled, label, description, updated_by, created_at, updated_at`;

let ensured = false;

async function ensureFeatureFlagsTable(): Promise<void> {
  if (ensured) return;
  await query(`
    CREATE TABLE IF NOT EXISTS feature_flags (
      key          TEXT PRIMARY KEY,
      enabled      BOOLEAN NOT NULL DEFAULT TRUE,
      label        TEXT NOT NULL,
      description  TEXT,
      updated_by   UUID REFERENCES users(id) ON DELETE SET NULL,
      created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )
  `);
  await query(`
    INSERT INTO feature_flags (key, enabled, label, description) VALUES
      ('wallet_module',          TRUE,  'Wallet Module',                 'When OFF, wallet UI hidden and wallet payment option removed'),
      ('pay_per_watch',          TRUE,  'Pay-Per-Watch',                 'When OFF, all content defaults to subscription / one-time pricing'),
      ('placement_support',      TRUE,  'Placement Support',             'When OFF, placement request UI hidden'),
      ('social_auto_publishing', TRUE,  'Social Auto-Publishing',        'When OFF, news posts are in-app only'),
      ('org_self_registration',  TRUE,  'Organisation Self-Registration','When OFF, orgs are only created by Admin'),
      ('job_portal',             TRUE,  'Job Portal',                    'When OFF, hidden from all dashboards'),
      ('resume_builder',         TRUE,  'Resume Builder',                'When OFF, hidden from profiles'),
      ('lms_module',             TRUE,  'LMS Module',                    'When OFF, LMS section hidden; existing enrolments still accessible'),
      ('content_live',           TRUE,  'Live Content',                  'Hide live content type platform-wide'),
      ('content_recorded',       TRUE,  'Recorded Content',              'Hide recorded content type platform-wide'),
      ('content_offline',        TRUE,  'Offline Content',               'Hide offline content type platform-wide')
    ON CONFLICT (key) DO NOTHING
  `);
  await query('CREATE INDEX IF NOT EXISTS feature_flags_enabled_idx ON feature_flags(enabled)');
  ensured = true;
}

export async function listFeatureFlags(): Promise<FeatureFlagRecord[]> {
  await ensureFeatureFlagsTable();
  const result = await query<FeatureFlagRecord>(
    `SELECT ${COLUMNS} FROM feature_flags ORDER BY key`,
  );
  return result.rows;
}

export async function getFeatureFlag(key: string): Promise<FeatureFlagRecord | null> {
  await ensureFeatureFlagsTable();
  const result = await query<FeatureFlagRecord>(
    `SELECT ${COLUMNS} FROM feature_flags WHERE key = $1 LIMIT 1`,
    [key],
  );
  return result.rows[0] ?? null;
}

export async function setFeatureFlag(
  key: string,
  enabled: boolean,
  updatedBy: string,
): Promise<FeatureFlagRecord | null> {
  await ensureFeatureFlagsTable();
  const result = await query<FeatureFlagRecord>(
    `UPDATE feature_flags
     SET enabled = $2, updated_by = $3, updated_at = NOW()
     WHERE key = $1
     RETURNING ${COLUMNS}`,
    [key, enabled, updatedBy],
  );
  return result.rows[0] ?? null;
}
