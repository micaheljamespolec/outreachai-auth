-- Additive migration: store full FullEnrich raw API response per saved profile
-- Applied to linked DB via: supabase db query --linked (migration history mismatch prevents db push)
ALTER TABLE saved_profiles ADD COLUMN IF NOT EXISTS raw_data JSONB;
