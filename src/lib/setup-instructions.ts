import chalk from 'chalk';

export const SETUP_SQL = `-- Claude Remote Guard: Database Setup
-- Run this in your Supabase SQL Editor

-- ==========================================
-- 1. approval_requests 테이블
-- ==========================================

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
  machine_id TEXT NOT NULL,
  CONSTRAINT valid_resolution CHECK (
    (status = 'pending' AND resolved_at IS NULL AND resolved_by IS NULL) OR
    (status != 'pending' AND resolved_at IS NOT NULL)
  )
);

-- If table already exists, add missing columns
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS danger_reason TEXT NOT NULL DEFAULT '';
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS severity TEXT NOT NULL DEFAULT 'medium';
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS cwd TEXT NOT NULL DEFAULT '';
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS machine_id TEXT;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ;
ALTER TABLE approval_requests ADD COLUMN IF NOT EXISTS resolved_by TEXT;

-- 레거시 데이터 정리
UPDATE approval_requests SET machine_id = 'legacy-' || id::text WHERE machine_id IS NULL;

-- Create indexes
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_approval_requests_machine_id ON approval_requests(machine_id);

-- Enable Row Level Security
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;

-- Drop existing policies
DROP POLICY IF EXISTS "Allow insert for authenticated and anon" ON approval_requests;
DROP POLICY IF EXISTS "Allow insert pending requests" ON approval_requests;
DROP POLICY IF EXISTS "Allow select own requests" ON approval_requests;
DROP POLICY IF EXISTS "Allow select pending requests" ON approval_requests;
DROP POLICY IF EXISTS "Allow update via service role only" ON approval_requests;
DROP POLICY IF EXISTS "Allow delete old requests" ON approval_requests;
DROP POLICY IF EXISTS "anon_insert" ON approval_requests;
DROP POLICY IF EXISTS "anon_select" ON approval_requests;
DROP POLICY IF EXISTS "service_role_update" ON approval_requests;
DROP POLICY IF EXISTS "anon_delete" ON approval_requests;

-- Policy: Allow insert with machine_id required
CREATE POLICY "Allow insert pending requests" ON approval_requests
  FOR INSERT WITH CHECK (
    status = 'pending' AND
    resolved_at IS NULL AND
    resolved_by IS NULL AND
    machine_id IS NOT NULL AND
    machine_id != '' AND
    length(machine_id) >= 16
  );

-- Policy: Allow select own pending requests only
CREATE POLICY "Allow select pending requests" ON approval_requests
  FOR SELECT USING (
    status = 'pending' AND
    created_at > NOW() - INTERVAL '1 hour' AND
    machine_id IS NOT NULL AND
    machine_id = COALESCE(
      current_setting('request.headers', true)::json->>'x-machine-id',
      'no-header'
    )
  );

-- Policy: Only service role can update
CREATE POLICY "Allow update via service role only" ON approval_requests
  FOR UPDATE USING (auth.role() = 'service_role');

-- Policy: Allow cleanup of old requests
CREATE POLICY "Allow delete old requests" ON approval_requests
  FOR DELETE USING (created_at < NOW() - INTERVAL '24 hours');

-- Enable realtime (ignore if already added)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'approval_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE approval_requests;
  END IF;
END $$;

-- Grant permissions
GRANT SELECT, INSERT, DELETE ON approval_requests TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_requests TO authenticated;
GRANT ALL ON approval_requests TO service_role;

-- ==========================================
-- 2. rate_limits 테이블 (서버리스 Rate Limiting)
-- ==========================================

CREATE TABLE IF NOT EXISTS rate_limits (
  id SERIAL PRIMARY KEY,
  identifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_rate_limits_identifier_created ON rate_limits(identifier, created_at);

ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS "service_role_only" ON rate_limits;

CREATE POLICY "service_role_only" ON rate_limits
  FOR ALL USING (auth.role() = 'service_role');

GRANT ALL ON rate_limits TO service_role;
GRANT USAGE, SELECT ON SEQUENCE rate_limits_id_seq TO service_role;`;

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

// SQL만 반환 (클립보드 복사용)
export function getSetupSQL(): string {
  return SETUP_SQL;
}
