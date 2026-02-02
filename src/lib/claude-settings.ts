import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

const CLAUDE_SETTINGS_PATH = path.join(os.homedir(), '.claude', 'settings.json');

interface ClaudeHook {
  type: 'command';
  command: string;
  matcher?: string;
  timeout?: number;
}

interface ClaudeSettings {
  hooks?: {
    PreToolUse?: ClaudeHook[];
    PostToolUse?: ClaudeHook[];
    [key: string]: ClaudeHook[] | undefined;
  };
  [key: string]: unknown;
}

const GUARD_HOOK: ClaudeHook = {
  type: 'command',
  command: 'claude-guard-hook',
  matcher: 'Bash',
  timeout: 310000, // 310 seconds (slightly more than the default 300s approval timeout)
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

function isGuardHook(hook: ClaudeHook): boolean {
  return hook.command === 'claude-guard-hook' || hook.command.includes('claude-guard-hook');
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

    // Check if already registered
    if (settings.hooks.PreToolUse.some(isGuardHook)) {
      return { success: true, message: 'Hook is already registered' };
    }

    // Add the hook
    settings.hooks.PreToolUse.push(GUARD_HOOK);
    writeClaudeSettings(settings);

    return { success: true, message: 'Hook registered successfully' };
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
