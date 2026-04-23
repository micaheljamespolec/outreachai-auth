-- ── recruiter_profiles table ─────────────────────────────────────────────────
-- Stores one row per user with recruiter identity used in draft personalization.

DO $$ BEGIN
  CREATE TYPE hiring_focus_enum AS ENUM (
    'engineering',
    'product',
    'design',
    'data',
    'sales',
    'marketing',
    'finance',
    'legal',
    'hr',
    'operations',
    'executive',
    'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE tone_enum AS ENUM (
    'professional',
    'friendly',
    'direct',
    'warm',
    'formal'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS recruiter_profiles (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       uuid NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name     text NOT NULL,
  company_name  text NOT NULL,
  job_title     text,
  hiring_focus  hiring_focus_enum,
  tone          tone_enum,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id)
);

ALTER TABLE recruiter_profiles ENABLE ROW LEVEL SECURITY;

DO $$ BEGIN
  CREATE POLICY "Users can view their own recruiter profile"
    ON recruiter_profiles FOR SELECT
    USING (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can insert their own recruiter profile"
    ON recruiter_profiles FOR INSERT
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE POLICY "Users can update their own recruiter profile"
    ON recruiter_profiles FOR UPDATE
    USING (auth.uid() = user_id)
    WITH CHECK (auth.uid() = user_id);
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ── DB function: check if current auth user is a first-time user ──────────────
-- Returns TRUE if the calling user has no recruiter_profiles row (needs onboarding).
-- Uses auth.uid() internally — no arbitrary UUID accepted.
CREATE OR REPLACE FUNCTION is_first_time_user()
RETURNS boolean
LANGUAGE sql
SECURITY INVOKER
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1 FROM recruiter_profiles WHERE user_id = auth.uid()
  );
$$;

-- ── Trigger: auto-update updated_at on recruiter_profiles changes ─────────────
CREATE OR REPLACE FUNCTION update_recruiter_profiles_updated_at()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$;

DROP TRIGGER IF EXISTS recruiter_profiles_updated_at ON recruiter_profiles;
CREATE TRIGGER recruiter_profiles_updated_at
  BEFORE UPDATE ON recruiter_profiles
  FOR EACH ROW
  EXECUTE FUNCTION update_recruiter_profiles_updated_at();
