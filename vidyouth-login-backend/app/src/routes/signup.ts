/**
 * /auth/signup — email or mobile + password signup.
 *
 * Matches the body the web frontend posts:
 *   { displayName, password, channel: 'email' | 'mobile', email?, mobile? }
 *
 * Email path delegates to services/auth-service.signupWithEmailPassword.
 * Mobile path runs the same orchestration (uniqueness check → hash →
 * createUser → authenticated session) but keyed on the normalized phone
 * number instead of an email address.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  signupWithEmailPassword,
  SignupUnavailableError,
  createAuthenticatedSession,
} from '../services/auth-service.js';
import {
  createUser,
  findUserByEmailIncludingDeleted,
  findUserByMobileIncludingDeleted,
} from '../repositories/users.js';
import { hashPassword, validatePasswordStrength } from '../services/passwords.js';
import { normalizePhoneNumber, InvalidPhoneNumberError } from '../services/phone-auth.js';
import { recordAudit } from '../services/audit.js';

const signupBody = z
  .object({
    displayName: z.string().trim().min(2).max(80).optional(),
    display_name: z.string().trim().min(2).max(80).optional(),
    password: z.string().min(8).max(128),
    channel: z.enum(['email', 'mobile']).optional(),
    email: z.string().email().max(254).optional(),
    mobile: z.string().min(3).max(32).optional(),
  })
  .refine((b) => !!(b.displayName ?? b.display_name), {
    message: 'display_name_required',
  })
  .refine((b) => ((b.channel ?? 'email') === 'email' ? !!b.email : !!b.mobile), {
    message: 'identifier_required_for_channel',
  });

export async function signupRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/signup', async (req, reply) => {
    const parsed = signupBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    const displayName = (parsed.data.displayName ?? parsed.data.display_name) as string;
    const { password } = parsed.data;
    const channel = parsed.data.channel ?? 'email';

    const strength = validatePasswordStrength(password);
    if (!strength.valid) {
      reply.code(400).send({ error: 'weak_password', issues: strength.issues });
      return;
    }

    try {
      if (channel === 'email') {
        const result = await signupWithEmailPassword({
          email: parsed.data.email as string,
          password,
          displayName,
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          logger: req.log,
        });
        reply.send({
          access_token: result.access_token,
          refresh_token: result.refresh_token,
          token_type: result.token_type,
          expires_in: result.expires_in,
        });
        return;
      }

      // channel === 'mobile'
      let mobile: string;
      try {
        mobile = normalizePhoneNumber(parsed.data.mobile as string);
      } catch (err) {
        if (err instanceof InvalidPhoneNumberError) {
          reply.code(400).send({ error: 'invalid_phone_number' });
          return;
        }
        throw err;
      }

      const existingMobile = await findUserByMobileIncludingDeleted(mobile);
      if (existingMobile) {
        await recordAudit({
          userId: existingMobile.deleted_at ? undefined : existingMobile.id,
          action: 'account.created',
          ip: req.ip,
          userAgent: req.headers['user-agent'],
          meta: {
            provider: 'password',
            reason: existingMobile.deleted_at ? 'deleted_mobile_exists' : 'mobile_exists',
          },
          succeeded: false,
        });
        reply.code(409).send({ error: 'signup_unavailable' });
        return;
      }

      // Defensive collision check — guard against someone using a phone string
      // that happens to match an existing email column.
      const collision = await findUserByEmailIncludingDeleted(mobile);
      if (collision) {
        reply.code(409).send({ error: 'signup_unavailable' });
        return;
      }

      const passwordHash = await hashPassword(password);
      const user = await createUser({
        role: 'student',
        mobile,
        passwordHash,
        displayName,
      });

      const result = await createAuthenticatedSession({
        user,
        auditAction: 'account.created',
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });

      reply.send({
        access_token: result.access_token,
        refresh_token: result.refresh_token,
        token_type: result.token_type,
        expires_in: result.expires_in,
      });
    } catch (err) {
      if (err instanceof SignupUnavailableError) {
        reply.code(409).send({ error: 'signup_unavailable' });
        return;
      }
      throw err;
    }
  });
}
