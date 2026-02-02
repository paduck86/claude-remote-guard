// Supabase Edge Function for Slack Interactive Callbacks
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

    // Initialize Supabase client with service role key
    const supabaseUrl = Deno.env.get('SUPABASE_URL');
    const supabaseServiceKey = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY');

    if (!supabaseUrl || !supabaseServiceKey) {
      console.error('Missing Supabase environment variables');
      return new Response('Server configuration error', { status: 500 });
    }

    const supabase = createClient(supabaseUrl, supabaseServiceKey);

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
      console.error('Request not found or already resolved:', requestId);
      return new Response('Request not found or already resolved', { status: 404 });
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
