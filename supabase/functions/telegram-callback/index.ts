// Supabase Edge Function for Telegram Bot Callbacks
// Deploy: supabase functions deploy telegram-callback
//
// Required environment variables:
// - TELEGRAM_BOT_TOKEN: Your Telegram bot token
// - TELEGRAM_WEBHOOK_SECRET: Secret token for webhook verification (set via setWebhook API)
// - SUPABASE_URL: Auto-provided by Supabase
// - SUPABASE_SERVICE_ROLE_KEY: Auto-provided by Supabase

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

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
  const payload = `${machineId}:${timestampStr}`;
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

serve(async (req: Request) => {
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
      `${callbackQuery.from.first_name}${callbackQuery.from.last_name ? ' ' + callbackQuery.from.last_name : ''}` ||
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
