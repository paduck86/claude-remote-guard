import type { Severity } from '../rules.js';

export type MessengerType = 'slack' | 'telegram' | 'whatsapp';

export interface MessengerMessage {
  requestId: string;
  command: string;
  reason: string;
  severity: Severity;
  cwd: string;
  timestamp: number;
}

export interface MessengerResult {
  ok: boolean;
  error?: string;
}

// testConnection() 결과: 성공 시 info에 메신저별 정보 포함
export interface ConnectionTestResult {
  ok: boolean;
  error?: string;
  info?: {
    // Telegram: Bot username
    botUsername?: string;
    // WhatsApp/Twilio: Account friendly name
    accountName?: string;
  };
}

export interface Messenger {
  readonly type: MessengerType;
  sendNotification(message: MessengerMessage): Promise<MessengerResult>;
  sendTestNotification(): Promise<MessengerResult>;
  validateConfig(): boolean;
  // API를 호출하여 연결 테스트 (Bot Token, Account 등 검증)
  testConnection(): Promise<ConnectionTestResult>;
}
