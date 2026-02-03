// Supabase Edge Function for WhatsApp (Twilio) Callbacks
// Deploy: supabase functions deploy whatsapp-callback
//
// Required environment variables:
// - TWILIO_AUTH_TOKEN: Your Twilio auth token for signature verification
// - SUPABASE_URL: Auto-provided by Supabase
// - SUPABASE_SERVICE_ROLE_KEY: Auto-provided by Supabase

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
    .map(key => `${key}${params[key]}`)
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
    const match = body.match(/^(APPROVE|REJECT)\s+([a-f0-9-]+)$/i);

    if (!match) {
      return twimlResponse(
        'Invalid format. Use:\nAPPROVE <request-id>\nor\nREJECT <request-id>'
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
    return twimlResponse(`${emoji} Request ${requestId.substring(0, 8)}... has been ${actionText}.`);

  } catch (error) {
    console.error('Error processing request:', error);
    return twimlResponse('Internal server error.');
  }
});

function twimlResponse(message: string): Response {
  const twiml = `<?xml version="1.0" encoding="UTF-8"?>
<Response>
  <Message>${escapeXml(message)}</Message>
</Response>`;

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
