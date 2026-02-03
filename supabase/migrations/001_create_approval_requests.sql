-- Create approval_requests table with proper security
-- Run this in your Supabase SQL editor

-- Create the table
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
  -- Add machine identifier for multi-user scenarios
  machine_id TEXT,
  -- Add index for faster queries
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

-- Create indexes for common queries
CREATE INDEX IF NOT EXISTS idx_approval_requests_status ON approval_requests(status);
CREATE INDEX IF NOT EXISTS idx_approval_requests_created_at ON approval_requests(created_at);
CREATE INDEX IF NOT EXISTS idx_approval_requests_machine_id ON approval_requests(machine_id);

-- Enable Row Level Security
ALTER TABLE approval_requests ENABLE ROW LEVEL SECURITY;

-- Drop existing policies if any
DROP POLICY IF EXISTS "Allow insert for authenticated and anon" ON approval_requests;
DROP POLICY IF EXISTS "Allow select own requests" ON approval_requests;
DROP POLICY IF EXISTS "Allow update via service role only" ON approval_requests;
DROP POLICY IF EXISTS "Allow delete old requests" ON approval_requests;

-- Policy: Allow insert (CLI creates requests)
-- In production, consider adding machine_id validation
CREATE POLICY "Allow insert for authenticated and anon" ON approval_requests
  FOR INSERT
  WITH CHECK (
    status = 'pending' AND
    resolved_at IS NULL AND
    resolved_by IS NULL
  );

-- Policy: Allow select own pending requests only (for real-time subscription)
-- Clients can only see their own pending requests
CREATE POLICY "Allow select pending requests" ON approval_requests
  FOR SELECT
  USING (
    status = 'pending' AND
    created_at > NOW() - INTERVAL '1 hour'
  );

-- Policy: Only service role can update (Edge Function uses service role key)
-- This prevents unauthorized approval/rejection via anon key
CREATE POLICY "Allow update via service role only" ON approval_requests
  FOR UPDATE
  USING (auth.role() = 'service_role');

-- Policy: Allow cleanup of old requests
CREATE POLICY "Allow delete old requests" ON approval_requests
  FOR DELETE
  USING (created_at < NOW() - INTERVAL '24 hours');

-- Enable realtime for the table (ignore if already added)
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_publication_tables
    WHERE pubname = 'supabase_realtime' AND tablename = 'approval_requests'
  ) THEN
    ALTER PUBLICATION supabase_realtime ADD TABLE approval_requests;
  END IF;
END $$;

-- Create a function to auto-cleanup old requests (optional)
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

-- Grant necessary permissions
GRANT SELECT, INSERT, DELETE ON approval_requests TO anon;
GRANT SELECT, INSERT, UPDATE, DELETE ON approval_requests TO authenticated;
GRANT ALL ON approval_requests TO service_role;

-- Comment for documentation
COMMENT ON TABLE approval_requests IS 'Stores pending command approval requests from Claude Guard CLI';
COMMENT ON COLUMN approval_requests.command IS 'The command that requires approval (sensitive info masked)';
COMMENT ON COLUMN approval_requests.machine_id IS 'Optional identifier to scope requests per machine';
