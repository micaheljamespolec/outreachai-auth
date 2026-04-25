import "jsr:@supabase/functions-js/edge-runtime.d.ts"
import { createClient } from "jsr:@supabase/supabase-js@2"

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, PUT, DELETE, OPTIONS",
  "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Client-Info, Apikey",
}

function jsonResponse(data: unknown, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

function errorResponse(msg: string, status: number) {
  return new Response(JSON.stringify({ error: msg }), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  })
}

// ── Step 2: Claude Haiku — generate email pattern candidates ──
async function generateEmailPatterns(
  fullName: string,
  companyHint: string,
  anthropicKey: string
): Promise<string[]> {
  if (!anthropicKey || !fullName || !companyHint) return []
  const prompt = `You are generating likely corporate email addresses.

Person name: "${fullName}"
Company: "${companyHint}"

Return the 3 most likely work email addresses for this person at this company, ranked from most likely to least likely.

Rules:
- Infer the company's likely email domain from the company name.
- Use common corporate email patterns.
- Lowercase everything.
- Return ONLY valid JSON with this exact shape:
{"candidates":["email1","email2","email3"]}`

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": anthropicKey,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: "claude-haiku-4-5",
      max_tokens: 200,
      messages: [{ role: "user", content: prompt }],
    }),
  })
  const d = await res.json()
  const raw = d.content?.[0]?.text?.trim() || "{}"
  let parsed: any
  try {
    parsed = JSON.parse(
      raw.replace(/^```json?\s*/i, "").replace(/```\s*$/, "").trim()
    )
  } catch {
    parsed = {}
  }
  const list = Array.isArray(parsed.candidates) ? parsed.candidates : []
  console.log("[Step 2] Claude raw candidates:", list)
  return list.filter(
    (e: any) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
  )
}

// ── Step 3: Google CSE — search company email FORMAT, construct candidates ──
async function searchGoogleForEmailFormat(
  firstName: string,
  lastName: string,
  companyHint: string,
  googleKey: string,
  googleCx: string
): Promise<string[]> {
  if (!googleKey || !googleCx || !companyHint || !firstName || !lastName) return []

  const q = `"${companyHint}" email format`
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(googleKey)}&cx=${encodeURIComponent(googleCx)}&q=${encodeURIComponent(q)}`

  try {
    const res = await fetch(url)
    if (!res.ok) {
      console.log("[Step 3] Google CSE request failed:", res.status)
      return []
    }
    const data = await res.json()
    const items = Array.isArray(data.items) ? data.items : []

    const patternRegex = /([a-z._%+-]+)@([a-z0-9.-]+\.[a-z]{2,})/gi
    const domainCounts: Record<string, number> = {}
    let mostLikelyDomain = ''

    for (const item of items) {
      const text = `${item.snippet || ''} ${item.title || ''}`
      const matches = [...text.matchAll(patternRegex)]
      for (const m of matches) {
        const domain = m[2].toLowerCase()
        if (['gmail.com','yahoo.com','hotmail.com','outlook.com'].includes(domain)) continue
        domainCounts[domain] = (domainCounts[domain] || 0) + 1
        if (!mostLikelyDomain || domainCounts[domain] > domainCounts[mostLikelyDomain]) {
          mostLikelyDomain = domain
        }
      }
    }

    if (!mostLikelyDomain) {
      console.log("[Step 3] No company domain found in Google results")
      return []
    }

    const first = firstName.toLowerCase().replace(/[^a-z]/g, '')
    const last = lastName.toLowerCase().replace(/[^a-z]/g, '')
    const candidates = [
      `${first}.${last}@${mostLikelyDomain}`,
      `${first[0]}${last}@${mostLikelyDomain}`,
      `${first}@${mostLikelyDomain}`,
    ]
    console.log("[Step 3] Constructed candidates from domain", mostLikelyDomain, ":", candidates)
    return candidates
  } catch (e: any) {
    console.log("[Step 3] Google CSE error:", e?.message)
    return []
  }
}

// ── Step 4: Email verification — MyEmailVerifier with Kickbox fallback ──
interface VerifyResult {
  verified: boolean
  accept_all: boolean
  method: "myemailverifier" | "kickbox" | "none"
  result: string | null
}

async function verifyEmail(
  email: string,
  myemailverifierKey: string,
  kickboxKey: string
): Promise<VerifyResult> {
  if (!email)
    return { verified: false, accept_all: false, method: "none", result: null }

  if (myemailverifierKey) {
    try {
      const res = await fetch(
        `https://api.myemailverifier.com/verify?secret=${encodeURIComponent(myemailverifierKey)}&email=${encodeURIComponent(email)}`
      )
      if (res.ok) {
        const data = await res.json()
        const status = String(data?.status || data?.result || "").toLowerCase()
        if (status === "valid")
          return { verified: true, accept_all: false, method: "myemailverifier", result: status }
        if (status === "accept_all" || status === "catch-all" || status === "catch_all")
          return { verified: true, accept_all: true, method: "myemailverifier", result: status }
        return { verified: false, accept_all: false, method: "myemailverifier", result: status || "unknown" }
      }
    } catch (e) {
      console.warn("MyEmailVerifier failed, trying Kickbox:", e)
    }
  }

  if (kickboxKey) {
    try {
      const res = await fetch(
        `https://api.kickbox.com/v2/verify?email=${encodeURIComponent(email)}&apikey=${encodeURIComponent(kickboxKey)}`
      )
      if (res.ok) {
        const data = await res.json()
        const result = String(data?.result || "").toLowerCase()
        if (result === "deliverable" || result === "risky")
          return { verified: true, accept_all: result === "risky", method: "kickbox", result }
        return { verified: false, accept_all: false, method: "kickbox", result: result || "unknown" }
      }
    } catch (e) {
      console.warn("Kickbox verify failed:", e)
    }
  }

  return { verified: false, accept_all: false, method: "none", result: null }
}

