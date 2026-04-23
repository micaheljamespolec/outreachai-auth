# AI Context — SourcedOut

> NOT user-facing. For AI assistants and code reviewers only.
> Last validated against commit: `debfdee` (2026-04-09).
> Self-update rule: after any critical change (schema, RLS, auth, main flow, cache/bookmark logic, provider, pricing, new risk), update the relevant section, update the "last validated" commit above, and prepend an entry under "Latest critical updates". Ignore UI tweaks, styling, and minor refactors.

---

## Product summary
Chrome extension (MV3) for recruiters. When viewing a LinkedIn profile it captures **only** `window.location.href` (zero DOM queries — LinkedIn ToS compliance). Passes the URL to a Supabase edge function that calls FullEnrich v2 (email/name/title/company) and Claude AI (draft generation, company inference, title fallback). Results are cached in `saved_profiles` to avoid repeat credits.

---

## Trust boundary
- **Extension → Supabase edge function**: user JWT in `Authorization` header. All three edge functions (`enrich-and-draft`, `generate-draft`, `lookup-email`) now validate via `db.auth.getUser(token)` before any action. 401 returned on missing or invalid token.
- **Edge function → external APIs**: service-role key (bypasses RLS). Never exposed to client.
- **Extension storage**: session (access + refresh token) in `chrome.storage.local` under key `sourcedout_session`. Auth module auto-refreshes within 5 min of expiry.
- **Scraping**: content script reads `window.location.href` only — no DOM selectors anywhere.
- **Credit gate**: `deduct_credit` RPC is called server-side after cache-miss check, before any FullEnrich call. Returns HTTP 402 with `CREDIT_LIMIT_REACHED` if allowance is exhausted. Cache hits are always free.

---

## Current flow
1. **URL capture** — `content.js` reads `window.location.href`, sends to popup via `chrome.tabs.sendMessage`.
2. **Cache check (free)** — `check-saved-profile` action queries `saved_profiles` for this URL: bookmarked OR enriched within 30 days. Hit → populate UI, no credit used.
3. **FullEnrich v2** — POST to bulk endpoint → poll GET every 2 s (max 15 attempts / 30 s) until `FINISHED`. Returns: full_name, work_email, personal_email, title, company, company_domain, raw payload.
4. **Raw data persist** — immediately upsert raw FullEnrich response to `saved_profiles.raw_data` (non-fatal; ensures data survives draft failure).
5. **Company resolution** (conditional, only if FullEnrich has no company) — check `company_domains` cache → hardcoded list → Claude Haiku inference. Result cached in `company_domains`.
6. **Title fallback** (conditional, only if FullEnrich has no title) — Claude Haiku infers from training data; confidence-gated at ≥ 0.25. Max confidence capped at 0.6. Shows "unverified" badge.
7. **Confidence scoring** — weighted: person×0.35 + company×0.20 + title×0.20 + email×0.15 + context×0.10 → drives green/amber/red bar.
8. **Draft generation** — Claude Sonnet. Rules: no LinkedIn mentions, no invented facts, no exclamation marks, 60–120 words, one soft CTA. Skipped if `not_enough_data`.
9. **Persist & respond** — insert `outreach_runs`, upsert `saved_profiles` (without `is_bookmarked` to preserve bookmark state), read back `is_bookmarked`, return all data.

Action router also handles: `summarize-job` (Haiku), `bookmark-profile`, `check-saved-profile`, `save-job`, `get-saved-jobs`, `delete-job`, `get-saved-profiles`.

---

## Core tables
- **saved_profiles** — enrichment cache per `(user_id, linkedin_url)`. Key fields: `work_email`, `personal_email`, `title`, `title_verified`, `email_status`, `is_bookmarked`, `enriched_at`, `raw_data` (JSONB). Cache window: 30 days OR `is_bookmarked = true`. RLS: owner-only.
- **outreach_runs** — full log of every enrich+draft run. Fields: confidences, draft subject/body, sources (JSONB), status. Append-only. RLS via `outreach_sources` join.
- **saved_jobs** — recruiter job context saved across sessions. Unique on `(user_id, label)`; upserts overwrite. Fields: `label`, `job_url`, `role_title`, `company`, `highlights`. RLS: owner-only.
- **credits** — one row per user. Fields: `tier` (free/paid), `lookups_used`, `emails_used`, `ai_runs_used`, `resets_at`, `stripe_customer_id`, `stripe_subscription_id`.
- **company_domains** — cache of `domain → canonical_company_name + confidence`. Avoids repeat Haiku calls.
- **enrichment_debug_logs** — raw FullEnrich request/response log. Service-role only (no RLS policies = no user access).

