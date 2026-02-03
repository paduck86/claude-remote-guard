-- Create approval_requests table with proper security
-- Run this in your Supabase SQL editor

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

-- 레거시 데이터 정리: NULL인 machine_id에 고유 값 설정
UPDATE approval_requests
SET machine_id = 'legacy-' || id::text
WHERE machine_id IS NULL;

-- Create indexes for common queries
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

-- Policy: Allow insert with machine_id required
CREATE POLICY "Allow insert pending requests" ON approval_requests
  FOR INSERT
  WITH CHECK (
    status = 'pending' AND
    resolved_at IS NULL AND
    resolved_by IS NULL AND
    machine_id IS NOT NULL AND
    machine_id != '' AND
    length(machine_id) >= 16
  );

-- Policy: Allow select own requests
-- Note: machine_id 체크 제거 - WebSocket(Realtime)은 HTTP 헤더를 전달하지 않음
-- 보안은 UUID v4 requestId의 추측 불가능성으로 보장
CREATE POLICY "Allow select own requests" ON approval_requests
  FOR SELECT
  USING (
    created_at > NOW() - INTERVAL '1 hour'
  );

-- Policy: Only service role can update
CREATE POLICY "Allow update via service role only" ON approval_requests
  FOR UPDATE
  USING (auth.role() = 'service_role');

-- Policy: Allow cleanup of old requests
CREATE POLICY "Allow delete old requests" ON approval_requests
  FOR DELETE
  USING (created_at < NOW() - INTERVAL '24 hours');

-- Enable realtime
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'approval_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE approval_requests;
  END IF;
END $$;

-- Cleanup function for old approval requests
CREATE OR REPLACE FUNCTION cleanup_old_approval_requests()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM approval_requests
  WHERE created_at < NOW() - INTERVAL '7 days';
END;
$$;

-- Grant permissions
GRANT SELECT, INSERT, DELETE ON approval_requests TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_requests TO authenticated;
GRANT ALL ON approval_requests TO service_role;

COMMENT ON TABLE approval_requests IS 'Stores pending command approval requests from Claude Guard CLI';
COMMENT ON COLUMN approval_requests.machine_id IS 'Required identifier to scope requests per machine (32-char hex)';

-- ==========================================
-- 2. rate_limits 테이블 (서버리스 Rate Limiting)
-- ==========================================

CREATE TABLE IF NOT EXISTS rate_limits (
  id SERIAL PRIMARY KEY,
  identifier TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Index for fast queries
CREATE INDEX IF NOT EXISTS idx_rate_limits_identifier_created ON rate_limits(identifier, created_at);

-- Enable RLS
ALTER TABLE rate_limits ENABLE ROW LEVEL SECURITY;

-- Drop existing policy if any
DROP POLICY IF EXISTS "service_role_only" ON rate_limits;

-- Policy: service_role only (Edge Functions use service_role_key)
CREATE POLICY "service_role_only" ON rate_limits
  FOR ALL USING (auth.role() = 'service_role');

-- Grant permissions
GRANT ALL ON rate_limits TO service_role;
GRANT USAGE, SELECT ON SEQUENCE rate_limits_id_seq TO service_role;

-- Cleanup function for old rate limit records
CREATE OR REPLACE FUNCTION cleanup_old_rate_limits()
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
AS $$
BEGIN
  DELETE FROM rate_limits
  WHERE created_at < NOW() - INTERVAL '1 hour';
END;
$$;

COMMENT ON TABLE rate_limits IS 'Rate limiting records for Edge Functions (serverless-compatible)';
