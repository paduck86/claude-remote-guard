import * as fs from 'node:fs';
import * as path from 'node:path';
import type { MessengerType } from './messenger/types.js';

// Slack Edge Function Code
export const SLACK_EDGE_FUNCTION_CODE = `// Supabase Edge Function for Slack Interactive Callbacks
// Deploy: supabase functions deploy slack-callback
//
// Required environment variables:
// - SLACK_SIGNING_SECRET: Your Slack app's signing secret
// - SUPABASE_URL: Auto-provided by Supabase
// - SUPABASE_SERVICE_ROLE_KEY: Auto-provided by Supabase

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2';

interface SlackAction {
  action_id: string;
  value: string;
}

interface SlackUser {
  id: string;
  username: string;
  name: string;
}

interface SlackPayload {
  type: string;
  user: SlackUser;
  actions: SlackAction[];
  response_url: string;
}

// HMAC-SHA256 signature verification for Slack requests
async function verifySlackSignature(
  body: string,
  timestamp: string,
  signature: string,
  signingSecret: string
): Promise<boolean> {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(signingSecret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );

  const baseString = \`v0:\${timestamp}:\${body}\`;
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(baseString));
  const computedSignature = 'v0=' + Array.from(new Uint8Array(signatureBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');

  // Timing-safe comparison
  if (computedSignature.length !== signature.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < computedSignature.length; i++) {
    result |= computedSignature.charCodeAt(i) ^ signature.charCodeAt(i);
  }
  return result === 0;
}

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const signingSecret = Deno.env.get('SLACK_SIGNING_SECRET');
    if (!signingSecret) {
      console.error('Missing SLACK_SIGNING_SECRET environment variable');
      return new Response('Server configuration error', { status: 500 });
    }

    const slackSignature = req.headers.get('x-slack-signature');
    const slackTimestamp = req.headers.get('x-slack-request-timestamp');

    if (!slackSignature || !slackTimestamp) {
      console.error('Missing Slack signature headers');
      return new Response('Unauthorized', { status: 401 });
    }

    const currentTime = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(slackTimestamp, 10);
    if (Math.abs(currentTime - requestTime) > 300) {
      console.error('Request timestamp too old');
      return new Response('Unauthorized', { status: 401 });
    }

    const bodyText = await req.text();
    const isValid = await verifySlackSignature(bodyText, slackTimestamp, slackSignature, signingSecret);
    if (!isValid) {
      console.error('Invalid Slack signature');
      return new Response('Unauthorized', { status: 401 });
    }

    const params = new URLSearchParams(bodyText);
    const payloadStr = params.get('payload');
    if (!payloadStr) {
      return new Response('Invalid payload', { status: 400 });
    }

    const payload: SlackPayload = JSON.parse(payloadStr);
    if (payload.type !== 'block_actions') {
      return new Response('Unsupported interaction type', { status: 400 });
    }

    const action = payload.actions[0];
    if (!action) {
      return new Response('No action found', { status: 400 });
    }

    const { action_id, value: requestId } = action;
    const resolvedBy = payload.user.username || payload.user.name || payload.user.id;

    let status: 'approved' | 'rejected';
    if (action_id === 'approve_command') {
      status = 'approved';
    } else if (action_id === 'reject_command') {
      status = 'rejected';
    } else {
      return new Response('Unknown action', { status: 400 });
    }

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
      return new Response('Failed to update request', { status: 500 });
    }

    if (!data || data.length === 0) {
      console.error('Request not found or already resolved:', requestId);
      return new Response('Request not found or already resolved', { status: 404 });
    }

    const responseMessage =
      status === 'approved'
        ? \`:white_check_mark: *Approved* by @\${resolvedBy}\`
        : \`:x: *Rejected* by @\${resolvedBy}\`;

    if (payload.response_url) {
      await fetch(payload.response_url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          replace_original: false,
          text: responseMessage,
        }),
      });
    }

    return new Response('OK', { status: 200, headers: { 'Content-Type': 'text/plain' } });
  } catch (error) {
    console.error('Error processing request:', error);
    return new Response('Internal server error', { status: 500 });
  }
});
`;

// Telegram Edge Function Code
export const TELEGRAM_EDGE_FUNCTION_CODE = `// Supabase Edge Function for Telegram Bot Callbacks
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
      \`\${callbackQuery.from.first_name}\${callbackQuery.from.last_name ? ' ' + callbackQuery.from.last_name : ''}\` ||
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
    await answerCallbackQuery(botToken, callbackQuery.id, \`\${emoji} \${actionText}\`);

    if (callbackQuery.message) {
      await editMessageReplyMarkup(botToken, callbackQuery.message.chat.id, callbackQuery.message.message_id, \`\\n\\n\${emoji} *\${actionText}* by @\${resolvedBy}\`);
    }

    return new Response('OK', { status: 200 });
  } catch (error) {
    console.error('Error processing request:', error);
    return new Response('Internal server error', { status: 500 });
  }
});

async function answerCallbackQuery(botToken: string, callbackQueryId: string, text: string): Promise<void> {
  await fetch(\`https://api.telegram.org/bot\${botToken}/answerCallbackQuery\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ callback_query_id: callbackQueryId, text, show_alert: false }),
  });
}

async function editMessageReplyMarkup(botToken: string, chatId: number, messageId: number, appendText: string): Promise<void> {
  await fetch(\`https://api.telegram.org/bot\${botToken}/editMessageReplyMarkup\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } }),
  });
  await fetch(\`https://api.telegram.org/bot\${botToken}/sendMessage\`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      chat_id: chatId,
      reply_to_message_id: messageId,
      text: appendText.replace(/[_*\\[\\]()~\`>#+\\-=|{}.!\\\\]/g, '\\\\$&'),
      parse_mode: 'MarkdownV2',
    }),
  });
}
`;