// ── Step 5: Apollo people match — trusted source, no re-verification ──
async function enrichWithApollo(
  firstName: string,
  lastName: string,
  company: string | null,
  linkedinUrl: string | null,
  apolloKey: string
): Promise<{
  email: string | null
  title: string | null
  company: string | null
  full_name: string | null
  raw: any
}> {
  const empty = { email: null, title: null, company: null, full_name: null, raw: null }
  if (!apolloKey) return empty
  try {
    const body: Record<string, any> = {}
    if (firstName) body.first_name = firstName
    if (lastName) body.last_name = lastName
    if (company) body.organization_name = company
    if (linkedinUrl) body.linkedin_url = linkedinUrl
    const res = await fetch("https://api.apollo.io/v1/people/match", {
      method: "POST",
      headers: { "Content-Type": "application/json", "x-api-key": apolloKey },
      body: JSON.stringify(body),
    })
    const data = await res.json()
    if (!res.ok) return { ...empty, raw: data }
    const person = data?.person || {}
    return {
      email: person.email || null,
      title: person.title || person.headline || null,
      company: person.organization?.name || person.organization_name || null,
      full_name:
        person.name ||
        (person.first_name && person.last_name
          ? `${person.first_name} ${person.last_name}`
          : null),
      raw: data,
    }
  } catch (e) {
    console.warn("Apollo enrichment failed:", e)
    return empty
  }
}

// ── Step 6: FullEnrich v2 — last resort, LinkedIn URL required ──
async function enrichWithFullEnrich(
  linkedinUrl: string,
  key: string
): Promise<{
  full_name: string | null
  work_email: string | null
  personal_email: string | null
  title: string | null
  company: string | null
  company_domain: string | null
  raw: any
}> {
  const empty = {
    full_name: null,
    work_email: null,
    personal_email: null,
    title: null,
    company: null,
    company_domain: null,
    raw: null,
  }

  const startRes = await fetch(
    "https://app.fullenrich.com/api/v2/contact/enrich/bulk",
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${key}`,
      },
      body: JSON.stringify({
        name: `LookupEmail-${Date.now()}`,
        data: [{ linkedin_url: linkedinUrl, enrich_fields: ["contact.emails"] }],
      }),
    }
  )

  const startData = await startRes.json()
  if (!startRes.ok)
    throw new Error(
      `FullEnrich start error ${startRes.status}: ${JSON.stringify(startData)}`
    )

  const enrichmentId = startData.enrichment_id
  if (!enrichmentId) throw new Error("FullEnrich did not return enrichment_id")

  await new Promise((r) => setTimeout(r, 3000))
  for (let i = 0; i < 22; i++) {
    if (i > 0) await new Promise((r) => setTimeout(r, 5000))

    const pollRes = await fetch(
      `https://app.fullenrich.com/api/v2/contact/enrich/bulk/${enrichmentId}`,
      { headers: { Authorization: `Bearer ${key}` } }
    )
    const pollData = await pollRes.json()

    if (pollData.status === "FINISHED") {
      const results = pollData.datas ?? pollData.data ?? []
      const row = results[0]
      if (!row) return { ...empty, raw: pollData }

      const contactInfo = row.contact_info ?? row.contact?.contact_info ?? null
      const profile = row.profile ?? row.contact?.profile ?? {}
      const current = profile.employment?.current

      const workEmail =
        contactInfo?.most_probable_work_email?.email ??
        contactInfo?.work_emails?.[0]?.email ??
        row.contact?.most_probable_email ??
        null
      const personalEmail =
        contactInfo?.most_probable_personal_email?.email ??
        contactInfo?.personal_emails?.[0]?.email ??
        null

      return {
        full_name: profile.full_name || null,
        work_email: workEmail,
        personal_email: personalEmail,
        title: current?.title || null,
        company: current?.company?.name || null,
        company_domain: current?.company?.domain || null,
        raw: pollData,
      }
    }

    if (pollData.status === "FAILED")
      throw new Error("FullEnrich enrichment failed")
  }

  throw new Error(
    "FullEnrich timeout — enrichment did not complete within polling window"
  )
}

