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

export async function listFeatureFlags(): Promise<FeatureFlagRecord[]> {
  const result = await query<FeatureFlagRecord>(
    `SELECT ${COLUMNS} FROM feature_flags ORDER BY key`,
  );
  return result.rows;
}

export async function getFeatureFlag(key: string): Promise<FeatureFlagRecord | null> {
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
  const result = await query<FeatureFlagRecord>(
    `UPDATE feature_flags
     SET enabled = $2, updated_by = $3, updated_at = NOW()
     WHERE key = $1
     RETURNING ${COLUMNS}`,
    [key, enabled, updatedBy],
  );
  return result.rows[0] ?? null;
}
