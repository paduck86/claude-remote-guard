#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const packageJson = require('../../package.json');
import {
  loadConfig,
  saveConfig,
  configExists,
  deleteConfig,
  type Config,
} from '../lib/config.js';
import { registerHook, unregisterHook, isHookRegistered } from '../lib/claude-settings.js';
import { testConnection as testSupabaseConnection, shutdownSupabase } from '../lib/supabase.js';
import {
  createEdgeFunctionFiles,
  getEdgeFunctionEnvVars,
  getEdgeFunctionName,
  getEdgeFunctionSource,
} from '../lib/edge-function.js';
import type { MessengerType } from '../lib/messenger/types.js';
import { printSupabaseSetupInstructions, getSetupSQL } from '../lib/setup-instructions.js';
import {
  deployEdgeFunction,
  setEdgeFunctionSecrets,
  extractProjectRef,
  validateAccessToken,
} from '../lib/deployment/supabase-deploy.js';
import { executeSetupSQL } from '../lib/deployment/db-setup.js';
import {
  setTelegramWebhook,
  generateWebhookSecret,
} from '../lib/deployment/telegram-webhook.js';
import { MessengerFactory } from '../lib/messenger/factory.js';
import { TelegramMessenger } from '../lib/messenger/telegram.js';
import { WhatsAppMessenger } from '../lib/messenger/whatsapp.js';
import { SlackMessenger } from '../lib/messenger/slack.js';

const program = new Command();

program
  .name('claude-remote-guard')
  .description('Claude Guard - Remote approval system for Claude Code CLI')
  .version(packageJson.version);

