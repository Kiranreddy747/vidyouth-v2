import type {
  EmailProvider,
  SendOtpEmailInput,
  SendPasswordResetEmailInput,
  SendVerificationEmailInput,
} from './email-provider.js';
import { SendEmailCommand, SESClient } from '@aws-sdk/client-ses';
import { env } from '../../config/env.js';

export class SesEmailProvider implements EmailProvider {
  private readonly client = new SESClient({ region: env.AWS_EMAIL_REGION || env.AWS_REGION });

  private readonly fromEmail = env.SES_FROM_EMAIL ?? env.EMAIL_FROM;

  async sendVerificationEmail(input: SendVerificationEmailInput): Promise<void> {
    await this.sendEmail({
      to: input.to,
      subject: 'Verify your Vidyouth email',
      text: [
        'Verify your Vidyouth email address using this link:',
        input.verificationUrl,
        '',
        `This link expires at ${input.expiresAt.toISOString()}.`,
      ].join('\n'),
      html: [
        '<p>Verify your Vidyouth email address using this link:</p>',
        `<p><a href="${escapeHtml(input.verificationUrl)}">Verify email</a></p>`,
        `<p>This link expires at ${escapeHtml(input.expiresAt.toISOString())}.</p>`,
      ].join(''),
      logger: input.logger,
      logContext: {
        type: 'email_verification',
        expiresAt: input.expiresAt.toISOString(),
      },
    });
  }

  async sendPasswordResetEmail(input: SendPasswordResetEmailInput): Promise<void> {
    await this.sendEmail({
      to: input.to,
      subject: 'Reset your Vidyouth password',
      text: [
        'Reset your Vidyouth password using this link:',
        input.resetUrl,
        '',
        `This link expires at ${input.expiresAt.toISOString()}.`,
        'If you did not request this, you can ignore this email.',
      ].join('\n'),
      html: [
        '<p>Reset your Vidyouth password using this link:</p>',
        `<p><a href="${escapeHtml(input.resetUrl)}">Reset password</a></p>`,
        `<p>This link expires at ${escapeHtml(input.expiresAt.toISOString())}.</p>`,
        '<p>If you did not request this, you can ignore this email.</p>',
      ].join(''),
      logger: input.logger,
      logContext: {
        type: 'password_reset',
        expiresAt: input.expiresAt.toISOString(),
      },
    });
  }

  async sendOtpEmail(input: SendOtpEmailInput): Promise<void> {
    const expiresInMin = Math.ceil(input.expiresInSec / 60);
    await this.sendEmail({
      to: input.to,
      subject: 'Your Vidyouth OTP',
      text: [
        `Your Vidyouth OTP is ${input.code}.`,
        `It expires in ${expiresInMin} minutes.`,
        '',
        'Do not share this code with anyone.',
      ].join('\n'),
      html: [
        '<p>Your Vidyouth OTP is:</p>',
        `<p style="font-size:24px;font-weight:700;letter-spacing:4px;">${escapeHtml(input.code)}</p>`,
        `<p>It expires in ${expiresInMin} minutes.</p>`,
        '<p>Do not share this code with anyone.</p>',
      ].join(''),
      logger: input.logger,
      logContext: {
        type: 'email_otp',
        expiresInSec: input.expiresInSec,
      },
    });
  }

  private async sendEmail(input: {
    to: string;
    subject: string;
    text: string;
    html: string;
    logger: SendVerificationEmailInput['logger'];
    logContext: Record<string, unknown>;
  }): Promise<void> {
    try {
      const result = await this.client.send(new SendEmailCommand({
        Source: this.fromEmail,
        Destination: {
          ToAddresses: [input.to],
        },
        Message: {
          Subject: {
            Charset: 'UTF-8',
            Data: input.subject,
          },
          Body: {
            Text: {
              Charset: 'UTF-8',
              Data: input.text,
            },
            Html: {
              Charset: 'UTF-8',
              Data: input.html,
            },
          },
        },
      }));

      input.logger.info(
        {
          provider: 'ses',
          to: input.to,
          from: this.fromEmail,
          messageId: result.MessageId,
          ...input.logContext,
        },
        'SES email sent',
      );
    } catch (err) {
      const awsError = err as { name?: string; message?: string; $metadata?: unknown };
      input.logger.error(
        {
          provider: 'ses',
          to: input.to,
          from: this.fromEmail,
          errorName: awsError.name,
          errorMessage: awsError.message,
          metadata: awsError.$metadata,
          ...input.logContext,
        },
        'SES email send failed',
      );
      throw err;
    }
  }
}

function escapeHtml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;');
}

// TODO(email-templates): replace placeholder HTML strings with templates.
// TODO(email-queue): enqueue SES sends through workers with retries/backoff.
// TODO(SES-bounces): handle SES SNS webhooks for bounces and complaints.
