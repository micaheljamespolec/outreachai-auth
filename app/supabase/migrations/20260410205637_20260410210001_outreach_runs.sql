/*
  # Create outreach_runs table

  ## Summary
  Stores one row per enrichment run performed by the `enrich-and-draft` edge
  function. Acts as an audit log and analytics source for every outreach attempt.

  ## New Table: outreach_runs
  | Column             | Type        | Notes                                        |
  |--------------------|-------------|----------------------------------------------|
  | id                 | uuid PK     | auto-generated                               |
  | user_id            | uuid FK     | references auth.users                        |
  | full_name          | text        | resolved candidate name                      |
  | company            | text        | resolved company (nullable)                  |
  | title              | text        | resolved title (nullable)                    |
  | email              | text        | work email used for draft (nullable)         |
  | email_status       | text        | 'found' \| 'uncertain' \| 'not_found'        |
  | person_confidence  | numeric     | 0–1 confidence score for identity            |
  | company_confidence | numeric     | 0–1 confidence score for company             |
  | title_confidence   | numeric     | 0–1 confidence score for title               |
  | draft_confidence   | numeric     | 0–1 weighted overall confidence              |
  | user_context       | text        | recruiter's custom context passed in         |
  | company_hint       | text        | optional company hint from client            |
  | draft_subject      | text        | generated email subject (nullable)           |
  | draft_body         | text        | generated email body (nullable)              |
  | status             | text        | 'success' \| 'partial' \| 'not_enough_data'  |
  | sources            | jsonb       | array of enrichment source objects           |
  | created_at         | timestamptz | auto                                         |

  ## Security
  - RLS enabled; owner-only SELECT and INSERT.
  - No UPDATE or DELETE for authenticated users (immutable audit log).
*/

CREATE TABLE IF NOT EXISTS outreach_runs (
  id                 uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            uuid        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  full_name          text        NOT NULL,
  company            text,
  title              text,
  email              text,
  email_status       text        NOT NULL DEFAULT 'not_found',
  person_confidence  numeric(4,3) NOT NULL DEFAULT 0,
  company_confidence numeric(4,3) NOT NULL DEFAULT 0,
  title_confidence   numeric(4,3) NOT NULL DEFAULT 0,
  draft_confidence   numeric(4,3) NOT NULL DEFAULT 0,
  user_context       text,
  company_hint       text,
  draft_subject      text,
  draft_body         text,
  status             text        NOT NULL DEFAULT 'not_enough_data',
  sources            jsonb       NOT NULL DEFAULT '[]'::jsonb,
  created_at         timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE outreach_runs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "Users can read own outreach runs"
  ON outreach_runs FOR SELECT
  TO authenticated
  USING (auth.uid() = user_id);

CREATE POLICY "Users can insert own outreach runs"
  ON outreach_runs FOR INSERT
  TO authenticated
  WITH CHECK (auth.uid() = user_id);

CREATE INDEX IF NOT EXISTS outreach_runs_user_id_created_at_idx
  ON outreach_runs (user_id, created_at DESC);