program
  .command('init')
  .description('Initialize Claude Guard with interactive setup')
  .action(async () => {
    console.log(chalk.blue('\n🛡️  Claude Guard Setup\n'));

    if (configExists()) {
      const { overwrite } = await inquirer.prompt([
        {
          type: 'confirm',
          name: 'overwrite',
          message: 'Configuration already exists. Overwrite?',
          default: false,
        },
      ]);

      if (!overwrite) {
        console.log(chalk.yellow('Setup cancelled.'));
        return;
      }
    }

    // ━━━ Step 1/3: Supabase 설정 ━━━
    console.log(chalk.cyan('\n━━━ Step 1/3: Supabase 설정 ━━━'));

    const supabaseAnswers = await inquirer.prompt([
      {
        type: 'input',
        name: 'supabaseUrl',
        message: 'Supabase URL:',
        validate: (input: string) => {
          if (!input.startsWith('https://') || !input.includes('.supabase.co')) {
            return 'https://xxx.supabase.co 형식으로 입력해주세요';
          }
          return true;
        },
      },
      {
        type: 'password',
        name: 'supabaseAnonKey',
        message: 'Anon Key:',
        mask: '*',
        validate: (input: string) => {
          if (!input || input.length < 20) {
            return 'Supabase Anon Key를 입력해주세요';
          }
          return true;
        },
      },
    ]);

    // Access Token 발급 안내
    console.log(chalk.blue('\n💡 Access Token 발급 방법 (자동 배포를 원하면):'));
    console.log(chalk.gray('   1. https://supabase.com/dashboard 접속'));
    console.log(chalk.gray('   2. 좌측 하단 프로필 클릭 → Account Settings'));
    console.log(chalk.gray('   3. Access Tokens 탭 → Generate new token'));
    console.log(chalk.gray('   4. 생성된 토큰 복사 (sbp_로 시작)'));
    console.log(chalk.gray('\n   ⏭️  건너뛰면 수동 배포 안내가 표시됩니다.\n'));

    const { accessToken } = await inquirer.prompt([
      {
        type: 'password',
        name: 'accessToken',
        message: 'Access Token (자동 배포용, 건너뛰려면 Enter):',
        mask: '*',
      },
    ]);

    // accessToken을 supabaseAnswers에 병합
    supabaseAnswers.accessToken = accessToken;

    // Supabase 연결 테스트
    console.log(chalk.gray('  Supabase 연결 확인 중...'));
    const tempConfig: Config = {
      messenger: { type: 'slack' }, // 임시
      supabase: {
        url: supabaseAnswers.supabaseUrl,
        anonKey: supabaseAnswers.supabaseAnonKey,
      },
      rules: { timeoutSeconds: 300, defaultAction: 'deny' },
    };
    const sbResult = await testSupabaseConnection(tempConfig);
    if (!sbResult.ok) {
      console.log(chalk.red(`✗ Supabase 연결 실패: ${sbResult.error}`));
      console.log(chalk.yellow('설정을 확인 후 다시 시도해주세요.'));
      await shutdownSupabase();
      return;
    }
    console.log(chalk.green('✓ Supabase 연결 확인됨'));
    await shutdownSupabase();

    // SQL 테이블 생성 방법 선택
    console.log(chalk.yellow('\n📋 데이터베이스 테이블 생성이 필요합니다.'));

    const { tableSetupMethod } = await inquirer.prompt([
      {
        type: 'list',
        name: 'tableSetupMethod',
        message: '테이블 생성 방법:',
        choices: [
          { name: 'CLI가 직접 실행 (Database Password 필요)', value: 'auto' },
          { name: '직접 SQL Editor에서 실행', value: 'manual' },
        ],
        default: 'auto',
      },
    ]);

    if (tableSetupMethod === 'auto') {
      // CLI가 직접 SQL 실행
      const { databasePassword } = await inquirer.prompt([
        {
          type: 'password',
          name: 'databasePassword',
          message: 'Database Password:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.length < 1) {
              return 'Database Password를 입력해주세요 (Supabase Dashboard > Settings > Database)';
            }
            return true;
          },
        },
      ]);

      console.log(chalk.gray('  테이블 생성 중...'));
      const dbResult = await executeSetupSQL(
        supabaseAnswers.supabaseUrl,
        databasePassword,
        supabaseAnswers.accessToken || undefined
      );

      if (!dbResult.ok) {
        console.log(chalk.red(`✗ 테이블 생성 실패: ${dbResult.error}`));

        // SSL 인증서 에러 처리
        if (
          dbResult.error?.includes('self-signed certificate') ||
          dbResult.error?.includes('SELF_SIGNED_CERT') ||
          dbResult.error?.includes('unable to verify')
        ) {
          console.log(chalk.yellow('\n⚠️  SSL 인증서 에러 (회사 프록시/VPN 환경)'));
          console.log(chalk.gray('  해결 방법:'));
          console.log(chalk.gray('  1. VPN 끄고 재시도'));
          console.log(chalk.gray('  2. 또는 환경변수 설정 후 재시도:'));
          console.log(chalk.cyan('     NODE_TLS_REJECT_UNAUTHORIZED=0 npx claude-remote-guard init'));
        }

        // 수동 방법으로 폴백
        const { retryManual } = await inquirer.prompt([
          {
            type: 'confirm',
            name: 'retryManual',
            message: '직접 SQL Editor에서 실행하시겠습니까?',
            default: true,
          },
        ]);

        if (retryManual) {
          const manualSuccess = await promptManualSqlSetup();
          if (!manualSuccess) return;
        } else {
          console.log(chalk.yellow('\n설정을 확인 후 다시 init을 실행해주세요.'));
          return;
        }
      } else {
        console.log(chalk.green('✓ 테이블 생성 완료'));
      }
    } else {
      // 사용자가 직접 SQL 실행
      const manualSuccess = await promptManualSqlSetup();
      if (!manualSuccess) return;
    }

    // Access Token 검증 (입력한 경우)
    let validAccessToken: string | null = null;
    if (supabaseAnswers.accessToken && supabaseAnswers.accessToken.startsWith('sbp_')) {
      console.log(chalk.gray('  Access Token 검증 중...'));
      const isValid = await validateAccessToken(supabaseAnswers.accessToken);
      if (isValid) {
        validAccessToken = supabaseAnswers.accessToken;
        console.log(chalk.green('✓ Access Token 유효'));
      } else {
        console.log(chalk.yellow('⚠ Access Token이 유효하지 않습니다. 수동 배포로 진행합니다.'));
      }
    }

    // ━━━ Step 2/3: 메신저 설정 ━━━
    console.log(chalk.cyan('\n━━━ Step 2/3: 메신저 설정 ━━━'));

    const { messengerType } = await inquirer.prompt([
      {
        type: 'list',
        name: 'messengerType',
        message: '메신저 선택:',
        choices: [
          { name: 'Telegram (권장)', value: 'telegram' },
          { name: 'Slack', value: 'slack' },
          { name: 'WhatsApp (Twilio)', value: 'whatsapp' },
        ],
        default: 'telegram',
      },
    ]);

    let messengerConfig: Config['messenger'];

    if (messengerType === 'telegram') {
      // Telegram: Bot Token 입력 후 즉시 검증
      const { botToken } = await inquirer.prompt([
        {
          type: 'password',
          name: 'botToken',
          message: 'Bot Token:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.length < 10) {
              return 'Telegram Bot Token을 입력해주세요 (@BotFather에서 생성)';
            }
            return true;
          },
        },
      ]);

      // Bot Token 검증
      console.log(chalk.gray('  Bot Token 검증 중...'));
      const telegramMessenger = new TelegramMessenger({ botToken, chatId: '' });
      const botResult = await telegramMessenger.testConnection();
      if (!botResult.ok) {
        console.log(chalk.red(`✗ Bot Token 검증 실패: ${botResult.error}`));
        console.log(chalk.yellow('설정을 확인 후 다시 시도해주세요.'));
        return;
      }
      console.log(chalk.green(`✓ Bot 확인됨: ${botResult.info?.botUsername}`));

      // Chat ID 확인 방법 안내
      console.log(chalk.blue('\n💡 Chat ID 확인 방법:'));
      console.log(chalk.gray('   1. Telegram에서 봇에게 아무 메시지 전송'));
      console.log(chalk.gray('   2. 브라우저에서 열기:'));
      console.log(chalk.cyan(`      https://api.telegram.org/bot${botToken}/getUpdates`));
      console.log(chalk.gray('   3. 응답에서 "chat":{"id": 숫자} 부분이 Chat ID'));
      console.log('');

      const { chatId } = await inquirer.prompt([
        {
          type: 'input',
          name: 'chatId',
          message: 'Chat ID:',
          validate: (input: string) => {
            if (!input || input.length === 0) {
              return 'Chat ID를 입력해주세요';
            }
            return true;
          },
        },
      ]);

      messengerConfig = {
        type: 'telegram',
        telegram: { botToken, chatId },
      };
    } else if (messengerType === 'slack') {
      const { webhookUrl } = await inquirer.prompt([
        {
          type: 'input',
          name: 'webhookUrl',
          message: 'Webhook URL:',
          validate: (input: string) => {
            if (!input.startsWith('https://hooks.slack.com/')) {
              return 'https://hooks.slack.com/으로 시작하는 URL을 입력해주세요';
            }
            return true;
          },
        },
      ]);

      // Slack Webhook 검증
      console.log(chalk.gray('  Slack Webhook 검증 중...'));
      const slackMessenger = new SlackMessenger({ webhookUrl });
      const slackResult = await slackMessenger.testConnection();
      if (!slackResult.ok) {
        console.log(chalk.red(`✗ Slack Webhook 검증 실패: ${slackResult.error}`));
        console.log(chalk.yellow('설정을 확인 후 다시 시도해주세요.'));
        return;
      }
      console.log(chalk.green('✓ Slack Webhook 확인됨'));

      messengerConfig = {
        type: 'slack',
        slack: { webhookUrl },
      };
    } else {
      // WhatsApp (Twilio)
      const { accountSid } = await inquirer.prompt([
        {
          type: 'input',
          name: 'accountSid',
          message: 'Twilio Account SID:',
          validate: (input: string) => {
            if (!input || !input.startsWith('AC')) {
              return 'AC로 시작하는 Account SID를 입력해주세요';
            }
            return true;
          },
        },
      ]);

      const { authToken } = await inquirer.prompt([
        {
          type: 'password',
          name: 'authToken',
          message: 'Twilio Auth Token:',
          mask: '*',
          validate: (input: string) => {
            if (!input || input.length < 20) {
              return 'Twilio Auth Token을 입력해주세요';
            }
            return true;
          },
        },
      ]);

      // Twilio 계정 검증
      console.log(chalk.gray('  Twilio 계정 검증 중...'));
      const tempWhatsApp = new WhatsAppMessenger({
        accountSid,
        authToken,
        fromNumber: 'whatsapp:+1',
        toNumber: 'whatsapp:+1',
      });
      const twilioResult = await tempWhatsApp.testConnection();
      if (!twilioResult.ok) {
        console.log(chalk.red(`✗ Twilio 계정 검증 실패: ${twilioResult.error}`));
        console.log(chalk.yellow('설정을 확인 후 다시 시도해주세요.'));
        return;
      }
      console.log(chalk.green(`✓ Twilio 계정 확인됨: ${twilioResult.info?.accountName}`));

      const whatsappNumbers = await inquirer.prompt([
        {
          type: 'input',
          name: 'fromNumber',
          message: 'From Number (e.g., whatsapp:+14155238886):',
          validate: (input: string) => {
            if (!input.startsWith('whatsapp:+')) {
              return 'whatsapp:+로 시작하는 번호를 입력해주세요';
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'toNumber',
          message: 'To Number (e.g., whatsapp:+1234567890):',
          validate: (input: string) => {
            if (!input.startsWith('whatsapp:+')) {
              return 'whatsapp:+로 시작하는 번호를 입력해주세요';
            }
            return true;
          },
        },
      ]);

      messengerConfig = {
        type: 'whatsapp',
        whatsapp: {
          accountSid,
          authToken,
          fromNumber: whatsappNumbers.fromNumber,
          toNumber: whatsappNumbers.toNumber,
        },
      };
    }

    // Config 저장
    const config: Config = {
      messenger: messengerConfig,
      supabase: {
        url: supabaseAnswers.supabaseUrl,
        anonKey: supabaseAnswers.supabaseAnonKey,
      },
      rules: {
        timeoutSeconds: 300, // 기본값
        defaultAction: 'deny', // 기본값 - 보안상 'deny' 권장
        // TODO (Phase 1.5): 사용자가 'allow'를 선택할 경우 경고 메시지 출력 필요
        // - 경고: "⚠️ 'allow'로 설정하면 타임아웃 시 위험한 명령이 자동 실행됩니다!"
        // - 확인: "정말 'allow'로 설정하시겠습니까?" 프롬프트 추가
      },
    };
    saveConfig(config);

    // ━━━ Step 3/3: 배포 및 설정 ━━━
    console.log(chalk.cyan('\n━━━ Step 3/3: 배포 및 설정 ━━━'));

    // Edge Function 배포
    if (validAccessToken) {
      await autoDeployEdgeFunction(config, messengerType as MessengerType, validAccessToken);
    } else {
      await manualEdgeFunctionSetup(messengerType as MessengerType);
    }

    // Hook 등록
    const hookResult = registerHook();
    if (hookResult.success) {
      console.log(chalk.green(`✓ ${hookResult.message}`));
    } else {
      console.log(chalk.red(`✗ ${hookResult.message}`));
    }

    console.log(chalk.green('\n🎉 Setup complete! Claude Guard is now active.\n'));
  });

