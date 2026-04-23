// ─── popup.js ─────────────────────────────────────────────────────────────────
import { CONFIG } from './config.js'
import { isLoggedIn, sendMagicLink, signInWithGoogle, signInWithMicrosoft, signInWithEmailPassword, signUpWithEmailPassword, getUser, signOut, getAccessToken, resetPassword } from './core/auth.js'
import { getCreditsData, enrichAndDraft, summarizeJob, bookmarkProfile, getSavedProfiles, checkSavedProfile, saveJob, getSavedJobs, deleteJob, openUpgradePage, parseErrorMessage, isAuthError } from './core/api.js'

// ── State machine ─────────────────────────────────────────────────────────────
// States: IDLE | PREFILLED | SUBMITTING | ENRICHING | DRAFTING | SUCCESS | PARTIAL_SUCCESS | EMPTY_RESULT | AUTH_ERROR | GENERIC_ERROR
let _state = 'IDLE'
let _lastResult = null
let _linkedinUrl = null
let _isBookmarked = false
let _isGenerating = false  // double-submission guard
let _prefillAborted = false  // set to true while batch drawer is open
let _mainAppListenersBound = false

// ── Helpers ───────────────────────────────────────────────────────────────────
const $  = id => document.getElementById(id)
const qs = sel => document.querySelector(sel)
function getStorage(keys) { return new Promise(r => chrome.storage.local.get(keys, r)) }
function setStorage(obj)  { return new Promise(r => chrome.storage.local.set(obj, r)) }

// ── Theme ─────────────────────────────────────────────────────────────────────
function applyTheme(pref) {
  const dark = pref === 'dark' || (pref !== 'light' && window.matchMedia('(prefers-color-scheme: dark)').matches)
  document.body.classList.toggle('dark', dark)
  document.querySelectorAll('.theme-btn').forEach(b => b.classList.toggle('active', b.dataset.theme === (pref || 'system')))
}

// ── Tabs ──────────────────────────────────────────────────────────────────────
function setupTabs() {
  document.querySelectorAll('.tab').forEach(tab => {
    tab.addEventListener('click', () => {
      document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'))
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'))
      tab.classList.add('active')
      $(`tab-${tab.dataset.tab}`)?.classList.add('active')
    })
  })
}

// ── Status message ────────────────────────────────────────────────────────────
function setStatus(msg, type = 'info') {
  const el = $('statusMessage')
  el.textContent = msg
  el.className = type
}
function clearStatus() {
  const el = $('statusMessage')
  el.textContent = ''
  el.className = ''
  el.style.display = 'none'
}

// ── Progress dots ─────────────────────────────────────────────────────────────
function setProgress(step) {
  // step: 'enrich' | 'company' | 'draft' | 'done'
  const steps = ['enrich', 'company', 'draft']
  const idx = steps.indexOf(step)
  steps.forEach((s, i) => {
    const dot = $(`dot${s.charAt(0).toUpperCase() + s.slice(1)}`)
    const lbl = $(`lbl${s.charAt(0).toUpperCase() + s.slice(1)}`)
    if (!dot) return
    if (step === 'done') { dot.className = 'progress-dot done'; if (lbl) lbl.className = 'progress-label done' }
    else if (i < idx)   { dot.className = 'progress-dot done';  if (lbl) lbl.className = 'progress-label done' }
    else if (i === idx) { dot.className = 'progress-dot active'; if (lbl) lbl.className = 'progress-label active' }
    else                { dot.className = 'progress-dot';        if (lbl) lbl.className = 'progress-label' }
  })
}

// ── UI sections ───────────────────────────────────────────────────────────────
function showSection(id, visible = true) {
  const el = $(id)
  if (el) el.style.display = visible ? 'block' : 'none'
}

function resetToIdle() {
  showSection('progressSection', false)
  showSection('resultSummary', false)
  showSection('draftOutput', false)
  showSection('errorBox', false)
  showSection('inputSection', true)
  clearStatus()
  $('generateDraftButton').disabled = false
  $('generateDraftButton').textContent = '✨ Generate draft'
}

function showErrorBox(message, isAuth = false) {
  showSection('progressSection', false)
  showSection('resultSummary', false)
  showSection('draftOutput', false)
  const box = $('errorBox')
  box.className = isAuth ? 'auth' : ''
  box.style.display = 'block'
  $('errorMessage').textContent = message
  $('authRecoveryButton').style.display = isAuth ? 'block' : 'none'
  $('generateDraftButton').disabled = false
  $('generateDraftButton').textContent = '✨ Generate draft'
}

// ── Confidence display ────────────────────────────────────────────────────────
function renderConfidence(draftConfidence) {
  const pct = Math.round(draftConfidence * 100)
  const fill = $('confFill')
  const badge = $('confBadge')
  const note = $('confNote')
  if (!fill) return
  fill.style.width = `${pct}%`
  if (pct >= 80) {
    fill.className = 'confidence-fill high'
    badge.textContent = 'High confidence'
    badge.className = 'confidence-badge high'
    if (note) note.textContent = ''
  } else if (pct >= 60) {
    fill.className = 'confidence-fill mid'
    badge.textContent = 'Medium confidence'
    badge.className = 'confidence-badge mid'
    if (note) note.textContent = 'Draft based on partial information — review before sending.'
  } else {
    fill.className = 'confidence-fill low'
    badge.textContent = 'Low confidence'
    badge.className = 'confidence-badge low'
    if (note) note.textContent = 'Limited public signals available. Edit the draft carefully before sending.'
  }
}

