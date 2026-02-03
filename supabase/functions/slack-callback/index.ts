// Supabase Edge Function for Slack Interactive Callbacks
// Deploy: supabase functions deploy slack-callback
//
// Required environment variables:
// - SLACK_SIGNING_SECRET: Your Slack app's signing secret
// - SUPABASE_URL: Auto-provided by Supabase
// - SUPABASE_SERVICE_ROLE_KEY: Auto-provided by Supabase

import { serve } from 'https://deno.land/std@0.168.0/http/server.ts';
import { createClient, SupabaseClient } from 'https://esm.sh/@supabase/supabase-js@2';

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

  const baseString = `v0:${timestamp}:${body}`;
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
        ? `:white_check_mark: *Approved* by @${resolvedBy}`
        : `:x: *Rejected* by @${resolvedBy}`;

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
