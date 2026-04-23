/*
  # Create credits table with billing RPCs

  ## Summary
  Adds the `credits` table that tracks per-user enrichment and AI-run quotas,
  plus two server-side RPCs:

  1. `deduct_credit(p_user_id uuid) → boolean`
     Called by the `enrich-and-draft` edge function before every fresh enrichment.
     - Auto-creates a free-tier row if one doesn't exist (new-user safe).
     - Returns TRUE and increments `lookups_used` when the user is under their limit.
     - Returns FALSE (without incrementing) when the limit is reached.

  2. `check_and_reset_credits(p_user_id uuid) → void`
     Called by the extension's `getCredits()` on each popup open.
     - Resets `lookups_used` and `ai_runs_used` to 0 when `period_end` is in the past.
     - Advances `period_end` by 30 days.
     - No-op if the period has not expired yet.

  ## New Table: credits
  | Column        | Type      | Notes                                      |
  |---------------|-----------|--------------------------------------------|
  | id            | uuid PK   | auto-generated                             |
  | user_id       | uuid FK   | references auth.users, unique per user     |
  | tier          | text      | 'free' \| 'pro' \| 'team', default 'free' |
  | lookups_used  | int       | incremented by deduct_credit RPC           |
  | ai_runs_used  | int       | incremented client-side via REST PATCH     |
  | period_end    | timestamptz | billing period boundary; reset trigger   |
  | created_at    | timestamptz | auto                                      |
  | updated_at    | timestamptz | auto                                      |

  ## Security
  - RLS enabled; owner-only SELECT and UPDATE (no INSERT — row created by RPC as
    SECURITY DEFINER so users cannot forge their own credits row).
  - INSERT and DELETE are intentionally blocked for authenticated role.
*/

CREATE TABLE IF NOT EXISTS credits (
  id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid        NOT NULL UNIQUE REFERENCES auth.users(id) ON DELETE CASCADE,
  tier         text        NOT NULL DEFAULT 'free',
  lookups_used integer     NOT NULL DEFAULT 0,
  ai_runs_used integer     NOT NULL DEFAULT 0,
  period_end   timestamptz NOT NULL DEFAULT (now() + interval '30 days'),
  created_at   timestamptz NOT NULL DEFAULT now(),
  updated_at   timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE credits ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own credits"
  ON credits FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can update own credits"
  ON credits FOR UPDATE
  TO authenticated
  USING (auth.uid() = user_id)
  WITH CHECK (auth.uid() = user_id);

-- ── deduct_credit ─────────────────────────────────────────────────────────────
-- Returns TRUE and bumps lookups_used if the user is under their tier limit.
-- Returns FALSE if the limit is reached. Auto-creates the row for new users.
CREATE OR REPLACE FUNCTION deduct_credit(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  v_tier        text;
  v_used        integer;
  v_limit       integer;
BEGIN
  -- Upsert: create the credits row if it doesn't exist yet
  INSERT INTO credits (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  SELECT tier, lookups_used
    INTO v_tier, v_used
    FROM credits
   WHERE user_id = p_user_id;

  v_limit := CASE v_tier
    WHEN 'pro'  THEN 100
    WHEN 'team' THEN 500
    ELSE 10          -- free tier
  END;

  IF v_used >= v_limit THEN
    RETURN false;
  END IF;

  UPDATE credits
     SET lookups_used = lookups_used + 1,
         updated_at   = now()
   WHERE user_id = p_user_id;

  RETURN true;
END;
$$;

-- ── check_and_reset_credits ───────────────────────────────────────────────────
-- Resets usage counters when the billing period has expired.
CREATE OR REPLACE FUNCTION check_and_reset_credits(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  -- Upsert: create the credits row if it doesn't exist yet
  INSERT INTO credits (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE credits
     SET lookups_used  = 0,
         ai_runs_used  = 0,
         period_end    = now() + interval '30 days',
         updated_at    = now()
   WHERE user_id   = p_user_id
     AND period_end < now();
END;
$$;
