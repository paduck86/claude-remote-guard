export type Severity = 'low' | 'medium' | 'high' | 'critical';

export interface RuleResult {
  isDangerous: boolean;
  severity: Severity;
  reason: string;
  matchedPattern?: string;
}

interface DangerPattern {
  pattern: RegExp;
  severity: Severity;
  reason: string;
}

const DANGER_PATTERNS: DangerPattern[] = [
  // Critical - Immediate system damage or remote code execution
  { pattern: /\bcurl\s+.*\|\s*(ba)?sh\b/i, severity: 'critical', reason: 'Remote script execution via curl pipe' },
  { pattern: /\bwget\s+.*\|\s*(ba)?sh\b/i, severity: 'critical', reason: 'Remote script execution via wget pipe' },
  { pattern: /\bbase64\s+(-d|--decode).*\|\s*(ba)?sh\b/i, severity: 'critical', reason: 'Encoded script execution' },
  { pattern: /\bgit\s+push\s+.*--force\b/i, severity: 'critical', reason: 'Force push can overwrite remote history' },
  { pattern: /\bgit\s+push\s+-f\b/i, severity: 'critical', reason: 'Force push can overwrite remote history' },
  { pattern: /\brm\s+-rf\s+\/(\s|$|\*)/i, severity: 'critical', reason: 'Recursive force delete from root directory' },
  { pattern: /\brm\s+-rf\s+\/\*/i, severity: 'critical', reason: 'Recursive force delete of root contents' },
  { pattern: /\brm\s+-rf\s+~\//i, severity: 'critical', reason: 'Recursive force delete from home directory' },
  { pattern: /:\(\)\s*\{\s*:\s*\|\s*:\s*&\s*\}\s*;\s*:/i, severity: 'critical', reason: 'Fork bomb detected' },
  { pattern: />\s*\/dev\/[sh]d[a-z]/i, severity: 'critical', reason: 'Direct disk device write' },
  { pattern: /\bdd\s+.*of=\/dev\/[sh]d[a-z]/i, severity: 'critical', reason: 'Direct disk device write via dd' },

  // High - Significant risk of data loss or security breach
  { pattern: /\brm\s+(-[a-zA-Z]*r|-[a-zA-Z]*f)/i, severity: 'high', reason: 'Recursive or force file deletion' },
  { pattern: /\bgit\s+reset\s+--hard\b/i, severity: 'high', reason: 'Hard reset discards all uncommitted changes' },
  { pattern: /\bgit\s+clean\s+-[a-zA-Z]*f/i, severity: 'high', reason: 'Force clean removes untracked files' },
  { pattern: /\bgit\s+checkout\s+\.\s*$/i, severity: 'high', reason: 'Discards all unstaged changes' },
  { pattern: /\bgit\s+restore\s+\.\s*$/i, severity: 'high', reason: 'Discards all unstaged changes' },
  { pattern: /\bgit\s+branch\s+-D\b/i, severity: 'high', reason: 'Force delete branch' },
  { pattern: /\bnpm\s+publish\b/i, severity: 'high', reason: 'Publishing package to npm registry' },
  { pattern: /\byarn\s+publish\b/i, severity: 'high', reason: 'Publishing package to npm registry' },
  { pattern: /\bsudo\b/i, severity: 'high', reason: 'Elevated privileges command' },
  { pattern: /\bchmod\s+777\b/i, severity: 'high', reason: 'Setting world-writable permissions' },
  { pattern: /\bchown\b/i, severity: 'high', reason: 'Changing file ownership' },
  { pattern: /\bmkfs\b/i, severity: 'high', reason: 'Filesystem formatting command' },
  { pattern: /\bdd\s+if=/i, severity: 'high', reason: 'Low-level disk write command' },
  { pattern: /\bhistory\s+-c\b/i, severity: 'high', reason: 'Clearing shell history' },
  { pattern: /\bshred\b/i, severity: 'high', reason: 'Secure file deletion' },
  { pattern: /\b(export|set)\s+.*=.*&&.*\b(curl|wget|bash)\b/i, severity: 'high', reason: 'Environment manipulation with network/script execution' },

  // Medium - Needs attention but less immediate risk
  { pattern: /\bgit\s+push\b/i, severity: 'medium', reason: 'Pushing changes to remote repository' },
  { pattern: /\bgit\s+merge\b/i, severity: 'medium', reason: 'Merging branches' },
  { pattern: /\bgit\s+rebase\b/i, severity: 'medium', reason: 'Rebasing commits' },
  { pattern: /\bnpm\s+install\s+-g\b/i, severity: 'medium', reason: 'Installing global npm package' },
  { pattern: /\bpip\s+install\b/i, severity: 'medium', reason: 'Installing Python package' },
  { pattern: /\bbrew\s+install\b/i, severity: 'medium', reason: 'Installing Homebrew package' },
  { pattern: /\bapt(-get)?\s+install\b/i, severity: 'medium', reason: 'Installing system package' },
  { pattern: /\bmv\s+.*\s+(\/usr|\/etc|\/bin|\/sbin|\/var|\/opt|~\/)/i, severity: 'medium', reason: 'Moving files to system directory' },
  { pattern: /\bdocker\s+run\b/i, severity: 'medium', reason: 'Running Docker container' },
  { pattern: /\bkubectl\s+delete\b/i, severity: 'medium', reason: 'Deleting Kubernetes resources' },
  { pattern: /\benv\b\s*$/i, severity: 'medium', reason: 'Displaying environment variables (potential credential exposure)' },
  { pattern: /\bprintenv\b/i, severity: 'medium', reason: 'Displaying environment variables (potential credential exposure)' },

  // Low - Generally safe but worth noting
  { pattern: /\bkubectl\s+apply\b/i, severity: 'low', reason: 'Applying Kubernetes configuration' },
  { pattern: /\bdocker\s+build\b/i, severity: 'low', reason: 'Building Docker image' },
];

const SAFE_PATTERNS: RegExp[] = [
  /^\s*git\s+status\s*$/i,
  /^\s*git\s+log\b/i,
  /^\s*git\s+diff\b/i,
  /^\s*git\s+show\b/i,
  /^\s*git\s+branch\s*$/i,
  /^\s*git\s+branch\s+-[av]+\s*$/i,
  /^\s*ls\b/i,
  /^\s*cat\b/i,
  /^\s*head\b/i,
  /^\s*tail\b/i,
  /^\s*echo\b/i,
  /^\s*pwd\s*$/i,
  /^\s*whoami\s*$/i,
  /^\s*which\b/i,
  /^\s*file\b/i,
  /^\s*wc\b/i,
  /^\s*grep\b/i,
  /^\s*find\b/i,
  /^\s*npm\s+list\b/i,
  /^\s*npm\s+outdated\b/i,
  /^\s*npm\s+view\b/i,
  /^\s*node\s+-[ve]+\s*$/i,
  /^\s*python\s+--version\s*$/i,
  /^\s*python3?\s+-c\s+['"]print/i,
];

export function analyzeCommand(
  command: string,
  customPatterns?: DangerPattern[],
  whitelist?: string[]
): RuleResult {
  const trimmedCommand = command.trim();

  // Check safe patterns first
  for (const pattern of SAFE_PATTERNS) {
    if (pattern.test(trimmedCommand)) {
      return { isDangerous: false, severity: 'low', reason: 'Safe command' };
    }
  }

  // Check user whitelist
  if (whitelist) {
    for (const pattern of whitelist) {
      try {
        const regex = new RegExp(pattern, 'i');
        if (regex.test(trimmedCommand)) {
          return { isDangerous: false, severity: 'low', reason: 'Whitelisted command' };
        }
      } catch {
        // Invalid regex, skip
      }
    }
  }

  // Check custom patterns first (higher priority)
  if (customPatterns) {
    for (const dp of customPatterns) {
      if (dp.pattern.test(trimmedCommand)) {
        return {
          isDangerous: true,
          severity: dp.severity,
          reason: dp.reason,
          matchedPattern: dp.pattern.source,
        };
      }
    }
  }

  // Check default danger patterns
  for (const dp of DANGER_PATTERNS) {
    if (dp.pattern.test(trimmedCommand)) {
      return {
        isDangerous: true,
        severity: dp.severity,
        reason: dp.reason,
        matchedPattern: dp.pattern.source,
      };
    }
  }

  return { isDangerous: false, severity: 'low', reason: 'No dangerous patterns detected' };
}

export function getSeverityColor(severity: Severity): string {
  switch (severity) {
    case 'critical': return '#dc2626';
    case 'high': return '#ea580c';
    case 'medium': return '#ca8a04';
    case 'low': return '#16a34a';
  }
}

export function getSeverityEmoji(severity: Severity): string {
  switch (severity) {
    case 'critical': return '\u{1F6A8}';
    case 'high': return '\u26A0\uFE0F';
    case 'medium': return '\u{1F7E1}';
    case 'low': return '\u{1F7E2}';
  }
}
