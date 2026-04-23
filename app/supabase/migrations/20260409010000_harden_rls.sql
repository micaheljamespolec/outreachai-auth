-- Additive migration: harden RLS on tables missing it
-- Applied via: supabase db query --linked (NOT db push — migration history mismatch)

-- ── company_domains ───────────────────────────────────────────────────────────
-- Shared domain-to-company cache. Only the edge function (service role) reads/writes it.
-- No user policies = no direct REST access for authenticated or anon roles.
ALTER TABLE company_domains ENABLE ROW LEVEL SECURITY;

-- ── candidate_title_sources ───────────────────────────────────────────────────
-- Internal title-source evidence table. No user_id column; service role only.
-- No user policies = no direct REST access for authenticated or anon roles.
ALTER TABLE candidate_title_sources ENABLE ROW LEVEL SECURITY;

-- ── workflow_jobs ─────────────────────────────────────────────────────────────
-- Job-tracking table with user_id column. Owner-only access.
ALTER TABLE workflow_jobs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own workflow jobs"
  ON workflow_jobs FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own workflow jobs"
  ON workflow_jobs FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own workflow jobs"
  ON workflow_jobs FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own workflow jobs"
  ON workflow_jobs FOR DELETE
  USING (auth.uid() = user_id);

-- ── candidates: add missing DELETE policy ────────────────────────────────────
-- SELECT and INSERT policies already exist; DELETE was missing.
CREATE POLICY "Users can delete own candidates"
  ON candidates FOR DELETE
  USING (auth.uid() = user_id);
