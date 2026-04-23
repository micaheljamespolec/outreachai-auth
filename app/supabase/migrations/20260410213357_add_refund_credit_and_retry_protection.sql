/*
  # Credit refund function + retry-safe enrichment cache

  ## Changes

  ### 1. New RPC: refund_credit(p_user_id)
  - Decrements lookups_used by 1 (floor 0) for the given user
  - Used to manually refund credits when enrichment failed due to a bug
  - SECURITY DEFINER so it can be called from edge functions or admin tooling

  ### 2. New RPC: refund_credit_by_email(p_email)
  - Convenience wrapper that resolves user_id from email then calls refund_credit
  - Useful when you know the user's email but not their UUID
*/

-- ── refund_credit(uuid) ──────────────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refund_credit(p_user_id uuid)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
BEGIN
  UPDATE credits
  SET lookups_used = GREATEST(0, lookups_used - 1),
      updated_at   = now()
  WHERE user_id = p_user_id;

  RETURN FOUND;
END;
$$;

-- ── refund_credit_by_email(text) ─────────────────────────────────────────────
CREATE OR REPLACE FUNCTION public.refund_credit_by_email(p_email text)
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public'
AS $$
DECLARE
  v_user_id uuid;
BEGIN
  SELECT id INTO v_user_id
  FROM auth.users
  WHERE email = p_email
  LIMIT 1;

  IF v_user_id IS NULL THEN
    RETURN false;
  END IF;

  RETURN public.refund_credit(v_user_id);
END;
$$;
