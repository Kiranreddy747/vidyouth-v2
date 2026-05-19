import { PublishCommand, SNSClient } from '@aws-sdk/client-sns';
import { env } from '../../config/env.js';
import type { SendOtpSmsInput, SmsProvider } from './sms-provider.js';

export class SnsSmsProvider implements SmsProvider {
  private readonly client = new SNSClient({ region: env.AWS_SMS_REGION || env.AWS_REGION });

  async sendOtp(input: SendOtpSmsInput): Promise<void> {
    try {
      const result = await this.client.send(new PublishCommand({
        PhoneNumber: input.to,
        Message: `Your Vidyouth OTP is ${input.code}. It expires in ${Math.ceil(input.expiresInSec / 60)} minutes.`,
        MessageAttributes: {
          'AWS.SNS.SMS.SMSType': {
            DataType: 'String',
            StringValue: env.SNS_SMS_TYPE,
          },
          ...(env.SNS_SENDER_ID ? {
            'AWS.SNS.SMS.SenderID': {
              DataType: 'String',
              StringValue: env.SNS_SENDER_ID,
            },
          } : {}),
          ...(env.SNS_ENTITY_ID ? {
            'AWS.MM.SMS.EntityId': {
              DataType: 'String',
              StringValue: env.SNS_ENTITY_ID,
            },
          } : {}),
          ...(env.SNS_TEMPLATE_ID ? {
            'AWS.MM.SMS.TemplateId': {
              DataType: 'String',
              StringValue: env.SNS_TEMPLATE_ID,
            },
          } : {}),
        },
      }));

      input.logger.info(
        {
          provider: 'sns',
          to: input.to,
          messageId: result.MessageId,
          smsType: env.SNS_SMS_TYPE,
        },
        'SNS OTP SMS sent',
      );
    } catch (err) {
      const awsError = err as { name?: string; message?: string; $metadata?: unknown };
      input.logger.error(
        {
          provider: 'sns',
          to: input.to,
          errorName: awsError.name,
          errorMessage: awsError.message,
          metadata: awsError.$metadata,
        },
        'SNS OTP SMS send failed',
      );
      throw err;
    }
  }
}

// TODO(twilio-provider): add a TwilioSmsProvider behind this same interface.
// TODO(sms-delivery-receipts): persist SNS delivery status callbacks.
// TODO(sms-fraud-detection): block abusive destinations and velocity spikes.
// TODO(phone-normalization): normalize to E.164 before provider delivery.
// TODO(resend-cooldowns): add per-phone resend cooldown UX and enforcement.