// WhatsApp (Twilio) Edge Function Code
export const WHATSAPP_EDGE_FUNCTION_CODE = `// Supabase Edge Function for WhatsApp (Twilio) Callbacks
// Deploy: supabase functions deploy whatsapp-callback
//
// Required environment variables:
// - TWILIO_AUTH_TOKEN: Your Twilio auth token for signature verification
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

async function verifyTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>
): Promise<boolean> {
  const sortedParams = Object.keys(params).sort().map(key => \`\${key}\${params[key]}\`).join('');
  const data = url + sortedParams;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(authToken), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']);
  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const computedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));
  return timingSafeEqual(signature, computedSignature);
}

serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    if (!authToken) {
      console.error('Missing TWILIO_AUTH_TOKEN environment variable');
      return new Response('Server configuration error', { status: 500 });
    }

    const formData = await req.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => { params[key] = value.toString(); });

    const twilioSignature = req.headers.get('X-Twilio-Signature');
    if (!twilioSignature) {
      console.error('Missing Twilio signature header');
      return new Response('Unauthorized', { status: 401 });
    }

    const isValid = await verifyTwilioSignature(authToken, twilioSignature, req.url, params);
    if (!isValid) {
      console.error('Invalid Twilio signature');
      return new Response('Unauthorized', { status: 401 });
    }

    const body = params['Body']?.trim();
    const from = params['From'];
    if (!body) {
      return twimlResponse('No message body received.');
    }

    const match = body.match(/^(APPROVE|REJECT)\\s+([a-f0-9-]+)$/i);
    if (!match) {
      return twimlResponse('Invalid format. Use:\\nAPPROVE <request-id>\\nor\\nREJECT <request-id>');
    }

    const [, action, requestId] = match;
    const status = action.toUpperCase() === 'APPROVE' ? 'approved' : 'rejected';
    const resolvedBy = from?.replace('whatsapp:', '') || 'unknown';

    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase environment variables');
      return twimlResponse('Server configuration error.');
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
      return twimlResponse('Failed to update request. Please try again.');
    }

    if (!data || data.length === 0) {
      return twimlResponse('Request not found or already resolved.');
    }

    const emoji = status === 'approved' ? '✅' : '❌';
    const actionText = status === 'approved' ? 'approved' : 'rejected';
    return twimlResponse(\`\${emoji} Request \${requestId.substring(0, 8)}... has been \${actionText}.\`);
  } catch (error) {
    console.error('Error processing request:', error);
    return twimlResponse('Internal server error.');
  }
});

function twimlResponse(message: string): Response {
  const twiml = \`<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>\${escapeXml(message)}</Message>
</Response>\`;
  return new Response(twiml, { status: 200, headers: { 'Content-Type': 'application/xml' } });
}

function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&apos;');
}
`;

// Legacy export for backward compatibility
export const EDGE_FUNCTION_CODE = SLACK_EDGE_FUNCTION_CODE;

export interface CreateEdgeFunctionResult {
  success: boolean;
  path?: string;
  error?: string;
}

interface EdgeFunctionInfo {
  code: string;
  folderName: string;
  envVars: string[];
}

const EDGE_FUNCTIONS: Record<MessengerType, EdgeFunctionInfo> = {
  slack: {
    code: SLACK_EDGE_FUNCTION_CODE,
    folderName: 'slack-callback',
    envVars: ['SLACK_SIGNING_SECRET'],
  },
  telegram: {
    code: TELEGRAM_EDGE_FUNCTION_CODE,
    folderName: 'telegram-callback',
    envVars: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET'],
  },
  whatsapp: {
    code: WHATSAPP_EDGE_FUNCTION_CODE,
    folderName: 'whatsapp-callback',
    envVars: ['TWILIO_AUTH_TOKEN'],
  },
};

export function createEdgeFunctionFiles(
  targetDir: string,
  messengerType: MessengerType = 'slack'
): CreateEdgeFunctionResult {
  try {
    const funcInfo = EDGE_FUNCTIONS[messengerType];
    const functionsDir = path.join(targetDir, 'supabase', 'functions', funcInfo.folderName);

    fs.mkdirSync(functionsDir, { recursive: true });

    const filePath = path.join(functionsDir, 'index.ts');
    fs.writeFileSync(filePath, funcInfo.code, 'utf-8');

    return {
      success: true,
      path: path.join('supabase', 'functions', funcInfo.folderName),
    };
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

export function getEdgeFunctionEnvVars(messengerType: MessengerType): string[] {
  return EDGE_FUNCTIONS[messengerType].envVars;
}

export function getEdgeFunctionName(messengerType: MessengerType): string {
  return EDGE_FUNCTIONS[messengerType].folderName;
}
