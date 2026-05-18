/**
 * Phone OTP authentication routes.
 *   POST /auth/phone/start   — send an OTP to an E.164 phone number
 *   POST /auth/phone/verify  — verify OTP, log in or auto-create the user
 *
 * Service is services/phone-auth.ts. SMS delivery goes through the configured
 * provider (mock in dev, SNS in prod).
 */

import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  InvalidPhoneNumberError,
  InvalidPhoneOtpError,
  PhoneSignupUnavailableError,
  requestPhoneOtp,
  signupWithPhoneOtp,
  verifyPhoneOtp,
  WeakPhoneSignupPasswordError,
} from '../services/phone-auth.js';

const startBody = z.object({
  phone_number: z.string().min(8).max(20),
});

const verifyBody = z.object({
  phone_number: z.string().min(8).max(20),
  code: z.string().regex(/^\d{4,8}$/),
});

const signupVerifyBody = z.object({
  phone_number: z.string().min(8).max(20),
  code: z.string().regex(/^\d{4,8}$/),
  display_name: z.string().trim().min(2).max(80),
  password: z.string().min(12).max(128),
});

export async function phoneAuthRoutes(app: FastifyInstance): Promise<void> {
  async function handleOtpStart(req: FastifyRequest, reply: FastifyReply) {
    const parsed = startBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request' });
      return;
    }
    try {
      await requestPhoneOtp({
        phoneNumber: parsed.data.phone_number,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
        logger: req.log,
      });
      reply.send({ status: 'sent' });
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
  }

  app.post('/auth/phone/start', handleOtpStart);

  app.post('/auth/phone/request-otp', async (req, reply) => {
    await handleOtpStart(req, reply);
  });

  app.post('/auth/phone/verify', async (req, reply) => {
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request' });
      return;
    }
    try {
      const result = await verifyPhoneOtp({
        phoneNumber: parsed.data.phone_number,
        code: parsed.data.code,
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
      if (err instanceof InvalidPhoneNumberError) {
        reply.code(400).send({ error: 'invalid_phone_number' });
        return;
      }
      if (err instanceof InvalidPhoneOtpError) {
        reply.code(401).send({ error: 'invalid_phone_otp' });
        return;
      }
      throw err;
    }
  });

  app.post('/auth/phone/verify-otp', async (req, reply) => {
    const parsed = verifyBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request' });
      return;
    }
    try {
      const result = await verifyPhoneOtp({
        phoneNumber: parsed.data.phone_number,
        code: parsed.data.code,
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
      if (err instanceof InvalidPhoneNumberError) {
        reply.code(400).send({ error: 'invalid_phone_number' });
        return;
      }
      if (err instanceof InvalidPhoneOtpError) {
        reply.code(401).send({ error: 'invalid_otp' });
        return;
      }
      throw err;
    }
  });

  app.post('/auth/phone/signup/verify-otp', async (req, reply) => {
    const parsed = signupVerifyBody.safeParse(req.body);
    if (!parsed.success) {
      reply.code(400).send({ error: 'invalid_request', issues: parsed.error.issues });
      return;
    }

    try {
      await signupWithPhoneOtp({
        phoneNumber: parsed.data.phone_number,
        code: parsed.data.code,
        displayName: parsed.data.display_name,
        password: parsed.data.password,
        ip: req.ip,
        userAgent: req.headers['user-agent'],
      });
      reply.code(201).send({ status: 'account_created' });
    } catch (err) {
      if (err instanceof InvalidPhoneNumberError) {
        reply.code(400).send({ error: 'invalid_phone_number' });
        return;
      }
      if (err instanceof WeakPhoneSignupPasswordError) {
        reply.code(400).send({ error: 'weak_password', issues: err.issues });
        return;
      }
      if (err instanceof InvalidPhoneOtpError) {
        reply.code(401).send({ error: 'invalid_otp' });
        return;
      }
      if (err instanceof PhoneSignupUnavailableError) {
        reply.code(409).send({ error: 'signup_unavailable' });
        return;
      }
      throw err;
    }
  });
}
