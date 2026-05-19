/**
 * User repository.
 *
 * Keeps user SQL out of route handlers while preserving the current raw-query
 * approach. Signup, OAuth linking, and email verification will grow here
 * before routes need to know about the underlying schema details.
 */

import { query } from '../db/pg.js';

export type UserRole = 'student' | 'admin' | 'vendor' | 'organisation' | 'superadmin';

export interface UserRecord {
  id: string;
  organisation_id: string | null;
  role: UserRole;
  email: string | null;
  mobile: string | null;
  phone_number: string | null;
  email_verified_at: Date | null;
  mobile_verified_at: Date | null;
  phone_verified_at: Date | null;
  password_hash: string | null;
  display_name: string | null;
  is_active: boolean;
  created_at: Date;
  updated_at: Date;
  deleted_at: Date | null;
}

export interface CreateUserInput {
  organisationId?: string | null;
  role?: UserRole;
  email?: string | null;
  mobile?: string | null;
  passwordHash?: string | null;
  displayName?: string | null;
}

const userColumns = `
  id,
  organisation_id,
  role,
  email,
  mobile,
  phone_number,
  email_verified_at,
  mobile_verified_at,
  phone_verified_at,
  password_hash,
  display_name,
  is_active,
  created_at,
  updated_at,
  deleted_at
`;

export async function findUserByEmailOrMobile(identifier: string): Promise<UserRecord | null> {
  const result = await query<UserRecord>(
    `SELECT ${userColumns}
     FROM users
     WHERE (lower(email) = lower($1) OR mobile = $1 OR phone_number = $1)
       AND deleted_at IS NULL
     LIMIT 1`,
    [identifier],
  );
  return result.rows[0] ?? null;
}

export async function findUserByEmailIncludingDeleted(email: string): Promise<UserRecord | null> {
  const result = await query<UserRecord>(
    `SELECT ${userColumns}
     FROM users
     WHERE lower(email) = lower($1)
     LIMIT 1`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findActiveUserByEmail(email: string): Promise<UserRecord | null> {
  const result = await query<UserRecord>(
    `SELECT ${userColumns}
     FROM users
     WHERE lower(email) = lower($1) AND deleted_at IS NULL
     LIMIT 1`,
    [email],
  );
  return result.rows[0] ?? null;
}

export async function findUserByMobileIncludingDeleted(mobile: string): Promise<UserRecord | null> {
  const result = await query<UserRecord>(
    `SELECT ${userColumns}
     FROM users
     WHERE mobile = $1 OR phone_number = $1
     LIMIT 1`,
    [mobile],
  );
  return result.rows[0] ?? null;
}

export async function findUserByPhone(phoneNumber: string): Promise<UserRecord | null> {
  const result = await query<UserRecord>(
    `SELECT ${userColumns}
     FROM users
     WHERE (phone_number = $1 OR mobile = $1) AND deleted_at IS NULL
     LIMIT 1`,
    [phoneNumber],
  );
  return result.rows[0] ?? null;
}

export async function findUserById(userId: string): Promise<UserRecord | null> {
  const result = await query<UserRecord>(
    `SELECT ${userColumns}
     FROM users
     WHERE id = $1 AND deleted_at IS NULL
     LIMIT 1`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function createUser(input: CreateUserInput): Promise<UserRecord> {
  // TODO(signup): validate ownership/uniqueness at the service layer and add
  // email/mobile verification issuance as part of the onboarding transaction.
  const result = await query<UserRecord>(
    `INSERT INTO users
       (organisation_id, role, email, mobile, password_hash, display_name)
     VALUES ($1, $2, $3, $4, $5, $6)
     RETURNING ${userColumns}`,
    [
      input.organisationId ?? null,
      input.role ?? 'student',
      input.email ?? null,
      input.mobile ?? null,
      input.passwordHash ?? null,
      input.displayName ?? null,
    ],
  );
  return result.rows[0] as UserRecord;
}

export interface CreatePhoneUserInput {
  phoneNumber: string;
  passwordHash?: string | null;
  displayName?: string | null;
}

export async function createPhoneUser(input: CreatePhoneUserInput): Promise<UserRecord> {
  const result = await query<UserRecord>(
    `INSERT INTO users
       (role, mobile, phone_number, mobile_verified_at, phone_verified_at, password_hash, display_name)
     VALUES ('student', $1, $1, NOW(), NOW(), $2, $3)
     RETURNING ${userColumns}`,
    [
      input.phoneNumber,
      input.passwordHash ?? null,
      input.displayName ?? `Student ${input.phoneNumber.slice(-4)}`,
    ],
  );
  return result.rows[0] as UserRecord;
}

export async function updateLastLogin(_userId: string): Promise<void> {
  // TODO(schema): add users.last_login_at or user_security_events before this
  // becomes observable state. Keeping this as a repository boundary lets
  // signup/OAuth call the same hook later without route churn.
}

export async function markEmailVerified(userId: string): Promise<UserRecord | null> {
  const result = await query<UserRecord>(
    `UPDATE users
     SET email_verified_at = COALESCE(email_verified_at, NOW()),
         updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL
     RETURNING ${userColumns}`,
    [userId],
  );
  return result.rows[0] ?? null;
}

export async function markPhoneVerified(
  userId: string,
  phoneNumber: string,
): Promise<UserRecord | null> {
  const result = await query<UserRecord>(
    `UPDATE users
     SET mobile = COALESCE(mobile, $2),
         phone_number = COALESCE(phone_number, $2),
         mobile_verified_at = COALESCE(mobile_verified_at, NOW()),
         phone_verified_at = COALESCE(phone_verified_at, NOW()),
         updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL AND is_active = TRUE
     RETURNING ${userColumns}`,
    [userId, phoneNumber],
  );
  return result.rows[0] ?? null;
}

export async function updateUserPassword(
  userId: string,
  passwordHash: string,
): Promise<UserRecord | null> {
  const result = await query<UserRecord>(
    `UPDATE users
     SET password_hash = $2,
         updated_at = NOW()
     WHERE id = $1 AND deleted_at IS NULL AND is_active = TRUE
     RETURNING ${userColumns}`,
    [userId, passwordHash],
  );
  return result.rows[0] ?? null;
}
