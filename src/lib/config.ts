import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

export interface SlackConfig {
  webhookUrl: string;
  channelId?: string;
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
  slack: SlackConfig;
  supabase: SupabaseConfig;
  rules: RulesConfig;
}

const CONFIG_DIR = path.join(os.homedir(), '.claude-guard');
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

export function loadConfig(): Config | null {
  if (!configExists()) {
    return null;
  }

  try {
    const content = fs.readFileSync(CONFIG_FILE, 'utf-8');
    const config = JSON.parse(content) as Config;
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

function validateConfig(config: unknown): config is Config {
  if (typeof config !== 'object' || config === null) {
    return false;
  }

  const c = config as Record<string, unknown>;

  // Validate slack config
  if (typeof c.slack !== 'object' || c.slack === null) {
    return false;
  }
  const slack = c.slack as Record<string, unknown>;
  if (typeof slack.webhookUrl !== 'string' || !slack.webhookUrl.startsWith('https://')) {
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
    slack: {
      webhookUrl: '',
      channelId: '',
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
