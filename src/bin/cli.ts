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
import { createEdgeFunctionFiles } from '../lib/edge-function.js';
import { printSupabaseSetupInstructions } from '../lib/setup-instructions.js';

const program = new Command();

program
  .name('guard')
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

    const answers = await inquirer.prompt([
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
      slack: {
        webhookUrl: answers.webhookUrl,
        channelId: answers.channelId || undefined,
      },
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
      const result = createEdgeFunctionFiles(process.cwd());
      if (result.success) {
        console.log(chalk.green(`\n✓ Edge Function files created at ./${result.path}/`));
        console.log(chalk.blue('\nNext steps:'));
        console.log(chalk.gray('  1. supabase login'));
        console.log(chalk.gray('  2. supabase link --project-ref <your-project-ref>'));
        console.log(chalk.gray('  3. Set SLACK_SIGNING_SECRET:'));
        console.log(chalk.cyan('     supabase secrets set SLACK_SIGNING_SECRET=<your-slack-signing-secret>'));
        console.log(chalk.gray('  4. supabase functions deploy slack-callback'));
        console.log(chalk.gray('  5. Set Slack Interactivity URL to:'));
        console.log(chalk.cyan('     https://<project-ref>.supabase.co/functions/v1/slack-callback'));
        console.log(chalk.yellow('\n⚠️  Important: Get your Slack Signing Secret from:'));
        console.log(chalk.gray('   Slack App Settings > Basic Information > App Credentials > Signing Secret'));
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
      console.log(chalk.gray(`  Run ${chalk.cyan('guard init')} to set up`));
      return;
    }
    console.log(chalk.green('✓ Configuration loaded'));

    // Check hook registration
    if (isHookRegistered()) {
      console.log(chalk.green('✓ Hook registered in Claude settings'));
    } else {
      console.log(chalk.yellow('⚠ Hook not registered'));
      console.log(chalk.gray(`  Run ${chalk.cyan('guard init')} to register`));
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
  .description('Send a test notification to Slack')
  .action(async () => {
    const config = loadConfig();
    if (!config) {
      console.log(chalk.red('Configuration not found. Run guard init first.'));
      return;
    }

    console.log(chalk.blue('Sending test notification to Slack...'));

    const result = await sendTestNotification(config.slack.webhookUrl);
    if (result.ok) {
      console.log(chalk.green('✓ Test notification sent successfully!'));
    } else {
      console.log(chalk.red(`✗ Failed to send notification: ${result.error}`));
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

  // Test Slack
  console.log(chalk.gray('Testing Slack webhook...'));
  const slackResult = await sendTestNotification(config.slack.webhookUrl);
  if (slackResult.ok) {
    console.log(chalk.green('✓ Slack webhook OK'));
  } else {
    console.log(chalk.red(`✗ Slack webhook failed: ${slackResult.error}`));
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
