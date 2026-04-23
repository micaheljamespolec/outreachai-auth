-- Enable RLS on tables that are missing it
ALTER TABLE outreach_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrichment_debug_logs ENABLE ROW LEVEL SECURITY;

-- outreach_sources: users can only read/write their own records
-- (linked via outreach_run_id → outreach_runs.user_id)
CREATE POLICY "Users can view their own outreach sources"
  ON outreach_sources FOR SELECT
  USING (
    EXISTS (
      SELECT 1 FROM outreach_runs
      WHERE outreach_runs.id = outreach_sources.outreach_run_id
        AND outreach_runs.user_id = auth.uid()
    )
  );

CREATE POLICY "Users can insert their own outreach sources"
  ON outreach_sources FOR INSERT
  WITH CHECK (
    EXISTS (
      SELECT 1 FROM outreach_runs
      WHERE outreach_runs.id = outreach_sources.outreach_run_id
        AND outreach_runs.user_id = auth.uid()
    )
  );

-- enrichment_debug_logs: service role only — no direct user access
-- (no policies = no access for authenticated/anon roles when RLS is enabled)
-- The edge function uses the service role key, so it bypasses RLS entirely.
