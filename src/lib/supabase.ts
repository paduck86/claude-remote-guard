import { createClient, SupabaseClient, RealtimeChannel } from '@supabase/supabase-js';
import type { Config } from './config.js';
import type { Severity } from './rules.js';

// Patterns that may contain sensitive information
const SENSITIVE_PATTERNS: Array<{ pattern: RegExp; replacement: string }> = [
  { pattern: /([?&])(api[_-]?key|token|secret|password|auth|key|access[_-]?token)=([^&\s'"]+)/gi, replacement: '$1$2=[REDACTED]' },
  { pattern: /(Authorization:\s*)(Bearer\s+)?[^\s'"]+/gi, replacement: '$1$2[REDACTED]' },
  { pattern: /(export\s+)?(AWS_SECRET_ACCESS_KEY|AWS_ACCESS_KEY_ID|API_KEY|SECRET_KEY|PRIVATE_KEY|DATABASE_URL|DB_PASSWORD|SLACK_TOKEN|GITHUB_TOKEN|NPM_TOKEN)=([^\s'"]+)/gi, replacement: '$1$2=[REDACTED]' },
  { pattern: /:\/\/([^:]+):([^@]+)@/g, replacement: '://$1:[REDACTED]@' },
  { pattern: /(Basic\s+)[A-Za-z0-9+/=]{20,}/gi, replacement: '$1[REDACTED]' },
];

function maskSensitiveInfo(text: string): string {
  let masked = text;
  for (const { pattern, replacement } of SENSITIVE_PATTERNS) {
    masked = masked.replace(pattern, replacement);
  }
  return masked;
}

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'timeout';

export interface ApprovalRequest {
  id: string;
  command: string;
  danger_reason: string;
  severity: Severity;
  cwd: string;
  status: ApprovalStatus;
  created_at: string;
  resolved_at?: string;
  resolved_by?: string;
}

let supabaseClient: SupabaseClient | null = null;

export function initializeSupabase(config: Config, machineId?: string): SupabaseClient {
  if (supabaseClient) {
    return supabaseClient;
  }

  // machineId가 있으면 x-machine-id 헤더 추가 (RLS 정책에서 사용)
  const options = machineId
    ? { global: { headers: { 'x-machine-id': machineId } } }
    : undefined;

  supabaseClient = createClient(config.supabase.url, config.supabase.anonKey, options);
  return supabaseClient;
}

export function getSupabaseClient(): SupabaseClient {
  if (!supabaseClient) {
    throw new Error('Supabase not initialized. Call initializeSupabase first.');
  }
  return supabaseClient;
}

export async function createRequest(
  requestId: string,
  request: { command: string; dangerReason: string; severity: Severity; cwd: string; machineId?: string }
): Promise<void> {
  const client = getSupabaseClient();

  // Mask sensitive information before storing in database
  const maskedCommand = maskSensitiveInfo(request.command);

  const { error } = await client.from('approval_requests').insert({
    id: requestId,
    command: maskedCommand,
    danger_reason: request.dangerReason,
    severity: request.severity,
    cwd: request.cwd,
    status: 'pending',
    machine_id: request.machineId,
  });

  if (error) {
    throw new Error(`Failed to create request: ${error.message}`);
  }
}

export async function updateRequestStatus(
  requestId: string,
  status: ApprovalStatus,
  resolvedBy?: string
): Promise<void> {
  const client = getSupabaseClient();

  const updates: Partial<ApprovalRequest> = {
    status,
    resolved_at: new Date().toISOString(),
  };

  if (resolvedBy) {
    updates.resolved_by = resolvedBy;
  }

  const { error } = await client.from('approval_requests').update(updates).eq('id', requestId);

  if (error) {
    throw new Error(`Failed to update request status: ${error.message}`);
  }
}

export async function getRequest(requestId: string): Promise<ApprovalRequest | null> {
  const client = getSupabaseClient();

  const { data, error } = await client
    .from('approval_requests')
    .select('*')
    .eq('id', requestId)
    .single();

  if (error) {
    if (error.code === 'PGRST116') {
      return null; // Not found
    }
    throw new Error(`Failed to get request: ${error.message}`);
  }

  return data as ApprovalRequest;
}

export function listenForApproval(
  requestId: string,
  timeoutMs: number,
  onResolved: (status: ApprovalStatus) => void
): () => void {
  const client = getSupabaseClient();

  let resolved = false;
  let timeoutId: NodeJS.Timeout | null = null;
  let channel: RealtimeChannel | null = null;

  // Subscribe to realtime changes
  channel = client
    .channel(`approval-${requestId}`)
    .on(
      'postgres_changes',
      {
        event: 'UPDATE',
        schema: 'public',
        table: 'approval_requests',
        filter: `id=eq.${requestId}`,
      },
      (payload) => {
        const newStatus = (payload.new as ApprovalRequest).status;

        if (newStatus && newStatus !== 'pending' && !resolved) {
          resolved = true;
          if (timeoutId) {
            clearTimeout(timeoutId);
          }
          cleanup();
          onResolved(newStatus);
        }
      }
    )
    .subscribe();

  // Set timeout
  timeoutId = setTimeout(async () => {
    if (!resolved) {
      resolved = true;
      cleanup();

      // Update status to timeout in Supabase
      try {
        await updateRequestStatus(requestId, 'timeout');
      } catch (err) {
        // Log error but don't block the timeout flow
        console.error(`[Claude Guard] Failed to update timeout status for ${requestId}:`, err);
      }

      onResolved('timeout');
    }
  }, timeoutMs);

  // Cleanup function
  function cleanup(): void {
    if (channel) {
      client.removeChannel(channel);
      channel = null;
    }
  }

  // Return cleanup function
  return () => {
    if (!resolved) {
      resolved = true;
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      cleanup();
    }
  };
}

export async function cleanupOldRequests(maxAgeMs: number = 24 * 60 * 60 * 1000): Promise<number> {
  const client = getSupabaseClient();
  const cutoff = new Date(Date.now() - maxAgeMs).toISOString();

  const { data, error } = await client
    .from('approval_requests')
    .delete()
    .lt('created_at', cutoff)
    .select('id');

  if (error) {
    throw new Error(`Failed to cleanup old requests: ${error.message}`);
  }

  return data?.length ?? 0;
}

export async function testConnection(config: Config): Promise<{ ok: boolean; error?: string }> {
  try {
    const client = initializeSupabase(config);

    // Try to query the table (will fail if table doesn't exist or no access)
    const { error } = await client.from('approval_requests').select('id').limit(1);

    if (error) {
      return { ok: false, error: error.message };
    }

    return { ok: true };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { ok: false, error: errorMessage };
  }
}

export async function shutdownSupabase(): Promise<void> {
  if (supabaseClient) {
    await supabaseClient.removeAllChannels();
    supabaseClient = null;
  }
}
