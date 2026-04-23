import { createClient } from "jsr:@supabase/supabase-js@2"

const FULLENRICH_KEY    = Deno.env.get('FULLENRICH_API_KEY') ?? ''
const SUPABASE_URL      = Deno.env.get('SUPABASE_URL') ?? ''
const SUPABASE_SERVICE_KEY = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY') ?? ''

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') {
    return new Response('ok', { headers: cors() })
  }

  // ── Auth guard ────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') ?? ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return error('Session expired — please sign in again.', 401)
  const db = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY)
  const { data: { user }, error: authErr } = await db.auth.getUser(token)
  if (authErr || !user) return error('Session expired — please sign in again.', 401)
  const userId = user.id

  try {
    const { firstName, lastName, linkedinUrl, company } = await req.json()
    if (!firstName && !lastName && !linkedinUrl) return error('Missing name or LinkedIn URL', 400)
    console.log('Received:', { firstName, lastName, company, linkedinUrl, userId })

    // ── Check cache first ─────────────────────────────────────────────────
    if (linkedinUrl) {
      const cacheRes = await fetch(
        `${SUPABASE_URL}/rest/v1/candidates?linkedin_url=eq.${encodeURIComponent(linkedinUrl)}&email_found=eq.true&order=looked_up_at.desc&limit=1`,
        { headers: serviceHeaders() }
      )
      if (cacheRes.ok) {
        const cached = await cacheRes.json()
        if (cached?.length > 0 && cached[0].email) {
          console.log('Cache hit for:', linkedinUrl, '→', cached[0].email)
          return new Response(
            JSON.stringify({ email: cached[0].email, source: 'cache', found: true }),
            { headers: { ...cors(), 'Content-Type': 'application/json' } }
          )
        }
      }
    }

    // ── Deduct credit server-side before calling FullEnrich ───────────────
    const deductRes = await fetch(
      `${SUPABASE_URL}/rest/v1/rpc/deduct_credit`,
      {
        method: 'POST',
        headers: serviceHeaders(),
        body: JSON.stringify({ p_user_id: userId }),
      }
    )
    if (deductRes.ok) {
      const allowed = await deductRes.json()
      if (allowed === false) {
        return error('Credit limit reached. Upgrade your plan for more lookups.', 402)
      }
    }
    console.log('Credit deducted for user:', userId)

    // ── Call FullEnrich ──────────────────────────────────────────────────────────
    const contactData: Record<string, any> = { enrich_fields: ['contact.emails'] }
    if (firstName) contactData.first_name = firstName
    if (lastName) contactData.last_name = lastName
    if (linkedinUrl) contactData.linkedin_url = linkedinUrl
    if (company) contactData.company_name = company

    const enrichRes = await fetch('https://app.fullenrich.com/api/v2/contact/enrich/bulk', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${FULLENRICH_KEY}`,
      },
      body: JSON.stringify({
        name: `${firstName || ''} ${lastName || ''}`.trim() || 'lookup',
        data: [contactData],
      }),
    })

    console.log('FullEnrich status:', enrichRes.status)
    if (!enrichRes.ok) {
      const text = await enrichRes.text()
      return error(`FullEnrich enrich failed: ${enrichRes.status} ${text}`, 502)
    }

    const enrichData = await enrichRes.json()
    const enrichmentId = enrichData?.id ?? enrichData?.enrichment_id
    console.log('Enrichment response:', JSON.stringify(enrichData))
    console.log('Enrichment ID:', enrichmentId)

    if (!enrichmentId) return error('No enrichment ID returned', 502)

    // ── Poll for result ───────────────────────────────────────────────────
    let email = ''
    for (let i = 0; i < 12; i++) {
      await new Promise(r => setTimeout(r, 5000))

      const pollRes = await fetch(`https://app.fullenrich.com/api/v2/contact/enrich/bulk/${enrichmentId}`, {
        headers: { 'Authorization': `Bearer ${FULLENRICH_KEY}` },
      })

      if (!pollRes.ok) continue

      const pollData = await pollRes.json()
      console.log('Poll response:', JSON.stringify(pollData))
      if (pollData?.status !== 'FINISHED') continue

      const results = pollData?.datas ?? pollData?.data ?? []
      const firstResult = results?.[0]
      email = firstResult?.contact?.most_probable_email
        ?? firstResult?.contact?.emails?.[0]?.email
        ?? firstResult?.contact_info?.most_probable_work_email?.email
        ?? firstResult?.contact_info?.work_emails?.[0]?.email
        ?? ''
      console.log('Extracted email:', email)
      break
    }

    const found = !!email
    console.log('Email found:', email)

    // ── Save to candidates cache ──────────────────────────────────────────
    const candidateRow = {
      user_id: userId,
      first_name: firstName || null,
      last_name: lastName || null,
      full_name: `${firstName || ''} ${lastName || ''}`.trim() || null,
      title: null,
      company: company || null,
      linkedin_url: linkedinUrl || null,
      email: email || null,
      email_source: 'FullEnrich',
      email_found: found,
    }

    await fetch(`${SUPABASE_URL}/rest/v1/candidates`, {
      method: 'POST',
      headers: serviceHeaders(),
      body: JSON.stringify(candidateRow),
    }).catch(e => console.error('Failed to cache candidate:', e.message))

    return new Response(
      JSON.stringify({ email, source: 'FullEnrich', found }),
      { headers: { ...cors(), 'Content-Type': 'application/json' } }
    )
  } catch (e) {
    return error(e.message, 500)
  }
})

function serviceHeaders() {
  return {
    'Content-Type': 'application/json',
    'apikey': SUPABASE_SERVICE_KEY,
    'Authorization': `Bearer ${SUPABASE_SERVICE_KEY}`,
    'Prefer': 'return=representation',
  }
}

function cors() {
  return {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'authorization, content-type, apikey, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
  }
}

function error(msg: string, status: number) {
  return new Response(
    JSON.stringify({ error: msg }),
    { status, headers: { ...cors(), 'Content-Type': 'application/json' } }
  )
}
