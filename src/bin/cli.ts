#!/usr/bin/env node

import { Command } from 'commander';
import chalk from 'chalk';
import inquirer from 'inquirer';
import {
  loadConfig,
  saveConfig,
  getConfigPath,
  configExists,
  deleteConfig,
  type Config,
} from '../lib/config.js';
import { registerHook, unregisterHook, isHookRegistered } from '../lib/claude-settings.js';
import { sendTestNotification } from '../lib/slack.js';
import { testConnection as testSupabaseConnection, shutdownSupabase } from '../lib/supabase.js';
import { createEdgeFunctionFiles, getEdgeFunctionEnvVars, getEdgeFunctionName } from '../lib/edge-function.js';
import type { MessengerType } from '../lib/messenger/types.js';
import { printSupabaseSetupInstructions } from '../lib/setup-instructions.js';

const program = new Command();

program
  .name('claude-remote-guard')
  .description('Claude Guard - Remote approval system for Claude Code CLI')
  .version('1.0.0');

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

    // Step 1: Select messenger type
    const { messengerType } = await inquirer.prompt([
      {
        type: 'list',
        name: 'messengerType',
        message: 'Select notification messenger:',
        choices: [
          { name: 'Slack', value: 'slack' },
          { name: 'Telegram', value: 'telegram' },
          { name: 'WhatsApp (Twilio)', value: 'whatsapp' },
        ],
        default: 'slack',
      },
    ]);

    // Step 2: Messenger-specific configuration
    let messengerConfig: Config['messenger'];

    if (messengerType === 'slack') {
      const slackAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'webhookUrl',
          message: 'Slack Webhook URL:',
          validate: (input: string) => {
            if (!input.startsWith('https://hooks.slack.com/')) {
              return 'Please enter a valid Slack webhook URL';
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'channelId',
          message: 'Slack Channel ID (optional):',
          default: '',
        },
      ]);
      messengerConfig = {
        type: 'slack',
        slack: {
          webhookUrl: slackAnswers.webhookUrl,
          channelId: slackAnswers.channelId || undefined,
        },
      };
    } else if (messengerType === 'telegram') {
      const telegramAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'botToken',
          message: 'Telegram Bot Token:',
          validate: (input: string) => {
            if (!input || input.length < 10) {
              return 'Please enter a valid Telegram Bot Token';
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'chatId',
          message: 'Telegram Chat ID:',
          validate: (input: string) => {
            if (!input || input.length === 0) {
              return 'Please enter a valid Chat ID';
            }
            return true;
          },
        },
      ]);
      messengerConfig = {
        type: 'telegram',
        telegram: {
          botToken: telegramAnswers.botToken,
          chatId: telegramAnswers.chatId,
        },
      };
    } else {
      // WhatsApp (Twilio)
      const whatsappAnswers = await inquirer.prompt([
        {
          type: 'input',
          name: 'accountSid',
          message: 'Twilio Account SID:',
          validate: (input: string) => {
            if (!input || !input.startsWith('AC')) {
              return 'Please enter a valid Twilio Account SID (starts with AC)';
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'authToken',
          message: 'Twilio Auth Token:',
          validate: (input: string) => {
            if (!input || input.length < 20) {
              return 'Please enter a valid Twilio Auth Token';
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'fromNumber',
          message: 'WhatsApp From Number (e.g., whatsapp:+14155238886):',
          validate: (input: string) => {
            if (!input.startsWith('whatsapp:+')) {
              return 'Please enter a valid WhatsApp number (format: whatsapp:+1234567890)';
            }
            return true;
          },
        },
        {
          type: 'input',
          name: 'toNumber',
          message: 'WhatsApp To Number (e.g., whatsapp:+1234567890):',
          validate: (input: string) => {
            if (!input.startsWith('whatsapp:+')) {
              return 'Please enter a valid WhatsApp number (format: whatsapp:+1234567890)';
            }
            return true;
          },
        },
      ]);
      messengerConfig = {
        type: 'whatsapp',
        whatsapp: {
          accountSid: whatsappAnswers.accountSid,
          authToken: whatsappAnswers.authToken,
          fromNumber: whatsappAnswers.fromNumber,
          toNumber: whatsappAnswers.toNumber,
        },
      };
    }

    // Step 3: Common configuration (Supabase and Rules)
    const answers = await inquirer.prompt([
      {
        type: 'input',
        name: 'supabaseUrl',
        message: 'Supabase Project URL (https://xxx.supabase.co):',
        validate: (input: string) => {
          if (!input.startsWith('https://') || !input.includes('.supabase.co')) {
            return 'Please enter a valid Supabase URL (https://xxx.supabase.co)';
          }
          return true;
        },
      },
      {
        type: 'input',
        name: 'supabaseAnonKey',
        message: 'Supabase Anon Key:',
        validate: (input: string) => {
          if (!input || input.length < 20) {
            return 'Please enter a valid Supabase Anon Key';
          }
          return true;
        },
      },
      {
        type: 'number',
        name: 'timeoutSeconds',
        message: 'Approval timeout (seconds):',
        default: 300,
        validate: (input: number) => {
          if (input < 10 || input > 3600) {
            return 'Timeout must be between 10 and 3600 seconds';
          }
          return true;
        },
      },
      {
        type: 'list',
        name: 'defaultAction',
        message: 'Default action on timeout:',
        choices: [
          { name: 'Deny (safer)', value: 'deny' },
          { name: 'Allow', value: 'allow' },
        ],
        default: 'deny',
      },
    ]);

    const config: Config = {
      messenger: messengerConfig,
      supabase: {
        url: answers.supabaseUrl,
        anonKey: answers.supabaseAnonKey,
      },
      rules: {
        timeoutSeconds: answers.timeoutSeconds,
        defaultAction: answers.defaultAction,
      },
    };

    saveConfig(config);
    console.log(chalk.green(`\n✓ Configuration saved to ${getConfigPath()}`));

    // Register hook
    const hookResult = registerHook();
    if (hookResult.success) {
      console.log(chalk.green(`✓ ${hookResult.message}`));
    } else {
      console.log(chalk.red(`✗ ${hookResult.message}`));
    }

    // Test connections
    const { testNow } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'testNow',
        message: 'Test connections now?',
        default: true,
      },
    ]);

    if (testNow) {
      await runTests(config);
    }

    // Edge Function setup prompt
    const { setupEdgeFunction } = await inquirer.prompt([
      {
        type: 'confirm',
        name: 'setupEdgeFunction',
        message: 'Do you want to set up Supabase Edge Function?',
        default: true,
      },
    ]);

    if (setupEdgeFunction) {
      const result = createEdgeFunctionFiles(process.cwd(), messengerType as MessengerType);
      if (result.success) {
        const funcName = getEdgeFunctionName(messengerType as MessengerType);
        const envVars = getEdgeFunctionEnvVars(messengerType as MessengerType);

        console.log(chalk.green(`\n✓ Edge Function files created at ./${result.path}/`));
        console.log(chalk.blue('\nNext steps:'));
        console.log(chalk.gray('  1. supabase login'));
        console.log(chalk.gray('  2. supabase link --project-ref <your-project-ref>'));
        console.log(chalk.gray(`  3. Set environment variable(s):`));
        for (const envVar of envVars) {
          console.log(chalk.cyan(`     supabase secrets set ${envVar}=<your-${envVar.toLowerCase().replace(/_/g, '-')}>`));
        }
        console.log(chalk.gray(`  4. supabase functions deploy ${funcName}`));
        console.log(chalk.gray(`  5. Set webhook URL to:`));
        console.log(chalk.cyan(`     https://<project-ref>.supabase.co/functions/v1/${funcName}`));

        // Messenger-specific setup instructions
        if (messengerType === 'slack') {
          console.log(chalk.yellow('\n⚠️  Slack Setup:'));
          console.log(chalk.gray('   Get your Signing Secret from:'));
          console.log(chalk.gray('   Slack App Settings > Basic Information > App Credentials > Signing Secret'));
          console.log(chalk.gray('   Set Interactivity URL in: Slack App Settings > Interactivity & Shortcuts'));
        } else if (messengerType === 'telegram') {
          console.log(chalk.yellow('\n⚠️  Telegram Setup:'));
          console.log(chalk.gray('   1. Generate a random secret (e.g., openssl rand -hex 32)'));
          console.log(chalk.gray('   2. Set webhook with secret_token:'));
          console.log(chalk.cyan('   curl -X POST "https://api.telegram.org/bot<BOT_TOKEN>/setWebhook" \\'));
          console.log(chalk.cyan('     -d "url=https://<project-ref>.supabase.co/functions/v1/telegram-callback" \\'));
          console.log(chalk.cyan('     -d "secret_token=<YOUR_WEBHOOK_SECRET>"'));
        } else if (messengerType === 'whatsapp') {
          console.log(chalk.yellow('\n⚠️  WhatsApp (Twilio) Setup:'));
          console.log(chalk.gray('   Set webhook URL in: Twilio Console > Messaging > Settings > WhatsApp Sandbox'));
          console.log(chalk.gray('   When a message comes in: https://<project-ref>.supabase.co/functions/v1/whatsapp-callback'));
        }
      } else {
        console.log(chalk.red(`\n✗ Failed to create Edge Function files: ${result.error}`));
      }
    }

    // Always show SQL setup instructions
    printSupabaseSetupInstructions();

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

    const messengerType = config.messenger.type;
    console.log(chalk.blue(`Sending test notification via ${messengerType}...`));

    if (messengerType === 'slack' && config.messenger.slack) {
      const result = await sendTestNotification(config.messenger.slack.webhookUrl);
      if (result.ok) {
        console.log(chalk.green('✓ Test notification sent successfully!'));
      } else {
        console.log(chalk.red(`✗ Failed to send notification: ${result.error}`));
      }
    } else if (messengerType === 'telegram') {
      // TODO: Implement Telegram test notification
      console.log(chalk.yellow('⚠ Telegram test notification not yet implemented'));
    } else if (messengerType === 'whatsapp') {
      // TODO: Implement WhatsApp test notification
      console.log(chalk.yellow('⚠ WhatsApp test notification not yet implemented'));
    } else {
      console.log(chalk.red('✗ Unknown messenger type or missing configuration'));
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

async function runTests(config: Config): Promise<void> {
  console.log(chalk.blue('\nTesting connections...\n'));

  // Test messenger based on type
  const messengerType = config.messenger.type;
  console.log(chalk.gray(`Testing ${messengerType} connection...`));

  if (messengerType === 'slack' && config.messenger.slack) {
    const slackResult = await sendTestNotification(config.messenger.slack.webhookUrl);
    if (slackResult.ok) {
      console.log(chalk.green('✓ Slack webhook OK'));
    } else {
      console.log(chalk.red(`✗ Slack webhook failed: ${slackResult.error}`));
    }
  } else if (messengerType === 'telegram') {
    // TODO: Implement Telegram test
    console.log(chalk.yellow('⚠ Telegram connection test not yet implemented'));
  } else if (messengerType === 'whatsapp') {
    // TODO: Implement WhatsApp test
    console.log(chalk.yellow('⚠ WhatsApp connection test not yet implemented'));
  }

  // Test Supabase
  console.log(chalk.gray('Testing Supabase connection...'));
  const sbResult = await testSupabaseConnection(config);
  if (sbResult.ok) {
    console.log(chalk.green('✓ Supabase connection OK'));
  } else {
    console.log(chalk.red(`✗ Supabase connection failed: ${sbResult.error}`));
  }

  await shutdownSupabase();
}

program.parse();