program
  .command('status')
  .description('Check Claude Guard status and connections')
  .action(async () => {
    console.log(chalk.blue('\n🛡️  Claude Guard Status\n'));

    // Check config
    const config = loadConfig();
    if (!config) {
      console.log(chalk.red('✗ Configuration not found or invalid'));
      console.log(chalk.gray(`  Run ${chalk.cyan('claude-remote-guard init')} to set up`));
      return;
    }
    console.log(chalk.green('✓ Configuration loaded'));

    // Check hook registration
    if (isHookRegistered()) {
      console.log(chalk.green('✓ Hook registered in Claude settings'));
    } else {
      console.log(chalk.yellow('⚠ Hook not registered'));
      console.log(chalk.gray(`  Run ${chalk.cyan('claude-remote-guard init')} to register`));
    }

    // Test Supabase
    console.log(chalk.gray('  Testing Supabase connection...'));
    const sbResult = await testSupabaseConnection(config);
    if (sbResult.ok) {
      console.log(chalk.green('✓ Supabase connection OK'));
    } else {
      console.log(chalk.red(`✗ Supabase connection failed: ${sbResult.error}`));
    }

    await shutdownSupabase();
    console.log('');
  });

program
  .command('test')
  .description('Send a test notification')
  .action(async () => {
    const config = loadConfig();
    if (!config) {
      console.log(chalk.red('Configuration not found. Run claude-remote-guard init first.'));
      return;
    }

    try {
      const messenger = MessengerFactory.create(config.messenger);
      const messengerLabel = MessengerFactory.getMessengerTypeLabel(config.messenger.type);

      console.log(chalk.blue(`Sending test notification via ${messengerLabel}...`));

      const result = await messenger.sendTestNotification();
      if (result.ok) {
        console.log(chalk.green('✓ Test notification sent successfully!'));
      } else {
        console.log(chalk.red(`✗ Failed to send notification: ${result.error}`));
      }
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : 'Unknown error';
      console.log(chalk.red(`✗ Failed: ${errorMessage}`));
    }
  });

