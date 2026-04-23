import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const cors = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-Client-Info, Apikey',
}

function json(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), { status, headers: { ...cors, 'Content-Type': 'application/json' } })
}

async function callAnthropic(key: string, model: string, maxTokens: number, prompt: string): Promise<string> {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'user', content: prompt }] }),
  })
  const d = await res.json()
  return d.content?.[0]?.text?.trim() || '{}'
}

function parseJson(s: string): any {
  try { return JSON.parse(s.replace(/^```json?\s*/i, '').replace(/```\s*$/, '').trim()) } catch { return {} }
}

// ── FullEnrich v2: LinkedIn URL → work email, personal email, name, title, company ──
async function enrichWithLinkedInV2(linkedinUrl: string, key: string): Promise<{
  full_name: string | null
  work_email: string | null
  personal_email: string | null
  title: string | null
  company: string | null
  company_domain: string | null
  raw: any
}> {
  const empty = { full_name: null, work_email: null, personal_email: null, title: null, company: null, company_domain: null, raw: null }

  const startRes = await fetch('https://app.fullenrich.com/api/v2/contact/enrich/bulk', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${key}`,
    },
    body: JSON.stringify({
      name: `OutreachAI-${Date.now()}`,
      data: [{ linkedin_url: linkedinUrl, enrich_fields: ['contact.emails'] }],
    }),
  })

  const startData = await startRes.json()
  if (!startRes.ok) throw new Error(`FullEnrich start error ${startRes.status}: ${JSON.stringify(startData)}`)

  const enrichmentId = startData.enrichment_id
  if (!enrichmentId) throw new Error('FullEnrich did not return enrichment_id')

  await new Promise(r => setTimeout(r, 3000))
  for (let i = 0; i < 22; i++) {
    if (i > 0) await new Promise(r => setTimeout(r, 5000))

    const pollRes = await fetch(`https://app.fullenrich.com/api/v2/contact/enrich/bulk/${enrichmentId}`, {
      headers: { 'Authorization': `Bearer ${key}` },
    })
    const pollData = await pollRes.json()

    if (pollData.status === 'FINISHED') {
      const results = pollData.datas ?? pollData.data ?? []
      const row = results[0]
      if (!row) return { ...empty, raw: pollData }

      const contactInfo = row.contact_info ?? row.contact?.contact_info ?? null
      const profile     = row.profile ?? row.contact?.profile ?? {}
      const current     = profile.employment?.current

      const workEmail = contactInfo?.most_probable_work_email?.email
        ?? contactInfo?.work_emails?.[0]?.email
        ?? row.contact?.most_probable_email
        ?? null
      const personalEmail = contactInfo?.most_probable_personal_email?.email
        ?? contactInfo?.personal_emails?.[0]?.email
        ?? null

      return {
        full_name:      profile.full_name || null,
        work_email:     workEmail,
        personal_email: personalEmail,
        title:          current?.title || null,
        company:        current?.company?.name || null,
        company_domain: current?.company?.domain || null,
        raw:            pollData,
      }
    }

    if (pollData.status === 'FAILED') throw new Error('FullEnrich enrichment failed')
  }

  throw new Error('FullEnrich timeout — enrichment did not complete within 55s')
}

// ── Employer resolution from email domain ──
async function resolveEmployer(domain: string, db: any, anthropicKey: string): Promise<{ company: string; confidence: number }> {
  const { data: cached } = await db.from('company_domains').select('canonical_company_name,confidence').eq('domain', domain).single()
  if (cached) return { company: cached.canonical_company_name, confidence: cached.confidence }

  const known: Record<string, string> = {
    'google.com': 'Google', 'microsoft.com': 'Microsoft', 'apple.com': 'Apple',
    'amazon.com': 'Amazon', 'meta.com': 'Meta', 'salesforce.com': 'Salesforce',
    'bms.com': 'Bristol Myers Squibb', 'pfizer.com': 'Pfizer', 'jnj.com': 'Johnson & Johnson',
    'ibm.com': 'IBM', 'oracle.com': 'Oracle', 'adobe.com': 'Adobe', 'stripe.com': 'Stripe',
    'openai.com': 'OpenAI', 'anthropic.com': 'Anthropic', 'goodparty.org': 'Good Party',
  }
  if (known[domain]) {
    await db.from('company_domains').upsert({ domain, canonical_company_name: known[domain], confidence: 0.99 })
    return { company: known[domain], confidence: 0.99 }
  }

  if (!anthropicKey) return { company: domain, confidence: 0.3 }

  const raw = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 100,
    `What company uses email domain "${domain}"? Reply ONLY JSON: {"company_name":"...","confidence":0.0-1.0}`)
  const p = parseJson(raw)
  const company = p.company_name || domain
  const confidence = typeof p.confidence === 'number' ? p.confidence : 0.4
  await db.from('company_domains').upsert({ domain, canonical_company_name: company, confidence })
  return { company, confidence }
}

// ── Title fallback ──
async function inferTitleFallback(fullName: string, company: string, anthropicKey: string): Promise<{
  title: string | null
  confidence: number
}> {
  if (!anthropicKey) return { title: null, confidence: 0 }

  const raw = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 200, `
You are inferring a person's current job title from your training data only.
Do NOT use LinkedIn or any LinkedIn-adjacent source.
Use only: company websites, press releases, conference bios, SEC filings, Crunchbase, ZoomInfo-type public records.
If you have no reliable non-LinkedIn evidence, return title: null and confidence: 0.

Person: "${fullName}" at "${company}"

Return ONLY JSON: {"title": "job title or null", "confidence": 0.0}`)

  const p = parseJson(raw)
  const confidence = typeof p.confidence === 'number' ? Math.min(p.confidence, 0.6) : 0
  return {
    title: confidence >= 0.25 ? (p.title || null) : null,
    confidence,
  }
}

