import type {
  EmailProvider,
  SendOtpEmailInput,
  SendPasswordResetEmailInput,
  SendVerificationEmailInput,
} from './email-provider.js';

export class MockEmailProvider implements EmailProvider {
  async sendVerificationEmail(input: SendVerificationEmailInput): Promise<void> {
    input.logger.info(
      {
        provider: 'mock',
        to: input.to,
        verificationUrl: input.verificationUrl,
        expiresAt: input.expiresAt.toISOString(),
      },
      '[DEV] Email verification link',
    );
  }

  async sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<void> {
    input.logger.info(
      {
        provider: 'mock',
        to: input.to,
        resetUrl: input.resetUrl,
        expiresAt: input.expiresAt.toISOString(),
      },
      '[DEV] Password reset link',
    );
  }

  async sendOtpEmail(input: SendOtpEmailInput): Promise<void> {
    input.logger.info(
      {
        provider: 'mock',
        to: input.to,
        code: input.code,
        expiresInSec: input.expiresInSec,
      },
      '[DEV] Email OTP issued',
    );
  }
}