// ── Result rendering ──────────────────────────────────────────────────────────
function renderResult(result) {
  const { person, confidence, draft, status } = result
  _lastResult = result

  // Result summary
  showSection('resultSummary', true)
  $('resName').textContent = person.fullName || '—'

  if (person.email) {
    $('resEmail').innerHTML = `<span class="result-value email-found">${person.email}</span>`
    $('resEmailRow').style.display = 'flex'
  } else {
    $('resEmail').textContent = person.emailStatus === 'not_found' ? 'Not found' : 'Uncertain'
    $('resEmailRow').style.display = 'flex'
  }

  if (person.company) {
    $('resCompany').textContent = person.company
    $('resCompanyRow').style.display = 'flex'
  }

  if (person.title) {
    const titleEl = $('resTitle')
    titleEl.textContent = person.title
    if (person.titleVerified === false) {
      const badge = document.createElement('span')
      badge.textContent = 'unverified'
      badge.className = 'title-badge unverified'
      titleEl.appendChild(badge)
    }
    $('resTitleRow').style.display = 'flex'
  }

  renderConfidence(confidence.draftConfidence)

  // Status messages for partial states
  if (status === 'partial') {
    if (!person.email) {
      setStatus('No work email found — draft generated from partial info.', 'warn')
    } else if (!person.title) {
      setStatus('Company found, but title is uncertain — draft keeps it general.', 'warn')
    }
  } else if (status === 'not_enough_data') {
    setStatus('Not enough reliable info to generate a strong draft.', 'warn')
    return
  }

  // Draft
  if (draft) {
    showSection('draftOutput', true)
    const subjectEl = $('draftSubjectLine')
    if (draft.subject) {
      subjectEl.innerHTML = `<strong>Subject:</strong> ${draft.subject}`
      $('draftBody').dataset.subject = draft.subject
    }
    $('draftBody').value = draft.body || ''
  }

  // Wire compose buttons
  const to = person.email || ''
  const subject = draft?.subject || `Reaching out — ${person.fullName}`
  const body = draft?.body || ''

  $('btnOpenOutlook').onclick = () => chrome.tabs.create({
    url: `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(to)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent($('draftBody').value)}`
  })
  $('btnOpenGmail').onclick = () => chrome.tabs.create({
    url: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(to)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent($('draftBody').value)}`
  })
}

// ── Candidate summary card (top of Outreach tab) ─────────────────────────────
function populateCandidateSummary(result) {
  const { person, fromCache, isBookmarked } = result
  _isBookmarked = isBookmarked ?? false

  const card = $('candidateSummary')
  if (card) card.classList.add('visible')

  const cacheBadge = $('csCacheBadge')
  if (cacheBadge) cacheBadge.style.display = fromCache ? 'inline-block' : 'none'

  $('csName').textContent = person.fullName || '—'

  const metaParts = []
  if (person.title) metaParts.push(person.title)
  if (person.company) metaParts.push(person.company)
  $('csMeta').textContent = metaParts.join(' · ')

  const emailBadge = $('csEmailBadge')
  emailBadge.textContent = ''
  if (person.email) {
    const isWork = !!person.workEmail
    const emailSpan = document.createElement('span')
    emailSpan.className = 'result-value email-found'
    emailSpan.textContent = person.email
    const typeBadge = document.createElement('span')
    typeBadge.textContent = isWork ? 'work' : 'personal'
    typeBadge.className = `email-type-badge ${isWork ? 'work' : 'personal'}`
    emailBadge.appendChild(emailSpan)
    emailBadge.appendChild(typeBadge)
  } else {
    emailBadge.textContent = person.emailStatus === 'not_found' ? 'No email found' : ''
  }

  const linkEl = $('csLinkedinLink')
  if (_linkedinUrl && linkEl) {
    linkEl.textContent = _linkedinUrl.replace('https://www.linkedin.com/', 'linkedin.com/').replace('https://linkedin.com/', 'linkedin.com/')
    linkEl.href = _linkedinUrl
    linkEl.style.display = 'inline'
  }

  updateBookmarkButton()
}

function updateBookmarkButton() {
  const btn = $('btnBookmark')
  if (!btn) return
  btn.textContent = _isBookmarked ? '✅ Saved' : '🔖 Save profile'
  btn.className = `btn btn-ghost${_isBookmarked ? ' btn-bookmark-saved' : ''}`
  btn.style.cssText = 'font-size:11px;padding:4px 9px;width:auto;'
}

// ── Profile tab: saved profiles list ─────────────────────────────────────────
async function loadSavedProfiles() {
  const listEl = $('savedProfilesList')
  if (!listEl) return
  try {
    const { profiles } = await getSavedProfiles()
    const emptyEl = $('savedProfilesEmpty')

    // Always clear stale rows first
    listEl.querySelectorAll('.saved-profile-row').forEach(el => el.remove())

    if (!profiles || profiles.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block'
      return
    }
    if (emptyEl) emptyEl.style.display = 'none'

    for (const p of profiles) {
      const row = document.createElement('div')
      row.className = 'saved-profile-row'
      const meta = p.company || p.work_email || p.personal_email || ''
      const nameSpan = document.createElement('span')
      nameSpan.className = 'saved-profile-name'
      nameSpan.textContent = p.full_name || '—'
      const metaSpan = document.createElement('span')
      metaSpan.className = 'saved-profile-meta'
      metaSpan.textContent = meta
      row.appendChild(nameSpan)
      row.appendChild(metaSpan)
      row.addEventListener('click', () => {
        _linkedinUrl = p.linkedin_url
        // Pre-fill Draft tab inputs for when user navigates there
        if ($('fullNameInput'))    $('fullNameInput').value    = p.full_name || ''
        if ($('companyHintInput')) $('companyHintInput').value = p.company   || ''
        // Update profile pill and open customize section if data is present
        updateProfilePill(p.full_name || 'LinkedIn profile detected')
        if (p.full_name || p.company) {
          const fields = $('customizeFields'); const toggle = $('customizeToggle')
          if (fields && toggle) { fields.style.display = 'block'; toggle.textContent = '▾ Customize draft' }
        }
        // Populate profile card and STAY on the Profile tab
        populateCandidateSummary({
          person: {
            fullName:      p.full_name      || '',
            email:         p.work_email || p.personal_email || null,
            workEmail:     p.work_email     || null,
            personalEmail: p.personal_email || null,
            title:         p.title          || null,
            titleVerified: p.title_verified ?? false,
            company:       p.company        || null,
            emailStatus:   p.email_status   || 'not_found',
          },
          fromCache: true,
          isBookmarked: p.is_bookmarked ?? false,
        })
      })
      listEl.appendChild(row)
    }
  } catch (e) {
    console.warn('loadSavedProfiles failed:', e)
  }
}

// ── Candidate summary + bookmark setup ───────────────────────────────────────
function setupCandidateSummary() {
  $('btnBookmark')?.addEventListener('click', async () => {
    if (!_linkedinUrl) return
    const newState = !_isBookmarked
    const btn = $('btnBookmark')
    btn.disabled = true
    try {
      await bookmarkProfile({ linkedinUrl: _linkedinUrl, save: newState })
      _isBookmarked = newState
      updateBookmarkButton()
      const statusEl = $('bookmarkStatus')
      if (statusEl) {
        statusEl.textContent = newState ? 'Profile saved to your list.' : 'Profile removed from saved list.'
        statusEl.style.color = newState ? '#16a34a' : '#9ca3af'
        setTimeout(() => { statusEl.textContent = '' }, 2500)
      }
      await loadSavedProfiles()
    } catch (e) {
      const statusEl = $('bookmarkStatus')
      if (statusEl) { statusEl.textContent = 'Could not save — try again.'; statusEl.style.color = '#dc2626' }
    } finally {
      btn.disabled = false
    }
  })

  const toggle = $('savedProfilesToggle')
  const wrap = $('savedProfilesWrap')
  if (toggle && wrap) {
    toggle.addEventListener('click', () => {
      const open = wrap.style.display !== 'none'
      wrap.style.display = open ? 'none' : 'block'
      toggle.textContent = open ? 'Saved profiles' : 'Hide saved profiles'
    })
  }

  loadSavedProfiles()
}

// ── Core flow ─────────────────────────────────────────────────────────────────
async function generateDraftFlow() {
  // Double-submission guard
  if (_isGenerating) return
  _isGenerating = true

  const companyHint    = $('companyHintInput').value.trim() || null
  const userContext    = $('userContextInput').value.trim() || null
  const fullNameHint   = $('fullNameInput').value.trim() || null

  if (!_linkedinUrl) {
    setStatus('Open a LinkedIn profile page first, then click Generate draft.', 'error')
    _isGenerating = false
    return
  }

  // Get job context for draft personalization
  const jobData = await getStorage(['job_title', 'job_company', 'job_description'])
  const contextParts = [userContext]
  if (jobData.job_title) contextParts.push(`Recruiting for: ${jobData.job_title}${jobData.job_company ? ' at ' + jobData.job_company : ''}`)
  if (jobData.job_description) contextParts.push(jobData.job_description)
  const fullContext = contextParts.filter(Boolean).join('. ') || null

  // Disable input, show progress
  _state = 'ENRICHING'
  $('generateDraftButton').disabled = true
  $('generateDraftButton').textContent = 'Working…'
  clearStatus()
  showSection('progressSection', true)
  showSection('resultSummary', false)
  showSection('draftOutput', false)
  showSection('errorBox', false)
  setProgress('enrich')

  // Simulate step transitions (progress UI while async work runs)
  const companyTimer = setTimeout(() => setProgress('company'), 5000)
  const draftTimer   = setTimeout(() => setProgress('draft'), 12000)

  try {
    const result = await enrichAndDraft({
      linkedinUrl: _linkedinUrl,
      companyHint,
      userContext: fullContext,
      fullNameHint,
    })

    clearTimeout(companyTimer)
    clearTimeout(draftTimer)
    setProgress('done')

    showSection('progressSection', false)
    _state = result.status === 'success' ? 'SUCCESS'
           : result.status === 'partial' ? 'PARTIAL_SUCCESS'
           : 'EMPTY_RESULT'

    // Populate name and company fields from FullEnrich result for recruiter reference
    if (result.person?.fullName) {
      $('fullNameInput').value = result.person.fullName
      updateProfilePill(result.person.fullName)
    }
    if (result.person?.company && !$('companyHintInput').value.trim()) {
      $('companyHintInput').value = result.person.company
    }

    renderResult(result)
    populateCandidateSummary(result)

    // Cache result by LinkedIn URL
    const cacheKey = `outreach_${_linkedinUrl.replace(/[^a-z0-9]/gi, '_').slice(-60)}`
    await setStorage({ [cacheKey]: { result, timestamp: Date.now() } })

  } catch (e) {
    clearTimeout(companyTimer)
    clearTimeout(draftTimer)
    showSection('progressSection', false)

    const err = parseErrorMessage(e)
    const auth = isAuthError(e) || isAuthError(err)

    if (auth) {
      _state = 'AUTH_ERROR'
      showErrorBox('Your session expired. Click below to sign out and sign back in.', true)
    } else {
      _state = 'GENERIC_ERROR'
      const MESSAGES = {
        NO_LINKEDIN_URL:         'Open a LinkedIn profile page to generate a draft.',
        ENRICHMENT_UNAVAILABLE:  'Contact lookup is temporarily unavailable. Please try again.',
        NO_EMAIL_FOUND:          'No work email was found. A draft can still be generated.',
        NOT_ENOUGH_DATA:         "There isn't enough reliable public information to generate a strong draft.",
        DRAFT_GENERATION_FAILED: 'Contact details were found, but the draft could not be generated.',
        CREDIT_LIMIT_REACHED:    'You have reached your lookup limit. Upgrade your plan for more enrichments.',
        CREDIT_ERROR:            'Could not verify your credit balance. Please try again.',
      }
      showErrorBox(MESSAGES[err.code] || err.message || 'Something went wrong.')
    }
  } finally {
    _isGenerating = false
  }
}

// ── Profile pill helper ───────────────────────────────────────────────────────
function updateProfilePill(label) {
  const pill = $('profilePill')
  const text = $('profilePillText')
  if (!pill || !text) return
  if (label) {
    text.textContent = label
    pill.style.display = 'flex'
  } else {
    pill.style.display = 'none'
  }
}

// ── Customize toggle helper ───────────────────────────────────────────────────
function setupCustomizeToggle() {
  const toggle = $('customizeToggle')
  const fields = $('customizeFields')
  if (!toggle || !fields) return
  toggle.addEventListener('click', () => {
    const open = fields.style.display !== 'none'
    fields.style.display = open ? 'none' : 'block'
    toggle.textContent = open ? '▸ Customize draft' : '▾ Customize draft'
  })
}

// ── Page prefill strategy ─────────────────────────────────────────────────────
function sendMessageWithTimeout(tabId, msg, ms = 3000) {
  return Promise.race([
    chrome.tabs.sendMessage(tabId, msg),
    new Promise(resolve => setTimeout(() => resolve(null), ms))
  ])
}

async function prefillFromPage() {
  if (_prefillAborted || $('batchDrawer')?.classList.contains('open')) return
  try {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
    if (!tab?.url) return

    const isLinkedInProfile = tab.url.includes('linkedin.com/in/') ||
      tab.url.includes('linkedin.com/talent/') ||
      tab.url.includes('linkedin.com/recruiter/')

    let data = null
    try {
      data = await sendMessageWithTimeout(tab.id, { type: 'scrape' })
    } catch {
      if (isLinkedInProfile) {
        await new Promise(r => setTimeout(r, 800))
        if (_prefillAborted || $('batchDrawer')?.classList.contains('open')) return
        try {
          data = await sendMessageWithTimeout(tab.id, { type: 'scrape' })
        } catch {}
      }
    }

    if (_prefillAborted || $('batchDrawer')?.classList.contains('open')) return

    // Accept any LinkedIn profile URL: standard (/in/), Recruiter (/talent/, /recruiter/), etc.
    if (data?.linkedin_url && data.linkedin_url.includes('linkedin.com/')) {
      _linkedinUrl = data.linkedin_url
      _state = 'PREFILLED'

      // Show a basic pill immediately so the user knows which profile is queued
      updateProfilePill('LinkedIn profile detected')

      // Check saved-profile cache immediately — no credit needed
      try {
        if (_prefillAborted || $('batchDrawer')?.classList.contains('open')) return
        const check = await checkSavedProfile({ linkedinUrl: _linkedinUrl })
        if (_prefillAborted || $('batchDrawer')?.classList.contains('open')) return
        if (check.found) {
          const p = check.profile
          // Pre-fill Draft tab inputs
          if (p.fullName) $('fullNameInput').value = p.fullName
          if (p.company && !$('companyHintInput').value.trim()) $('companyHintInput').value = p.company
          // Update pill to show the cached name
          if (p.fullName) updateProfilePill(p.fullName)
          // Auto-open customize section when we have pre-filled data
          const fields = $('customizeFields')
          const toggle = $('customizeToggle')
          if (fields && toggle && (p.fullName || p.company)) {
            fields.style.display = 'block'
            toggle.textContent = '▾ Customize draft'
          }
          setStatus('Saved profile detected — draft is free.', 'success')
          populateCandidateSummary({
            person: {
              fullName: p.fullName, email: p.email,
              workEmail: p.workEmail, personalEmail: p.personalEmail,
              title: p.title, titleVerified: p.titleVerified,
              company: p.company, emailStatus: p.emailStatus,
            },
            fromCache: true,
            isBookmarked: p.isBookmarked,
          })
        } else {
          setStatus('LinkedIn profile detected — ready to generate draft.', 'info')
        }
      } catch {
        if (!_prefillAborted && !$('batchDrawer')?.classList.contains('open')) {
          setStatus('LinkedIn profile detected — ready to generate draft.', 'info')
        }
      }
    } else {
      updateProfilePill(null)
    }
  } catch {}
}

// ── Credits UI ────────────────────────────────────────────────────────────────
async function loadCreditsUI() {
  try {
    const credits = await getCreditsData()
    const tier = credits?.tier ?? 'free'
    const used = credits?.lookups_used ?? 0
    const max  = CONFIG.tiers[tier]?.lookups ?? 10

    if ($('settingsEmail') && credits?.user_id) {
      const user = await getUser()
      if (user?.email) $('settingsEmail').textContent = user.email
    }
    const badge = $('settingsPlanBadge')
    if (badge) {
      badge.textContent = CONFIG.tiers[tier]?.label ?? 'Free'
      badge.className = `plan-badge${tier === 'free' ? ' free' : ''}`
    }
    if ($('settingsLookups')) $('settingsLookups').textContent = `${used} / ${max}`
  } catch {}
}

// ── Recruiter profile API helpers ─────────────────────────────────────────────
async function fetchRecruiterProfile() {
  const token = await getAccessToken()
  if (!token) return null
  try {
    const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/recruiter_profiles?select=*&limit=1`, {
      headers: {
        'apikey':        CONFIG.supabaseKey,
        'Authorization': `Bearer ${token}`,
      },
    })
    if (!res.ok) return null
    const rows = await res.json()
    return rows?.[0] ?? null
  } catch { return null }
}