program
  .command('uninstall')
  .description('Remove Claude Guard configuration and hooks')
  .action(async () => {
    const { confirm } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'confirm',
        message: 'Are you sure you want to uninstall Claude Guard?',
        default: false,
      },
    ]);

    if (!confirm) {
      console.log(chalk.yellow('Uninstall cancelled.'));
      return;
    }

    // Unregister hook
    const hookResult = unregisterHook();
    console.log(hookResult.success ? chalk.green(`✓ ${hookResult.message}`) : chalk.red(`✗ ${hookResult.message}`));

    // Delete config
    deleteConfig();
    console.log(chalk.green('✓ Configuration deleted'));

    console.log(chalk.blue('\nClaude Guard has been uninstalled.\n'));
  });

program
  .command('show-sql')
  .description('Show SQL script for Supabase database setup')
  .option('--copy', 'Copy SQL to clipboard')
  .action(async (options: { copy?: boolean }) => {
    const sql = getSetupSQL();

    if (options.copy) {
      try {
        // clipboardy 동적 import (ESM)
        const { default: clipboard } = await import('clipboardy');
        await clipboard.write(sql);
        console.log(chalk.green('✓ SQL이 클립보드에 복사되었습니다.'));
        console.log(chalk.gray('Supabase Dashboard → SQL Editor에서 붙여넣기하세요.'));
      } catch {
        console.log(chalk.yellow('⚠ 클립보드 복사 실패. 아래 SQL을 직접 복사하세요.'));
        printSupabaseSetupInstructions();
      }
    } else {
      printSupabaseSetupInstructions();
      console.log(chalk.gray('Tip: --copy 옵션으로 클립보드에 복사할 수 있습니다.'));
    }
  });

