import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import type { MessengerType } from './messenger/types.js';
import type { SlackConfig } from './messenger/slack.js';
import type { TelegramConfig } from './messenger/telegram.js';
import type { WhatsAppConfig } from './messenger/whatsapp.js';

// Re-export for backward compatibility
export type { SlackConfig } from './messenger/slack.js';
export type { TelegramConfig } from './messenger/telegram.js';
export type { WhatsAppConfig } from './messenger/whatsapp.js';

// ============================================================
// Phase 2.1: 환경변수 매핑
// ============================================================
const ENV_MAPPING: Record<string, string> = {
  CLAUDE_GUARD_SUPABASE_URL: 'supabase.url',
  CLAUDE_GUARD_SUPABASE_ANON_KEY: 'supabase.anonKey',
  CLAUDE_GUARD_TELEGRAM_BOT_TOKEN: 'messenger.telegram.botToken',
  CLAUDE_GUARD_TELEGRAM_CHAT_ID: 'messenger.telegram.chatId',
  CLAUDE_GUARD_SLACK_WEBHOOK_URL: 'messenger.slack.webhookUrl',
  CLAUDE_GUARD_DEFAULT_ACTION: 'rules.defaultAction',
  CLAUDE_GUARD_TIMEOUT_SECONDS: 'rules.timeoutSeconds',
};

// ============================================================
// Phase 3.1: 시크릿 암호화 (AES-256-GCM)
// ============================================================

// 암호화할 민감한 필드 경로 목록
const SENSITIVE_FIELDS = [
  'supabase.anonKey',
  'messenger.slack.webhookUrl',
  'messenger.telegram.botToken',
  'messenger.whatsapp.authToken',
];

/**
 * 머신 고유 키 생성 (hostname + username + CPU model)
 * 해당 머신에서만 복호화 가능
 */
function getMachineKey(): Buffer {
  const raw = `${os.hostname()}:${os.userInfo().username}:${os.cpus()[0]?.model || 'unknown'}`;
  return crypto.createHash('sha256').update(raw).digest();
}

/**
 * 평문을 AES-256-GCM으로 암호화
 * 형식: ENC:<iv_base64>:<authTag_base64>:<ciphertext_base64>
 */
function encryptSecret(plaintext: string): string {
  if (!plaintext || plaintext.startsWith('ENC:')) {
    return plaintext; // 이미 암호화됨 또는 빈 값
  }
  const key = getMachineKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  let encrypted = cipher.update(plaintext, 'utf8', 'base64');
  encrypted += cipher.final('base64');
  const authTag = cipher.getAuthTag();
  return `ENC:${iv.toString('base64')}:${authTag.toString('base64')}:${encrypted}`;
}

/**
 * AES-256-GCM으로 암호화된 값을 복호화
 * ENC: 접두사가 없으면 평문으로 간주 (하위 호환)
 */
function decryptSecret(encrypted: string): string {
  if (!encrypted || !encrypted.startsWith('ENC:')) {
    return encrypted; // 평문 (하위 호환)
  }
  try {
    const parts = encrypted.split(':');
    if (parts.length !== 4) {
      return encrypted; // 잘못된 형식, 평문으로 반환
    }
    const [, ivB64, tagB64, ciphertext] = parts;
    const key = getMachineKey();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return decipher.update(ciphertext, 'base64', 'utf8') + decipher.final('utf8');
  } catch {
    // 복호화 실패 시 원본 반환 (다른 머신에서 생성된 경우 등)
    console.warn('[claude-remote-guard] 시크릿 복호화 실패: 다른 머신에서 암호화되었거나 손상됨');
    return encrypted;
  }
}

// ============================================================
// Phase 3.2: HMAC 무결성 검증
// ============================================================

/**
 * 설정 객체의 HMAC 계산 (_hmac 필드 제외)
 */
