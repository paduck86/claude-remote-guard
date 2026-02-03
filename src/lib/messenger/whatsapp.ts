import type { Messenger, MessengerMessage, MessengerResult, ConnectionTestResult } from './types.js';
import { maskSensitiveInfo, truncateCommand, getSeverityEmoji } from './base.js';

export interface WhatsAppConfig {
  accountSid: string;
  authToken: string;
  fromNumber: string; // Twilio WhatsApp number (e.g., whatsapp:+14155238886)
  toNumber: string;   // Recipient number (e.g., whatsapp:+821012345678)
}

function buildWhatsAppMessage(message: MessengerMessage): string {
  const emoji = getSeverityEmoji(message.severity);
  const maskedCommand = maskSensitiveInfo(message.command);
  const truncatedCommand = truncateCommand(maskedCommand, 300);

  const lines = [
    `${emoji} Claude Guard: Approval Required`,
    '',
    `Reason: ${message.reason}`,
    `Severity: ${message.severity.toUpperCase()}`,
    '',
    `Command:`,
    truncatedCommand,
    '',
    `Working Directory: ${message.cwd}`,
    '',
    `---`,
    `To approve, reply: APPROVE ${message.requestId}`,
    `To reject, reply: REJECT ${message.requestId}`,
  ];

  return lines.join('\n');
}

export class WhatsAppMessenger implements Messenger {
  readonly type = 'whatsapp' as const;
  private config: WhatsAppConfig;

  constructor(config: WhatsAppConfig) {
    this.config = config;
  }

  validateConfig(): boolean {
    return (
      typeof this.config.accountSid === 'string' &&
      this.config.accountSid.length > 0 &&
      typeof this.config.authToken === 'string' &&
      this.config.authToken.length > 0 &&
      typeof this.config.fromNumber === 'string' &&
      this.config.fromNumber.startsWith('whatsapp:') &&
      typeof this.config.toNumber === 'string' &&
      this.config.toNumber.startsWith('whatsapp:')
    );
  }

  async sendNotification(message: MessengerMessage): Promise<MessengerResult> {
    try {
      const body = buildWhatsAppMessage(message);

      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;
      const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64');

      const formData = new URLSearchParams();
      formData.append('From', this.config.fromNumber);
      formData.append('To', this.config.toNumber);
      formData.append('Body', body);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      const result = await response.json() as { sid?: string; message?: string; code?: number };

      if (!response.ok) {
        return { ok: false, error: `Twilio API error: ${result.message || 'Unknown error'}` };
      }

      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, error: errorMessage };
    }
  }

  async sendTestNotification(): Promise<MessengerResult> {
    try {
      const body = [
        '✅ Claude Guard Test Notification',
        '',
        'This is a test notification from Claude Guard.',
        'If you see this message, your WhatsApp integration is working correctly!',
        '',
        `Sent at: ${new Date().toISOString()}`,
      ].join('\n');

      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}/Messages.json`;
      const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64');

      const formData = new URLSearchParams();
      formData.append('From', this.config.fromNumber);
      formData.append('To', this.config.toNumber);
      formData.append('Body', body);

      const response = await fetch(url, {
        method: 'POST',
        headers: {
          'Authorization': `Basic ${auth}`,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: formData.toString(),
      });

      const result = await response.json() as { sid?: string; message?: string; code?: number };

      if (!response.ok) {
        return { ok: false, error: `Twilio API error: ${result.message || 'Unknown error'}` };
      }

      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, error: errorMessage };
    }
  }

  // Twilio Account 정보 조회로 연결 테스트
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const url = `https://api.twilio.com/2010-04-01/Accounts/${this.config.accountSid}.json`;
      const auth = Buffer.from(`${this.config.accountSid}:${this.config.authToken}`).toString('base64');

      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'Authorization': `Basic ${auth}`,
        },
      });

      const result = await response.json() as {
        sid?: string;
        friendly_name?: string;
        status?: string;
        message?: string;
        code?: number;
      };

      if (!response.ok) {
        return { ok: false, error: `Twilio API error: ${result.message || 'Invalid credentials'}` };
      }

      return {
        ok: true,
        info: {
          accountName: result.friendly_name || result.sid,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, error: errorMessage };
    }
  }
}
