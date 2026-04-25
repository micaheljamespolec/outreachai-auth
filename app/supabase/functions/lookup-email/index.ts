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

// ── Claude Haiku: generate 2-3 email pattern candidates ──
async function generateEmailPatterns(
  fullName: string,
  companyHint: string,
  anthropicKey: string
): Promise<string[]> {
  if (!anthropicKey || !fullName || !companyHint) return []
  const prompt = `Given a person's full name and their employer (company name or domain), produce the 2-3 most likely work email addresses ranked by probability.

Person: "${fullName}"
Employer: "${companyHint}"

Rules:
- If the employer looks like a domain (contains a dot), use it directly.
- If it is a company name, infer the most likely primary email domain (e.g. "Stripe" -> "stripe.com").
- Use common corporate patterns: firstname.lastname@domain, flastname@domain, firstname@domain, firstinitiallastname@domain.
- Lowercase everything. Strip accents and punctuation from the name.

Return ONLY JSON: {"candidates":["email1","email2","email3"]}`

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
  return list.filter(
    (e: any) => typeof e === "string" && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e)
  )
}

// ── Google Custom Search: find emails matching company domain ──
async function searchGoogleForEmail(
  firstName: string,
  lastName: string,
  companyHint: string,
  googleKey: string,
  googleCx: string
): Promise<string[]> {
  if (!googleKey || !googleCx || !companyHint) return []
  const nameQuery = `${firstName || ""} ${lastName || ""}`.trim()
  if (!nameQuery) return []
  const q = `"${nameQuery}" "${companyHint}" email`
  const url = `https://www.googleapis.com/customsearch/v1?key=${encodeURIComponent(googleKey)}&cx=${encodeURIComponent(googleCx)}&q=${encodeURIComponent(q)}`
  try {
    const res = await fetch(url)
    if (!res.ok) return []
    const data = await res.json()
    const items = Array.isArray(data.items) ? data.items : []
    const emailRegex =
      /[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/g
    const found = new Set<string>()
    const domainLower = companyHint.toLowerCase()
    for (const item of items) {
      const text = `${item.snippet || ""} ${item.link || ""} ${item.title || ""}`
      const matches = text.match(emailRegex) || []
      for (const m of matches) {
        const emailLower = m.toLowerCase()
        if (emailLower.endsWith("@" + domainLower)) found.add(emailLower)
      }
    }
    return Array.from(found)
  } catch {
    return []
  }
}

// ── Email verification: MyEmailVerifier with Kickbox fallback ──
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

// ── Apollo people match ──
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

// ── FullEnrich v2: LinkedIn URL -> email ──
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

  // Initial 3s wait, then poll every 5s, up to 22 polls (~115s max)
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

// ── Refund credit helper ──
async function refundCredit(db: any, userId: string) {
  try {
    await db.rpc("refund_credit", { p_user_id: userId })
  } catch (e) {
    console.error("refundCredit failed (non-fatal):", e)
  }
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

  // ── Auth guard ──
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

    console.log("lookup-email received:", { firstName, lastName, companyHint, linkedinUrl, userId })

    // ── Check cache ──
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
        console.log("Cache hit for:", linkedinUrl, "->", email)
        return jsonResponse({
          email,
          source: cached.email_source || "cache",
          found: true,
          fromCache: true,
        })
      }
    }

    // ── Deduct credit upfront — refunded by Step 7 if no email found ──
    const { data: creditAllowed, error: creditErr } = await db.rpc(
      "deduct_credit",
      { p_user_id: userId }
    )
    if (creditErr) {
      console.error("deduct_credit RPC error:", creditErr)
      return errorResponse("Could not verify your credit balance. Please try again.", 500)
    }
    if (creditAllowed === false) {
      return errorResponse(
        "Credit limit reached. Upgrade your plan for more lookups.",
        402
      )
    }
    console.log("Credit deducted for user:", userId)

    // ── Waterfall variables ──
    let selectedEmail: string | null = null
    let emailSource: string | null = null
    let emailAcceptAll = false
    let resultFullName: string | null = fullName || null
    let resultTitle: string | null = null
    let resultCompany: string | null = companyHint
    let resultCompanyDomain: string | null = null
    let titleVerified = false
    let rawDataPayload: any = null
    let fullenrichFailed = false

    // ════════════════════════════════════════════════════════════════════════
    // Step 3 — Claude Haiku email pattern guess
    // ════════════════════════════════════════════════════════════════════════
    const patternCandidates: string[] = []
    if (fullName && companyHint && anthropicKey) {
      console.log("[Step 3] Generating email patterns for:", fullName, "at domain:", companyHint)
      try {
        const patterns = await generateEmailPatterns(fullName, companyHint, anthropicKey)
        for (const p of patterns) patternCandidates.push(p.toLowerCase())
        await logDebug(db, userId, "claude_pattern", { fullName, companyHint }, { candidates: patterns }, 200)
        console.log("[Step 3] Pattern candidates:", patternCandidates)
      } catch (e: any) {
        await logDebug(db, userId, "claude_pattern", { fullName, companyHint }, { error: String(e?.message || e) }, 500)
        console.log("[Step 3] Failed —", e?.message)
      }
    } else {
      console.log("[Step 3] Skipped (missing fullName, companyHint, or anthropic key)")
    }

    // ════════════════════════════════════════════════════════════════════════
    // Step 4 — Google Custom Search
    // ════════════════════════════════════════════════════════════════════════
    const searchCandidates: string[] = []
    if (companyHint && googleKey && googleCx) {
      console.log("[Step 4] Running Google search for:", fullName, companyHint)
      try {
        const found = await searchGoogleForEmail(firstName, lastName, companyHint, googleKey, googleCx)
        for (const e of found) searchCandidates.push(e)
        await logDebug(db, userId, "google_cse", { firstName, lastName, companyHint }, { found }, 200)
        console.log("[Step 4] Search candidates found:", searchCandidates)
      } catch (e: any) {
        await logDebug(db, userId, "google_cse", { firstName, lastName, companyHint }, { error: String(e?.message || e) }, 500)
        console.log("[Step 4] Failed —", e?.message)
      }
    } else {
      console.log("[Step 4] Skipped (missing companyHint or Google keys)")
    }

    // ════════════════════════════════════════════════════════════════════════
    // Step 5 — Verification (MyEmailVerifier -> Kickbox fallback)
    // ════════════════════════════════════════════════════════════════════════
    // Combine and deduplicate pattern + search candidates
    const seen = new Set<string>()
    const allCandidates: Array<{ email: string; origin: string }> = []
    for (const e of patternCandidates) {
      if (!seen.has(e)) { seen.add(e); allCandidates.push({ email: e, origin: "claude_pattern" }) }
    }
    for (const e of searchCandidates) {
      if (!seen.has(e)) { seen.add(e); allCandidates.push({ email: e, origin: "google_search" }) }
    }

    if (allCandidates.length > 0 && (myemailverifierKey || kickboxKey)) {
      console.log("[Step 5] Verifying", allCandidates.length, "candidates:", allCandidates.map((c) => c.email))
      for (const cand of allCandidates) {
        const v = await verifyEmail(cand.email, myemailverifierKey, kickboxKey)
        await logDebug(
          db, userId, `verify_${v.method}`,
          { email: cand.email },
          { verified: v.verified, accept_all: v.accept_all, result: v.result },
          v.method === "none" ? 500 : 200
        )
        if (v.verified) {
          selectedEmail = cand.email
          emailSource = cand.origin
          emailAcceptAll = v.accept_all
          console.log("[Step 5] Verified email:", selectedEmail, "| source:", emailSource)
          break
        }
      }
      if (!selectedEmail) {
        console.log("[Step 5] No candidates verified — moving to Apollo")
      }
    } else if (allCandidates.length === 0) {
      console.log("[Step 5] No candidates to verify — moving to Apollo")
    } else {
      console.log("[Step 5] Skipped verification (no verifier keys)")
    }

    // ════════════════════════════════════════════════════════════════════════
    // Step 6 — Apollo (only if Steps 3-5 found nothing)
    // ════════════════════════════════════════════════════════════════════════
    if (!selectedEmail && apolloKey) {
      console.log("[Step 6] Calling Apollo for:", fullName)
      try {
        const apollo = await enrichWithApollo(firstName, lastName, companyHint, linkedinUrl || null, apolloKey)
        await logDebug(
          db, userId, "apollo",
          { firstName, lastName, companyHint, linkedinUrl },
          apollo.raw || {},
          apollo.email ? 200 : 204
        )
        console.log("[Step 6] Apollo result:", apollo.email || "none")

        if (apollo.full_name && !resultFullName) resultFullName = apollo.full_name
        if (apollo.title) { resultTitle = apollo.title; titleVerified = true }
        if (apollo.company && !resultCompany) resultCompany = apollo.company

        if (apollo.email) {
          const v = await verifyEmail(apollo.email, myemailverifierKey, kickboxKey)
          await logDebug(
            db, userId, `verify_${v.method}`,
            { email: apollo.email, source: "apollo" },
            { verified: v.verified, accept_all: v.accept_all, result: v.result },
            v.method === "none" ? 500 : 200
          )
          if (v.verified) {
            selectedEmail = apollo.email.toLowerCase()
            emailSource = "apollo"
            emailAcceptAll = v.accept_all
            console.log("[Step 6] Apollo email verified:", selectedEmail, "| source: apollo")
          } else if (!myemailverifierKey && !kickboxKey) {
            selectedEmail = apollo.email.toLowerCase()
            emailSource = "apollo"
            console.log("[Step 6] Apollo email accepted (no verifier configured):", selectedEmail)
          }
        }
      } catch (e: any) {
        await logDebug(db, userId, "apollo", { firstName, lastName }, { error: String(e?.message || e) }, 500)
        console.log("[Step 6] Apollo failed —", e?.message)
      }
    } else if (!selectedEmail) {
      console.log("[Step 6] Skipped (no Apollo key)")
    }

    // ════════════════════════════════════════════════════════════════════════
    // Step 7 — FullEnrich (last resort, only if Steps 3-6 found nothing)
    // ════════════════════════════════════════════════════════════════════════
    if (!selectedEmail && fullenrichKey && linkedinUrl) {
      console.log("[Step 7] All prior steps failed — calling FullEnrich as last resort")
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

        console.log("[Step 7] FullEnrich result — email:", selectedEmail || "none — refunding credit")

        if (!selectedEmail) {
          await refundCredit(db, userId)
          console.log("[Step 7] No email from FullEnrich — credit refunded")
        }
      } catch (e: any) {
        enrichRaw = { error: String(e?.message || e) }
        enrichStatus = 500
        fullenrichFailed = true
        console.log("[Step 7] FullEnrich failed —", e?.message, "— refunding credit")
        await refundCredit(db, userId)
      } finally {
        await logDebug(
          db, userId, "fullenrich_v2",
          { linkedin_url: linkedinUrl, company_hint: companyHint },
          enrichRaw, enrichStatus
        )
      }
    } else if (!selectedEmail) {
      if (!fullenrichKey) {
        console.log("[Step 7] Skipped (no FullEnrich key)")
      } else {
        console.log("[Step 7] Skipped (no LinkedIn URL)")
      }
      // No FullEnrich and no email from Steps 3-6 — refund credit
      await refundCredit(db, userId)
      console.log("[Step 7] No providers returned email — credit refunded")
    }

    // ════════════════════════════════════════════════════════════════════════
    // Determine status and save result
    // ════════════════════════════════════════════════════════════════════════
    const found = !!selectedEmail
    const emailStatus = selectedEmail
      ? emailAcceptAll
        ? "uncertain"
        : "found"
      : "not_found"

    console.log(
      "[FINAL] status:", found ? "found" : "not_found",
      "| email:", selectedEmail || "none",
      "| source:", emailSource || "none"
    )

    // Save to saved_profiles if we have a LinkedIn URL
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
