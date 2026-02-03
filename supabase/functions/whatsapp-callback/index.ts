// Supabase Edge Function for WhatsApp (Twilio) Callbacks
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

// UUID v4 형식 검증
const UUID_V4_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function isValidUUID(id: string): boolean {
  return UUID_V4_REGEX.test(id);
}

// 타임스탬프 검증: 1시간(3600초) 이내 요청만 허용
const MAX_REQUEST_AGE_SECONDS = 3600;
function isRequestExpired(createdAt: string): boolean {
  const createdTime = new Date(createdAt).getTime();
  const now = Date.now();
  return (now - createdTime) / 1000 > MAX_REQUEST_AGE_SECONDS;
}

// 인메모리 rate limiter (분당 30회 제한)
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const windowMs = 60 * 1000; // 1분
  const maxRequests = 30;

  const record = rateLimitMap.get(ip);

  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + windowMs });
    return true;
  }

  if (record.count >= maxRequests) {
    return false; // Rate limit exceeded
  }

  record.count++;
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

serve(async (req: Request) => {
  // Only allow POST
  if (req.method !== 'POST') {
    return new Response('Method not allowed', { status: 405 });
  }

  // Rate limiting 체크
  const clientIP = req.headers.get('x-forwarded-for')?.split(',')[0]?.trim() || 'unknown';
  if (!checkRateLimit(clientIP)) {
    return new Response(JSON.stringify({ error: 'Too many requests' }), {
      status: 429,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  try {
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

    // Initialize Supabase client
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase environment variables');
      return twimlResponse('Server configuration error.');
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

    // 타임스탬프 검증: 요청의 created_at 조회
    const { data: requestData, error: fetchError } = await supabase
      .from('approval_requests')
      .select('id, created_at, status')
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
