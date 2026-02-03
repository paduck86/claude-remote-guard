import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import type { MessengerType } from './messenger/types.js';
import type { SlackConfig } from './messenger/slack.js';
import type { TelegramConfig } from './messenger/telegram.js';
import type { WhatsAppConfig } from './messenger/whatsapp.js';

// Re-export for backward compatibility
export type { SlackConfig } from './messenger/slack.js';
export type { TelegramConfig } from './messenger/telegram.js';
export type { WhatsAppConfig } from './messenger/whatsapp.js';

export interface MessengerConfig {
  type: MessengerType;
  slack?: SlackConfig;
  telegram?: TelegramConfig;
  whatsapp?: WhatsAppConfig;
}

export interface SupabaseConfig {
  url: string;
  anonKey: string;
}

export interface RulesConfig {
  timeoutSeconds: number;
  defaultAction: 'allow' | 'deny';
  customPatterns?: Array<{
    pattern: string;
    severity: 'low' | 'medium' | 'high' | 'critical';
    reason: string;
  }>;
  whitelist?: string[];
}

export interface Config {
  messenger: MessengerConfig;
  supabase: SupabaseConfig;
  rules: RulesConfig;
}

// Legacy config for backward compatibility
export interface LegacyConfig {
  slack: SlackConfig;
  supabase: SupabaseConfig;
  rules: RulesConfig;
}

const CONFIG_DIR = path.join(os.homedir(), '.claude-remote-guard');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export function getConfigDir(): string {
  return CONFIG_DIR;
}

export function getConfigPath(): string {
  return CONFIG_FILE;
}

export function configExists(): boolean {
  return fs.existsSync(CONFIG_FILE);
}

// Migrate legacy config to new format
export function migrateConfig(legacy: LegacyConfig): Config {
  return {
    messenger: {
      type: 'slack',
      slack: legacy.slack,
    },
    supabase: legacy.supabase,
    rules: legacy.rules,
  };
}

// Check if config is legacy format
function isLegacyConfig(config: unknown): config is LegacyConfig {
  if (typeof config !== 'object' || config === null) {
    return false;
  }
  const c = config as Record<string, unknown>;
  // Legacy format has 'slack' at top level, new format has 'messenger'
  return 'slack' in c && !('messenger' in c);
}

export function loadConfig(): Config | null {
  if (!configExists()) {
    return null;
  }

  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const rawConfig = JSON.parse(content);

    // Handle legacy config migration
    if (isLegacyConfig(rawConfig)) {
      const migratedConfig = migrateConfig(rawConfig);
      // Auto-save migrated config
      saveConfig(migratedConfig);
      return migratedConfig;
    }

    const config = rawConfig as Config;
    return validateConfig(config) ? config : null;
  } catch {
    return null;
  }
}

export function saveConfig(config: Config): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export function deleteConfig(): void {
  if (fs.existsSync(CONFIG_FILE)) {
    fs.unlinkSync(CONFIG_FILE);
  }
}

function validateMessengerConfig(messenger: unknown): boolean {
  if (typeof messenger !== 'object' || messenger === null) {
    return false;
  }

  const m = messenger as Record<string, unknown>;

  if (!['slack', 'telegram', 'whatsapp'].includes(m.type as string)) {
    return false;
  }

  const type = m.type as MessengerType;

  switch (type) {
    case 'slack': {
      const slack = m.slack as Record<string, unknown> | undefined;
      if (!slack || typeof slack.webhookUrl !== 'string' || !slack.webhookUrl.startsWith('https://')) {
        return false;
      }
      break;
    }
    case 'telegram': {
      const telegram = m.telegram as Record<string, unknown> | undefined;
      if (!telegram || typeof telegram.botToken !== 'string' || telegram.botToken.length === 0) {
        return false;
      }
      if (typeof telegram.chatId !== 'string' || telegram.chatId.length === 0) {
        return false;
      }
      break;
    }
    case 'whatsapp': {
      const whatsapp = m.whatsapp as Record<string, unknown> | undefined;
      if (!whatsapp) {
        return false;
      }
      if (typeof whatsapp.accountSid !== 'string' || whatsapp.accountSid.length === 0) {
        return false;
      }
      if (typeof whatsapp.authToken !== 'string' || whatsapp.authToken.length === 0) {
        return false;
      }
      if (typeof whatsapp.fromNumber !== 'string' || !whatsapp.fromNumber.startsWith('whatsapp:')) {
        return false;
      }
      if (typeof whatsapp.toNumber !== 'string' || !whatsapp.toNumber.startsWith('whatsapp:')) {
        return false;
      }
      break;
    }
  }

  return true;
}

function validateConfig(config: unknown): config is Config {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  const c = config as Record<string, unknown>;

  // Validate messenger config
  if (!validateMessengerConfig(c.messenger)) {
    return false;
  }

  // Validate supabase config
  if (typeof c.supabase !== 'object' || c.supabase === null) {
    return false;
  }
  const supabase = c.supabase as Record<string, unknown>;
  if (typeof supabase.url !== 'string' || !supabase.url.startsWith('https://')) {
    return false;
  }
  if (typeof supabase.anonKey !== 'string' || supabase.anonKey.length === 0) {
    return false;
  }

  // Validate rules config
  if (typeof c.rules !== 'object' || c.rules === null) {
    return false;
  }
  const rules = c.rules as Record<string, unknown>;
  if (typeof rules.timeoutSeconds !== 'number' || rules.timeoutSeconds < 10) {
    return false;
  }
  if (rules.defaultAction !== 'allow' && rules.defaultAction !== 'deny') {
    return false;
  }

  return true;
}

export function expandPath(filePath: string): string {
  if (filePath.startsWith('~/')) {
    return path.join(os.homedir(), filePath.slice(2));
  }
  return filePath;
}

export function getDefaultConfig(): Config {
  return {
    messenger: {
      type: 'slack',
      slack: {
        webhookUrl: '',
        channelId: '',
      },
    },
    supabase: {
      url: '',
      anonKey: '',
    },
    rules: {
      timeoutSeconds: 300,
      defaultAction: 'deny',
    },
  };
}