---

## Critical files
- `extension/content.js` — 5 lines: reads `window.location.href` (strips query string) only. The scraping rule is specific to this file: do NOT add any DOM selectors here; this is what keeps the extension LinkedIn ToS-safe.
- `extension/manifest.json` — MV3, permissions: activeTab/storage/tabs/scripting. Content script matches `/in/`, `/talent/`, `/recruiter/`.
- `extension/core/auth.js` — session management (magic link + Google OAuth). Stores in `chrome.storage.local`. Do not touch.
- `extension/core/api.js` — all API exports. Single `apiRequest` wrapper with 401 refresh-and-retry.
- `extension/popup.js` — 4-tab UI (Draft/Profile/Job/Settings). State machine: `IDLE | PREFILLED | SUBMITTING | ENRICHING | DRAFTING | SUCCESS | PARTIAL_SUCCESS | EMPTY_RESULT | AUTH_ERROR | GENERIC_ERROR`. Key functions: `setupProfileTab`, `setupJobTab`, `populateProfileTab`, `updateBookmarkButton`, `generateDraftFlow`.
- `extension/ui/popup.html` — CSS dark mode classes (do not use inline styles for themeable elements).
- `supabase/functions/enrich-and-draft/index.ts` — monolithic edge function: all 9 steps + all secondary actions in one file.
- `supabase/migrations/20260405010000_saved_profiles.sql` — saved_profiles DDL + RLS.
- `supabase/migrations/20260407010000_add_raw_data_to_saved_profiles.sql` — additive: `raw_data JSONB`.
- `supabase/migrations/20260407020000_add_saved_jobs.sql` — saved_jobs DDL + RLS.

---

## Open risks
- **`pref_name` / `pref_title` not sent to draft** — recruiter identity fields exist in config/settings but are not passed to `generateDraft`. Draft has no personalized sender context.
- **`pricingUrl` is a checkout URL, not a Stripe payment link** — `config.js` now points to `create-checkout` edge function. Replace with a real hosted payment-link URL if a standalone Stripe payment link is created.
- **Personal email coverage** — FullEnrich is a B2B work-email product; personal email is rarely returned. No secondary provider (Hunter, Apollo) is integrated.
- **Migration history mismatch** — `supabase db push` fails. All schema changes must use `supabase db query --linked "SQL..."`. Never edit original DDL migration files; always create additive migrations.
- **Claude model names** — `claude-haiku-4-5` (fast/cheap), `claude-sonnet-4-5` (draft). Verify these remain valid model IDs if Anthropic updates naming.
- **`is_bookmarked` not in upsert payload** — intentional design: prevents overwriting bookmark on re-enrichment. If this changes, audit all upsert call sites.
- **`generate-draft` uses Gemini, not Claude** — the secondary `generate-draft` function (fallback path only) uses Gemini 2.0 Flash, not Claude. The primary enrichment+draft flow in `enrich-and-draft` uses Claude Sonnet.

---

## Latest critical updates
- 2026-04-09: **Task #6 — Hardened credits, auth, and RLS.** (1) Credit gate (`deduct_credit` RPC) added to `enrich-and-draft` between cache-miss check and FullEnrich call — returns HTTP 402 `CREDIT_LIMIT_REACHED` if exhausted. (2) JWT auth guard added to `generate-draft` and `lookup-email` (were previously open or optional). (3) RLS enabled on `company_domains`, `candidate_title_sources`, `workflow_jobs`; DELETE policy added to `candidates`. (4) `config.js`: version→`1.1.0`, `pricingUrl`→`create-checkout` endpoint, Stripe sourcer IDs corrected (removed `Monthly:`/`Yearly:` prefixes). (5) `popup.js` MESSAGES map updated with `CREDIT_LIMIT_REACHED` and `CREDIT_ERROR` user-friendly strings.
- 2026-04-09: Created this file (`docs/AI_CONTEXT.md`) as permanent AI/code-review context reference.
- 2026-04-08: Switched to LinkedIn URL-first FullEnrich v2 bulk-poll flow; added 30-day cache-first `saved_profiles` logic, saved jobs (`saved_jobs` table), bookmark system, raw_data persistence, and dark mode CSS class fixes.
