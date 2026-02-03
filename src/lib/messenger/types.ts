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

export interface Messenger {
  readonly type: MessengerType;
  sendNotification(message: MessengerMessage): Promise<MessengerResult>;
  sendTestNotification(): Promise<MessengerResult>;
  validateConfig(): boolean;
}
