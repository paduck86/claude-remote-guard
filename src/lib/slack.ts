/**
 * @deprecated This file is maintained for backward compatibility.
 * Use the messenger module instead:
 * import { SlackMessenger, MessengerFactory } from './messenger/index.js';
 */

import { SlackMessenger, type SlackConfig as NewSlackConfig } from './messenger/slack.js';
import type { MessengerMessage, MessengerResult } from './messenger/types.js';

// Re-export types for backward compatibility
export type SlackMessage = MessengerMessage;
export type SlackConfig = NewSlackConfig;

/**
 * @deprecated Use SlackMessenger.sendNotification() instead
 */
export async function sendSlackNotification(
  webhookUrl: string,
  message: SlackMessage
): Promise<MessengerResult> {
  const messenger = new SlackMessenger({ webhookUrl });
  return messenger.sendNotification(message);
}

/**
 * @deprecated Use SlackMessenger.sendTestNotification() instead
 */
export async function sendTestNotification(
  webhookUrl: string
): Promise<MessengerResult> {
  const messenger = new SlackMessenger({ webhookUrl });
  return messenger.sendTestNotification();
}
