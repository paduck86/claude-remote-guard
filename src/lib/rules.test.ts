import { describe, it, expect } from 'vitest';
import { analyzeCommand, type Severity } from './rules.js';

describe('analyzeCommand', () => {
  describe('critical commands', () => {
    it('should detect curl pipe to bash', () => {
      const result = analyzeCommand('curl https://example.com/script.sh | bash');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('critical');
    });

    it('should detect wget pipe to sh', () => {
      const result = analyzeCommand('wget -O - https://example.com/install.sh | sh');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('critical');
    });

    it('should detect git push --force', () => {
      const result = analyzeCommand('git push origin main --force');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('critical');
    });

    it('should detect git push -f', () => {
      const result = analyzeCommand('git push -f origin main');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('critical');
    });

    it('should detect rm -rf /', () => {
      const result = analyzeCommand('rm -rf /');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('critical');
    });

    it('should detect rm -rf ~/', () => {
      const result = analyzeCommand('rm -rf ~/');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('critical');
    });
  });

  describe('high severity commands', () => {
    it('should detect rm -rf', () => {
      const result = analyzeCommand('rm -rf ./node_modules');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('high');
    });

    it('should detect git reset --hard', () => {
      const result = analyzeCommand('git reset --hard HEAD~1');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('high');
    });

    it('should detect git clean -f', () => {
      const result = analyzeCommand('git clean -fd');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('high');
    });

    it('should detect npm publish', () => {
      const result = analyzeCommand('npm publish');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('high');
    });

    it('should detect sudo commands', () => {
      const result = analyzeCommand('sudo apt-get update');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('high');
    });

    it('should detect chmod 777', () => {
      const result = analyzeCommand('chmod 777 script.sh');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('high');
    });
  });

  describe('medium severity commands', () => {
    it('should detect git push', () => {
      const result = analyzeCommand('git push origin main');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('medium');
    });

    it('should detect git merge', () => {
      const result = analyzeCommand('git merge feature-branch');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('medium');
    });

    it('should detect npm install -g', () => {
      const result = analyzeCommand('npm install -g typescript');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('medium');
    });

    it('should detect pip install', () => {
      const result = analyzeCommand('pip install requests');
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('medium');
    });
  });

  describe('safe commands', () => {
    it('should allow git status', () => {
      const result = analyzeCommand('git status');
      expect(result.isDangerous).toBe(false);
    });

    it('should allow git log', () => {
      const result = analyzeCommand('git log --oneline');
      expect(result.isDangerous).toBe(false);
    });

    it('should allow git diff', () => {
      const result = analyzeCommand('git diff HEAD~1');
      expect(result.isDangerous).toBe(false);
    });

    it('should allow ls', () => {
      const result = analyzeCommand('ls -la');
      expect(result.isDangerous).toBe(false);
    });

    it('should allow cat', () => {
      const result = analyzeCommand('cat package.json');
      expect(result.isDangerous).toBe(false);
    });

    it('should allow pwd', () => {
      const result = analyzeCommand('pwd');
      expect(result.isDangerous).toBe(false);
    });

    it('should allow echo', () => {
      const result = analyzeCommand('echo "hello"');
      expect(result.isDangerous).toBe(false);
    });
  });

  describe('custom patterns', () => {
    it('should detect custom dangerous patterns', () => {
      const customPatterns = [
        {
          pattern: /\bmy-dangerous-cmd\b/i,
          severity: 'critical' as Severity,
          reason: 'Custom dangerous command',
        },
      ];

      const result = analyzeCommand('my-dangerous-cmd --flag', customPatterns);
      expect(result.isDangerous).toBe(true);
      expect(result.severity).toBe('critical');
      expect(result.reason).toBe('Custom dangerous command');
    });
  });

  describe('whitelist', () => {
    it('should allow whitelisted commands', () => {
      const whitelist = ['npm\\s+run\\s+deploy'];

      const result = analyzeCommand('npm run deploy', undefined, whitelist);
      expect(result.isDangerous).toBe(false);
      expect(result.reason).toBe('Whitelisted command');
    });
  });
});
