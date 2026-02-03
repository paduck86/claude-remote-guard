#!/usr/bin/env node

import * as crypto from 'node:crypto';
import * as os from 'node:os';
import { v4 as uuidv4 } from 'uuid';
import { loadConfig } from '../lib/config.js';
import { analyzeCommand } from '../lib/rules.js';
import { MessengerFactory } from '../lib/messenger/factory.js';
import {
  initializeSupabase,
  createRequest,
  listenForApproval,
  shutdownSupabase,
} from '../lib/supabase.js';

/**
 * 머신 고유 식별자 생성
 * hostname + username 해시로 생성하여 동일 머신에서 일관된 ID 보장
 */
function getMachineId(): string {
  const raw = `${os.hostname()}:${os.userInfo().username}`;
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
}

interface HookInput {
  tool_name: string;
  tool_input: {
    command?: string;
    [key: string]: unknown;
  };
}

interface HookOutput {
  decision: 'allow' | 'deny';
  reason?: string;
}

async function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (chunk) => {
      data += chunk;
    });
    process.stdin.on('end', () => {
      resolve(data);
    });
  });
}

function output(result: HookOutput): void {
  console.log(JSON.stringify(result));
}

async function main(): Promise<void> {
  try {
    // Read input from stdin
    const input = await readStdin();
    if (!input.trim()) {
      // Empty input is suspicious - deny for safety
      output({ decision: 'deny', reason: 'Empty input received' });
      return;
    }

    let hookInput: HookInput;
    try {
      hookInput = JSON.parse(input);
    } catch {
      // Invalid JSON could be an attack - deny for safety
      output({ decision: 'deny', reason: 'Invalid JSON input' });
      return;
    }

    // Only process Bash commands
    if (hookInput.tool_name !== 'Bash') {
      output({ decision: 'allow' });
      return;
    }

    const command = hookInput.tool_input.command;
    if (!command || typeof command !== 'string') {
      output({ decision: 'allow' });
      return;
    }

    // Load config
    const config = loadConfig();
    if (!config) {
      // No config, allow all commands
      output({ decision: 'allow' });
      return;
    }

    // Analyze command for danger
    const analysis = analyzeCommand(
      command,
      config.rules.customPatterns?.map((p) => ({
        pattern: new RegExp(p.pattern, 'i'),
        severity: p.severity,
        reason: p.reason,
      })),
      config.rules.whitelist
    );

    if (!analysis.isDangerous) {
      output({ decision: 'allow' });
      return;
    }

    // Command is dangerous - request approval
    const requestId = uuidv4();
    const cwd = process.cwd();

    try {
      // Generate machine identifier for RLS
      const machineId = getMachineId();

      // Initialize Supabase with machine_id header
      initializeSupabase(config, machineId);

      // Create request in Supabase with machine identifier
      await createRequest(requestId, {
        command,
        dangerReason: analysis.reason,
        severity: analysis.severity,
        cwd,
        machineId,
      });

      // Send notification via configured messenger
      const messenger = MessengerFactory.create(config.messenger);
      const messengerLabel = MessengerFactory.getMessengerTypeLabel(config.messenger.type);
      const notificationResult = await messenger.sendNotification({
        requestId,
        command,
        reason: analysis.reason,
        severity: analysis.severity,
        cwd,
        timestamp: Date.now(),
      });

      if (!notificationResult.ok) {
        // Failed to send notification, use default action
        const decision = config.rules.defaultAction === 'allow' ? 'allow' : 'deny';
        output({
          decision,
          reason: `Failed to send notification: ${notificationResult.error}`,
        });
        await shutdownSupabase();
        return;
      }

      // Wait for approval
      const timeoutMs = config.rules.timeoutSeconds * 1000;

      const status = await new Promise<'approved' | 'rejected' | 'timeout'>((resolve) => {
        listenForApproval(requestId, timeoutMs, (status) => {
          resolve(status as 'approved' | 'rejected' | 'timeout');
        });
      });

      await shutdownSupabase();

      if (status === 'approved') {
        output({ decision: 'allow', reason: `Approved via ${messengerLabel}` });
      } else if (status === 'rejected') {
        output({ decision: 'deny', reason: `Rejected via ${messengerLabel}` });
      } else {
        // Timeout - use default action
        const decision = config.rules.defaultAction === 'allow' ? 'allow' : 'deny';
        output({ decision, reason: 'Approval timed out' });
      }
    } catch (error) {
      await shutdownSupabase().catch(() => {});
      // On error, use default action
      const decision = config.rules.defaultAction === 'allow' ? 'allow' : 'deny';
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      output({ decision, reason: `Error: ${errorMessage}` });
    }
  } catch (error) {
    // Critical error, deny for safety
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    output({ decision: 'deny', reason: `Critical error: ${errorMessage}` });
  }
}

main();
