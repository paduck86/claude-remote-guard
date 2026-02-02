import { getSeverityColor, getSeverityEmoji, type Severity } from './rules.js';

export interface SlackMessage {
  requestId: string;
  command: string;
  reason: string;
  severity: Severity;
  cwd: string;
  timestamp: number;
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

// Patterns that may contain sensitive information
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  // API keys, tokens, secrets in various formats
  { pattern: /([?&])(api[_-]?key|token|secret|password|auth|key|access[_-]?token)=([^&\s'"]+)/gi, replacement: '$1$2=[REDACTED]' },
  // Authorization headers
  { pattern: /(Authorization:\s*)(Bearer\s+)?[^\s'"]+/gi, replacement: '$1$2[REDACTED]' },
  // Environment variable assignments with sensitive names
  { pattern: /(export\s+)?(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|API_KEY|SECRET_KEY|PRIVATE_KEY|DATABASE_URL|DB_PASSWORD|SLACK_TOKEN|GITHUB_TOKEN|NPM_TOKEN)=([^\s'"]+)/gi, replacement: '$1$2=[REDACTED]' },
  // Connection strings with passwords
  { pattern: /:\/\/([^:]+):([^@]+)@/g, replacement: '://$1:[REDACTED]@' },
  // Base64 encoded credentials (likely in headers)
  { pattern: /(Basic\s+)[A-Za-z0-9+/=]{20,}/gi, replacement: '$1[REDACTED]' },
];

function maskSensitiveInfo(text: string): string {
  let masked = text;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

function truncateCommand(command: string, maxLength: number = 500): string {
  if (command.length <= maxLength) {
    return command;
  }
  return command.substring(0, maxLength - 3) + '...';
}

function escapeSlackText(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function buildSlackBlocks(message: SlackMessage): SlackPayload {
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

export async function sendSlackNotification(
  webhookUrl: string,
  message: SlackMessage
): Promise<{ ok: boolean; error?: string }> {
  try {
    const payload = buildSlackBlocks(message);

    const response = await fetch(webhookUrl, {
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

export async function sendTestNotification(
  webhookUrl: string
): Promise<{ ok: boolean; error?: string }> {
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

    const response = await fetch(webhookUrl, {
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
