import type { Messenger, MessengerMessage, MessengerResult, ConnectionTestResult } from './types.js';
import { maskSensitiveInfo, truncateCommand, getSeverityEmoji } from './base.js';

export interface TelegramConfig {
  botToken: string;
  chatId: string;
}

// Bot Token을 마스킹하여 에러 메시지에서 노출 방지
function maskBotToken(text: string): string {
  // bot123456789:ABCdefGHI... 형식의 토큰을 마스킹
  return text.replace(/bot[0-9]+:[A-Za-z0-9_-]+/gi, 'bot[REDACTED]');
}

// Telegram MarkdownV2에서 이스케이프가 필요한 문자
function escapeTelegramMarkdownV2(text: string): string {
  // eslint-disable-next-line no-useless-escape
  return text.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&');
}

function buildTelegramMessage(message: MessengerMessage): string {
  const emoji = getSeverityEmoji(message.severity);
  const maskedCommand = maskSensitiveInfo(message.command);
  const truncatedCommand = truncateCommand(maskedCommand, 300);

  // MarkdownV2 형식으로 메시지 구성
  const lines = [
    `${emoji} *Claude Guard: Approval Required*`,
    '',
    `*Reason:* ${escapeTelegramMarkdownV2(message.reason)}`,
    `*Severity:* ${message.severity.toUpperCase()}`,
    '',
    `*Command:*`,
    '```',
    escapeTelegramMarkdownV2(truncatedCommand),
    '```',
    '',
    `*Working Directory:*`,
    `\`${escapeTelegramMarkdownV2(message.cwd)}\``,
    '',
    `_Request ID: ${escapeTelegramMarkdownV2(message.requestId)}_`,
  ];

  return lines.join('\n');
}

function buildInlineKeyboard(requestId: string) {
  return {
    inline_keyboard: [
      [
        {
          text: '✅ Approve',
          callback_data: `approve:${requestId}`,
        },
        {
          text: '❌ Reject',
          callback_data: `reject:${requestId}`,
        },
      ],
    ],
  };
}

export class TelegramMessenger implements Messenger {
  readonly type = 'telegram' as const;
  private config: TelegramConfig;
  private baseUrl: string;

  constructor(config: TelegramConfig) {
    this.config = config;
    this.baseUrl = `https://api.telegram.org/bot${config.botToken}`;
  }

  validateConfig(): boolean {
    return (
      typeof this.config.botToken === 'string' &&
      this.config.botToken.length > 0 &&
      typeof this.config.chatId === 'string' &&
      this.config.chatId.length > 0
    );
  }

  async sendNotification(message: MessengerMessage): Promise<MessengerResult> {
    try {
      const text = buildTelegramMessage(message);
      const replyMarkup = buildInlineKeyboard(message.requestId);

      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          parse_mode: 'MarkdownV2',
          reply_markup: replyMarkup,
        }),
      });

      const result = await response.json() as { ok: boolean; description?: string };

      if (!result.ok) {
        return { ok: false, error: maskBotToken(`Telegram API error: ${result.description || 'Unknown error'}`) };
      }

      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, error: maskBotToken(errorMessage) };
    }
  }

  async sendTestNotification(): Promise<MessengerResult> {
    try {
      const text = [
        '✅ *Claude Guard Test Notification*',
        '',
        'This is a test notification from Claude Guard\\.',
        'If you see this message, your Telegram integration is working correctly\\!',
        '',
        `_Sent at: ${escapeTelegramMarkdownV2(new Date().toISOString())}_`,
      ].join('\n');

      const response = await fetch(`${this.baseUrl}/sendMessage`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          chat_id: this.config.chatId,
          text,
          parse_mode: 'MarkdownV2',
        }),
      });

      const result = await response.json() as { ok: boolean; description?: string };

      if (!result.ok) {
        return { ok: false, error: maskBotToken(`Telegram API error: ${result.description || 'Unknown error'}`) };
      }

      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, error: maskBotToken(errorMessage) };
    }
  }

  // getMe API로 Bot Token 검증 및 Bot 정보 조회
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      const response = await fetch(`${this.baseUrl}/getMe`, {
        method: 'GET',
      });

      const result = await response.json() as {
        ok: boolean;
        description?: string;
        result?: {
          id: number;
          is_bot: boolean;
          first_name: string;
          username?: string;
        };
      };

      if (!result.ok) {
        return { ok: false, error: maskBotToken(`Telegram API error: ${result.description || 'Invalid Bot Token'}`) };
      }

      return {
        ok: true,
        info: {
          botUsername: result.result?.username ? `@${result.result.username}` : result.result?.first_name,
        },
      };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, error: maskBotToken(errorMessage) };
    }
  }
}
