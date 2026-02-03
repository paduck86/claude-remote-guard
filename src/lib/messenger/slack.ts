import type { Messenger, MessengerMessage, MessengerResult, ConnectionTestResult } from './types.js';
import { maskSensitiveInfo, truncateCommand, getSeverityEmoji, getSeverityColor } from './base.js';

export interface SlackConfig {
  webhookUrl: string;
  channelId?: string;
}

interface SlackTextElement {
  type: string;
  text: string;
  emoji?: boolean;
}

interface SlackButtonElement {
  type: string;
  text?: SlackTextElement;
  action_id?: string;
  value?: string;
  style?: string;
}

interface SlackContextElement {
  type: string;
  text?: string;
}

interface SlackBlock {
  type: string;
  text?: SlackTextElement;
  elements?: Array<SlackButtonElement | SlackContextElement>;
  accessory?: {
    type: string;
    text: SlackTextElement;
    value: string;
    action_id: string;
    style?: string;
  };
}

interface SlackPayload {
  blocks: SlackBlock[];
  attachments?: Array<{
    color: string;
    blocks: SlackBlock[];
  }>;
}

function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildSlackBlocks(message: MessengerMessage): SlackPayload {
  const emoji = getSeverityEmoji(message.severity);
  const color = getSeverityColor(message.severity);
  // Mask sensitive information before displaying
  const maskedCommand = maskSensitiveInfo(message.command);
  const escapedCommand = escapeSlackText(truncateCommand(maskedCommand));
  const escapedCwd = escapeSlackText(message.cwd);
  const escapedReason = escapeSlackText(message.reason);

  return {
    blocks: [
      {
        type: 'header',
        text: {
          type: 'plain_text',
          text: `${emoji} Claude Guard: Approval Required`,
          emoji: true,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Reason:* ${escapedReason}\n*Severity:* ${message.severity.toUpperCase()}`,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Command:*\n\`\`\`${escapedCommand}\`\`\``,
        },
      },
      {
        type: 'section',
        text: {
          type: 'mrkdwn',
          text: `*Working Directory:*\n\`${escapedCwd}\``,
        },
      },
      {
        type: 'actions',
        elements: [
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Approve',
              emoji: true,
            },
            style: 'primary',
            action_id: 'approve_command',
            value: message.requestId,
          },
          {
            type: 'button',
            text: {
              type: 'plain_text',
              text: 'Reject',
              emoji: true,
            },
            style: 'danger',
            action_id: 'reject_command',
            value: message.requestId,
          },
        ],
      },
      {
        type: 'context',
        elements: [
          {
            type: 'mrkdwn',
            text: `Request ID: \`${message.requestId}\` | Time: <!date^${Math.floor(message.timestamp / 1000)}^{date_short_pretty} {time}|${new Date(message.timestamp).toISOString()}>`,
          },
        ],
      },
    ],
    attachments: [
      {
        color: color,
        blocks: [],
      },
    ],
  };
}

export class SlackMessenger implements Messenger {
  readonly type = 'slack' as const;
  private config: SlackConfig;

  constructor(config: SlackConfig) {
    this.config = config;
  }

  validateConfig(): boolean {
    return (
      typeof this.config.webhookUrl === 'string' &&
      this.config.webhookUrl.startsWith('https://hooks.slack.com/')
    );
  }

  async sendNotification(message: MessengerMessage): Promise<MessengerResult> {
    try {
      const payload = buildSlackBlocks(message);

      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        return { ok: false, error: `Slack API error: ${response.status} ${text}` };
      }

      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, error: errorMessage };
    }
  }

  async sendTestNotification(): Promise<MessengerResult> {
    try {
      const payload = {
        blocks: [
          {
            type: 'header',
            text: {
              type: 'plain_text',
              text: '✅ Claude Guard Test Notification',
              emoji: true,
            },
          },
          {
            type: 'section',
            text: {
              type: 'mrkdwn',
              text: 'This is a test notification from Claude Guard.\nIf you see this message, your Slack integration is working correctly!',
            },
          },
          {
            type: 'context',
            elements: [
              {
                type: 'mrkdwn',
                text: `Sent at: <!date^${Math.floor(Date.now() / 1000)}^{date_short_pretty} {time}|${new Date().toISOString()}>`,
              },
            ],
          },
        ],
      };

      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(payload),
      });

      if (!response.ok) {
        const text = await response.text();
        return { ok: false, error: `Slack API error: ${response.status} ${text}` };
      }

      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, error: errorMessage };
    }
  }

  // Slack Webhook은 연결 테스트용 별도 API가 없으므로 간단한 메시지 전송으로 테스트
  async testConnection(): Promise<ConnectionTestResult> {
    try {
      // Webhook URL로 간단한 메시지 전송 시도
      const response = await fetch(this.config.webhookUrl, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          text: '🔗 Claude Guard: Connection test successful',
        }),
      });

      if (!response.ok) {
        const text = await response.text();
        return { ok: false, error: `Slack Webhook error: ${response.status} ${text}` };
      }

      return { ok: true };
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      return { ok: false, error: errorMessage };
    }
  }
}
