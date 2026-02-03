#!/usr/bin/env node

import { execSync } from 'node:child_process';
import * as crypto from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as readline from 'node:readline';
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
 * 다양한 엔트로피 소스를 조합하여 RLS 우회를 방지
 * - hostname, username, platform, arch: 기본 시스템 정보
 * - machine-id: Linux/macOS 시스템 고유 ID
 * - IOPlatformUUID: macOS 하드웨어 고유 ID
 * - homedir: 사용자별 고유 경로
 */
function getMachineId(): string {
  const components: string[] = [
    os.hostname(),
    os.userInfo().username,
    os.platform(),
    os.arch(),
  ];

  // Linux/macOS machine-id 추가 (시스템 고유 식별자)
  try {
    if (fs.existsSync('/etc/machine-id')) {
      components.push(fs.readFileSync('/etc/machine-id', 'utf8').trim());
    } else if (fs.existsSync('/var/lib/dbus/machine-id')) {
      components.push(fs.readFileSync('/var/lib/dbus/machine-id', 'utf8').trim());
    }
  } catch {
    // 에러 시 무시하고 다른 소스 사용
  }

  // macOS: IOPlatformUUID (하드웨어 고유 ID)
  try {
    if (os.platform() === 'darwin') {
      const uuid = execSync(
        'ioreg -rd1 -c IOPlatformExpertDevice | grep IOPlatformUUID',
        { encoding: 'utf8' }
      );
      const match = uuid.match(/"IOPlatformUUID" = "([^"]+)"/);
      if (match) {
        components.push(match[1]);
      }
    }
  } catch {
    // 에러 시 무시하고 다른 소스 사용
  }

  // 홈 디렉토리 경로 추가 (사용자별 고유)
  components.push(os.homedir());

  const raw = components.join(':');
  return crypto.createHash('sha256').update(raw).digest('hex').substring(0, 32);
}

/**
 * 서명된 machine_id 생성
 * HMAC 서명으로 machine_id 위조 방지
 * 형식: machineId:timestamp:signature
 */
function getSignedMachineId(machineId: string, secret: string): string {
  const timestamp = Math.floor(Date.now() / 1000);
  const payload = `${machineId}:${timestamp}`;
  const signature = crypto
    .createHmac('sha256', secret)
    .update(payload)
    .digest('hex')
    .substring(0, 16);
  return `${payload}:${signature}`;
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

interface ApprovalResult {
  status: 'approved' | 'rejected' | 'timeout';
  source: 'local' | 'remote';
}

/**
 * 로컬 TTY에서 사용자 입력을 대기하고 유효한 입력만 resolve
 * stdin은 이미 JSON 입력에 사용되었으므로 /dev/tty를 직접 열어 사용
 *
 * @returns cleanup 함수와 함께 Promise 반환. 유효한 입력이 있을 때만 resolve
 */
function createLocalInputListener(): {
  promise: Promise<ApprovalResult>;
  cleanup: () => void;
} {
  let ttyStream: fs.ReadStream | null = null;
  let rl: readline.Interface | null = null;
  let resolved = false;

  const cleanup = () => {
    if (rl) {
      rl.close();
      rl = null;
    }
    if (ttyStream) {
      ttyStream.destroy();
      ttyStream = null;
    }
  };

  const promise = new Promise<ApprovalResult>((resolve) => {
    // TTY 장치 파일 확인 (Unix/Linux/macOS)
    const ttyPath = '/dev/tty';

    // TTY 사용 가능 여부 확인
    try {
      fs.accessSync(ttyPath, fs.constants.R_OK);
    } catch {
      // TTY 없음 - 원격 응답만 대기
      process.stderr.write('[claude-remote-guard] TTY not available, waiting for remote approval only...\n');
      return;
    }

    try {
      // /dev/tty를 직접 열어 사용자 입력 대기
      ttyStream = fs.createReadStream(ttyPath, { encoding: 'utf8' });

      rl = readline.createInterface({
        input: ttyStream,
        output: process.stderr, // stdout은 JSON 출력용이므로 stderr 사용
        terminal: false,
      });

      // 프롬프트 출력 (stderr로)
      process.stderr.write('\n[Remote] Waiting for response... or type here: [y] approve / [n] reject: ');

      rl.on('line', (answer) => {
        if (resolved) return;

        const normalized = answer.trim().toLowerCase();
        if (normalized === 'y' || normalized === 'yes') {
          resolved = true;
          resolve({ status: 'approved', source: 'local' });
        } else if (normalized === 'n' || normalized === 'no') {
          resolved = true;
          resolve({ status: 'rejected', source: 'local' });
        }
        // 잘못된 입력은 무시하고 계속 대기 (다시 입력 가능)
      });

      rl.once('error', () => {
        // 에러 시에도 resolve하지 않음 - 원격 응답만 기다림
        cleanup();
      });
    } catch {
      // 초기화 실패 - resolve하지 않음
      cleanup();
    }
  });

  return { promise, cleanup };
}

/**
 * listenForApproval 콜백을 Promise로 래핑
 */
function listenForApprovalPromise(
  requestId: string,
  timeoutMs: number
): Promise<ApprovalResult> {
  return new Promise((resolve) => {
    listenForApproval(requestId, timeoutMs, (status) => {
      resolve({
        status: status as 'approved' | 'rejected' | 'timeout',
        source: 'remote',
      });
    });
  });
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

      // machineIdSecret이 있으면 서명된 machineId 사용 (위조 방지)
      const signedMachineId = config.machineIdSecret
        ? getSignedMachineId(machineId, config.machineIdSecret)
        : machineId;

      // Initialize Supabase with machine_id header
      initializeSupabase(config, signedMachineId);

      // Create request in Supabase with machine identifier
      await createRequest(requestId, {
        command,
        dangerReason: analysis.reason,
        severity: analysis.severity,
        cwd,
        machineId: signedMachineId,
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

      // Wait for approval (원격 응답 + 로컬 TTY 입력 동시 대기)
      const timeoutMs = config.rules.timeoutSeconds * 1000;

      // 로컬 TTY 입력 리스너 생성
      const localInput = createLocalInputListener();

      // 원격 응답 대기 시작
      const remotePromise = listenForApprovalPromise(requestId, timeoutMs);

      // Promise.race로 둘 중 먼저 응답하는 것 사용
      // - 로컬 입력: 유효한 y/n 입력이 있을 때만 resolve
      // - 원격 응답: approved/rejected/timeout 중 하나로 항상 resolve
      const result = await Promise.race([remotePromise, localInput.promise]);

      // 로컬 입력 리스너 정리 (어느 쪽이 이기든)
      localInput.cleanup();

      await shutdownSupabase();

      const { status, source } = result;
      const sourceLabel = source === 'local' ? 'Local TTY' : messengerLabel;

      if (status === 'approved') {
        output({ decision: 'allow', reason: `Approved via ${sourceLabel}` });
      } else if (status === 'rejected') {
        output({ decision: 'deny', reason: `Rejected via ${sourceLabel}` });
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