function computeConfigHmac(config: Config): string {
  const key = getMachineKey();
  // _hmac 필드를 제외한 설정 복사
  const configWithoutHmac = { ...config };
  delete (configWithoutHmac as Record<string, unknown>)['_hmac'];
  const data = JSON.stringify(configWithoutHmac);
  return crypto.createHmac('sha256', key).update(data).digest('base64');
}

// ============================================================
// 헬퍼 함수: 중첩 객체 경로 접근
// ============================================================

/**
 * 점(.) 표기법 경로로 중첩 객체의 값 가져오기
 * 예: getNestedValue(obj, 'messenger.telegram.botToken')
 */
function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split('.');
  let current: unknown = obj;
  for (const key of keys) {
    if (current === null || current === undefined || typeof current !== 'object') {
      return undefined;
    }
    current = (current as Record<string, unknown>)[key];
  }
  return current;
}

/**
 * 점(.) 표기법 경로로 중첩 객체에 값 설정
 * 중간 경로가 없으면 생성
 */
function setNestedValue(obj: Record<string, unknown>, path: string, value: unknown): void {
  const keys = path.split('.');
  let current = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const key = keys[i];
    if (!(key in current) || typeof current[key] !== 'object' || current[key] === null) {
      current[key] = {};
    }
    current = current[key] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

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

    // Phase 3.2: HMAC 무결성 검증
    const storedHmac = rawConfig._hmac;
    if (storedHmac) {
      // _hmac 필드를 제외하고 검증
      const configWithoutHmac = { ...rawConfig };
      delete configWithoutHmac._hmac;
      const computedHmac = computeConfigHmac(configWithoutHmac as Config);
      if (storedHmac !== computedHmac) {
        console.warn(
          '[claude-remote-guard] 경고: 설정 파일 무결성 검증 실패. ' +
            '파일이 외부에서 수정되었거나 다른 머신에서 생성되었을 수 있습니다.'
        );
      }
    }

    // Phase 3.1: 민감한 필드 복호화
    const config = rawConfig as Config;
    for (const fieldPath of SENSITIVE_FIELDS) {
      const encryptedValue = getNestedValue(config as unknown as Record<string, unknown>, fieldPath);
      if (typeof encryptedValue === 'string' && encryptedValue) {
        const decrypted = decryptSecret(encryptedValue);
        setNestedValue(config as unknown as Record<string, unknown>, fieldPath, decrypted);
      }
    }

    // Phase 2.1: 환경변수로 오버라이드
    for (const [envVar, configPath] of Object.entries(ENV_MAPPING)) {
      const envValue = process.env[envVar];
      if (envValue !== undefined) {
        // timeoutSeconds는 숫자로 변환
        if (configPath === 'rules.timeoutSeconds') {
          const parsed = parseInt(envValue, 10);
          if (!isNaN(parsed)) {
            setNestedValue(config as unknown as Record<string, unknown>, configPath, parsed);
          }
        } else {
          setNestedValue(config as unknown as Record<string, unknown>, configPath, envValue);
        }
      }
    }

    return validateConfig(config) ? config : null;
  } catch {
    return null;
  }
}

export function saveConfig(config: Config): void {
  if (!fs.existsSync(CONFIG_DIR)) {
    fs.mkdirSync(CONFIG_DIR, { recursive: true, mode: 0o700 });
  }

  // Phase 3.1: 저장 전 민감한 필드 암호화
  const configToSave = JSON.parse(JSON.stringify(config)) as Record<string, unknown>;
  for (const fieldPath of SENSITIVE_FIELDS) {
    const plainValue = getNestedValue(configToSave, fieldPath);
    if (typeof plainValue === 'string' && plainValue && !plainValue.startsWith('ENC:')) {
      const encrypted = encryptSecret(plainValue);
      setNestedValue(configToSave, fieldPath, encrypted);
    }
  }

  // Phase 3.2: HMAC 계산 및 추가
  const hmac = computeConfigHmac(configToSave as unknown as Config);
  configToSave._hmac = hmac;

  fs.writeFileSync(CONFIG_FILE, JSON.stringify(configToSave, null, 2), {
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
