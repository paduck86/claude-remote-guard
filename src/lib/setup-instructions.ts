import chalk from 'chalk';

export const SETUP_SQL = `-- Create approval_requests table
CREATE TABLE IF NOT EXISTS approval_requests (
  id UUID PRIMARY KEY,
  command TEXT NOT NULL,
  danger_reason TEXT NOT NULL,
  severity TEXT NOT NULL CHECK (severity IN ('low', 'medium', 'high', 'critical')),
  cwd TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'approved', 'rejected', 'timeout')),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  resolved_at TIMESTAMPTZ,
  resolved_by TEXT,
  machine_id TEXT
);

-- Enable Row Level Security (CRITICAL)
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;

-- Allow INSERT for CLI (anon can create pending requests)
CREATE POLICY "anon_insert" ON approval_requests
  FOR INSERT WITH CHECK (status = 'pending');

-- Allow SELECT for realtime subscription
CREATE POLICY "anon_select" ON approval_requests
  FOR SELECT USING (status = 'pending');

-- Only service_role can UPDATE (Edge Function)
CREATE POLICY "service_role_update" ON approval_requests
  FOR UPDATE USING (auth.role() = 'service_role');

-- Allow DELETE for cleanup
CREATE POLICY "anon_delete" ON approval_requests
  FOR DELETE USING (created_at < NOW() - INTERVAL '24 hours');

-- Enable realtime
ALTER PUBLICATION supabase_realtime ADD TABLE approval_requests;

-- Grant permissions
GRANT SELECT, INSERT, DELETE ON approval_requests TO anon;
GRANT ALL ON approval_requests TO service_role;`;

export function printSupabaseSetupInstructions(): void {
  const border = '━'.repeat(60);

  console.log(chalk.cyan(`\n${border}`));
  console.log(chalk.blue.bold('📋 Supabase Database Setup Required'));
  console.log('');
  console.log(chalk.white('Run the following SQL in your Supabase SQL Editor:'));
  console.log(chalk.gray('(Dashboard → SQL Editor → New query)'));
  console.log(chalk.cyan(`${border}`));
  console.log(chalk.yellow(SETUP_SQL));
  console.log(chalk.cyan(border));
  console.log('');
  console.log(
    chalk.gray('Full SQL with RLS policies: supabase/migrations/001_create_approval_requests.sql')
  );
  console.log('');
}
