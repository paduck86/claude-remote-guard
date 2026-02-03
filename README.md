# claude-remote-guard

Remote approval system for Claude Code CLI. Get Slack notifications for dangerous commands and approve or reject them in real-time.

## Quick Start

Get started in 5 minutes:

```bash
# 1. Install
npm install -g claude-remote-guard

# 2. Run interactive setup
guard init
```

The `guard init` command will:
- Ask for your Slack Webhook URL and Supabase credentials
- Generate the SQL schema to run in Supabase
- Create the Edge Function files to deploy

Follow the on-screen instructions to complete setup.

## Detailed Setup Guide

### Step 1: Create a Slack App

1. Go to [Slack API](https://api.slack.com/apps) and create a new app
2. Enable **Incoming Webhooks**:
   - Go to "Incoming Webhooks" in the sidebar
   - Toggle "Activate Incoming Webhooks" to On
   - Click "Add New Webhook to Workspace"
   - Select a channel and authorize
   - Copy the Webhook URL (you'll need this for `guard init`)
3. **Note**: We'll configure Interactivity later (Step 6) after deploying the Edge Function

### Step 2: Create Supabase Project

1. Create a project at [Supabase Dashboard](https://supabase.com/dashboard)
2. Go to **Project Settings > API** and copy:
   - Project URL (e.g., `https://xxxx.supabase.co`)
   - Anon/public key

### Step 3: Run guard init

```bash
guard init
```

The interactive setup will ask for:
- Slack Webhook URL (from Step 1)
- Supabase Project URL (from Step 2)
- Supabase Anon Key (from Step 2)

After completion, it will output:
- SQL schema to run in Supabase
- Edge Function files in `~/.claude-guard/supabase/functions/slack-callback/`

### Step 4: Run SQL in Supabase

1. Copy the SQL schema output from `guard init`
2. Go to your Supabase project's **SQL Editor**
3. Paste and run the SQL

The SQL creates the `approval_requests` table with:
- Realtime subscriptions enabled
- Row Level Security (RLS) policies
- Proper indexes for performance

### Step 5: Deploy Edge Function

```bash
# Install Supabase CLI (if not installed)
npm install -g supabase

# Login to Supabase
supabase login

# Link to your project
supabase link --project-ref <your-project-ref>

# Deploy the Edge Function
supabase functions deploy slack-callback --project-ref <your-project-ref>
```

Your Edge Function URL will be:
`https://<project-ref>.supabase.co/functions/v1/slack-callback`

### Step 6: Configure Slack Interactivity

Now that you have the Edge Function URL:

1. Go back to your [Slack App settings](https://api.slack.com/apps)
2. Navigate to **Interactivity & Shortcuts**
3. Toggle "Interactivity" to On
4. Set the **Request URL** to your Edge Function URL:
   `https://<project-ref>.supabase.co/functions/v1/slack-callback`
5. Click "Save Changes"

### Verify Setup

```bash
# Check configuration and connections
guard status

# Send a test notification
guard test
```

## How It Works

```
┌─────────────────┐     ┌──────────────────┐     ┌─────────────────┐
│   Claude Code   │────▶│   hook.ts        │────▶│  Slack API      │
│   (PreToolUse)  │     │  (CLI execution) │     │  (notification) │
└─────────────────┘     └────────┬─────────┘     └────────┬────────┘
                                │                        │
                                │ Realtime subscription  │ Button click
                                ▼                        ▼
                       ┌──────────────────┐     ┌─────────────────┐
                       │  Supabase DB     │◀────│  Edge Function  │
                       │  (PostgreSQL)    │     │  (Deno-based)   │
                       └──────────────────┘     └─────────────────┘
```

1. When Claude Code tries to execute a Bash command, the hook intercepts it
2. The command is analyzed for dangerous patterns
3. If dangerous, a Slack notification is sent with Approve/Reject buttons
4. The approval request is stored in Supabase with `pending` status
5. You click Approve or Reject in Slack
6. The Edge Function updates the status in Supabase
7. The hook receives the update via Realtime subscription
8. The command is allowed or blocked accordingly

## Commands

```bash
guard init       # Initialize Claude Guard (interactive setup)
guard status     # Check status and test connections
guard test       # Send a test notification
guard uninstall  # Remove Claude Guard
```

## Configuration

Configuration is stored in `~/.claude-guard/config.json`:

```json
{
  "slack": {
    "webhookUrl": "https://hooks.slack.com/services/..."
  },
  "supabase": {
    "url": "https://xxxx.supabase.co",
    "anonKey": "eyJhbGciOiJIUzI1NiIs..."
  },
  "rules": {
    "timeoutSeconds": 300,
    "defaultAction": "deny",
    "customPatterns": [],
    "whitelist": []
  }
}
```

### Options

| Option | Default | Description |
|--------|---------|-------------|
| `timeoutSeconds` | 300 | How long to wait for approval |
| `defaultAction` | "deny" | Action on timeout: `allow` or `deny` |
| `customPatterns` | [] | Additional dangerous patterns to detect |
| `whitelist` | [] | Regex patterns for commands to always allow |

### Custom Pattern Example

```json
{
  "rules": {
    "customPatterns": [
      {
        "pattern": "my-deploy-cmd",
        "severity": "high",
        "reason": "Custom deployment command"
      }
    ]
  }
}
```

## Dangerous Patterns

Built-in patterns that trigger approval requests:

| Pattern | Severity | Reason |
|---------|----------|--------|
| `rm -rf` | high | Recursive force file deletion |
| `git push --force` | critical | Force push can overwrite remote history |
| `git reset --hard` | high | Discards uncommitted changes |
| `npm publish` | high | Publishing package to npm |
| `sudo` | high | Elevated privileges |
| `curl \| bash` | critical | Remote script execution |

## Features

- Detects dangerous Bash commands before execution
- Sends Slack notifications with Approve/Reject buttons
- Real-time approval via Supabase Realtime
- Configurable timeout and default actions
- Custom patterns and whitelist support

## Prerequisites

- **Node.js** 18 or higher
- **Slack** workspace with permission to create apps
- **Supabase** account (free tier works)

## Development

```bash
# Install dependencies
npm install

# Build
npm run build

# Run tests
npm test

# Lint
npm run lint
```

## License

MIT
