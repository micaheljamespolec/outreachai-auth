import { createClient } from "jsr:@supabase/supabase-js@2"

const GEMINI_KEY    = Deno.env.get('GEMINI_API_KEY') ?? ''
const SUPABASE_URL  = Deno.env.get('SUPABASE_URL')!
const SERVICE_KEY   = Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!

// Models to try in order — if one is rate-limited, fall back to the next
const MODELS = [
  'gemini-2.0-flash',
  'gemini-1.5-flash',
  'gemini-2.0-flash-lite',
]

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers: cors() })

  // ── Auth guard ────────────────────────────────────────────────────────────
  const authHeader = req.headers.get('Authorization') || ''
  const token = authHeader.replace(/^Bearer\s+/i, '').trim()
  if (!token) return error('Session expired — please sign in again.', 401)
  const db = createClient(SUPABASE_URL, SERVICE_KEY)
  const { data: { user }, error: authErr } = await db.auth.getUser(token)
  if (authErr || !user) return error('Session expired — please sign in again.', 401)

  try {
    const { profile, job, recruiter } = await req.json()
    const prompt = buildPrompt(profile, job, recruiter)
    console.log('Generating draft for:', profile?.firstName, profile?.lastName)

    if (!GEMINI_KEY) {
      console.error('GEMINI_API_KEY is not set')
      return error('AI service not configured. Set GEMINI_API_KEY in Supabase Edge Function secrets.', 503)
    }

    // Try each model — if rate-limited, move to the next
    for (const model of MODELS) {
      console.log(`Trying model: ${model}`)

      // Up to 2 attempts per model with backoff
      for (let attempt = 0; attempt < 2; attempt++) {
        if (attempt > 0) {
          await new Promise(r => setTimeout(r, 4000))
        }

        const res = await fetch(
          `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${GEMINI_KEY}`,
          {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
              contents: [{ parts: [{ text: prompt }] }],
              generationConfig: {
                temperature: 0.7,
                maxOutputTokens: 512,
              },
            }),
          }
        )

        if (res.status === 429) {
          console.log(`${model} returned 429 (attempt ${attempt + 1})`)
          continue  // retry this model or move to next
        }

        if (!res.ok) {
          const text = await res.text()
          console.error(`${model} error:`, res.status, text)
          // If not a rate limit, it's a real error — try next model
          break
        }

        // Success!
        const data = await res.json()
        const raw = data?.candidates?.[0]?.content?.parts?.[0]?.text ?? ''
        console.log(`${model} responded, length:`, raw.length)

        let subject = '', body = raw
        try {
          const jsonStr = raw.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim()
          const parsed = JSON.parse(jsonStr)
          subject = parsed.subject ?? ''
          body    = parsed.body ?? raw
        } catch {
          console.log('Response was not JSON, using raw text')
        }

        return new Response(
          JSON.stringify({ draft: body, subject }),
          { headers: { ...cors(), 'Content-Type': 'application/json' } }
        )
      }
    }

    // All models exhausted
    return error('AI rate limit reached across all models. Please wait a minute and try again.', 429)
  } catch (e) {
    console.error('generate-draft error:', e.message)
    return error(e.message, 500)
  }
})

function buildPrompt(profile: any, job: any, recruiter: any) {
  const jobText = [job?.title, job?.company, job?.description].filter(Boolean).join(' | ')
  return `You are an expert recruiter writing professional outreach emails to potential candidates.

Candidate LinkedIn Profile:
- Name: ${profile?.firstName ?? ''} ${profile?.lastName ?? ''}
- Current Title: ${profile?.title ?? 'Unknown'}
- Current Company: ${profile?.company ?? 'Unknown'}

Job Opening: ${jobText || 'Not specified'}
Recruiter: ${recruiter?.name ?? ''}, ${recruiter?.title ?? ''}

Write a concise, personalized recruiter outreach email:
1. Open with a warm, personalized reference to their current role
2. Briefly introduce the opportunity
3. Highlight 1-2 reasons why they specifically are a great fit
4. Be conversational and 150-200 words max
5. End with a soft call-to-action

Respond ONLY with valid JSON (no markdown, no backticks):
{"subject": "Email subject line", "body": "Full email body"}`
}

function cors() {
  return {
    'Access-Control-Allow-Origin':  '*',
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
