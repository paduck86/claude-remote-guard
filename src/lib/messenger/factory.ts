import type { Messenger, MessengerType } from './types.js';
import { SlackMessenger, type SlackConfig } from './slack.js';
import { TelegramMessenger, type TelegramConfig } from './telegram.js';
import { WhatsAppMessenger, type WhatsAppConfig } from './whatsapp.js';

export interface MessengerConfig {
  type: MessengerType;
  slack?: SlackConfig;
  telegram?: TelegramConfig;
  whatsapp?: WhatsAppConfig;
}

export class MessengerFactory {
  static create(config: MessengerConfig): Messenger {
    switch (config.type) {
      case 'slack':
        if (!config.slack) {
          throw new Error('Slack configuration is required when type is "slack"');
        }
        return new SlackMessenger(config.slack);

      case 'telegram':
        if (!config.telegram) {
          throw new Error('Telegram configuration is required when type is "telegram"');
        }
        return new TelegramMessenger(config.telegram);

      case 'whatsapp':
        if (!config.whatsapp) {
          throw new Error('WhatsApp configuration is required when type is "whatsapp"');
        }
        return new WhatsAppMessenger(config.whatsapp);

      default:
        throw new Error(`Unknown messenger type: ${config.type}`);
    }
  }

  static getMessengerTypeLabel(type: MessengerType): string {
    switch (type) {
      case 'slack':
        return 'Slack';
      case 'telegram':
        return 'Telegram';
      case 'whatsapp':
        return 'WhatsApp (Twilio)';
    }
  }
}
