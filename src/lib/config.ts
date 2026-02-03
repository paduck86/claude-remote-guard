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
  'machineIdSecret',
];

/**
 * 머신 고유 키 생성 (PBKDF2 + 다중 엔트로피 소스)
 * 해당 머신에서만 복호화 가능
 */
function getMachineKey(): Buffer {
  const components = [
    os.hostname(),
    os.userInfo().username,
    os.cpus()[0]?.model || '',
    os.platform(),
    os.arch(),
    os.totalmem().toString(),
  ];

  // Linux/macOS에서 machine-id 추가
  try {
    if (fs.existsSync('/etc/machine-id')) {
      components.push(fs.readFileSync('/etc/machine-id', 'utf8').trim());
    } else if (fs.existsSync('/var/lib/dbus/machine-id')) {
      components.push(fs.readFileSync('/var/lib/dbus/machine-id', 'utf8').trim());
    }
  } catch {
    // machine-id 읽기 실패는 무시
  }

  const raw = components.join(':');

  // PBKDF2로 키 파생 (100,000 iterations)
  const salt = 'claude-remote-guard-v1'; // 고정 솔트 (버전 관리용)
  return crypto.pbkdf2Sync(raw, salt, 100000, 32, 'sha256');
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
 * 서명된 machine_id 생성용 비밀 키 생성
 * 32바이트 랜덤 hex 문자열 반환
 */
function generateMachineIdSecret(): string {
  return crypto.randomBytes(32).toString('hex');
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
    // 복호화 실패 시 예외 발생 (보안)
    // 다른 머신에서 생성된 config는 사용 불가
    console.error('[claude-remote-guard] 오류: 시크릿 복호화 실패. 다른 머신에서 생성된 설정 파일입니다.');
    throw new Error('시크릿 복호화 실패. claude-remote-guard init 으로 재설정하세요.');
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
  machineIdSecret?: string; // 서명된 machine_id 생성용 비밀 키
}

// Legacy config for backward compatibility
export interface LegacyConfig {
  slack: SlackConfig;
  supabase: SupabaseConfig;
  rules: RulesConfig;
}

const CONFIG_DIR = path.join(os.homedir(), '.claude-remote-guard');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

// ============================================================
// Phase 3.3: Symlink Race Condition 방지
// ============================================================

/**
 * 주어진 경로가 심볼릭 링크인지 확인
 * lstat을 사용하여 링크 자체의 정보를 가져옴 (따라가지 않음)
 */
function isSymlink(filePath: string): boolean {
  try {
    const stats = fs.lstatSync(filePath);
    return stats.isSymbolicLink();
  } catch {
    return false; // 파일이 없으면 false
  }
}

/**
 * 디렉토리 보안 검사 및 생성
 * - 심볼릭 링크 여부 검사
 * - 권한이 0700이 아니면 경고 후 변경
 */
function ensureSecureDirectory(dirPath: string): void {
  // 디렉토리가 심볼릭 링크인지 확인
  if (isSymlink(dirPath)) {
    throw new Error(`보안 오류: ${dirPath}가 심볼릭 링크입니다. 직접 디렉토리를 사용하세요.`);
  }

  // 디렉토리 생성
  if (!fs.existsSync(dirPath)) {
    fs.mkdirSync(dirPath, { mode: 0o700, recursive: true });
  }

  // 디렉토리 권한 확인 (소유자만 접근 가능)
  const stats = fs.statSync(dirPath);
  const mode = stats.mode & 0o777;
  if (mode !== 0o700) {
    console.warn(
      `[claude-remote-guard] 경고: ${dirPath} 권한이 ${mode.toString(8)}입니다. 0700으로 변경합니다.`
    );
    fs.chmodSync(dirPath, 0o700);
  }
}

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

  // Phase 3.3: 심볼릭 링크 검사 (Symlink Race Condition 방지)
  if (isSymlink(CONFIG_FILE)) {
    console.error(`[claude-remote-guard] 보안 오류: ${CONFIG_FILE}가 심볼릭 링크입니다.`);
    console.error('[claude-remote-guard] 해결: 심볼릭 링크를 삭제하고 claude-remote-guard init 으로 재설정하세요.');
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
        console.error(
          '[claude-remote-guard] 오류: 설정 파일 무결성 검증 실패. 설정이 변조되었을 수 있습니다.'
        );
        console.error('[claude-remote-guard] 해결: claude-remote-guard init 으로 재설정하세요.');
        return null; // 설정 로드 거부
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

    // Phase 2.1: 환경변수로 오버라이드 (보안 설정 완화 방지)
    const SECURITY_SETTINGS = ['rules.defaultAction', 'rules.timeoutSeconds'];

    for (const [envVar, configPath] of Object.entries(ENV_MAPPING)) {
      const envValue = process.env[envVar];
      if (envValue !== undefined) {
        // 보안 설정 완화 방지
        if (SECURITY_SETTINGS.includes(configPath)) {
          const currentValue = getNestedValue(config as unknown as Record<string, unknown>, configPath);

          // defaultAction: allow로 완화 불가
          if (configPath === 'rules.defaultAction' && envValue === 'allow' && currentValue === 'deny') {
            console.warn(
              `[claude-remote-guard] 경고: 환경변수로 defaultAction을 'allow'로 완화할 수 없습니다.`
            );
            continue;
          }

          // timeoutSeconds: 60초 미만으로 완화 불가
          if (configPath === 'rules.timeoutSeconds') {
            const numValue = parseInt(envValue, 10);
            if (isNaN(numValue) || numValue < 60) {
              console.warn(
                `[claude-remote-guard] 경고: 환경변수로 timeoutSeconds를 60초 미만으로 설정할 수 없습니다.`
              );
              continue;
            }
            setNestedValue(config as unknown as Record<string, unknown>, configPath, numValue);
            continue;
          }
        }

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
  // Phase 3.3: 디렉토리 보안 검사 (Symlink Race Condition 방지)
  ensureSecureDirectory(CONFIG_DIR);

  // Phase 3.3: config.json이 심볼릭 링크인지 확인
  if (isSymlink(CONFIG_FILE)) {
    throw new Error(
      `보안 오류: ${CONFIG_FILE}가 심볼릭 링크입니다. 파일을 삭제하고 다시 시도하세요.`
    );
  }

  // machineIdSecret이 없으면 자동 생성
  if (!config.machineIdSecret) {
    config.machineIdSecret = generateMachineIdSecret();
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
