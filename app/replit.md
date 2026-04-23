# SourcedOut

## Project Overview
SourcedOut is a Chrome browser extension for recruiters and talent sourcers. It automates candidate research and outreach by capturing candidate names from LinkedIn profiles and using a backend pipeline to enrich that data (emails, titles, companies) and generate personalized outreach drafts using Anthropic's Claude LLMs.

## Architecture

### Chrome Extension (Frontend)
- **Location**: `extension/`
- **Manifest V3** Chrome extension
- **No bundler** — vanilla JavaScript, loaded directly by Chrome
- Key files:
  - `extension/manifest.json` — Extension configuration and permissions
  - `extension/background.js` — Service worker for background tasks
  - `extension/content.js` — DOM scraping logic for LinkedIn
  - `extension/config.js` — API endpoints and configuration constants
  - `extension/core/` — Shared logic (API wrappers, auth, credits)
  - `extension/modes/` — UI/logic for different user types
  - `extension/ui/popup.html` — Extension popup UI

### Backend (Supabase Edge Functions)
- **Location**: `supabase/functions/`
- **Runtime**: Deno (via Supabase Edge Functions)
- **Database**: Supabase PostgreSQL
- **Auth**: Supabase GoTrue
- Key functions:
  - `enrichment-pipeline/` — Main AI/enrichment logic
  - `lookup-email/` — Dedicated email discovery
- **APIs used**: Anthropic (Claude AI), FullEnrich (email lookup), Stripe (payments)

### Auth Callback Page
- **Location**: `docs/index.html`
- A simple static page used as the OAuth callback for the Chrome extension's Supabase auth flow

## Replit Setup
- **Workflow**: "Start application" runs `node server.js` on port 5000
- `server.js` — Simple Node.js HTTP static file server serving project files
- The server serves the `docs/index.html` auth page and all extension assets
- Supabase CLI is available via `npx supabase` (linked to project `szxjcitbjcpkhxtjztay`)
- Secrets: `SUPABASE_ACCESS_TOKEN` (CLI auth), `SUPABASE_SERVICE_ROLE_KEY` (admin DB access)

## Changelog
### v1.2.0 (April 2026) — Auth & Onboarding Overhaul
- **Auth screen redesign**: 4 sign-in options: Google, Microsoft (Azure), Email+Password, Magic link
- **Microsoft OAuth**: Added `signInWithMicrosoft()` in `core/auth.js` — uses Supabase Azure provider
- **Email/Password**: Added `signInWithEmailPassword()` and `signUpWithEmailPassword()` in `core/auth.js`
- **Onboarding flow**: 2-screen onboarding for first-time users (full name + company required; job title, hiring focus, tone optional/skippable)
- **recruiter_profiles table**: Migration added (`20260409020000_recruiter_profiles.sql`) with RLS; stores one row per user; UNIQUE on user_id
- **Draft personalization**: Edge function fetches recruiter profile, injects name/title/company/focus/tone into Claude prompt; adds sign-off block
- **Settings tab**: Replaced old `pref_name`/`pref_title` fields with full recruiter profile editor (all 5 fields editable)
- **Returning users**: Skip onboarding automatically if recruiter_profiles row exists
- **Note**: Supabase Azure/Microsoft OAuth provider must be enabled in Supabase dashboard for Microsoft sign-in to work

### v1.1.0 (April 2026)
- Fixed TypeScript annotation bug in `popup.js` (`Record<string, string>` removed — syntax error in Chrome)
- Bumped `manifest.json` version from 1.0.0 → 1.1.0
- Deleted dead Edge Functions: `candidate-bootstrap`, `enrichment-pipeline`, `requirements-match`
- Enabled RLS on `outreach_sources` (user-scoped policies) and `enrichment_debug_logs` (service-role only)

## Outstanding Tasks
- **Microsoft OAuth**: Enable Azure provider in Supabase Auth dashboard (Settings → Auth → Providers → Azure)
- **Auth end-to-end test**: Load extension in Chrome, sign in with Google, confirm auth.html tab opens/closes
  - Note: Supabase Auth must have `chrome-extension://[EXTENSION_ID]/auth.html` in the allowed redirect URLs list
- **recruiter_profiles migration**: Run `20260409020000_recruiter_profiles.sql` against Supabase DB
- **enrich-and-draft end-to-end test**: Open LinkedIn profile, run a draft generation, verify recruiter sign-off appears
- **Pricing URL**: Replace placeholder in `config.js` with real Stripe checkout URL
- **Real web search for title inference**: Integrate Serper/Brave/SerpAPI instead of Claude training data only

## External Services
- **Supabase**: `https://szxjcitbjcpkhxtjztay.supabase.co`
- **FullEnrich**: Email enrichment API
- **Anthropic**: Claude 3.5 Sonnet / 4.5 Haiku for AI draft generation
- **Stripe**: Payments (Sourcer and Pro tiers)

## Loading the Extension in Chrome
1. Open Chrome and go to `chrome://extensions`
2. Enable "Developer mode"
3. Click "Load unpacked" and select the `extension/` directory