// ── Debug log helper ──
async function logDebug(
  db: any,
  userId: string,
  provider: string,
  requestPayload: any,
  responsePayload: any,
  statusCode: number
) {
  try {
    await db.from("enrichment_debug_logs").insert({
      user_id: userId,
      provider,
      request_payload: requestPayload,
      response_payload: responsePayload,
      status_code: statusCode,
    })
  } catch {}
}

// ── Main handler ──
Deno.serve(async (req: Request) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { status: 200, headers: corsHeaders })
  }

  const supabaseUrl = Deno.env.get("SUPABASE_URL")!
  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!
  const anthropicKey = Deno.env.get("ANTHROPIC_API_KEY") || ""
  const fullenrichKey = Deno.env.get("FULLENRICH_API_KEY") || ""
  const googleKey = Deno.env.get("GOOGLE_CSE_API_KEY") || ""
  const googleCx = Deno.env.get("GOOGLE_CSE_CX") || ""
  const myemailverifierKey = Deno.env.get("MYEMAILVERIFIER_API_KEY") || ""
  const kickboxKey = Deno.env.get("KICKBOX_API_KEY") || ""
  const apolloKey = Deno.env.get("APOLLO_API_KEY") || ""
  const db = createClient(supabaseUrl, serviceKey)

  const authHeader = req.headers.get("Authorization") || ""
  const token = authHeader.replace(/^Bearer\s+/i, "").trim()
  if (!token) return errorResponse("Session expired — please sign in again.", 401)
  const {
    data: { user },
    error: authErr,
  } = await db.auth.getUser(token)
  if (authErr || !user)
    return errorResponse("Session expired — please sign in again.", 401)
  const userId = user.id

  try {
    const body = await req.json()
    const firstName = (body.firstName || "").trim()
    const lastName = (body.lastName || "").trim()
    const linkedinUrl = (body.linkedinUrl || "").trim()
    const companyHint = (body.company || "").trim() || null
    const fullName = `${firstName} ${lastName}`.trim()

    if (!firstName && !lastName && !linkedinUrl)
      return errorResponse("Missing name or LinkedIn URL", 400)

    console.log("[lookup-email] received:", { firstName, lastName, companyHint, linkedinUrl, userId })

    // ── Cache check (free) ──
    if (linkedinUrl) {
      const cacheWindow = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000).toISOString()
      const { data: cached } = await db
        .from("saved_profiles")
        .select("work_email, personal_email, email_source")
        .eq("user_id", userId)
        .eq("linkedin_url", linkedinUrl)
        .gte("enriched_at", cacheWindow)
        .maybeSingle()

      if (cached && (cached.work_email || cached.personal_email)) {
        const email = cached.work_email || cached.personal_email
        console.log("[Cache] Hit for:", linkedinUrl, "->", email)
        return jsonResponse({
          email,
          source: cached.email_source || "cache",
          found: true,
          fromCache: true,
        })
      }
    }

    let selectedEmail: string | null = null
    let emailSource: string | null = null
    let emailAcceptAll = false
    let resultFullName: string | null = fullName || null
    let resultTitle: string | null = null
    let resultCompany: string | null = companyHint
    let resultCompanyDomain: string | null = null
    let titleVerified = false
    let rawDataPayload: any = null

    // ── Step 2: Claude Haiku — email pattern candidates ──
    let patternCandidates: string[] = []
    if (fullName && companyHint && anthropicKey) {
      console.log("[Step 2] Starting Claude lookup — fullName:", fullName, "| companyHint:", companyHint)
      try {
        patternCandidates = await generateEmailPatterns(fullName, companyHint, anthropicKey)
        console.log("[Step 2] Claude returned", patternCandidates.length, "candidate(s):", patternCandidates)
        await logDebug(db, userId, "claude_pattern", { fullName, companyHint }, { candidates: patternCandidates }, 200)
      } catch (e: any) {
        console.log("[Step 2] Failed —", e?.message)
        await logDebug(db, userId, "claude_pattern", { fullName, companyHint }, { error: String(e?.message || e) }, 500)
      }
    } else {
      console.log("[Step 2] Skipped — fullName:", fullName || '(empty)', "| companyHint:", companyHint || '(empty)', "| anthropicKey:", anthropicKey ? 'present' : 'missing')
    }

    // ── Step 3: Google CSE — only if Claude returned nothing ──
    let searchCandidates: string[] = []
    if (patternCandidates.length === 0 && companyHint && googleKey && googleCx) {
      console.log("[Step 3] Claude returned no candidates — running Google format search for:", companyHint)
      try {
        searchCandidates = await searchGoogleForEmailFormat(firstName, lastName, companyHint, googleKey, googleCx)
        await logDebug(db, userId, "google_cse", { firstName, lastName, companyHint }, { candidates: searchCandidates }, 200)
      } catch (e: any) {
        await logDebug(db, userId, "google_cse", { firstName, lastName, companyHint }, { error: String(e?.message || e) }, 500)
        console.log("[Step 3] Failed —", e?.message)
      }
    } else if (patternCandidates.length > 0) {
      console.log("[Step 3] Skipped — Claude already returned candidates")
    } else {
      console.log("[Step 3] Skipped — missing companyHint or Google keys")
    }

    // ── Step 4: Verify candidates from Steps 2 & 3 ──
    const seen = new Set<string>()
    const allCandidates: Array<{ email: string; origin: string }> = []
    for (const e of patternCandidates) {
      if (!seen.has(e)) { seen.add(e); allCandidates.push({ email: e, origin: "claude_pattern" }) }
    }
    for (const e of searchCandidates) {
      if (!seen.has(e)) { seen.add(e); allCandidates.push({ email: e, origin: "google_search" }) }
    }

    if (allCandidates.length > 0) {
      if (myemailverifierKey || kickboxKey) {
        console.log("[Step 4] Starting verification of", allCandidates.length, "candidate(s):", allCandidates.map((c) => c.email))
        for (const cand of allCandidates) {
          console.log("[Step 4] Verifying:", cand.email, "(source:", cand.origin + ")")
          const v = await verifyEmail(cand.email, myemailverifierKey, kickboxKey)
          await logDebug(
            db, userId, `verify_${v.method}`,
            { email: cand.email },
            { verified: v.verified, accept_all: v.accept_all, result: v.result },
            v.method === "none" ? 500 : 200
          )
          console.log("[Step 4] Result:", cand.email, "->", v.result, "| verified:", v.verified)
          if (v.verified) {
            selectedEmail = cand.email
            emailSource = cand.origin
            emailAcceptAll = v.accept_all
            console.log("[Step 4] Accepted:", selectedEmail, "| source:", emailSource, "| accept_all:", emailAcceptAll)
            break
          }
        }
        if (!selectedEmail) console.log("[Step 4] No candidates passed verification — moving to Apollo")
      } else {
        selectedEmail = allCandidates[0].email
        emailSource = allCandidates[0].origin
        console.log("[Step 4] No verifier keys — accepting top candidate directly:", selectedEmail)
      }
    } else {
      console.log("[Step 4] No candidates to verify — moving to Apollo")
    }

    // ── Step 5: Apollo — trusted source, accept directly ──
    if (!selectedEmail && apolloKey) {
      console.log("[Step 5] Calling Apollo for:", fullName)
      try {
        const apollo = await enrichWithApollo(firstName, lastName, companyHint, linkedinUrl || null, apolloKey)
        await logDebug(
          db, userId, "apollo",
          { firstName, lastName, companyHint, linkedinUrl },
          apollo.raw || {},
          apollo.email ? 200 : 204
        )
        console.log("[Step 5] Apollo result:", apollo.email || "none")

        if (apollo.full_name && !resultFullName) resultFullName = apollo.full_name
        if (apollo.title) { resultTitle = apollo.title; titleVerified = true }
        if (apollo.company && !resultCompany) resultCompany = apollo.company

        if (apollo.email) {
          selectedEmail = apollo.email.toLowerCase()
          emailSource = "apollo"
          console.log("[Step 5] Apollo email accepted:", selectedEmail)
        }
      } catch (e: any) {
        await logDebug(db, userId, "apollo", { firstName, lastName }, { error: String(e?.message || e) }, 500)
        console.log("[Step 5] Apollo failed —", e?.message)
      }
    } else if (!selectedEmail) {
      console.log("[Step 5] Skipped — no Apollo key")
    }

    // ── Step 6: FullEnrich — absolute last resort ──
    if (!selectedEmail && fullenrichKey && linkedinUrl) {
      console.log("[Step 6] All prior steps failed — calling FullEnrich as last resort")
      let enrichRaw: any = null
      let enrichStatus = 0
      try {
        const fe = await enrichWithFullEnrich(linkedinUrl, fullenrichKey)
        enrichRaw = fe.raw
        enrichStatus = 200
        rawDataPayload = fe.raw

        if (fe.full_name && !resultFullName) resultFullName = fe.full_name
        if (fe.title) { resultTitle = fe.title; titleVerified = true }
        if (fe.company && !resultCompany) resultCompany = fe.company
        if (fe.company_domain) resultCompanyDomain = fe.company_domain

        if (fe.work_email) {
          selectedEmail = fe.work_email
          emailSource = "fullenrich"
        } else if (fe.personal_email) {
          selectedEmail = fe.personal_email
          emailSource = "fullenrich"
        }

        console.log("[Step 6] FullEnrich result:", selectedEmail || "none")
      } catch (e: any) {
        enrichRaw = { error: String(e?.message || e) }
        enrichStatus = 500
        console.log("[Step 6] FullEnrich failed —", e?.message)
      } finally {
        await logDebug(
          db, userId, "fullenrich_v2",
          { linkedin_url: linkedinUrl, company_hint: companyHint },
          enrichRaw, enrichStatus
        )
      }
    } else if (!selectedEmail) {
      if (!fullenrichKey) console.log("[Step 6] Skipped — no FullEnrich key")
      else console.log("[Step 6] Skipped — no LinkedIn URL")
    }

    // ── Step 7: Deduct credit ONLY if email found ──
    if (selectedEmail) {
      const { data: creditAllowed, error: creditErr } = await db.rpc(
        "deduct_credit",
        { p_user_id: userId }
      )
      if (creditErr) {
        console.error("[Step 7] deduct_credit RPC error:", creditErr)
      } else if (creditAllowed === false) {
        console.log("[Step 7] Credit limit reached — returning result without charging")
        return errorResponse("Credit limit reached. Upgrade your plan for more lookups.", 402)
      } else {
        console.log("[Step 7] Credit deducted for user:", userId)
      }
    } else {
      console.log("[Step 7] No email found — no credit charged")
    }

    const found = !!selectedEmail
    const emailStatus = selectedEmail
      ? emailAcceptAll
        ? "uncertain"
        : "found"
      : "not_found"

    console.log(
      "[FINAL]", found ? "FOUND" : "NOT FOUND",
      "| email:", selectedEmail || "none",
      "| source:", emailSource || "none",
      "| credit charged:", found ? "yes" : "no"
    )

    if (linkedinUrl) {
      try {
        await db.from("saved_profiles").upsert(
          {
            user_id: userId,
            linkedin_url: linkedinUrl,
            full_name: resultFullName || null,
            work_email: selectedEmail || null,
            personal_email: null,
            title: resultTitle || null,
            company: resultCompany || null,
            title_verified: titleVerified,
            email_status: emailStatus,
            email_source: emailSource,
            raw_data: rawDataPayload,
            enriched_at: new Date().toISOString(),
            updated_at: new Date().toISOString(),
          },
          { onConflict: "user_id,linkedin_url", ignoreDuplicates: false }
        )
      } catch (e) {
        console.error("saved_profiles upsert failed (non-fatal):", e)
      }
    }

    return jsonResponse({
      email: selectedEmail,
      source: emailSource,
      found,
      emailStatus,
      fromCache: false,
      person: {
        fullName: resultFullName,
        company: resultCompany,
        title: resultTitle,
        titleVerified,
        emailSource,
      },
    })
  } catch (e: any) {
    console.error("lookup-email error:", String(e?.message || e), e?.stack || "")
    return errorResponse("Something went wrong. Please try again.", 500)
  }
})
