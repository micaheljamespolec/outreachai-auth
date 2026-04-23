/*
  # Create enrichment_debug_logs table

  ## Summary
  Stores raw request/response payloads from third-party enrichment providers
  (e.g. FullEnrich). Used for debugging failed enrichments and provider
  reliability monitoring. Written in the `finally` block of the edge function
  so it captures both successes and failures.

  ## New Table: enrichment_debug_logs
  | Column           | Type        | Notes                                     |
  |------------------|-------------|-------------------------------------------|
  | id               | uuid PK     | auto-generated                            |
  | user_id          | uuid FK     | references auth.users                     |
  | provider         | text        | e.g. 'fullenrich_v2'                      |
  | request_payload  | jsonb       | sanitised request sent to the provider    |
  | response_payload | jsonb       | raw provider response (nullable)          |
  | status_code      | integer     | HTTP status returned by provider          |
  | created_at       | timestamptz | auto                                      |

  ## Security
  - RLS enabled.
  - Authenticated users may only INSERT their own rows (edge function writes as
    the user's JWT via the service-role client, so inserts always pass).
  - SELECT is restricted to service-role only (no policy = no authenticated
    read), keeping raw provider data private.
*/

CREATE TABLE IF NOT EXISTS enrichment_debug_logs (
  id               uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  provider         text        NOT NULL,
  request_payload  jsonb,
  response_payload jsonb,
  status_code      integer     NOT NULL DEFAULT 0,
  created_at       timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE enrichment_debug_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can insert own debug logs"
  ON enrichment_debug_logs FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS enrichment_debug_logs_user_id_created_at_idx
  ON enrichment_debug_logs (user_id, created_at DESC);