async function autoDeployEdgeFunction(config: Config, messengerType: MessengerType, accessToken: string): Promise<void> {
  const projectRef = extractProjectRef(config.supabase.url);
  if (!projectRef) {
    console.log(chalk.red('✗ Supabase URL에서 project ref를 추출할 수 없습니다.'));
    console.log(chalk.yellow('수동 배포로 전환합니다.'));
    await manualEdgeFunctionSetup(messengerType);
    return;
  }

  const funcName = getEdgeFunctionName(messengerType);
  const sourceCode = getEdgeFunctionSource(messengerType);

  // Edge Function 배포
  console.log(chalk.gray(`  Edge Function 배포 중... (${funcName})`));
  const deployResult = await deployEdgeFunction(projectRef, accessToken, funcName, sourceCode);

  if (!deployResult.success) {
    console.log(chalk.red(`\n✗ Edge Function 배포 실패: ${deployResult.error}`));
    console.log(chalk.yellow('수동 배포로 전환합니다.'));
    await manualEdgeFunctionSetup(messengerType);
    return;
  }
  console.log(chalk.green(`✓ Edge Function 배포 완료: ${deployResult.url}`));

  // Secrets 설정
  const secrets = await collectSecretsForMessenger(config, messengerType);
  if (Object.keys(secrets).length > 0) {
    console.log(chalk.gray('  Secrets 설정 중...'));
    const secretsResult = await setEdgeFunctionSecrets(projectRef, accessToken, secrets);

    if (!secretsResult.success) {
      console.log(chalk.yellow(`⚠ Secrets 설정 실패: ${secretsResult.error}`));
      console.log(chalk.gray('  수동으로 설정해주세요:'));
      for (const [key] of Object.entries(secrets)) {
        console.log(chalk.cyan(`    supabase secrets set ${key}=<value>`));
      }
    } else {
      console.log(chalk.green('✓ Secrets 설정 완료'));
    }
  }

  // Telegram인 경우 Webhook 설정
  if (messengerType === 'telegram' && config.messenger.telegram) {
    await setupTelegramWebhook(config.messenger.telegram.botToken, deployResult.url!, secrets['TELEGRAM_WEBHOOK_SECRET']);
  }
}

