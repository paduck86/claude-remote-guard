# claude-remote-guard

Remote approval system for Claude Code CLI. Get Slack notifications for dangerous commands and approve or reject them in real-time.

## Architecture

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

## Features

- Detects dangerous Bash commands before execution
- Sends Slack notifications with Approve/Reject buttons
- Real-time approval via Supabase Realtime
- Configurable timeout and default actions
- Custom patterns and whitelist support

## Prerequisites

1. **Slack App** with Incoming Webhooks enabled
2. **Supabase Project** (free tier works)
3. **Node.js** 18 or higher

## Installation

```bash
npm install -g claude-remote-guard
```

## Setup

### 1. Create a Slack App

1. Go to [Slack API](https://api.slack.com/apps) and create a new app
2. Enable **Incoming Webhooks** and create a webhook URL
3. Enable **Interactivity** and set the Request URL to your Edge Function URL (see step 3)
4. Install the app to your workspace

### 2. Set up Supabase

1. Create a project at [Supabase Dashboard](https://supabase.com/dashboard)
2. Go to **SQL Editor** and run the following schema:

```sql
CREATE TABLE approval_requests (
  id UUID PRIMARY KEY,
  command TEXT NOT NULL,
  danger_reason TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  cwd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'timeout')),
  created_at TIMESTAMPTZ DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT
);

-- Enable Realtime
ALTER PUBLICATION supabase_realtime ADD TABLE approval_requests;

-- Enable RLS (Row Level Security)
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;

-- Allow anonymous users to insert and select
CREATE POLICY "Allow anonymous insert" ON approval_requests
  FOR INSERT TO anon WITH CHECK (true);

CREATE POLICY "Allow anonymous select" ON approval_requests
  FOR SELECT TO anon USING (true);
```

3. Go to **Project Settings > API** and copy:
   - Project URL (e.g., `https://xxxx.supabase.co`)
   - Anon/public key

### 3. Deploy Edge Function

```bash
# Install Supabase CLI
npm install -g supabase

# Login and link project
supabase login
supabase link --project-ref <your-project-ref>

# Deploy the function
supabase functions deploy slack-callback
```

Update your Slack App's **Interactivity Request URL** to:
`https://<project-ref>.supabase.co/functions/v1/slack-callback`

### 4. Initialize Claude Guard

```bash
guard init
```

Follow the prompts to enter:
- Slack Webhook URL
- Supabase Project URL
- Supabase Anon Key

## Usage

### Commands

```bash
# Initialize Claude Guard
guard init

# Check status and test connections
guard status

# Send a test notification
guard test

# Remove Claude Guard
guard uninstall
```

### How It Works

1. When Claude Code tries to execute a Bash command, the hook intercepts it
2. The command is analyzed for dangerous patterns
3. If dangerous, a Slack notification is sent
4. You click Approve or Reject in Slack
5. The command is allowed or blocked accordingly

### Dangerous Commands Detected

| Pattern | Severity | Reason |
|---------|----------|--------|
| `rm -rf` | high | Recursive force file deletion |
| `git push --force` | critical | Force push can overwrite remote history |
| `git reset --hard` | high | Discards uncommitted changes |
| `npm publish` | high | Publishing package to npm |
| `sudo` | high | Elevated privileges |
| `curl \| bash` | critical | Remote script execution |

### Configuration

Configuration is stored in `~/.claude-guard/config.json`:

```json
{
  "slack": {
    "webhookUrl": "https://hooks.slack.com/services/...",
    "channelId": "C1234567890"
  },
  "supabase": {
    "url": "https://xxxx.supabase.co",
    "anonKey": "eyJhbGciOiJIUzI1NiIs..."
  },
  "rules": {
    "timeoutSeconds": 300,
    "defaultAction": "deny",
    "customPatterns": [
      {
        "pattern": "my-custom-cmd",
        "severity": "high",
        "reason": "Custom dangerous command"
      }
    ],
    "whitelist": [
      "npm run deploy"
    ]
  }
}
```

### Options

- `timeoutSeconds`: How long to wait for approval (default: 300)
- `defaultAction`: What to do on timeout - `allow` or `deny` (default: deny)
- `customPatterns`: Additional patterns to detect as dangerous
- `whitelist`: Commands to always allow (regex patterns)

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
