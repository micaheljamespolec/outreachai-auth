/*
  # Campaign Automation Tables

  Adds two tables to support batch campaign automation from LinkedIn Recruiter CSV imports.

  ## New Tables

  ### campaigns
  - Represents one outreach campaign tied to one saved job.
  - `id` - Primary key
  - `user_id` - Owner (FK to auth.users)
  - `name` - Campaign name, typically from CSV "Active Project" column
  - `job_id` - FK to saved_jobs (nullable until job is linked)
  - `status` - Workflow status: needs_job | ready | active | archived
  - `total_count` - Total candidates imported
  - `enriched_count` - Candidates with enriched contact data
  - `drafted_count` - Candidates with generated draft emails
  - `approved_count` - Candidates approved for sending
  - `created_at`, `updated_at`

  ### campaign_candidates
  - One row per candidate imported from a CSV row.
  - Raw CSV columns stored as-is, plus enrichment and draft output columns.
  - `id` - Primary key
  - `campaign_id` - FK to campaigns
  - `user_id` - Owner (denormalized for RLS efficiency)
  - CSV input columns: first_name, last_name, headline, location, current_title, current_company,
    csv_email, phone, linkedin_url, notes, feedback
  - `saved_profile_id` - FK to saved_profiles once enrichment links a profile
  - `status` - Workflow status: imported | enriching | enriched | no_email | drafting | drafted |
    approved | skipped | failed
  - Enrichment output: work_email, personal_email, email_status, enriched_title, enriched_company
  - Draft output: draft_subject, draft_body, draft_confidence
  - Timestamps: enriched_at, drafted_at, approved_at, created_at, updated_at

  ## Security
  - RLS enabled on both tables
  - Owner-only SELECT / INSERT / UPDATE / DELETE on campaigns
  - Owner-only SELECT / INSERT / UPDATE / DELETE on campaign_candidates

  ## Indexes
  - campaigns(user_id)
  - campaign_candidates(campaign_id)
  - campaign_candidates(user_id, status)
*/

-- ── campaigns ─────────────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaigns (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name           text NOT NULL,
  job_id         uuid REFERENCES saved_jobs(id) ON DELETE SET NULL,
  status         text NOT NULL DEFAULT 'needs_job'
                   CHECK (status IN ('needs_job','ready','active','archived')),
  total_count    int  NOT NULL DEFAULT 0,
  enriched_count int  NOT NULL DEFAULT 0,
  drafted_count  int  NOT NULL DEFAULT 0,
  approved_count int  NOT NULL DEFAULT 0,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE campaigns ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own campaigns"
  ON campaigns FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own campaigns"
  ON campaigns FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own campaigns"
  ON campaigns FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own campaigns"
  ON campaigns FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_campaigns_user_id ON campaigns(user_id);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_campaigns_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_campaigns_updated_at ON campaigns;
CREATE TRIGGER trg_campaigns_updated_at
  BEFORE UPDATE ON campaigns
  FOR EACH ROW EXECUTE FUNCTION update_campaigns_updated_at();

-- ── campaign_candidates ───────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS campaign_candidates (
  id                uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  campaign_id       uuid NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  user_id           uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,

  -- Raw CSV columns
  first_name        text,
  last_name         text,
  headline          text,
  location          text,
  current_title     text,
  current_company   text,
  csv_email         text,
  phone             text,
  linkedin_url      text,
  notes             text,
  feedback          text,

  -- Link to enriched profile (populated after enrichment)
  saved_profile_id  uuid REFERENCES saved_profiles(id) ON DELETE SET NULL,

  -- Workflow status
  status            text NOT NULL DEFAULT 'imported'
                      CHECK (status IN (
                        'imported','enriching','enriched','no_email',
                        'drafting','drafted','approved','skipped','failed'
                      )),

  -- Enrichment output
  work_email        text,
  personal_email    text,
  email_status      text,
  enriched_title    text,
  enriched_company  text,

  -- Draft output
  draft_subject     text,
  draft_body        text,
  draft_confidence  numeric(4,3),

  -- Timestamps
  enriched_at       timestamptz,
  drafted_at        timestamptz,
  approved_at       timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE campaign_candidates ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can select own campaign candidates"
  ON campaign_candidates FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own campaign candidates"
  ON campaign_candidates FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update own campaign candidates"
  ON campaign_candidates FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete own campaign candidates"
  ON campaign_candidates FOR DELETE
  TO authenticated
  USING (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS idx_campaign_candidates_campaign_id ON campaign_candidates(campaign_id);
CREATE INDEX IF NOT EXISTS idx_campaign_candidates_user_status ON campaign_candidates(user_id, status);

-- Auto-update updated_at
CREATE OR REPLACE FUNCTION update_campaign_candidates_updated_at()
RETURNS TRIGGER LANGUAGE plpgsql AS $$
BEGIN NEW.updated_at = now(); RETURN NEW; END;
$$;

DROP TRIGGER IF EXISTS trg_campaign_candidates_updated_at ON campaign_candidates;
CREATE TRIGGER trg_campaign_candidates_updated_at
  BEFORE UPDATE ON campaign_candidates
  FOR EACH ROW EXECUTE FUNCTION update_campaign_candidates_updated_at();