async function collectSecretsForMessenger(
  config: Config,
  messengerType: MessengerType
): Promise<Record<string, string>> {
  const secrets: Record<string, string> = {};

  // machineIdSecret이 있으면 추가 (모든 메신저 공통)
  if (config.machineIdSecret) {
    secrets['MACHINE_ID_SECRET'] = config.machineIdSecret;
  }

  if (messengerType === 'slack') {
    const { signingSecret } = await inquirer.prompt([
      {
        type: 'password',
        name: 'signingSecret',
        message: 'Slack Signing Secret:',
        mask: '*',
        validate: (input: string) => {
          if (!input || input.length < 10) {
            return 'Slack Signing Secret을 입력해주세요. (Slack App > Basic Information > Signing Secret)';
          }
          return true;
        },
      },
    ]);
    secrets['SLACK_SIGNING_SECRET'] = signingSecret;
  } else if (messengerType === 'telegram' && config.messenger.telegram) {
    secrets['TELEGRAM_BOT_TOKEN'] = config.messenger.telegram.botToken;

    // Webhook Secret 항상 자동 생성
    // 보안: Secret 값을 로그에 출력하지 않음 (Phase 1.4)
    secrets['TELEGRAM_WEBHOOK_SECRET'] = generateWebhookSecret();
    console.log(chalk.gray('  Webhook Secret 자동 생성됨'));
  } else if (messengerType === 'whatsapp' && config.messenger.whatsapp) {
    secrets['TWILIO_AUTH_TOKEN'] = config.messenger.whatsapp.authToken;
  }

  return secrets;
}

async function setupTelegramWebhook(botToken: string, webhookUrl: string, webhookSecret: string): Promise<void> {
  console.log(chalk.gray('  Telegram Webhook 설정 중...'));

  const result = await setTelegramWebhook(botToken, webhookUrl, webhookSecret);

  if (!result.ok) {
    console.log(chalk.yellow(`⚠ Telegram Webhook 설정 실패: ${result.description}`));
    console.log(chalk.gray('  수동으로 설정해주세요:'));
    console.log(chalk.cyan(`  curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \\`));
    console.log(chalk.cyan(`    -d "url=${webhookUrl}" \\`));
    console.log(chalk.cyan(`    -d "secret_token=<YOUR_WEBHOOK_SECRET>"`));
  } else {
    console.log(chalk.green('✓ Telegram Webhook 설정 완료'));
  }
}