// ── Recruiter profile type ────────────────────────────────────────────────────
interface RecruiterProfile {
  full_name:    string
  company_name: string
  job_title:    string | null
  hiring_focus: string | null
  tone:         string | null
}

// ── Draft generation ──────────────────────────────────────────────────────────
async function generateDraft(
  fullName: string, company: string | null, title: string | null,
  titleVerified: boolean, email: string | null, userContext: string | null,
  draftConf: number, anthropicKey: string,
  recruiter: RecruiterProfile | null
): Promise<{ subject: string; body: string } | null> {
  if (!anthropicKey) return null

  const titleInstruction = title
    ? (titleVerified
        ? `Candidate's current role: ${title} (confirmed from data provider — reference it naturally).`
        : `Candidate's likely role: ${title} (inferred — reference it cautiously without claiming certainty).`)
    : `Candidate's role is unknown — do NOT claim any specific title. Write using name and company only.`

  const recruiterName    = recruiter?.full_name    || null
  const recruiterCompany = recruiter?.company_name || null
  const recruiterTitle   = recruiter?.job_title    || null
  const hiringFocus      = recruiter?.hiring_focus || null
  const tone             = recruiter?.tone         || null

  let signOff = 'Best,'
  if (recruiterName) {
    signOff = `Best,\n${recruiterName}`
    if (recruiterTitle && recruiterCompany) signOff += `\n${recruiterTitle} at ${recruiterCompany}`
  }

  const toneInstruction = tone
    ? `Tone: ${tone}, professional, peer-to-peer.`
    : 'Tone: professional, modern, peer-to-peer.'

  const hiringFocusInstruction = hiringFocus
    ? `Recruiter specializes in: ${hiringFocus} hiring.`
    : 'Recruiter specializes in general talent acquisition.'

  const recruiterBlock = recruiterName
    ? `Recruiter sending this email: ${recruiterName}${recruiterTitle ? `, ${recruiterTitle}` : ''}${recruiterCompany ? ` at ${recruiterCompany}` : ''}`
    : ''

  const prompt = `Write a concise recruiter outreach email (60–120 words). Use ONLY the supplied information. Do not invent facts.

Candidate: ${fullName}
${company ? `Company: ${company}` : ''}
${titleInstruction}
${email ? `Email: ${email}` : 'No email — generate body only.'}
${userContext ? `Recruiter context: ${userContext}` : ''}
${recruiterBlock}
${hiringFocusInstruction}
Confidence level: ${draftConf >= 0.65 ? 'normal — personalize where evidence exists' : 'low — be warm but generic, no specific claims'}

Rules:
- No mention of "I saw your profile", "I noticed you", or LinkedIn.
- No exclamation marks.
- No invented achievements.
- ${toneInstruction}
- One soft CTA.
- End the email body with exactly this sign-off (include it verbatim in the body field):
${signOff}

Return ONLY JSON: {"subject": "...", "body": "..."}`

  const raw = await callAnthropic(anthropicKey, 'claude-sonnet-4-5', 500, prompt)
  const p = parseJson(raw)
  if (!p.body) return null

  const bodyLines = p.body.trimEnd().split('\n')
  let trimIdx = bodyLines.length
  for (let i = bodyLines.length - 1; i >= 0; i--) {
    const line = bodyLines[i].trim()
    if (line === '' || line.startsWith('Best')) { trimIdx = i; continue }
    break
  }
  const bodyWithoutSignOff = bodyLines.slice(0, trimIdx).join('\n').trimEnd()
  const finalBody = bodyWithoutSignOff ? `${bodyWithoutSignOff}\n\n${signOff}` : signOff

  return { subject: p.subject || `Reaching out — ${fullName}`, body: finalBody }
}

// ── Weighted confidence formula ────────────────────────────────────────────────
function computeDraftConfidence(
  personConf: number, companyConf: number, titleConf: number,
  emailStatus: string, userContextLength: number
): number {
  const emailConf   = emailStatus === 'found' ? 1 : emailStatus === 'uncertain' ? 0.5 : 0
  const contextConf = Math.min(1, userContextLength / 100)
  return Math.round((
    personConf  * 0.35 +
    companyConf * 0.20 +
    titleConf   * 0.20 +
    emailConf   * 0.15 +
    contextConf * 0.10
  ) * 100) / 100
}

