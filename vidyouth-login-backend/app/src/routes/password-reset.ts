/**
 * Password-reset routes.
 *   POST /auth/password-reset/request  — email a reset link (generic 202)
 *   POST /auth/password-reset/confirm  — consume token + set new password
 *
 * Service is services/password-reset.ts. The request endpoint deliberately
 * returns the same 202 for known and unknown emails to prevent enumeration.
 */

import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import {
  InvalidPasswordResetTokenError,
  InvalidPhonePasswordResetOtpError,
  requestPhonePasswordReset,
  WeakPasswordResetPasswordError,
  requestPasswordReset,
  resetPassword,
  resetPasswordWithPhoneOtp,
} from '../services/password-reset.js';
import { InvalidPhoneNumberError } from '../services/phone-auth.js';

const requestBody = z.object({
  email: z.string().email().max(254),
});

const confirmBody = z.object({
  token: z.string().min(16).max(256),
  newPassword: z.string().min(8).max(128),
});

const aliasConfirmBody = z.object({
  token: z.string().min(16).max(256),
  new_password: z.string().min(12).max(128),
});

const phoneRequestBody = z.object({
  phone_number: z.string().trim().min(8).max(20),
});

const phoneConfirmBody = z.object({
  phone_number: z.string().trim().min(8).max(20),
  code: z.string().regex(/^\d{4,8}$/),
  new_password: z.string().min(12).max(128),
});

export async function passwordResetRoutes(app: FastifyInstance): Promise<void> {
  app.post('/auth/password-reset/request', async (req, reply) => {
    const parsed = requestBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request' });
      return;
    }
    await requestPasswordReset({
      email: parsed.data.email,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      logger: req.log,
    });
    reply.code(202).send({ status: 'queued_if_eligible' });
  });

  app.post('/auth/password-reset/confirm', async (req, reply) => {
    const parsed = confirmBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request' });
      return;
    }
    try {
      await resetPassword({
        token: parsed.data.token,
        newPassword: parsed.data.newPassword,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      reply.code(204).send();
    } catch (err) {
      if (err instanceof WeakPasswordResetPasswordError) {
        reply.code(400).send({ error: 'weak_password', issues: err.issues });
        return;
      }
      if (err instanceof InvalidPasswordResetTokenError) {
        reply.code(400).send({ error: 'invalid_or_expired_token' });
        return;
      }
      throw err;
    }
  });

  app.post('/auth/forgot-password', async (req, reply) => {
    const parsed = requestBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    await requestPasswordReset({
      email: parsed.data.email,
      ip: req.ip,
      userAgent: req.headers['user-agent'],
      logger: req.log,
    });
    reply.send({ status: 'sent_if_account_exists' });
  });

  app.post('/auth/reset-password', async (req, reply) => {
    const parsed = aliasConfirmBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }
    try {
      await resetPassword({
        token: parsed.data.token,
        newPassword: parsed.data.new_password,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      reply.send({ status: 'password_reset' });
    } catch (err) {
      if (err instanceof WeakPasswordResetPasswordError) {
        reply.code(400).send({ error: 'weak_password', issues: err.issues });
        return;
      }
      if (err instanceof InvalidPasswordResetTokenError) {
        reply.code(400).send({ error: 'invalid_or_expired_token' });
        return;
      }
      throw err;
    }
  });

  app.post('/auth/phone/forgot-password', async (req, reply) => {
    const parsed = phoneRequestBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }

    try {
      await requestPhonePasswordReset({
        phoneNumber: parsed.data.phone_number,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        logger: req.log,
      });
      reply.send({ status: 'sent_if_account_exists' });
    } catch (err) {
      if (err instanceof InvalidPhoneNumberError) {
        reply.code(400).send({ error: 'invalid_phone_number' });
        return;
      }
      const e = err as { statusCode?: number };
      if (e.statusCode === 429) {
        reply.code(429).send({ error: 'rate_limited' });
        return;
      }
      throw err;
    }
  });

  app.post('/auth/phone/reset-password', async (req, reply) => {
    const parsed = phoneConfirmBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }

    try {
      await resetPasswordWithPhoneOtp({
        phoneNumber: parsed.data.phone_number,
        code: parsed.data.code,
        newPassword: parsed.data.new_password,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      reply.send({ status: 'password_reset' });
    } catch (err) {
      if (err instanceof InvalidPhoneNumberError) {
        reply.code(400).send({ error: 'invalid_phone_number' });
        return;
      }
      if (err instanceof WeakPasswordResetPasswordError) {
        reply.code(400).send({ error: 'weak_password', issues: err.issues });
        return;
      }
      if (err instanceof InvalidPhonePasswordResetOtpError) {
        reply.code(400).send({ error: 'invalid_or_expired_otp' });
        return;
      }
      throw err;
    }
  });
}
