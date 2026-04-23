-- saved_profiles: cache enrichment results per LinkedIn URL per user
CREATE TABLE IF NOT EXISTS saved_profiles (
  id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  linkedin_url  TEXT NOT NULL,
  full_name     TEXT,
  work_email    TEXT,
  personal_email TEXT,
  title         TEXT,
  company       TEXT,
  title_verified BOOLEAN DEFAULT false,
  email_status  TEXT DEFAULT 'not_found',
  enriched_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
  is_bookmarked BOOLEAN NOT NULL DEFAULT false,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
  UNIQUE (user_id, linkedin_url)
);

CREATE INDEX IF NOT EXISTS saved_profiles_user_id_idx ON saved_profiles(user_id);
CREATE INDEX IF NOT EXISTS saved_profiles_bookmarked_idx ON saved_profiles(user_id, is_bookmarked) WHERE is_bookmarked = true;

ALTER TABLE saved_profiles ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can view their own saved profiles"
  ON saved_profiles FOR SELECT
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert their own saved profiles"
  ON saved_profiles FOR INSERT
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can update their own saved profiles"
  ON saved_profiles FOR UPDATE
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

CREATE POLICY "Users can delete their own saved profiles"
  ON saved_profiles FOR DELETE
  USING (auth.uid() = user_id);