// ── Main handler ──────────────────────────────────────────────────────────────
Deno.serve(async (req: Request) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors })

  const supabaseUrl   = Deno.env.get('SUPABASE_URL')!
  const serviceKey    = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!
  const anthropicKey  = Deno.env.get('ANTHROPIC_API_KEY') || ''
  const fullenrichKey = Deno.env.get('FULLENRICH_API_KEY') || ''
  const db = createClient(supabaseUrl, serviceKey)

  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return json({ error: { code: 'AUTH_EXPIRED', message: 'Session expired — please sign in again.' } }, 401)
  const { data: { user }, error: authErr } = await db.auth.getUser(token)
  if (authErr || !user) return json({ error: { code: 'AUTH_EXPIRED', message: 'Session expired — please sign in again.' } }, 401)

  try {
    const body   = await req.json()
    const action = body.action || 'enrich-and-draft'

    // ── Summarize-job action ───────────────────────────────────────────────────
    if (action === 'summarize-job') {
      const rawText  = (body.rawText  || '').slice(0, 3000)
      const jobTitle = (body.jobTitle || '').trim()
      const company  = (body.company  || '').trim()
      if (!rawText && !jobTitle) return json({ error: { code: 'MISSING_INPUT', message: 'No job text provided.' } }, 400)
      if (!anthropicKey)         return json({ error: { code: 'NO_API_KEY',    message: 'AI not configured.'     } }, 500)

      const prompt = `You are helping a recruiter understand a job posting so they can write personalized outreach emails.

Job title: ${jobTitle || 'not specified'}
Company: ${company || 'not specified'}

Raw job posting text:
${rawText}

Extract the 3–5 most useful selling points a recruiter would reference in an outreach email. Focus on:
- What the role actually does day-to-day (skip generic boilerplate)
- The seniority level and key skills required
- Anything distinctive: compensation range, tech stack, team size, company stage, notable impact
- Why a strong candidate would find this role interesting

Format as short bullet points starting with "•", max 15 words each.
Return ONLY the bullet list — no intro sentence, no JSON, no extra commentary.`

      const summary = await callAnthropic(anthropicKey, 'claude-haiku-4-5', 400, prompt)
      if (!summary || summary === '{}') return json({ error: { code: 'SUMMARY_FAILED', message: 'Could not summarize job posting.' } }, 500)
      return json({ summary })
    }

    // ── Bookmark-profile action ────────────────────────────────────────────────
    if (action === 'bookmark-profile') {
      const linkedinUrl = (body.linkedinUrl || '').trim()
      const save        = body.save !== false
      if (!linkedinUrl) return json({ error: { code: 'MISSING_INPUT', message: 'linkedinUrl is required.' } }, 400)

      const { error: updateErr, count } = await db.from('saved_profiles')
        .update({ is_bookmarked: save, updated_at: new Date().toISOString() }, { count: 'exact' })
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)

      if (updateErr) {
        console.error('bookmark-profile update failed:', updateErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not update bookmark.' } }, 500)
      }
      if (count === 0) {
        const { error: insertErr } = await db.from('saved_profiles')
          .insert({ user_id: user.id, linkedin_url: linkedinUrl, is_bookmarked: save })
        if (insertErr) {
          console.error('bookmark-profile insert failed:', insertErr)
          return json({ error: { code: 'DB_ERROR', message: 'Could not create bookmark.' } }, 500)
        }
      }
      return json({ bookmarked: save })
    }

    // ── Check-saved-profile action ─────────────────────────────────────────────
    if (action === 'check-saved-profile') {
      const linkedinUrl = (body.linkedinUrl || '').trim()
      if (!linkedinUrl) return json({ found: false })

      const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data: cached } = await db.from('saved_profiles')
        .select('full_name, work_email, personal_email, title, company, title_verified, email_status, is_bookmarked, enriched_at')
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)
        .or(`is_bookmarked.eq.true,enriched_at.gte.${cacheWindow}`)
        .limit(1)
        .maybeSingle()

      if (!cached || !cached.full_name) return json({ found: false })

      return json({
        found: true,
        profile: {
          fullName:      cached.full_name,
          workEmail:     cached.work_email     || null,
          personalEmail: cached.personal_email || null,
          email:         cached.work_email || cached.personal_email || null,
          title:         cached.title          || null,
          titleVerified: cached.title_verified ?? false,
          company:       cached.company        || null,
          emailStatus:   cached.email_status   || 'not_found',
          isBookmarked:  cached.is_bookmarked  ?? false,
        },
      })
    }

    // ── Save-job action ────────────────────────────────────────────────────────
    if (action === 'save-job') {
      const label      = (body.label      || '').trim()
      const jobUrl     = (body.jobUrl     || '').trim() || null
      const roleTitle  = (body.roleTitle  || '').trim() || null
      const jobCompany = (body.company    || '').trim() || null
      const highlights = (body.highlights || '').trim() || null
      if (!label) return json({ error: { code: 'MISSING_INPUT', message: 'A job label is required.' } }, 400)

      const { data: job, error: upsertErr } = await db.from('saved_jobs')
        .upsert({
          user_id: user.id, label, job_url: jobUrl, role_title: roleTitle,
          company: jobCompany, highlights, updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id,label' })
        .select('id, label, job_url, role_title, company, highlights')
        .single()

      if (upsertErr) {
        console.error('save-job upsert failed:', upsertErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not save job.' } }, 500)
      }
      return json({ job })
    }

    // ── Get-saved-jobs action ──────────────────────────────────────────────────
    if (action === 'get-saved-jobs') {
      const { data: jobs, error: fetchErr } = await db.from('saved_jobs')
        .select('id, label, job_url, role_title, company, highlights, updated_at')
        .eq('user_id', user.id)
        .order('updated_at', { ascending: false })
        .limit(30)

      if (fetchErr) {
        console.error('get-saved-jobs failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load saved jobs.' } }, 500)
      }
      return json({ jobs: jobs || [] })
    }

    // ── Delete-job action ──────────────────────────────────────────────────────
    if (action === 'delete-job') {
      const jobId = (body.jobId || '').trim()
      if (!jobId) return json({ error: { code: 'MISSING_INPUT', message: 'jobId is required.' } }, 400)

      const { error: deleteErr } = await db.from('saved_jobs')
        .delete()
        .eq('id', jobId)
        .eq('user_id', user.id)

      if (deleteErr) {
        console.error('delete-job failed:', deleteErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not delete job.' } }, 500)
      }
      return json({ deleted: true })
    }

    // ── Get-saved-profiles action ──────────────────────────────────────────────
    if (action === 'get-saved-profiles') {
      const { data: profiles, error: fetchErr } = await db.from('saved_profiles')
        .select('id, linkedin_url, full_name, work_email, personal_email, title, company, title_verified, email_status, enriched_at, is_bookmarked')
        .eq('user_id', user.id)
        .eq('is_bookmarked', true)
        .order('updated_at', { ascending: false })
        .limit(20)

      if (fetchErr) {
        console.error('get-saved-profiles fetch failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load saved profiles.' } }, 500)
      }
      return json({ profiles: profiles || [] })
    }

    // ── Import-campaign action ─────────────────────────────────────────────────
    if (action === 'import-campaign') {
      const campaignName = (body.campaignName || '').trim()
      const jobId        = (body.jobId || '').trim() || null
      const candidates   = Array.isArray(body.candidates) ? body.candidates : []

      if (!campaignName) return json({ error: { code: 'MISSING_INPUT', message: 'Campaign name is required.' } }, 400)
      if (candidates.length === 0) return json({ error: { code: 'MISSING_INPUT', message: 'No candidates provided.' } }, 400)

      // Credit pre-flight: count how many need fresh enrichment
      // Check which LinkedIn URLs are already cached
      const linkedinUrls = candidates.map((c: any) => c.linkedin_url).filter(Boolean)
      const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      let cachedCount = 0
      if (linkedinUrls.length > 0) {
        const { data: cachedProfiles } = await db.from('saved_profiles')
          .select('linkedin_url')
          .eq('user_id', user.id)
          .in('linkedin_url', linkedinUrls)
          .gte('enriched_at', cacheWindow)
        cachedCount = cachedProfiles?.length || 0
      }
      const freshNeeded = candidates.length - cachedCount

      // Fetch current credits
      const { data: credits } = await db.from('credits')
        .select('tier, lookups_used, period_end')
        .eq('user_id', user.id)
        .maybeSingle()

      let creditsRemaining = 10 // free tier default
      if (credits) {
        const tierLimits: Record<string, number> = { free: 10, sourcer: 50, pro: 200 }
        const max = tierLimits[credits.tier] || 10
        creditsRemaining = Math.max(0, max - (credits.lookups_used || 0))
      }

      const creditWarning = freshNeeded > creditsRemaining ? {
        needed: freshNeeded,
        available: creditsRemaining,
        message: `You have ${creditsRemaining} lookup${creditsRemaining !== 1 ? 's' : ''} remaining. Only ${creditsRemaining} of ${freshNeeded} candidates needing enrichment can be processed. Upgrade to enrich the full pipeline.`,
      } : null

      // Create campaign
      const campaignStatus = jobId ? 'ready' : 'needs_job'
      const { data: campaign, error: campaignErr } = await db.from('campaigns')
        .insert({
          user_id: user.id,
          name: campaignName,
          job_id: jobId,
          status: campaignStatus,
          total_count: candidates.length,
        })
        .select('id, name, job_id, status, total_count')
        .single()

      if (campaignErr || !campaign) {
        console.error('import-campaign insert failed:', campaignErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not create campaign.' } }, 500)
      }

      // Insert all candidates
      const candidateRows = candidates.map((c: any) => ({
        campaign_id:     campaign.id,
        user_id:         user.id,
        first_name:      c.first_name || null,
        last_name:       c.last_name  || null,
        headline:        c.headline   || null,
        location:        c.location   || null,
        current_title:   c.current_title   || null,
        current_company: c.current_company || null,
        csv_email:       c.email      || null,
        phone:           c.phone      || null,
        linkedin_url:    c.linkedin_url || null,
        notes:           c.notes      || null,
        feedback:        c.feedback   || null,
        status:          'imported',
      }))

      const { error: candidatesErr } = await db.from('campaign_candidates').insert(candidateRows)
      if (candidatesErr) {
        console.error('import-campaign candidates insert failed:', candidatesErr)
        // Cleanup the campaign row
        await db.from('campaigns').delete().eq('id', campaign.id)
        return json({ error: { code: 'DB_ERROR', message: 'Could not import candidates.' } }, 500)
      }

      return json({ campaign, totalCount: candidates.length, creditWarning })
    }

    // ── Get-campaigns action ───────────────────────────────────────────────────
    if (action === 'get-campaigns') {
      const { data: campaigns, error: fetchErr } = await db.from('campaigns')
        .select('id, name, job_id, status, total_count, enriched_count, drafted_count, approved_count, created_at, saved_jobs(label, company, job_url)')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false })
        .limit(50)

      if (fetchErr) {
        console.error('get-campaigns failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load campaigns.' } }, 500)
      }
      return json({ campaigns: campaigns || [] })
    }

    // ── Get-campaign-candidates action ─────────────────────────────────────────
    if (action === 'get-campaign-candidates') {
      const campaignId = (body.campaignId || '').trim()
      const statusFilter = body.status || null
      if (!campaignId) return json({ error: { code: 'MISSING_INPUT', message: 'campaignId is required.' } }, 400)

      let query = db.from('campaign_candidates')
        .select('*')
        .eq('campaign_id', campaignId)
        .eq('user_id', user.id)
        .order('created_at', { ascending: true })
        .limit(200)

      if (statusFilter) query = query.eq('status', statusFilter)

      const { data: candidates, error: fetchErr } = await query
      if (fetchErr) {
        console.error('get-campaign-candidates failed:', fetchErr)
        return json({ error: { code: 'DB_ERROR', message: 'Could not load candidates.' } }, 500)
      }
      return json({ candidates: candidates || [] })
    }

    // ── Enrich-campaign-candidate action ──────────────────────────────────────
    if (action === 'enrich-campaign-candidate') {
      const candidateId = (body.candidateId || '').trim()
      if (!candidateId) return json({ error: { code: 'MISSING_INPUT', message: 'candidateId is required.' } }, 400)

      // Fetch the candidate
      const { data: candidate, error: fetchErr } = await db.from('campaign_candidates')
        .select('*')
        .eq('id', candidateId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (fetchErr || !candidate) return json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } }, 404)
      if (!candidate.linkedin_url) {
        await db.from('campaign_candidates').update({ status: 'no_email', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ status: 'no_email', reason: 'No LinkedIn URL available for enrichment.' })
      }

      // Mark as enriching
      await db.from('campaign_candidates').update({ status: 'enriching', updated_at: new Date().toISOString() }).eq('id', candidateId)

      // Check saved_profiles cache first
      const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data: cached } = await db.from('saved_profiles')
        .select('id, full_name, work_email, personal_email, title, company, title_verified, email_status, enriched_at')
        .eq('user_id', user.id)
        .eq('linkedin_url', candidate.linkedin_url)
        .gte('enriched_at', cacheWindow)
        .maybeSingle()

      if (cached && cached.full_name) {
        const email = cached.work_email || cached.personal_email || null
        const newStatus = email ? 'enriched' : 'no_email'
        await db.from('campaign_candidates').update({
          status:           newStatus,
          work_email:       cached.work_email || null,
          personal_email:   cached.personal_email || null,
          email_status:     cached.email_status || 'not_found',
          enriched_title:   cached.title || null,
          enriched_company: cached.company || null,
          saved_profile_id: cached.id,
          enriched_at:      new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        }).eq('id', candidateId)

        // Update campaign counts
        await _incrementCampaignCount(db, candidate.campaign_id, 'enriched_count')

        return json({ status: newStatus, fromCache: true, email })
      }

      // Deduct credit for fresh enrichment
      const { data: creditAllowed, error: creditErr } = await db.rpc('deduct_credit', { p_user_id: user.id })
      if (creditErr) {
        await db.from('campaign_candidates').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ error: { code: 'CREDIT_ERROR', message: 'Could not verify credit balance.' } }, 500)
      }
      if (creditAllowed === false) {
        await db.from('campaign_candidates').update({ status: 'imported', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ error: { code: 'CREDIT_LIMIT_REACHED', message: 'Credit limit reached. Upgrade to continue enriching.' } }, 402)
      }

      // Run FullEnrich
      try {
        const enrichResult = await enrichWithLinkedInV2(candidate.linkedin_url, fullenrichKey)
        const email = enrichResult.work_email || enrichResult.personal_email || null
        const emailStatus = enrichResult.work_email ? 'found' : enrichResult.personal_email ? 'uncertain' : 'not_found'
        const newStatus = email ? 'enriched' : 'no_email'

        // Upsert into saved_profiles
        const { data: savedProfile } = await db.from('saved_profiles').upsert({
          user_id:        user.id,
          linkedin_url:   candidate.linkedin_url,
          full_name:      enrichResult.full_name || `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || null,
          work_email:     enrichResult.work_email || null,
          personal_email: enrichResult.personal_email || null,
          title:          enrichResult.title || null,
          company:        enrichResult.company || null,
          title_verified: !!enrichResult.title,
          email_status:   emailStatus,
          raw_data:       enrichResult.raw,
          enriched_at:    new Date().toISOString(),
          updated_at:     new Date().toISOString(),
        }, { onConflict: 'user_id,linkedin_url', ignoreDuplicates: false })
          .select('id')
          .maybeSingle()

        await db.from('campaign_candidates').update({
          status:           newStatus,
          work_email:       enrichResult.work_email || null,
          personal_email:   enrichResult.personal_email || null,
          email_status:     emailStatus,
          enriched_title:   enrichResult.title || candidate.current_title || null,
          enriched_company: enrichResult.company || candidate.current_company || null,
          saved_profile_id: savedProfile?.id || null,
          enriched_at:      new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        }).eq('id', candidateId)

        await _incrementCampaignCount(db, candidate.campaign_id, 'enriched_count')

        return json({ status: newStatus, fromCache: false, email })
      } catch (e: any) {
        console.error('enrich-campaign-candidate FullEnrich failed:', e)
        await db.from('campaign_candidates').update({ status: 'failed', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ error: { code: 'ENRICHMENT_FAILED', message: e.message || 'Enrichment failed.' } }, 500)
      }
    }

    // ── Draft-campaign-candidate action ───────────────────────────────────────
    if (action === 'draft-campaign-candidate') {
      const candidateId = (body.candidateId || '').trim()
      if (!candidateId) return json({ error: { code: 'MISSING_INPUT', message: 'candidateId is required.' } }, 400)

      const { data: candidate, error: fetchErr } = await db.from('campaign_candidates')
        .select('*')
        .eq('id', candidateId)
        .eq('user_id', user.id)
        .maybeSingle()

      if (fetchErr || !candidate) return json({ error: { code: 'NOT_FOUND', message: 'Candidate not found.' } }, 404)

      // Fetch campaign to get job_id
      const { data: campaign } = await db.from('campaigns')
        .select('job_id')
        .eq('id', candidate.campaign_id)
        .maybeSingle()

      // Fetch job highlights for context
      let jobContext: string | null = null
      if (campaign?.job_id) {
        const { data: job } = await db.from('saved_jobs')
          .select('role_title, company, highlights')
          .eq('id', campaign.job_id)
          .maybeSingle()
        if (job) {
          const parts = []
          if (job.role_title) parts.push(`Recruiting for: ${job.role_title}${job.company ? ' at ' + job.company : ''}`)
          if (job.highlights) parts.push(job.highlights)
          jobContext = parts.join('. ') || null
        }
      }

      // Fetch recruiter profile
      let recruiterProfile: RecruiterProfile | null = null
      try {
        const { data: rp } = await db.from('recruiter_profiles')
          .select('full_name, company_name, job_title, hiring_focus, tone')
          .eq('user_id', user.id)
          .maybeSingle()
        if (rp) recruiterProfile = rp as RecruiterProfile
      } catch {}

      const email = candidate.work_email || candidate.personal_email || candidate.csv_email || null
      const fullName = `${candidate.first_name || ''} ${candidate.last_name || ''}`.trim() || 'this candidate'
      const company = candidate.enriched_company || candidate.current_company || null
      const title = candidate.enriched_title || candidate.current_title || null

      // Mark as drafting
      await db.from('campaign_candidates').update({ status: 'drafting', updated_at: new Date().toISOString() }).eq('id', candidateId)

      const personConf  = 0.8
      const companyConf = company ? 0.85 : 0.3
      const titleConf   = title ? 0.7 : 0
      const emailStatus = email ? (candidate.work_email ? 'found' : 'uncertain') : 'not_found'
      const draftConf = computeDraftConfidence(personConf, companyConf, titleConf, emailStatus, (jobContext || '').length)

      try {
        const draft = await generateDraft(
          fullName, company, title, !!candidate.enriched_title,
          email, jobContext,
          draftConf, anthropicKey,
          recruiterProfile
        )

        if (!draft) {
          await db.from('campaign_candidates').update({ status: 'enriched', updated_at: new Date().toISOString() }).eq('id', candidateId)
          return json({ error: { code: 'DRAFT_FAILED', message: 'Could not generate draft.' } }, 500)
        }

        await db.from('campaign_candidates').update({
          status:           'drafted',
          draft_subject:    draft.subject,
          draft_body:       draft.body,
          draft_confidence: draftConf,
          drafted_at:       new Date().toISOString(),
          updated_at:       new Date().toISOString(),
        }).eq('id', candidateId)

        await _incrementCampaignCount(db, candidate.campaign_id, 'drafted_count')

        try { await db.rpc('increment_ai_run', { p_user_id: user.id }) } catch {}

        return json({ status: 'drafted', draft, draftConfidence: draftConf })
      } catch (e: any) {
        console.error('draft-campaign-candidate failed:', e)
        await db.from('campaign_candidates').update({ status: 'enriched', updated_at: new Date().toISOString() }).eq('id', candidateId)
        return json({ error: { code: 'DRAFT_FAILED', message: e.message || 'Draft generation failed.' } }, 500)
      }
    }

    // ── Update-candidate-status action ─────────────────────────────────────────
    if (action === 'update-candidate-status') {
      const candidateId = (body.candidateId || '').trim()
      const newStatus   = (body.status || '').trim()
      const allowed     = ['approved', 'skipped', 'imported', 'enriched', 'drafted']
      if (!candidateId) return json({ error: { code: 'MISSING_INPUT', message: 'candidateId is required.' } }, 400)
      if (!allowed.includes(newStatus)) return json({ error: { code: 'INVALID_STATUS', message: 'Invalid status value.' } }, 400)

      const updateData: any = { status: newStatus, updated_at: new Date().toISOString() }
      if (newStatus === 'approved') updateData.approved_at = new Date().toISOString()

      const { data: updated, error: updateErr } = await db.from('campaign_candidates')
        .update(updateData)
        .eq('id', candidateId)
        .eq('user_id', user.id)
        .select('id, campaign_id, status')
        .maybeSingle()

      if (updateErr) return json({ error: { code: 'DB_ERROR', message: 'Could not update status.' } }, 500)

      // Update approved_count on campaign
      if (newStatus === 'approved' && updated?.campaign_id) {
        await _incrementCampaignCount(db, updated.campaign_id, 'approved_count')
      }

      return json({ updated: true, status: newStatus })
    }

    // ── Link-campaign-job action ───────────────────────────────────────────────
    if (action === 'link-campaign-job') {
      const campaignId = (body.campaignId || '').trim()
      const jobId      = (body.jobId || '').trim()
      if (!campaignId || !jobId) return json({ error: { code: 'MISSING_INPUT', message: 'campaignId and jobId are required.' } }, 400)

      const { error: updateErr } = await db.from('campaigns')
        .update({ job_id: jobId, status: 'ready', updated_at: new Date().toISOString() })
        .eq('id', campaignId)
        .eq('user_id', user.id)

      if (updateErr) return json({ error: { code: 'DB_ERROR', message: 'Could not link job.' } }, 500)
      return json({ linked: true })
    }

    // ── Delete-campaign action ─────────────────────────────────────────────────
    if (action === 'delete-campaign') {
      const campaignId = (body.campaignId || '').trim()
      if (!campaignId) return json({ error: { code: 'MISSING_INPUT', message: 'campaignId is required.' } }, 400)

      // Candidates cascade-delete via FK
      const { error: deleteErr } = await db.from('campaigns')
        .delete()
        .eq('id', campaignId)
        .eq('user_id', user.id)

      if (deleteErr) return json({ error: { code: 'DB_ERROR', message: 'Could not delete campaign.' } }, 500)
      return json({ deleted: true })
    }

    // ── Guard: reject unknown actions before falling through to default flow ──
    const KNOWN_ACTIONS = [
      'enrich-and-draft', 'summarize-job', 'bookmark-profile', 'check-saved-profile',
      'get-saved-profiles', 'save-job', 'get-saved-jobs', 'delete-job',
      'import-campaign', 'get-campaigns', 'get-campaign-candidates',
      'enrich-campaign-candidate', 'draft-campaign-candidate',
      'update-candidate-status', 'link-campaign-job', 'delete-campaign',
    ]
    if (!KNOWN_ACTIONS.includes(action)) {
      return json({ error: { code: 'UNKNOWN_ACTION', message: `Unknown action: ${action}` } }, 400)
    }

    // ── Enrich-and-draft action (default single-profile flow) ─────────────────
    const linkedinUrl = body.linkedinUrl?.trim() || null
    const companyHint = body.companyHint?.trim() || null
    const userContext = body.userContext?.trim() || null
    const fullNameHint = body.fullNameHint?.trim() || null

    if (!linkedinUrl) return json({ error: { code: 'NO_LINKEDIN_URL', message: 'Open a LinkedIn profile to generate a draft.' } }, 400)

    let recruiterProfile: RecruiterProfile | null = null
    try {
      const { data: rp } = await db.from('recruiter_profiles')
        .select('full_name, company_name, job_title, hiring_focus, tone')
        .eq('user_id', user.id)
        .maybeSingle()
      if (rp) recruiterProfile = rp as RecruiterProfile
    } catch (e) { console.warn('recruiter_profiles fetch failed (non-fatal):', e) }

    const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
    const { data: cached } = await db.from('saved_profiles')
      .select('full_name, work_email, personal_email, title, company, title_verified, email_status, is_bookmarked, enriched_at')
      .eq('user_id', user.id)
      .eq('linkedin_url', linkedinUrl)
      .or(`is_bookmarked.eq.true,enriched_at.gte.${cacheWindow}`)
      .limit(1)
      .maybeSingle()

    if (cached && cached.full_name) {
      const fullName     = cached.full_name
      const work_email   = cached.work_email || null
      const personal_email = cached.personal_email || null
      const selectedEmail  = work_email || personal_email || null
      const company        = companyHint || cached.company || null
      const title          = cached.title || null
      const titleVerified  = cached.title_verified ?? false
      const emailStatus    = (cached.email_status as 'found' | 'not_found' | 'uncertain') || 'not_found'

      const personConfidence  = 0.95
      const companyConfidence = company ? 0.90 : 0.3
      const titleConfidence   = title ? (titleVerified ? 0.90 : 0.40) : 0

      const draftConfidence = computeDraftConfidence(
        personConfidence, companyConfidence, titleConfidence,
        emailStatus, (userContext || '').length
      )

      let status: 'success' | 'partial' | 'not_enough_data' = 'success'
      if (!selectedEmail && !company) status = 'not_enough_data'
      else if (!selectedEmail || titleConfidence < 0.3) status = 'partial'

      let draft: { subject: string; body: string } | null = null
      if (status !== 'not_enough_data' && anthropicKey) {
        try {
          draft = await generateDraft(
            fullName, company, title, titleVerified,
            selectedEmail, userContext,
            draftConfidence, anthropicKey,
            recruiterProfile
          )
        } catch (e) { console.error('Draft generation (cache) failed:', e) }
      }

      if (!draft && status !== 'not_enough_data') {
        return json({ error: { code: 'DRAFT_GENERATION_FAILED', message: 'Contact details were found, but the draft could not be generated.' } }, 500)
      }

      return json({
        status,
        fromCache: true,
        isBookmarked: cached.is_bookmarked ?? false,
        person: {
          fullName, company, title, titleVerified,
          email: selectedEmail, workEmail: work_email,
          personalEmail: personal_email, emailStatus,
        },
        confidence: { personConfidence, companyConfidence, titleConfidence, draftConfidence },
        sources: [{ type: 'saved_profile', label: 'From saved profile (cached)', confidence: 0.95 }],
        draft: draft || null,
      })
    }

    const { data: creditAllowed, error: creditErr } = await db.rpc('deduct_credit', { p_user_id: user.id })
    if (creditErr) {
      console.error('deduct_credit RPC error:', creditErr)
      return json({ error: { code: 'CREDIT_ERROR', message: 'Could not verify your credit balance. Please try again.' } }, 500)
    }
    if (creditAllowed === false) {
      return json({ error: { code: 'CREDIT_LIMIT_REACHED', message: 'You have reached your lookup limit. Upgrade your plan for more enrichments.' } }, 402)
    }

    const sources: any[] = []
    let personConfidence = 0.5

    let fullName: string = fullNameHint || ''
    let work_email: string | null = null
    let personal_email: string | null = null
    let selectedEmail: string | null = null
    let company: string | null = companyHint || null
    let companyDomain: string | null = null
    let providerTitle: string | null = null
    let emailStatus: 'found' | 'not_found' | 'uncertain' = 'not_found'
    let emailDomain: string | null = null
    let companyConfidence = companyHint ? 0.7 : 0.3
    let titleVerified = false
    let rawDataPayload: any = null

    if (fullenrichKey) {
      let enrichRaw: any = null
      let enrichStatus = 0
      try {
        const enrichResult = await enrichWithLinkedInV2(linkedinUrl, fullenrichKey)
        enrichRaw       = enrichResult.raw
        rawDataPayload  = enrichResult.raw
        enrichStatus = 200

        if (enrichResult.full_name) { fullName = enrichResult.full_name; personConfidence = 0.95 }

        work_email     = enrichResult.work_email
        personal_email = enrichResult.personal_email
        selectedEmail  = work_email || personal_email || null
        emailStatus    = work_email ? 'found' : personal_email ? 'uncertain' : 'not_found'
        if (work_email) emailDomain = work_email.split('@')[1] || null
        else if (personal_email) emailDomain = personal_email.split('@')[1] || null

        if (enrichResult.company) {
          company = enrichResult.company
          companyDomain = enrichResult.company_domain
          companyConfidence = 0.95
        } else if (enrichResult.company_domain) {
          companyDomain = enrichResult.company_domain
        }

        if (enrichResult.title) { providerTitle = enrichResult.title; titleVerified = true }

        try {
          const earlyEmailStatus = enrichResult.work_email ? 'found' : enrichResult.personal_email ? 'uncertain' : 'not_found'
          await db.from('saved_profiles').upsert({
            user_id: user.id, linkedin_url: linkedinUrl,
            full_name: enrichResult.full_name || fullName || null,
            work_email: enrichResult.work_email || null,
            personal_email: enrichResult.personal_email || null,
            title: enrichResult.title || null,
            company: enrichResult.company || companyHint || null,
            title_verified: !!enrichResult.title,
            email_status: earlyEmailStatus,
            raw_data: enrichResult.raw,
            enriched_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          }, { onConflict: 'user_id,linkedin_url', ignoreDuplicates: false })
        } catch (e) { console.error('early upsert failed (non-fatal):', e) }

        sources.push({ type: 'fullenrich_v2', label: 'LinkedIn URL enrichment', confidence: 0.95 })
      } catch (e: any) {
        console.error('FullEnrich v2 failed:', e)
        enrichRaw    = { error: String(e?.message || e) }
        enrichStatus = 500
        sources.push({ type: 'fullenrich_v2', label: 'Enrichment unavailable', confidence: 0 })
      } finally {
        try {
          await db.from('enrichment_debug_logs').insert({
            user_id: user.id, provider: 'fullenrich_v2',
            request_payload: { linkedin_url: linkedinUrl, company_hint: companyHint },
            response_payload: enrichRaw,
            status_code: enrichStatus,
          })
        } catch {}
      }
    } else {
      console.warn('FULLENRICH_API_KEY not set — skipping enrichment')
    }

    if (!fullName) return json({ error: { code: 'NOT_ENOUGH_DATA', message: 'Could not identify this person. Try again or check the LinkedIn profile URL.' } }, 422)

    if (emailDomain && !company) {
      try {
        const emp = await resolveEmployer(emailDomain, db, anthropicKey)
        company = emp.company; companyConfidence = emp.confidence
        sources.push({ type: 'domain_lookup', label: 'Company from email domain', confidence: emp.confidence })
      } catch (e) { console.error('Employer resolution failed:', e) }
    }

    if (companyDomain && !company) {
      try {
        const emp = await resolveEmployer(companyDomain, db, anthropicKey)
        company = emp.company; companyConfidence = emp.confidence
        sources.push({ type: 'domain_lookup', label: 'Company from profile domain', confidence: emp.confidence })
      } catch (e) { console.error('Company domain resolution failed:', e) }
    }

    let title: string | null = providerTitle
    let titleConfidence = providerTitle ? 0.90 : 0

    if (!title && company && anthropicKey) {
      try {
        const fallback = await inferTitleFallback(fullName, company, anthropicKey)
        if (fallback.title && fallback.confidence >= 0.25) {
          title = fallback.title; titleConfidence = fallback.confidence; titleVerified = false
          sources.push({ type: 'claude_inference', label: 'Title inferred (unverified)', confidence: fallback.confidence })
        }
      } catch (e) { console.error('Title fallback failed:', e) }
    }

    const draftConfidence = computeDraftConfidence(
      personConfidence, companyConfidence, titleConfidence,
      emailStatus, (userContext || '').length
    )

    let status: 'success' | 'partial' | 'not_enough_data' = 'success'
    if (!selectedEmail && !company) status = 'not_enough_data'
    else if (!selectedEmail || titleConfidence < 0.3) status = 'partial'

    let draft: { subject: string; body: string } | null = null
    if (status !== 'not_enough_data' && anthropicKey) {
      try {
        draft = await generateDraft(
          fullName, company, title, titleVerified,
          selectedEmail, userContext,
          draftConfidence, anthropicKey,
          recruiterProfile
        )
      } catch (e) { console.error('Draft generation failed:', e) }
    }

    if (!draft && status !== 'not_enough_data') {
      return json({ error: { code: 'DRAFT_GENERATION_FAILED', message: 'Contact details were found, but the draft could not be generated.' } }, 500)
    }

    try { await db.rpc('increment_ai_run', { p_user_id: user.id }) } catch (e) { console.error('increment_ai_run RPC failed (non-fatal):', e) }

    let runId: string | null = null
    try {
      const { data: run } = await db.from('outreach_runs').insert({
        user_id: user.id, full_name: fullName, company: company || null,
        title: title || null, email: work_email || null, email_status: emailStatus,
        person_confidence: personConfidence, company_confidence: companyConfidence,
        title_confidence: titleConfidence, draft_confidence: draftConfidence,
        user_context: userContext, company_hint: companyHint,
        draft_subject: draft?.subject || null, draft_body: draft?.body || null,
        status, sources,
      }).select('id').single()
      runId = run?.id ?? null
    } catch (e) { console.error('outreach_runs insert failed (non-fatal):', e) }

    let isBookmarked = false
    try {
      await db.from('saved_profiles').upsert({
        user_id: user.id, linkedin_url: linkedinUrl, full_name: fullName,
        work_email: work_email || null, personal_email: personal_email || null,
        title: title || null, company: company || null, title_verified: titleVerified,
        email_status: emailStatus, enriched_at: new Date().toISOString(),
        updated_at: new Date().toISOString(), raw_data: rawDataPayload || null,
      }, { onConflict: 'user_id,linkedin_url', ignoreDuplicates: false })

      const { data: savedRow } = await db.from('saved_profiles')
        .select('is_bookmarked')
        .eq('user_id', user.id)
        .eq('linkedin_url', linkedinUrl)
        .maybeSingle()
      isBookmarked = savedRow?.is_bookmarked ?? false
    } catch (e) { console.error('saved_profiles upsert failed (non-fatal):', e) }

    return json({
      status, fromCache: false, isBookmarked, runId,
      person: {
        fullName, company: company || null, title: title || null, titleVerified,
        email: selectedEmail || null, workEmail: work_email || null,
        personalEmail: personal_email || null, emailStatus,
      },
      confidence: { personConfidence, companyConfidence, titleConfidence, draftConfidence },
      sources,
      draft: draft || null,
    })

  } catch (e: any) {
    console.error('enrich-and-draft error:', String(e?.message || e), e?.stack || '')
    return json({ error: { code: 'UNKNOWN_ERROR', message: 'Something went wrong. Please try again.' } }, 500)
  }
})

// ── Helper: increment a campaign aggregate count ──────────────────────────────
async function _incrementCampaignCount(db: any, campaignId: string, field: string) {
  try {
    const { data: camp } = await db.from('campaigns').select(field).eq('id', campaignId).maybeSingle()
    if (camp) {
      await db.from('campaigns').update({
        [field]: (camp[field] || 0) + 1,
        updated_at: new Date().toISOString(),
      }).eq('id', campaignId)
    }
  } catch (e) { console.error(`_incrementCampaignCount(${field}) failed:`, e) }
}
