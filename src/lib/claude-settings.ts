import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

interface ClaudeHookCommand {
  type: 'command';
  command: string;
  timeout?: number;
}

interface ClaudeHookEntry {
  matcher: { tools: string[] };
  hooks: ClaudeHookCommand[];
}

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: ClaudeHookEntry[];
    PostToolUse?: ClaudeHookEntry[];
    [key: string]: ClaudeHookEntry[] | undefined;
  };
  [key: string]: unknown;
}

const GUARD_HOOK: ClaudeHookEntry = {
  matcher: { tools: ['Bash'] },
  hooks: [
    {
      type: 'command',
      command: 'claude-remote-guard-hook',
      timeout: 310000, // 310 seconds (slightly more than the default 300s approval timeout)
    },
  ],
};

function readClaudeSettings(): ClaudeSettings {
  if (!fs.existsSync(CLAUDE_SETTINGS_PATH)) {
    return {};
  }

  try {
    const content = fs.readFileSync(CLAUDE_SETTINGS_PATH, 'utf-8');
    return JSON.parse(content) as ClaudeSettings;
  } catch {
    return {};
  }
}

function writeClaudeSettings(settings: ClaudeSettings): void {
  const dir = path.dirname(CLAUDE_SETTINGS_PATH);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }

  fs.writeFileSync(CLAUDE_SETTINGS_PATH, JSON.stringify(settings, null, 2), {
    encoding: 'utf-8',
    mode: 0o600, // Owner read/write only
  });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isGuardCommand(command: string | undefined): boolean {
  if (!command) return false;
  return (
    command === 'claude-remote-guard-hook' ||
    command.includes('claude-remote-guard-hook') ||
    command === 'claude-guard-hook' ||
    command.includes('claude-guard-hook')
  );
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isGuardHook(entry: any): boolean {
  // 신버전 포맷: entry.hooks 배열
  if (entry.hooks && Array.isArray(entry.hooks)) {
    return entry.hooks.some((h: ClaudeHookCommand) => isGuardCommand(h.command));
  }
  // 구버전 포맷: entry.command 직접
  if (entry.command) {
    return isGuardCommand(entry.command);
  }
  return false;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function isNewFormatGuardHook(entry: any): boolean {
  // 신버전 포맷인지 확인: matcher가 객체이고 hooks 배열이 있어야 함
  return (
    entry.matcher &&
    typeof entry.matcher === 'object' &&
    Array.isArray(entry.matcher.tools) &&
    Array.isArray(entry.hooks) &&
    entry.hooks.some((h: ClaudeHookCommand) => isGuardCommand(h.command))
  );
}

export function isHookRegistered(): boolean {
  const settings = readClaudeSettings();

  if (!settings.hooks?.PreToolUse) {
    return false;
  }

  return settings.hooks.PreToolUse.some(isGuardHook);
}

export function registerHook(): { success: boolean; message: string } {
  try {
    const settings = readClaudeSettings();

    // Initialize hooks structure if needed
    if (!settings.hooks) {
      settings.hooks = {};
    }
    if (!settings.hooks.PreToolUse) {
      settings.hooks.PreToolUse = [];
    }

    // Check if already registered with new format
    if (settings.hooks.PreToolUse.some(isNewFormatGuardHook)) {
      return { success: true, message: 'Hook is already registered' };
    }

    // Remove any legacy format hooks (구버전 형식 제거)
    const hadLegacyHook = settings.hooks.PreToolUse.some(
      (entry) => isGuardHook(entry) && !isNewFormatGuardHook(entry)
    );
    if (hadLegacyHook) {
      settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter(
        (entry) => !isGuardHook(entry)
      );
    }

    // Add the hook with new format
    settings.hooks.PreToolUse.push(GUARD_HOOK);
    writeClaudeSettings(settings);

    const message = hadLegacyHook
      ? 'Hook migrated to new format successfully'
      : 'Hook registered successfully';
    return { success: true, message };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, message: `Failed to register hook: ${errorMessage}` };
  }
}

export function unregisterHook(): { success: boolean; message: string } {
  try {
    const settings = readClaudeSettings();

    if (!settings.hooks?.PreToolUse) {
      return { success: true, message: 'No hooks to remove' };
    }

    const originalLength = settings.hooks.PreToolUse.length;
    settings.hooks.PreToolUse = settings.hooks.PreToolUse.filter((hook) => !isGuardHook(hook));

    if (settings.hooks.PreToolUse.length === originalLength) {
      return { success: true, message: 'Hook was not registered' };
    }

    // Clean up empty arrays
    if (settings.hooks.PreToolUse.length === 0) {
      delete settings.hooks.PreToolUse;
    }
    if (Object.keys(settings.hooks).length === 0) {
      delete settings.hooks;
    }

    writeClaudeSettings(settings);

    return { success: true, message: 'Hook unregistered successfully' };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : 'Unknown error';
    return { success: false, message: `Failed to unregister hook: ${errorMessage}` };
  }
}

export function getClaudeSettingsPath(): string {
  return CLAUDE_SETTINGS_PATH;
}
