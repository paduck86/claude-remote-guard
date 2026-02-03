// Supabase Edge Function for Telegram Bot Callbacks
// Deploy: supabase functions deploy telegram-callback
//
// Required environment variables:
// - TELEGRAM_BOT_TOKEN: Your Telegram bot token
// - TELEGRAM_WEBHOOK_SECRET: Secret token for webhook verification (set via setWebhook API)
// - SUPABASE_URL: Auto-provided by Supabase
// - SUPABASE_SERVICE_ROLE_KEY: Auto-provided by Supabase

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

// Timing-safe string comparison to prevent timing attacks
function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i++) {
    result |= a.charCodeAt(i) ^ b.charCodeAt(i);
  }
  return result === 0;
}

interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
}

interface TelegramMessage {
  message_id: number;
  chat: { id: number };
}

interface CallbackQuery {
  id: string;
  from: TelegramUser;
  message?: TelegramMessage;
  data?: string;
}

interface TelegramUpdate {
  update_id: number;
  callback_query?: CallbackQuery;
}

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const botToken = Deno.env.get('TELEGRAM_BOT_TOKEN');
    if (!botToken) {
      console.error('Missing TELEGRAM_BOT_TOKEN environment variable');
      return new Response('Server configuration error', { status: 500 });
    }

    // Verify webhook secret token
    const webhookSecret = Deno.env.get('TELEGRAM_WEBHOOK_SECRET');
    if (!webhookSecret) {
      console.error('Missing TELEGRAM_WEBHOOK_SECRET environment variable');
      return new Response('Server configuration error', { status: 500 });
    }

    const headerToken = req.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!headerToken || !timingSafeEqual(headerToken, webhookSecret)) {
      console.error('Invalid or missing Telegram webhook secret token');
      return new Response('Unauthorized', { status: 401 });
    }

    const update: TelegramUpdate = await req.json();
    if (!update.callback_query) {
      return new Response('OK', { status: 200 });
    }

    const callbackQuery = update.callback_query;
    const callbackData = callbackQuery.data;
    if (!callbackData) {
      return new Response('No callback data', { status: 400 });
    }

    const [action, requestId] = callbackData.split(':');
    if (!action || !requestId || (action !== 'approve' && action !== 'reject')) {
      return new Response('Invalid callback data format', { status: 400 });
    }

    const status = action === 'approve' ? 'approved' : 'rejected';
    const resolvedBy = callbackQuery.from.username ||
      `${callbackQuery.from.first_name}${callbackQuery.from.last_name ? ' ' + callbackQuery.from.last_name : ''}` ||
      String(callbackQuery.from.id);

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase environment variables');
      return new Response('Server configuration error', { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);
    const { data, error } = await supabase
      .from('approval_requests')
      .update({
        status,
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedBy,
      })
      .eq('id', requestId)
      .eq('status', 'pending')
      .select('id');

    if (error) {
      console.error('Failed to update request:', error);
      await answerCallbackQuery(botToken, callbackQuery.id, '❌ Failed to update request');
      return new Response('Failed to update request', { status: 500 });
    }

    if (!data || data.length === 0) {
      await answerCallbackQuery(botToken, callbackQuery.id, '⚠️ Request not found or already resolved');
      return new Response('OK', { status: 200 });
    }

    const emoji = status === 'approved' ? '✅' : '❌';
    const actionText = status === 'approved' ? 'Approved' : 'Rejected';
    await answerCallbackQuery(botToken, callbackQuery.id, `${emoji} ${actionText}`);

    if (callbackQuery.message) {
      await editMessageReplyMarkup(botToken, callbackQuery.message.chat.id, callbackQuery.message.message_id, `\n\n${emoji} *${actionText}* by @${resolvedBy}`);
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Error processing request:', error);
    return new Response('Internal server error', { status: 500 });
  }
});

async function answerCallbackQuery(botToken: string, callbackQueryId: string, text: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/answerCallbackQuery`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
}

async function editMessageReplyMarkup(botToken: string, chatId: number, messageId: number, appendText: string): Promise<void> {
  await fetch(`https://api.telegram.org/bot${botToken}/editMessageReplyMarkup`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  });
  await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      reply_to_message_id: messageId,
      text: appendText.replace(/[_*\[\]()~`>#+\-=|{}.!\\]/g, '\\$&'),
      parse_mode: 'MarkdownV2',
    }),
  });
}