async function manualEdgeFunctionSetup(messengerType: MessengerType): Promise<void> {
  const result = createEdgeFunctionFiles(process.cwd(), messengerType);
  if (result.success) {
    const funcName = getEdgeFunctionName(messengerType);
    const envVars = getEdgeFunctionEnvVars(messengerType);

    console.log(chalk.green(`\n✓ Edge Function 파일 생성됨: ./${result.path}/`));
    console.log(chalk.blue('\n다음 단계를 수동으로 진행해주세요:'));
    console.log(chalk.gray('  1. supabase login'));
    console.log(chalk.gray('  2. supabase link --project-ref <your-project-ref>'));
    console.log(chalk.gray(`  3. 환경 변수 설정:`));
    for (const envVar of envVars) {
      console.log(
        chalk.cyan(`     supabase secrets set ${envVar}=<your-${envVar.toLowerCase().replace(/_/g, '-')}>`)
      );
    }
    console.log(chalk.gray(`  4. supabase functions deploy ${funcName}`));
    console.log(chalk.gray(`  5. Webhook URL 설정:`));
    console.log(chalk.cyan(`     https://<project-ref>.supabase.co/functions/v1/${funcName}`));

    // 메신저별 추가 안내
    if (messengerType === 'slack') {
      console.log(chalk.yellow('\n⚠️  Slack 설정:'));
      console.log(chalk.gray('   Signing Secret 위치:'));
      console.log(chalk.gray('   Slack App Settings > Basic Information > App Credentials > Signing Secret'));
      console.log(chalk.gray('   Interactivity URL 설정: Slack App Settings > Interactivity & Shortcuts'));
    } else if (messengerType === 'telegram') {
      console.log(chalk.yellow('\n⚠️  Telegram 설정:'));
      console.log(chalk.gray('   1. 랜덤 시크릿 생성 (예: openssl rand -hex 32)'));
      console.log(chalk.gray('   2. Webhook 설정:'));
      console.log(chalk.cyan('   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \\'));
      console.log(chalk.cyan('     -d "url=https://<project-ref>.supabase.co/functions/v1/telegram-callback" \\'));
      console.log(chalk.cyan('     -d "secret_token=<YOUR_WEBHOOK_SECRET>"'));
    } else if (messengerType === 'whatsapp') {
      console.log(chalk.yellow('\n⚠️  WhatsApp (Twilio) 설정:'));
      console.log(chalk.gray('   Webhook URL 설정: Twilio Console > Messaging > Settings > WhatsApp Sandbox'));
      console.log(
        chalk.gray('   When a message comes in: https://<project-ref>.supabase.co/functions/v1/whatsapp-callback')
      );
    }
  } else {
    console.log(chalk.red(`\n✗ Edge Function 파일 생성 실패: ${result.error}`));
  }
}

/**
 * 사용자가 직접 SQL을 실행하도록 안내하고 확인받는 함수
 */
async function promptManualSqlSetup(): Promise<boolean> {
  try {
    const { default: clipboard } = await import('clipboardy');
    await clipboard.write(getSetupSQL());
    console.log(chalk.green('   SQL이 클립보드에 복사되었습니다.'));
  } catch {
    console.log(chalk.gray('   SQL 확인: claude-remote-guard show-sql --copy'));
  }
  console.log(chalk.gray('   Supabase Dashboard → SQL Editor에서 실행하세요.'));

  const { sqlExecuted } = await inquirer.prompt([
    {
      type: 'confirm',
      name: 'sqlExecuted',
      message: 'SQL을 실행했습니까?',
      default: false,
    },
  ]);

  if (!sqlExecuted) {
    console.log(chalk.yellow('\nSQL 실행 후 다시 init을 실행해주세요.'));
    console.log(chalk.gray('SQL 복사: claude-remote-guard show-sql --copy'));
    return false;
  }

  return true;
}

program.parse();
