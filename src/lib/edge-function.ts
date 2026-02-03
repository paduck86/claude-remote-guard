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

// npm: specifier 사용 (Supabase Edge Runtime --no-remote 호환)
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

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

// UUID v4 형식 검증
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUUID(id: string): boolean {
  return UUID_V4_REGEX.test(id);
}

/**
 * 서명된 machine_id 검증
 * 형식: machineId:timestamp:signature (secret 설정 시)
 * 또는 machineId (secret 미설정 시 기존 방식)
 */
async function verifySignedMachineId(
  signedId: string | null,
  maxAgeSeconds = 600
): Promise<{ valid: boolean; machineId: string | null }> {
  if (!signedId) return { valid: false, machineId: null };

  const secret = Deno.env.get('MACHINE_ID_SECRET');
  if (!secret) {
    // secret 미설정 시 기존 방식 (32자 hex 검증만)
    const isValidFormat = /^[a-f0-9]{32}$/i.test(signedId);
    return { valid: isValidFormat, machineId: isValidFormat ? signedId : null };
  }

  const parts = signedId.split(':');
  if (parts.length !== 3) return { valid: false, machineId: null };

  const [machineId, timestampStr, signature] = parts;
  const timestamp = parseInt(timestampStr, 10);

  // 만료 확인
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > maxAgeSeconds) {
    return { valid: false, machineId: null };
  }

  // 서명 검증
  const payload = \`\${machineId}:\${timestampStr}\`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16);

  // 서명 일치 확인
  if (signature !== expected) {
    return { valid: false, machineId: null };
  }

  return { valid: true, machineId };
}

// 클라이언트 IP 추출 (Supabase/Cloudflare 환경에서 실제 IP 획득)
function getClientIP(req: Request): string {
  // cf-connecting-ip: Cloudflare가 제공하는 실제 클라이언트 IP
  // x-real-ip: 일부 프록시/로드밸런서가 제공
  // x-forwarded-for: 마지막 값이 실제 클라이언트 IP (첫 번째는 스푸핑 가능)
  return req.headers.get('cf-connecting-ip')
    || req.headers.get('x-real-ip')
    || req.headers.get('x-forwarded-for')?.split(',').pop()?.trim()
    || 'unknown';
}

// Supabase 테이블 기반 Rate Limiter (서버리스 환경에서 분산 제한)
async function checkRateLimit(supabase: SupabaseClient, identifier: string): Promise<boolean> {
  const windowMs = 60 * 1000; // 1분
  const maxRequests = 30;
  const now = Date.now();
  const windowStart = now - windowMs;

  // 현재 윈도우 내 요청 수 조회
  const { count, error } = await supabase
    .from('rate_limits')
    .select('*', { count: 'exact', head: true })
    .eq('identifier', identifier)
    .gte('created_at', new Date(windowStart).toISOString());

  if (error) {
    console.error('Rate limit check failed:', error);
    return true; // 에러 시 허용 (서비스 가용성 우선)
  }

  if ((count || 0) >= maxRequests) {
    return false;
  }

  // 새 요청 기록
  await supabase.from('rate_limits').insert({
    identifier,
    created_at: new Date().toISOString(),
  });

  return true;
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

Deno.serve(async (req: Request) => {
  // Only allow POST from Slack
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Initialize Supabase client first for rate limiting
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase environment variables');
      return new Response('Server configuration error', { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Rate limiting 체크 (Supabase 테이블 기반)
    const clientIP = getClientIP(req);
    if (!(await checkRateLimit(supabase, clientIP))) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    // Get Slack signing secret
    const signingSecret = Deno.env.get('SLACK_SIGNING_SECRET');
    if (!signingSecret) {
      console.error('Missing SLACK_SIGNING_SECRET environment variable');
      return new Response('Server configuration error', { status: 500 });
    }

    // Get signature headers
    const slackSignature = req.headers.get('x-slack-signature');
    const slackTimestamp = req.headers.get('x-slack-request-timestamp');

    if (!slackSignature || !slackTimestamp) {
      console.error('Missing Slack signature headers');
      return new Response('Unauthorized', { status: 401 });
    }

    // Check timestamp to prevent replay attacks (5 minute window)
    const currentTime = Math.floor(Date.now() / 1000);
    const requestTime = parseInt(slackTimestamp, 10);
    if (Math.abs(currentTime - requestTime) > 300) {
      console.error('Request timestamp too old');
      return new Response('Unauthorized', { status: 401 });
    }

    // Read body as text for signature verification
    const bodyText = await req.text();

    // Verify signature
    const isValid = await verifySlackSignature(bodyText, slackTimestamp, slackSignature, signingSecret);
    if (!isValid) {
      console.error('Invalid Slack signature');
      return new Response('Unauthorized', { status: 401 });
    }

    // Parse form data from body text
    const params = new URLSearchParams(bodyText);
    const payloadStr = params.get('payload');

    if (!payloadStr) {
      return new Response('Invalid payload', { status: 400 });
    }

    const payload: SlackPayload = JSON.parse(payloadStr);

    // Validate payload type
    if (payload.type !== 'block_actions') {
      return new Response('Unsupported interaction type', { status: 400 });
    }

    // Get action details
    const action = payload.actions[0];
    if (!action) {
      return new Response('No action found', { status: 400 });
    }

    const { action_id, value: requestId } = action;

    // UUID 형식 검증
    if (!isValidUUID(requestId)) {
      console.error('Invalid request ID format:', requestId);
      return new Response('Invalid request ID format', { status: 400 });
    }

    const resolvedBy = payload.user.username || payload.user.name || payload.user.id;

    // Determine status based on action
    let status: 'approved' | 'rejected';
    if (action_id === 'approve_command') {
      status = 'approved';
    } else if (action_id === 'reject_command') {
      status = 'rejected';
    } else {
      return new Response('Unknown action', { status: 400 });
    }

    // 요청 조회 (machine_id 포함)
    const { data: requestData, error: fetchError } = await supabase
      .from('approval_requests')
      .select('id, created_at, status, machine_id')
      .eq('id', requestId)
      .eq('status', 'pending')
      .single();

    if (fetchError || !requestData) {
      console.error('Request not found or already resolved:', requestId);
      return new Response('Request not found or already resolved', { status: 404 });
    }

    // machine_id 서명 검증
    const machineIdSecret = Deno.env.get('MACHINE_ID_SECRET');
    if (machineIdSecret && requestData.machine_id) {
      const verification = await verifySignedMachineId(requestData.machine_id);
      if (!verification.valid) {
        console.error('Invalid machine_id signature:', requestId);
        return new Response(JSON.stringify({ error: 'Invalid machine signature' }), {
          status: 403,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    }

    // Update the approval request
    const { data, error } = await supabase
      .from('approval_requests')
      .update({
        status,
        resolved_at: new Date().toISOString(),
        resolved_by: resolvedBy,
      })
      .eq('id', requestId)
      .eq('status', 'pending') // Only update if still pending
      .select('id');

    if (error) {
      console.error('Failed to update request:', error);
      return new Response('Failed to update request', { status: 500 });
    }

    // Verify that a row was actually updated
    if (!data || data.length === 0) {
      console.error('Request update failed (race condition):', requestId);
      return new Response('Request update failed', { status: 409 });
    }

    // Send response back to Slack to update the message
    const responseMessage =
      status === 'approved'
        ? \`:white_check_mark: *Approved* by @\${resolvedBy}\`
        : \`:x: *Rejected* by @\${resolvedBy}\`;

    // Respond to Slack's response_url to update the original message
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

    return new Response('OK', {
      status: 200,
      headers: { 'Content-Type': 'text/plain' },
    });
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

// npm: specifier 사용 (Supabase Edge Runtime --no-remote 호환)
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

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

// UUID v4 형식 검증
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUUID(id: string): boolean {
  return UUID_V4_REGEX.test(id);
}

/**
 * 서명된 machine_id 검증
 * 형식: machineId:timestamp:signature (secret 설정 시)
 * 또는 machineId (secret 미설정 시 기존 방식)
 */
async function verifySignedMachineId(
  signedId: string | null,
  maxAgeSeconds = 600
): Promise<{ valid: boolean; machineId: string | null }> {
  if (!signedId) return { valid: false, machineId: null };

  const secret = Deno.env.get('MACHINE_ID_SECRET');
  if (!secret) {
    // secret 미설정 시 기존 방식 (32자 hex 검증만)
    const isValidFormat = /^[a-f0-9]{32}$/i.test(signedId);
    return { valid: isValidFormat, machineId: isValidFormat ? signedId : null };
  }

  const parts = signedId.split(':');
  if (parts.length !== 3) return { valid: false, machineId: null };

  const [machineId, timestampStr, signature] = parts;
  const timestamp = parseInt(timestampStr, 10);

  // 만료 확인
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > maxAgeSeconds) {
    return { valid: false, machineId: null };
  }

  // 서명 검증
  const payload = \`\${machineId}:\${timestampStr}\`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16);

  // 서명 일치 확인
  if (signature !== expected) {
    return { valid: false, machineId: null };
  }

  return { valid: true, machineId };
}

// 타임스탬프 검증: 1시간(3600초) 이내 요청만 허용
const MAX_REQUEST_AGE_SECONDS = 3600;
function isRequestExpired(createdAt: string): boolean {
  const createdTime = new Date(createdAt).getTime();
  const now = Date.now();
  return (now - createdTime) / 1000 > MAX_REQUEST_AGE_SECONDS;
}

// 클라이언트 IP 추출 (Supabase/Cloudflare 환경에서 실제 IP 획득)
function getClientIP(req: Request): string {
  // cf-connecting-ip: Cloudflare가 제공하는 실제 클라이언트 IP
  // x-real-ip: 일부 프록시/로드밸런서가 제공
  // x-forwarded-for: 마지막 값이 실제 클라이언트 IP (첫 번째는 스푸핑 가능)
  return req.headers.get('cf-connecting-ip')
    || req.headers.get('x-real-ip')
    || req.headers.get('x-forwarded-for')?.split(',').pop()?.trim()
    || 'unknown';
}

// Supabase 테이블 기반 Rate Limiter (서버리스 환경에서 분산 제한)
async function checkRateLimit(supabase: SupabaseClient, identifier: string): Promise<boolean> {
  const windowMs = 60 * 1000; // 1분
  const maxRequests = 30;
  const now = Date.now();
  const windowStart = now - windowMs;

  // 현재 윈도우 내 요청 수 조회
  const { count, error } = await supabase
    .from('rate_limits')
    .select('*', { count: 'exact', head: true })
    .eq('identifier', identifier)
    .gte('created_at', new Date(windowStart).toISOString());

  if (error) {
    console.error('Rate limit check failed:', error);
    return true; // 에러 시 허용 (서비스 가용성 우선)
  }

  if ((count || 0) >= maxRequests) {
    return false;
  }

  // 새 요청 기록
  await supabase.from('rate_limits').insert({
    identifier,
    created_at: new Date().toISOString(),
  });

  return true;
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

Deno.serve(async (req: Request) => {
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Initialize Supabase client first for rate limiting
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');
    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase environment variables');
      return new Response('Server configuration error', { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Rate limiting 체크 (Supabase 테이블 기반)
    const clientIP = getClientIP(req);
    if (!(await checkRateLimit(supabase, clientIP))) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }

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

    // UUID 형식 검증
    if (!isValidUUID(requestId)) {
      console.error('Invalid request ID format:', requestId);
      return new Response('Invalid request ID format', { status: 400 });
    }

    const status = action === 'approve' ? 'approved' : 'rejected';
    const resolvedBy = callbackQuery.from.username ||
      \`\${callbackQuery.from.first_name}\${callbackQuery.from.last_name ? ' ' + callbackQuery.from.last_name : ''}\` ||
      String(callbackQuery.from.id);

    // 타임스탬프 검증: 요청의 created_at 조회
    const { data: requestData, error: fetchError } = await supabase
      .from('approval_requests')
      .select('id, created_at, status, machine_id')
      .eq('id', requestId)
      .single();

    if (fetchError || !requestData) {
      console.error('Request not found:', requestId);
      await answerCallbackQuery(botToken, callbackQuery.id, '⚠️ Request not found');
      return new Response('Request not found', { status: 404 });
    }

    if (requestData.status !== 'pending') {
      await answerCallbackQuery(botToken, callbackQuery.id, '⚠️ Request already resolved');
      return new Response('OK', { status: 200 });
    }

    // 1시간 이내 요청만 허용
    if (isRequestExpired(requestData.created_at)) {
      console.error('Request expired:', requestId);
      await answerCallbackQuery(botToken, callbackQuery.id, '⏰ Request expired (>1 hour)');
      return new Response('Request expired', { status: 410 });
    }

    // machine_id 서명 검증
    const machineIdSecret = Deno.env.get('MACHINE_ID_SECRET');
    if (machineIdSecret && requestData.machine_id) {
      const verification = await verifySignedMachineId(requestData.machine_id);
      if (!verification.valid) {
        console.error('Invalid machine_id signature:', requestId);
        await answerCallbackQuery(botToken, callbackQuery.id, '⚠️ 유효하지 않은 요청입니다');
        return new Response('Invalid machine signature', { status: 403 });
      }
    }

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

// npm: specifier 사용 (Supabase Edge Runtime --no-remote 호환)
import { createClient, SupabaseClient } from 'npm:@supabase/supabase-js@2';

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

// UUID v4 형식 검증
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUUID(id: string): boolean {
  return UUID_V4_REGEX.test(id);
}

/**
 * 서명된 machine_id 검증
 * 형식: machineId:timestamp:signature (secret 설정 시)
 * 또는 machineId (secret 미설정 시 기존 방식)
 */
async function verifySignedMachineId(
  signedId: string | null,
  maxAgeSeconds = 600
): Promise<{ valid: boolean; machineId: string | null }> {
  if (!signedId) return { valid: false, machineId: null };

  const secret = Deno.env.get('MACHINE_ID_SECRET');
  if (!secret) {
    // secret 미설정 시 기존 방식 (32자 hex 검증만)
    const isValidFormat = /^[a-f0-9]{32}$/i.test(signedId);
    return { valid: isValidFormat, machineId: isValidFormat ? signedId : null };
  }

  const parts = signedId.split(':');
  if (parts.length !== 3) return { valid: false, machineId: null };

  const [machineId, timestampStr, signature] = parts;
  const timestamp = parseInt(timestampStr, 10);

  // 만료 확인
  const now = Math.floor(Date.now() / 1000);
  if (now - timestamp > maxAgeSeconds) {
    return { valid: false, machineId: null };
  }

  // 서명 검증
  const payload = \`\${machineId}:\${timestampStr}\`;
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', key, encoder.encode(payload));
  const expected = Array.from(new Uint8Array(sig))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('')
    .substring(0, 16);

  // 서명 일치 확인
  if (signature !== expected) {
    return { valid: false, machineId: null };
  }

  return { valid: true, machineId };
}

// 타임스탬프 검증: 1시간(3600초) 이내 요청만 허용
const MAX_REQUEST_AGE_SECONDS = 3600;
function isRequestExpired(createdAt: string): boolean {
  const createdTime = new Date(createdAt).getTime();
  const now = Date.now();
  return (now - createdTime) / 1000 > MAX_REQUEST_AGE_SECONDS;
}

// 클라이언트 IP 추출 (Supabase/Cloudflare 환경에서 실제 IP 획득)
function getClientIP(req: Request): string {
  // cf-connecting-ip: Cloudflare가 제공하는 실제 클라이언트 IP
  // x-real-ip: 일부 프록시/로드밸런서가 제공
  // x-forwarded-for: 마지막 값이 실제 클라이언트 IP (첫 번째는 스푸핑 가능)
  return req.headers.get('cf-connecting-ip')
    || req.headers.get('x-real-ip')
    || req.headers.get('x-forwarded-for')?.split(',').pop()?.trim()
    || 'unknown';
}

// Supabase 테이블 기반 Rate Limiter (서버리스 환경에서 분산 제한)
async function checkRateLimit(supabase: SupabaseClient, identifier: string): Promise<boolean> {
  const windowMs = 60 * 1000; // 1분
  const maxRequests = 30;
  const now = Date.now();
  const windowStart = now - windowMs;

  // 현재 윈도우 내 요청 수 조회
  const { count, error } = await supabase
    .from('rate_limits')
    .select('*', { count: 'exact', head: true })
    .eq('identifier', identifier)
    .gte('created_at', new Date(windowStart).toISOString());

  if (error) {
    console.error('Rate limit check failed:', error);
    return true; // 에러 시 허용 (서비스 가용성 우선)
  }

  if ((count || 0) >= maxRequests) {
    return false;
  }

  // 새 요청 기록
  await supabase.from('rate_limits').insert({
    identifier,
    created_at: new Date().toISOString(),
  });

  return true;
}

// Verify Twilio request signature
async function verifyTwilioSignature(
  authToken: string,
  signature: string,
  url: string,
  params: Record<string, string>
): Promise<boolean> {
  // Sort parameters and create string
  const sortedParams = Object.keys(params)
    .sort()
    .map(key => \`\${key}\${params[key]}\`)
    .join('');

  const data = url + sortedParams;

  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(authToken),
    { name: 'HMAC', hash: 'SHA-1' },
    false,
    ['sign']
  );

  const signatureBuffer = await crypto.subtle.sign('HMAC', key, encoder.encode(data));
  const computedSignature = btoa(String.fromCharCode(...new Uint8Array(signatureBuffer)));

  // Timing-safe comparison
  return timingSafeEqual(signature, computedSignature);
}

Deno.serve(async (req: Request) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  try {
    // Initialize Supabase client first for rate limiting
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase environment variables');
      return twimlResponse('Server configuration error.');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // Rate limiting 체크 (Supabase 테이블 기반)
    const clientIP = getClientIP(req);
    if (!(await checkRateLimit(supabase, clientIP))) {
      return new Response(JSON.stringify({ error: 'Too many requests' }), {
        status: 429,
        headers: { 'Content-Type': 'application/json' },
      });
    }

    const authToken = Deno.env.get('TWILIO_AUTH_TOKEN');
    if (!authToken) {
      console.error('Missing TWILIO_AUTH_TOKEN environment variable');
      return new Response('Server configuration error', { status: 500 });
    }

    // Parse form data
    const formData = await req.formData();
    const params: Record<string, string> = {};
    formData.forEach((value, key) => {
      params[key] = value.toString();
    });

    // Verify Twilio signature (required for security)
    const twilioSignature = req.headers.get('X-Twilio-Signature');
    if (!twilioSignature) {
      console.error('Missing Twilio signature header');
      return new Response('Unauthorized', { status: 401 });
    }

    const isValid = await verifyTwilioSignature(
      authToken,
      twilioSignature,
      req.url,
      params
    );
    if (!isValid) {
      console.error('Invalid Twilio signature');
      return new Response('Unauthorized', { status: 401 });
    }

    // Get message body
    const body = params['Body']?.trim();
    const from = params['From'];

    if (!body) {
      return twimlResponse('No message body received.');
    }

    // Parse command: "APPROVE <requestId>" or "REJECT <requestId>"
    const match = body.match(/^(APPROVE|REJECT)\\s+([a-f0-9-]+)$/i);

    if (!match) {
      return twimlResponse(
        'Invalid format. Use:\\nAPPROVE <request-id>\\nor\\nREJECT <request-id>'
      );
    }

    const [, action, requestId] = match;

    // UUID 형식 검증
    if (!isValidUUID(requestId)) {
      return twimlResponse('Invalid request ID format.');
    }

    const status = action.toUpperCase() === 'APPROVE' ? 'approved' : 'rejected';

    // Extract phone number for resolved_by
    const resolvedBy = from?.replace('whatsapp:', '') || 'unknown';

    // 타임스탬프 검증: 요청의 created_at 조회
    const { data: requestData, error: fetchError } = await supabase
      .from('approval_requests')
      .select('id, created_at, status, machine_id')
      .eq('id', requestId)
      .single();

    if (fetchError || !requestData) {
      return twimlResponse('Request not found.');
    }

    if (requestData.status !== 'pending') {
      return twimlResponse('Request already resolved.');
    }

    // 1시간 이내 요청만 허용
    if (isRequestExpired(requestData.created_at)) {
      return twimlResponse('⏰ Request expired (over 1 hour old).');
    }

    // machine_id 서명 검증
    const machineIdSecret = Deno.env.get('MACHINE_ID_SECRET');
    if (machineIdSecret && requestData.machine_id) {
      const verification = await verifySignedMachineId(requestData.machine_id);
      if (!verification.valid) {
        console.error('Invalid machine_id signature:', requestId);
        return new Response(
          '<?xml version="1.0" encoding="UTF-8"?><Response><Message>Invalid request signature</Message></Response>',
          { status: 403, headers: { 'Content-Type': 'text/xml' } }
        );
      }
    }

    // Update the approval request
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

    // Send success response
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

  return new Response(twiml, {
    status: 200,
    headers: {
      'Content-Type': 'application/xml',
    },
  });
}

function escapeXml(text: string): string {
  return text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
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
    envVars: ['SLACK_SIGNING_SECRET', 'MACHINE_ID_SECRET'],
  },
  telegram: {
    code: TELEGRAM_EDGE_FUNCTION_CODE,
    folderName: 'telegram-callback',
    envVars: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_WEBHOOK_SECRET', 'MACHINE_ID_SECRET'],
  },
  whatsapp: {
    code: WHATSAPP_EDGE_FUNCTION_CODE,
    folderName: 'whatsapp-callback',
    envVars: ['TWILIO_AUTH_TOKEN', 'MACHINE_ID_SECRET'],
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

/**
 * Edge Function 소스 코드를 문자열로 반환
 * 자동 배포 시 사용
 */
export function getEdgeFunctionSource(messengerType: MessengerType): string {
  return EDGE_FUNCTIONS[messengerType].code;
}
