// Types
export type { Messenger, MessengerMessage, MessengerResult, MessengerType } from './types.js';

// Base utilities
export { maskSensitiveInfo, truncateCommand, getSeverityEmoji, getSeverityColor } from './base.js';

// Messenger implementations
export { SlackMessenger, type SlackConfig } from './slack.js';
export { TelegramMessenger, type TelegramConfig } from './telegram.js';
export { WhatsAppMessenger, type WhatsAppConfig } from './whatsapp.js';

// Factory
export { MessengerFactory, type MessengerConfig } from './factory.js';
