import type { FastifyBaseLogger } from 'fastify';

export interface SendVerificationEmailInput {
  to: string;
  verificationUrl: string;
  expiresAt: Date;
  logger: FastifyBaseLogger;
}

export interface SendPasswordResetEmailInput {
  to: string;
  resetUrl: string;
  expiresAt: Date;
  logger: FastifyBaseLogger;
}

export interface SendOtpEmailInput {
  to: string;
  code: string;
  expiresInSec: number;
  logger: FastifyBaseLogger;
}

export interface EmailProvider {
  sendVerificationEmail(input: SendVerificationEmailInput): Promise<void>;
  sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<void>;
  sendOtpEmail(input: SendOtpEmailInput): Promise<void>;
}
