import { getSeverityEmoji as getEmoji, getSeverityColor as getColor, type Severity } from '../rules.js';

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

export function maskSensitiveInfo(text: string): string {
  let masked = text;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

export function truncateCommand(command: string, maxLength: number = 500): string {
  if (command.length <= maxLength) {
    return command;
  }
  return command.substring(0, maxLength - 3) + '...';
}

export function getSeverityEmoji(severity: Severity): string {
  return getEmoji(severity);
}

export function getSeverityColor(severity: Severity): string {
  return getColor(severity);
}