async function saveRecruiterProfile({ fullName, companyName, jobTitle, hiringFocus, tone }) {
  const token = await getAccessToken()
  if (!token) throw new Error('Not authenticated')
  const user = await getUser()
  if (!user?.id) throw new Error('No user')

  const payload = {
    user_id:      user.id,
    full_name:    fullName,
    company_name: companyName,
    job_title:    jobTitle || null,
    hiring_focus: hiringFocus || null,
    tone:         tone || null,
    updated_at:   new Date().toISOString(),
  }

  const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/recruiter_profiles?on_conflict=user_id`, {
    method: 'POST',
    headers: {
      'apikey':        CONFIG.supabaseKey,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Prefer':        'resolution=merge-duplicates,return=representation',
    },
    body: JSON.stringify(payload),
  })
  if (!res.ok) {
    const err = await res.json().catch(() => ({}))
    throw new Error(err.message || err.hint || 'Failed to save profile')
  }
  const rows = await res.json()
  return rows?.[0] ?? null
}

// ── Onboarding ────────────────────────────────────────────────────────────────
let _onboardingStep = 1
let _onboardingData = {}

function setOnboardingStep(step) {
  _onboardingStep = step
  document.querySelectorAll('.onboarding-step').forEach(el => el.classList.remove('active'))
  $(`onboardingStep${step}`)?.classList.add('active')

  // Update step dots
  const dot1 = $('stepDot1'), dot2 = $('stepDot2')
  if (step === 1) {
    if (dot1) { dot1.className = 'step-dot active' }
    if (dot2) { dot2.className = 'step-dot' }
  } else {
    if (dot1) { dot1.className = 'step-dot done' }
    if (dot2) { dot2.className = 'step-dot active' }
  }

  const statusEl = $('onboardingStatus')
  if (statusEl) { statusEl.textContent = ''; statusEl.className = '' }
}

function showOnboardingScreen() {
  $('loginScreen').style.display = 'none'
  $('mainApp').style.display = 'none'
  $('onboardingScreen').style.display = 'block'
  setOnboardingStep(1)
}

// _onboardingComplete stores the most-recent completion callback so the
// bound (single) handlers can call it even after being set up once.
let _onboardingComplete = null

function setupOnboarding(onComplete) {
  _onboardingComplete = onComplete

  if (_onboardingListenersBound) return
  _onboardingListenersBound = true

  $('btnOnboardingNext')?.addEventListener('click', () => {
    const fullName    = $('obFullName').value.trim()
    const companyName = $('obCompanyName').value.trim()
    const statusEl    = $('onboardingStatus')

    if (!fullName || !companyName) {
      statusEl.textContent = 'Full name and company are required.'
      statusEl.className = 'error'
      return
    }

    _onboardingData = { fullName, companyName }
    setOnboardingStep(2)
  })

  async function finishOnboarding(skip = false) {
    const statusEl = $('onboardingStatus')
    statusEl.textContent = 'Saving…'
    statusEl.className = 'info'

    try {
      await saveRecruiterProfile({
        fullName:    _onboardingData.fullName,
        companyName: _onboardingData.companyName,
        jobTitle:    skip ? null : ($('obJobTitle').value.trim() || null),
        hiringFocus: skip ? null : ($('obHiringFocus').value || null),
        tone:        skip ? null : ($('obTone').value || null),
      })
      $('onboardingScreen').style.display = 'none'
      if (_onboardingComplete) _onboardingComplete()
    } catch (e) {
      statusEl.textContent = e.message || 'Could not save profile — try again.'
      statusEl.className = 'error'
    }
  }

  $('btnOnboardingFinish')?.addEventListener('click', () => finishOnboarding(false))
  $('btnOnboardingSkip')?.addEventListener('click',   () => finishOnboarding(true))
}

// ── Login / Onboarding screen listener guards ─────────────────────────────────
// Guards ensure event listeners are bound only once per popup session,
// preventing duplicate submissions if the screen is shown more than once.
let _loginListenersBound = false
let _onboardingListenersBound = false

function showLoginScreen() {
  getStorage(['pref_theme']).then(d => applyTheme(d.pref_theme || 'system'))
  $('loginScreen').style.display = 'block'
  $('onboardingScreen').style.display = 'none'
  $('mainApp').style.display = 'none'

  // Reset to options view whenever login screen is shown
  $('authOptions').style.display = 'block'
  $('emailPasswordForm').style.display = 'none'
  $('forgotPasswordForm').style.display = 'none'
  $('magicLinkForm').style.display = 'none'
  const authErrEl = $('authError')
  if (authErrEl) { authErrEl.style.display = 'none'; authErrEl.textContent = '' }

  if (_loginListenersBound) return
  _loginListenersBound = true

  // Google
  $('btnGoogleSignin').addEventListener('click', () => signInWithGoogle())

  // Microsoft
  $('btnMicrosoftSignin').addEventListener('click', () => signInWithMicrosoft())

  // Email + Password
  $('btnShowEmailPassword').addEventListener('click', () => {
    $('authOptions').style.display = 'none'
    $('emailPasswordForm').style.display = 'block'
  })

  $('backFromEmailPassword').addEventListener('click', () => {
    $('emailPasswordForm').style.display = 'none'
    $('authOptions').style.display = 'block'
    $('epStatus').textContent = ''
    $('epStatus').className = ''
    const ae = $('authError')
    if (ae) { ae.style.display = 'none'; ae.textContent = '' }
  })

  $('btnForgotPassword').addEventListener('click', () => {
    $('emailPasswordForm').style.display = 'none'
    $('forgotPasswordForm').style.display = 'block'
    const fpEmail = $('fpEmail')
    if (fpEmail) fpEmail.value = $('epEmail').value
    $('fpStatus').textContent = ''
  })

  $('backFromForgotPassword').addEventListener('click', () => {
    $('forgotPasswordForm').style.display = 'none'
    $('emailPasswordForm').style.display = 'block'
    $('fpStatus').textContent = ''
  })

  $('btnSendReset').addEventListener('click', async () => {
    const email = $('fpEmail').value.trim()
    const fpStatus = $('fpStatus')
    if (!email) {
      fpStatus.textContent = 'Enter your email address.'
      fpStatus.style.color = '#dc2626'
      return
    }
    $('btnSendReset').disabled = true
    fpStatus.textContent = 'Sending reset link…'
    fpStatus.style.color = '#6b7280'
    const { error } = await resetPassword(email)
    $('btnSendReset').disabled = false
    if (error) {
      fpStatus.textContent = error.message
      fpStatus.style.color = '#dc2626'
    } else {
      fpStatus.textContent = 'Check your email — reset link sent!'
      fpStatus.style.color = '#16a34a'
    }
  })

  let isSignUp = false
  $('toggleSignUp').addEventListener('click', () => {
    isSignUp = !isSignUp
    $('btnEmailPasswordSignin').textContent = isSignUp ? 'Create account' : 'Sign in'
    $('toggleSignUp').textContent = isSignUp ? 'Already have an account? Sign in' : 'No account? Create one'
    const fpBtn = $('btnForgotPassword')
    if (fpBtn) fpBtn.style.display = isSignUp ? 'none' : ''
    $('epStatus').textContent = ''
  })

  $('btnEmailPasswordSignin').addEventListener('click', async () => {
    const email    = $('epEmail').value.trim()
    const password = $('epPassword').value
    const statusEl = $('epStatus')

    if (!email || !password) {
      statusEl.textContent = 'Enter your email and password.'
      statusEl.style.color = '#dc2626'
      return
    }

    $('btnEmailPasswordSignin').disabled = true
    statusEl.textContent = isSignUp ? 'Creating account…' : 'Signing in…'
    statusEl.style.color = '#6b7280'

    const fn = isSignUp ? signUpWithEmailPassword : signInWithEmailPassword
    const { session, error, confirmEmail } = await fn(email, password)

    $('btnEmailPasswordSignin').disabled = false

    if (error) {
      statusEl.textContent = error.message
      statusEl.style.color = '#dc2626'
      return
    }

    if (confirmEmail) {
      statusEl.textContent = 'Check your email to confirm your account.'
      statusEl.style.color = '#0a66c2'
      return
    }

    if (session) {
      await handlePostLogin()
    }
  })

  // Magic link
  const mlStatus = $('loginStatus')
  $('btnShowMagicLink').addEventListener('click', () => {
    $('authOptions').style.display = 'none'
    $('magicLinkForm').style.display = 'block'
  })

  $('backFromMagicLink').addEventListener('click', () => {
    $('magicLinkForm').style.display = 'none'
    $('authOptions').style.display = 'block'
    if (mlStatus) { mlStatus.textContent = ''; mlStatus.className = '' }
  })

  $('btnSendMagicLink').addEventListener('click', async () => {
    const email = $('loginEmail').value.trim()
    if (!email) { mlStatus.textContent = 'Enter your email first.'; mlStatus.style.color = '#dc2626'; return }
    mlStatus.textContent = 'Sending magic link…'
    mlStatus.style.color = '#6b7280'
    const { error } = await sendMagicLink(email)
    if (error) { mlStatus.textContent = `Error: ${error.message}`; mlStatus.style.color = '#dc2626' }
    else       { mlStatus.textContent = 'Check your email — link sent!'; mlStatus.style.color = '#16a34a' }
  })
}

// ── Post-login: check onboarding status via DB function ──────────────────────
// Calls is_first_time_user() which uses auth.uid() internally — no arg needed.
async function isFirstTimeUser() {
  let token = null
  for (let i = 0; i < 6; i++) {
    token = await getAccessToken()
    if (token) break
    await new Promise(r => setTimeout(r, 500))
  }
  if (!token) throw new Error('Not authenticated — token not available after login')
  const res = await fetch(`${CONFIG.supabaseUrl}/rest/v1/rpc/is_first_time_user`, {
    method: 'POST',
    headers: {
      'apikey':        CONFIG.supabaseKey,
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({}),
  })
  if (!res.ok) {
    if (res.status === 401) {
      await signOut()
    }
    const body = await res.text()
    throw new Error(`Onboarding check failed (${res.status}): ${body}`)
  }
  const result = await res.json()
  return result === true
}

async function handlePostLogin() {
  const prefs = await getStorage(['pref_theme'])
  applyTheme(prefs.pref_theme || 'system')

  const user = await getUser()

  let needsOnboarding = false
  try {
    needsOnboarding = await isFirstTimeUser()
  } catch (e) {
    console.error('Onboarding check error:', e.message)
    if (e.message.includes('401') || e.message.includes('Not authenticated')) {
      showLoginScreen()
      const errEl = $('authError')
      if (errEl) {
        errEl.textContent = 'Could not verify your account status — please try signing in again.'
        errEl.style.display = 'block'
      }
      return
    }
    needsOnboarding = false
  }

  if (needsOnboarding) {
    showOnboardingScreen()
    setupOnboarding(() => showMainApp(user))
  } else {
    await showMainApp(user)
  }
}

// ── Main app ──────────────────────────────────────────────────────────────────
async function showMainApp(user) {
  const prefs = await getStorage(['pref_theme'])
  applyTheme(prefs.pref_theme || 'system')
  $('loginScreen').style.display = 'none'
  $('onboardingScreen').style.display = 'none'
  $('mainApp').style.display = 'block'

  setupTabs()
  setupCustomizeToggle()
  await loadCreditsUI()

  await prefillFromPage()

  if (!_mainAppListenersBound) {
    _mainAppListenersBound = true

    $('generateDraftButton').addEventListener('click', () => generateDraftFlow())

    $('fullNameInput').addEventListener('keydown', e => {
      if (e.key === 'Enter') { e.preventDefault(); generateDraftFlow() }
    })

    $('clearButton').addEventListener('click', async () => {
      $('fullNameInput').value = ''
      $('companyHintInput').value = ''
      $('userContextInput').value = ''
      _linkedinUrl = null
      updateProfilePill(null)
      const fields = $('customizeFields'); const toggle = $('customizeToggle')
      if (fields && toggle) { fields.style.display = 'none'; toggle.textContent = '▸ Customize draft' }
      resetToIdle()
      await prefillFromPage()
    })

    $('retryButton')?.addEventListener('click', () => generateDraftFlow())
    $('retryButton2')?.addEventListener('click', () => {
      showSection('errorBox', false)
      $('authRecoveryButton').style.display = 'none'
      generateDraftFlow()
    })

    $('authRecoveryButton')?.addEventListener('click', async () => {
      await signOut()
      showLoginScreen()
    })

    $('btnCopyDraft')?.addEventListener('click', () => {
      const text = $('draftBody').value
      if (!text) return
      navigator.clipboard.writeText(text).then(() => {
        const btn = $('btnCopyDraft')
        btn.textContent = '✓ Copied'
        setTimeout(() => { btn.textContent = '📋 Copy draft' }, 2000)
      })
    })

    await setupSettingsTab(user)
    setupJobTab()
    setupCandidateSummary()

    $('batchDrawerClose')?.addEventListener('click', () => {
      _prefillAborted = false
      prefillFromPage()
    })

    const campaignsTab = $('campaignsTab')
    if (campaignsTab) {
      let _batchModule = null
      campaignsTab.addEventListener('click', async () => {
        _prefillAborted = true
        if (!_batchModule) {
          _batchModule = await import('./batch.js')
          _batchModule.initBatch()
        }
        _batchModule.openBatchDrawer()
      })
    }
  }
}

// ── Job tab: saved jobs list ───────────────────────────────────────────────────
// Activate a saved-job row and populate fields (shared by auto-restore and row click)
function _activateSavedJobRow(row, j, allRows, showStatus = false) {
  allRows.forEach(r => r.classList.remove('active'))
  row.classList.add('active')
  if ($('jobTitle'))       $('jobTitle').value       = j.role_title || ''
  if ($('jobCompany'))     $('jobCompany').value     = j.company    || ''
  if ($('jobDescription')) $('jobDescription').value = j.highlights || ''
  if ($('jobUrl'))         $('jobUrl').value         = j.job_url    || ''
  if ($('jobLabel'))       $('jobLabel').value       = j.label
  if (showStatus) {
    const statusEl = $('jobStatus')
    if (statusEl) {
      statusEl.textContent = `"${j.label}" loaded.`
      statusEl.style.color = '#16a34a'
      setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = '' }, 2000)
    }
  }
}

async function loadSavedJobs() {
  const listEl = $('savedJobsList')
  if (!listEl) return
  try {
    const [{ jobs }, stored] = await Promise.all([
      getSavedJobs(),
      getStorage(['saved_job_last_id']),
    ])
    const lastId = stored.saved_job_last_id || null
    const emptyEl = $('savedJobsEmpty')

    // Clear stale rows
    listEl.querySelectorAll('.saved-job-row').forEach(el => el.remove())

    if (!jobs || jobs.length === 0) {
      if (emptyEl) emptyEl.style.display = 'block'
      return
    }
    if (emptyEl) emptyEl.style.display = 'none'

    const renderedRows = []

    for (const j of jobs) {
      const row = document.createElement('div')
      row.className = 'saved-job-row'
      row.dataset.jobId = j.id

      const labelSpan = document.createElement('span')
      labelSpan.className = 'saved-job-label'
      labelSpan.textContent = j.label

      const companySpan = document.createElement('span')
      companySpan.className = 'saved-job-company'
      companySpan.textContent = j.company || ''

      const delBtn = document.createElement('button')
      delBtn.className = 'saved-job-delete'
      delBtn.title = 'Delete this saved job'
      delBtn.textContent = '✕'
      delBtn.addEventListener('click', async e => {
        e.stopPropagation()
        delBtn.disabled = true
        try {
          await deleteJob({ jobId: j.id })
          // Re-read current last-used ID at delete time (not stale captured value)
          const cur = await getStorage(['saved_job_last_id'])
          if (cur.saved_job_last_id === j.id) await setStorage({ saved_job_last_id: null })
          await loadSavedJobs()
        } catch {
          delBtn.disabled = false
        }
      })

      row.appendChild(labelSpan)
      row.appendChild(companySpan)
      row.appendChild(delBtn)

      row.addEventListener('click', async () => {
        _activateSavedJobRow(row, j, renderedRows, true)
        await setStorage({
          job_title:         j.role_title || '',
          job_company:       j.company    || '',
          job_description:   j.highlights || '',
          job_url:           j.job_url    || '',
          saved_job_last_id: j.id,
        })
      })

      listEl.appendChild(row)
      renderedRows.push(row)
    }

    // Auto-restore: if we have a last-used ID that matches a fetched job, activate it silently
    // Also re-write job_* to local storage to guard against stale state across devices/sessions
    if (lastId) {
      const idx = jobs.findIndex(j => j.id === lastId)
      if (idx !== -1) {
        const j = jobs[idx]
        _activateSavedJobRow(renderedRows[idx], j, renderedRows, false)
        await setStorage({
          job_title:         j.role_title || '',
          job_company:       j.company    || '',
          job_description:   j.highlights || '',
          job_url:           j.job_url    || '',
        })
      }
    }
  } catch (e) {
    console.warn('loadSavedJobs failed:', e)
  }
}

// ── Job tab ───────────────────────────────────────────────────────────────────
function setupJobTab() {
  getStorage(['job_title','job_company','job_description','job_url']).then(d => {
    if (d.job_title)       $('jobTitle').value       = d.job_title
    if (d.job_company)     $('jobCompany').value     = d.job_company
    if (d.job_description) $('jobDescription').value = d.job_description
    if (d.job_url)         $('jobUrl').value         = d.job_url
  })

  // Load saved jobs list on init
  loadSavedJobs()

  $('btnExtractJob').addEventListener('click', async () => {
    const url = $('jobUrl').value.trim()
    const statusEl = $('extractStatus')
    if (!url || !url.startsWith('http')) { statusEl.textContent = 'Enter a valid URL.'; return }
    const btn = $('btnExtractJob')
    btn.disabled = true
    statusEl.textContent = 'Fetching job details…'
    statusEl.style.color = '#6b7280'
    // Hide any previous expired warning
    const expiredWarn = $('jobExpiredWarning')
    if (expiredWarn) expiredWarn.style.display = 'none'

    const DIRECTS = { 'google.com': 'Google', 'amazon.jobs': 'Amazon', 'microsoft.com': 'Microsoft', 'apple.com': 'Apple', 'meta.com': 'Meta', 'netflix.com': 'Netflix', 'stripe.com': 'Stripe', 'openai.com': 'OpenAI' }
    const BOARDS  = ['greenhouse.io','lever.co','workday.com','myworkdayjobs.com','jobvite.com','smartrecruiters.com','ashbyhq.com','linkedin.com']
    const GENERIC = /^(job details?|job description|apply( now)?|about this role|overview|open role|career opportunity|careers|current opening|job posting|view job|find your dream job)$/i

    // ── Step 1: Instant pre-fill from URL slug & hostname ─────────────────────
    let preTitle = '', preCompany = ''
    try {
      const parsedHost = new URL(url).hostname.replace(/^www\./, '')
      for (const [d, n] of Object.entries(DIRECTS)) { if (parsedHost.includes(d)) { preCompany = n; break } }
      const slugPart = [...url.split('/')].reverse().find(p => /[a-zA-Z]/.test(p) && p.includes('-'))
      if (slugPart) preTitle = slugPart.replace(/^\d+-/, '').replace(/[-_]/g, ' ').trim().replace(/\b\w/g, c => c.toUpperCase())
    } catch {}
    if (preTitle)   $('jobTitle').value   = preTitle
    if (preCompany) $('jobCompany').value = preCompany

    // ── Step 2: Fetch HTML via background service worker (MV3 CSP compliant) ──
    try {
      const response = await new Promise(resolve =>
        chrome.runtime.sendMessage({ type: 'FETCH_URL', url }, resolve)
      )
      if (!response?.ok) throw new Error(response?.error || 'Fetch failed')
      const html = response.html
      const doc = new DOMParser().parseFromString(html, 'text/html')

      // JSON-LD (best source — Google Careers, Greenhouse, Lever, Ashby all include this)
      let ldTitle = '', ldCompany = '', ldDescription = ''
      for (const s of doc.querySelectorAll('script[type="application/ld+json"]')) {
        let data; try { data = JSON.parse(s.textContent) } catch { continue }
        const nodes = data?.['@graph'] ? data['@graph'] : [data]
        const job = nodes.find(n => n?.['@type'] === 'JobPosting')
        if (job) {
          ldTitle   = (job.title || '').trim()
          ldCompany = (job.hiringOrganization?.name || '').trim()
          const tmp = document.createElement('div')
          tmp.innerHTML = job.description || ''
          ldDescription = (tmp.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 600)
          break
        }
      }

      // Meta tag fallbacks
      const ogTitle   = doc.querySelector('meta[property="og:title"]')?.getAttribute('content')?.trim() || ''
      const ogSite    = doc.querySelector('meta[property="og:site_name"]')?.getAttribute('content')?.trim() || ''
      const pageTitle = doc.title?.trim() || ''

      // Body text fallback (for description only)
      const mainEl = doc.querySelector('main, article, [role="main"], #main-content') || doc.body
      const NAV = /^(home|menu|skip|search|sign in|sign up|login|log in|careers|jobs|apply|share|back|next|prev|navigation|cookie|privacy|terms|©|\d{4})$/i
      const bodyLines = (mainEl?.textContent || '').split('\n').map(l => l.trim()).filter(l => l.length > 40 && !NAV.test(l))
      const bodyText  = bodyLines.join(' ')
      const anchor    = bodyText.search(/minimum qualifications|about the job|about this role|responsibilities|what you.ll do|job summary/i)
      const bodyDesc  = (anchor > -1 ? bodyText.slice(anchor) : bodyText).slice(0, 600)

      // ── Detect expired / unavailable job postings ──────────────────────────
      // Check page title + body for common "job gone" signals
      const EXPIRED_TITLE = /^(jobs? search|job not found|page not found|404|no longer available|position filled|job closed|expired|error)$/i
      const EXPIRED_BODY  = /this (job|position|role|posting|listing) (is |has been )?(no longer available|closed|filled|expired|removed|taken down)|job (not found|has expired)|this page (could not|can.t) be found|no longer accepting applications/i
      const titleToCheck  = ldTitle || ogTitle || pageTitle
      const isExpired = EXPIRED_TITLE.test(titleToCheck.trim()) || EXPIRED_BODY.test(bodyText.slice(0, 1000))

      if (isExpired) {
        $('jobTitle').value = ''
        $('jobCompany').value = preCompany || ''
        $('jobDescription').value = ''
        statusEl.textContent = ''
        statusEl.style.color = ''
        // Show a warning banner instead
        const warn = $('jobExpiredWarning')
        if (warn) warn.style.display = 'block'
        btn.disabled = false
        return
      }

      // Hide expired warning if previously shown
      const warn = $('jobExpiredWarning')
      if (warn) warn.style.display = 'none'

      // Strip trailing " | Site" or " — Site" but NOT hyphens within the title (e.g. "Fixed-Term")
      const stripSuffix = s => s.replace(/\s+[|–—]\s+[^|–—]+$/, '').replace(/\s+-\s+\S.*$/, '').trim()

      // ── Resolve best title ─────────────────────────────────────────────────
      let bestTitle = ''
      if (ldTitle && !GENERIC.test(ldTitle)) bestTitle = ldTitle
      if (!bestTitle && ogTitle) bestTitle = stripSuffix(ogTitle)
      if (!bestTitle && pageTitle) bestTitle = stripSuffix(pageTitle)
      if (bestTitle && !GENERIC.test(bestTitle)) $('jobTitle').value = bestTitle

      // ── Resolve best company ───────────────────────────────────────────────
      if (ldCompany) $('jobCompany').value = ldCompany
      else if (ogSite && !BOARDS.some(b => url.includes(b))) $('jobCompany').value = ogSite

      // ── Description: set raw first, then summarize via Claude ────────────
      const rawDesc = ldDescription || bodyDesc
      $('jobDescription').value = rawDesc

      const titleForSummary   = $('jobTitle').value.trim()
      const companyForSummary = $('jobCompany').value.trim()

      statusEl.textContent = 'Details extracted — review and save.'
      btn.disabled = false

      // Kick off summarization in background — don't block the UI
      if (rawDesc || titleForSummary) {
        statusEl.textContent = 'Summarizing highlights…'
        try {
          const { summary } = await summarizeJob({
            rawText:  rawDesc,
            jobTitle: titleForSummary,
            company:  companyForSummary,
          })
          if (summary) $('jobDescription').value = summary
          statusEl.textContent = 'Details extracted — review and save.'
        } catch {
          statusEl.textContent = 'Details extracted — review and save.'
        }
      }

      return  // btn already re-enabled above
    } catch (e) {
      // Friendly message for fetch timeout (AbortController fired)
      const isTimeout = e?.name === 'AbortError' || e?.message?.includes('aborted') || e?.message?.includes('signal')
      const timeoutMsg = 'Request timed out — the page took too long to load. Try a direct job board link.'
      statusEl.textContent = isTimeout ? timeoutMsg : (preTitle ? 'Details extracted from URL — review and save.' : `Could not load the page. Try a different URL.`)
    }
    btn.disabled = false
  })

  $('btnSaveJob').addEventListener('click', async () => {
    const title      = $('jobTitle').value.trim()
    const company    = $('jobCompany').value.trim()
    const highlights = $('jobDescription').value.trim()
    const jobUrl     = $('jobUrl').value.trim()
    const label      = $('jobLabel').value.trim() || (title ? `${title}${company ? ' — ' + company : ''}` : '')

    if (!label) { $('jobStatus').textContent = 'Add a role title or label first.'; $('jobStatus').style.color = '#dc2626'; return }

    const btn = $('btnSaveJob')
    btn.disabled = true
    $('jobStatus').textContent = 'Saving…'
    $('jobStatus').style.color = '#6b7280'

    try {
      const { job } = await saveJob({ label, jobUrl: jobUrl || null, roleTitle: title || null, company: company || null, highlights: highlights || null })

      // Persist locally so draft flow picks it up, and mark as last-used
      await setStorage({
        job_title:           title,
        job_company:         company,
        job_description:     highlights,
        job_url:             jobUrl,
        saved_job_last_id:   job?.id || null,
      })

      $('jobStatus').textContent = 'Job saved!'
      $('jobStatus').style.color = '#16a34a'
      setTimeout(() => { $('jobStatus').textContent = ''; $('jobStatus').style.color = '' }, 2500)
      await loadSavedJobs()
    } catch (e) {
      $('jobStatus').textContent = 'Could not save — try again.'
      $('jobStatus').style.color = '#dc2626'
    } finally {
      btn.disabled = false
    }
  })
}

// ── Settings tab ──────────────────────────────────────────────────────────────
async function setupSettingsTab(user) {
  if (user?.email) $('settingsEmail').textContent = user.email

  $('btnUpgrade').addEventListener('click', () => openUpgradePage())
  $('btnSignOut').addEventListener('click', async () => { await signOut(); showLoginScreen() })

  const prefs = await getStorage(['pref_theme'])
  applyTheme(prefs.pref_theme || 'system')

  document.querySelectorAll('.theme-btn').forEach(btn => {
    btn.addEventListener('click', async () => { await setStorage({ pref_theme: btn.dataset.theme }); applyTheme(btn.dataset.theme) })
  })

  // Load recruiter profile into settings fields
  const profile = await fetchRecruiterProfile()
  if (profile) {
    if ($('prefFullName'))    $('prefFullName').value    = profile.full_name    || ''
    if ($('prefCompanyName')) $('prefCompanyName').value = profile.company_name || ''
    if ($('prefJobTitle'))    $('prefJobTitle').value    = profile.job_title    || ''
    if ($('prefHiringFocus')) $('prefHiringFocus').value = profile.hiring_focus || ''
    if ($('prefTone'))        $('prefTone').value        = profile.tone         || ''
  }

  $('btnSaveProfile').addEventListener('click', async () => {
    const fullName    = $('prefFullName').value.trim()
    const companyName = $('prefCompanyName').value.trim()
    const statusEl    = $('profileSaveStatus')

    if (!fullName || !companyName) {
      statusEl.textContent = 'Full name and company name are required.'
      statusEl.style.color = '#dc2626'
      return
    }

    const btn = $('btnSaveProfile')
    btn.disabled = true
    statusEl.textContent = 'Saving…'
    statusEl.style.color = '#6b7280'

    try {
      await saveRecruiterProfile({
        fullName,
        companyName,
        jobTitle:    $('prefJobTitle').value.trim()    || null,
        hiringFocus: $('prefHiringFocus').value        || null,
        tone:        $('prefTone').value               || null,
      })
      statusEl.textContent = 'Profile saved!'
      statusEl.style.color = '#16a34a'
      setTimeout(() => { statusEl.textContent = ''; statusEl.style.color = '' }, 2500)
    } catch (e) {
      statusEl.textContent = e.message || 'Could not save — try again.'
      statusEl.style.color = '#dc2626'
    } finally {
      btn.disabled = false
    }
  })
}

// ── Init ──────────────────────────────────────────────────────────────────────
async function init() {
  const loggedIn = await isLoggedIn()
  if (!loggedIn) { showLoginScreen(); return }
  await handlePostLogin()
}
init()
