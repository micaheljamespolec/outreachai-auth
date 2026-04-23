/*
  # Add increment_ai_run RPC

  ## Summary
  Moves `ai_runs_used` incrementing from a client-side REST PATCH into a
  server-side SECURITY DEFINER function, so clients can never directly write
  arbitrary values to the credits table.

  ## New Function: increment_ai_run(p_user_id uuid) → void
  - Auto-creates the credits row for new users (same pattern as deduct_credit).
  - Increments `ai_runs_used` by exactly 1 and updates `updated_at`.
  - SECURITY DEFINER with fixed search_path = public — runs as the function
    owner, bypassing RLS, so the edge function's service-role client is not
    required to own the row.

  ## Security
  - No new RLS policies needed; the function is SECURITY DEFINER and is called
    only from trusted edge functions via the service role.
  - The UPDATE-only RLS policy on credits for authenticated users is unchanged —
    clients still cannot directly set ai_runs_used to an arbitrary value.
*/

CREATE OR REPLACE FUNCTION increment_ai_run(p_user_id uuid)
RETURNS void
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
BEGIN
  INSERT INTO credits (user_id)
  VALUES (p_user_id)
  ON CONFLICT (user_id) DO NOTHING;

  UPDATE credits
     SET ai_runs_used = ai_runs_used + 1,
         updated_at   = now()
   WHERE user_id = p_user_id;
END;
$$;
