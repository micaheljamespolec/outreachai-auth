// ─── batch.js ─────────────────────────────────────────────────────────────────
import {
  getCampaigns, getCampaignCandidates, importCampaign,
  enrichCampaignCandidate, draftCampaignCandidate,
  updateCandidateStatus, linkCampaignJob, deleteCampaign,
  getSavedJobs, openUpgradePage,
} from './core/api.js'

// ── State ──────────────────────────────────────────────────────────────────────
let _activeCampaignId = null
let _allCandidates = []
let _savedJobs = []
let _batchRunId = 0
let _parsedCandidates = []
let _reviewIndex = 0

// ── DOM shorthand ──────────────────────────────────────────────────────────────
const $ = id => document.getElementById(id)

// ── Drawer open / close ────────────────────────────────────────────────────────
export function openBatchDrawer() {
  const drawer = $('batchDrawer')
  if (!drawer) return
  const statusMsg = $('statusMessage')
  if (statusMsg) { statusMsg.textContent = ''; statusMsg.className = ''; statusMsg.style.display = 'none' }
  drawer.classList.add('open')
  loadCampaignsList()
  loadJobsForSelector()
}

export function closeBatchDrawer() {
  const drawer = $('batchDrawer')
  if (!drawer) return
  drawer.classList.remove('open')
  _batchRunId++
}

// ── CSV parser (RFC 4180, handles quoted fields and embedded newlines) ─────────
function parseCsv(text) {
  const rows = []
  let col = '', row = [], inQuotes = false
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') { col += '"'; i++ }
        else inQuotes = false
      } else {
        col += ch
      }
    } else {
      if (ch === '"') { inQuotes = true }
      else if (ch === ',') { row.push(col); col = '' }
      else if (ch === '\n') { row.push(col); col = ''; rows.push(row); row = [] }
      else if (ch === '\r') { /* skip */ }
      else col += ch
    }
  }
  if (col || row.length) { row.push(col); rows.push(row) }
  return rows
}

function csvToObjects(rows) {
  if (rows.length < 2) return []
  const headers = rows[0].map(h => h.trim().toLowerCase())
  const get = (row, ...keys) => {
    for (const k of keys) {
      const idx = headers.indexOf(k)
      if (idx !== -1) return (row[idx] || '').trim()
    }
    return ''
  }
  return rows.slice(1).filter(r => r.some(c => c.trim())).map(row => ({
    first_name:      get(row, 'first name'),
    last_name:       get(row, 'last name'),
    headline:        get(row, 'headline'),
    location:        get(row, 'location'),
    current_title:   get(row, 'current title'),
    current_company: get(row, 'current company'),
    email:           get(row, 'email address', 'email'),
    phone:           get(row, 'phone number', 'phone'),
    linkedin_url:    get(row, 'profile url', 'linkedin url', 'linkedin'),
    active_project:  get(row, 'active project'),
    notes:           get(row, 'notes'),
    feedback:        get(row, 'feedback'),
  }))
}

// ── Load saved jobs for selectors ─────────────────────────────────────────────
async function loadJobsForSelector() {
  try {
    const { jobs } = await getSavedJobs()
    _savedJobs = jobs || []
    renderJobSelectors()
  } catch {}
}

function renderJobSelectors() {
  document.querySelectorAll('.batch-job-select').forEach(sel => {
    const current = sel.value
    sel.innerHTML = '<option value="">— Select a saved job —</option>'
    _savedJobs.forEach(j => {
      const opt = document.createElement('option')
      opt.value = j.id
      opt.textContent = j.label + (j.company ? ` — ${j.company}` : '')
      sel.appendChild(opt)
    })
    if (current) sel.value = current
  })
}

// ── Previous campaigns list (collapsed) ──────────────────────────────────────
async function loadCampaignsList() {
  const list = $('batchCampaignList')
  if (!list) return
  list.innerHTML = '<div class="batch-loading">Loading campaigns…</div>'
  try {
    const { campaigns } = await getCampaigns()
    list.innerHTML = ''
    if (!campaigns || campaigns.length === 0) {
      list.innerHTML = '<div class="batch-empty">No campaigns yet.</div>'
      return
    }
    campaigns.forEach(c => {
      const row = document.createElement('div')
      row.className = 'batch-campaign-row'
      const job = c.saved_jobs
      const jobLabel = job ? `${job.label}${job.company ? ' — ' + job.company : ''}` : null
      const statusBadge = c.status === 'needs_job'
        ? '<span class="batch-badge warn">Needs job</span>'
        : `<span class="batch-badge ok">${c.status}</span>`
      row.innerHTML = `
        <div class="batch-campaign-info">
          <div class="batch-campaign-name">${_esc(c.name)}</div>
          <div class="batch-campaign-meta">
            ${jobLabel ? `<span class="batch-campaign-job">${_esc(jobLabel)}</span>` : '<span class="batch-campaign-job warn-text">No job linked</span>'}
            ${statusBadge}
          </div>
          <div class="batch-campaign-counts">
            ${c.enriched_count}/${c.total_count} enriched · ${c.drafted_count} drafted · ${c.approved_count} approved
          </div>
        </div>
        <div class="batch-campaign-actions">
          <button class="batch-btn batch-btn-sm" data-open="${c.id}">Open</button>
          <button class="batch-btn batch-btn-sm batch-btn-danger" data-delete="${c.id}">✕</button>
        </div>`
      row.querySelector('[data-open]').addEventListener('click', () => openCampaign(c.id, c))
      row.querySelector('[data-delete]').addEventListener('click', async e => {
        e.stopPropagation()
        if (!confirm(`Delete campaign "${c.name}" and all its candidates?`)) return
        try {
          await deleteCampaign({ campaignId: c.id })
          await loadCampaignsList()
        } catch { alert('Could not delete campaign.') }
      })
      list.appendChild(row)
    })
  } catch (e) {
    list.innerHTML = '<div class="batch-empty">Could not load campaigns.</div>'
  }
}

async function openCampaign(campaignId, campaignData) {
  _activeCampaignId = campaignId

  if (campaignData?.status === 'needs_job') {
    setBatchStatus('This campaign has no job linked yet. Link a job before enriching or drafting.', 'warn')
    const linkRow = $('batchLinkJobRow')
    if (linkRow) linkRow.style.display = 'block'
  }

  await loadCandidatePanel(campaignId)
  showStep(3)
}

// ── Progressive disclosure: show/hide steps ─────────────────────────────────
function showStep(num) {
  for (let i = 3; i <= 4; i++) {
    const el = $(`batchStep${i}`)
    if (el) el.style.display = i <= num ? 'block' : 'none'
  }
  if (num >= 3) {
    const n1 = $('batchStepNum1')
    const n2 = $('batchStepNum2')
    if (n1) n1.classList.add('done')
    if (n2) n2.classList.add('done')
  }
}

// ── Dropzone: drag-drop + paste + click-to-browse ───────────────────────────
function setupDropzone() {
  const dropzone = $('batchDropzone')
  if (!dropzone) return

  let _fileInput = null

  dropzone.addEventListener('dragover', e => {
    e.preventDefault()
    dropzone.classList.add('dragover')
  })
  dropzone.addEventListener('dragleave', () => dropzone.classList.remove('dragover'))
  dropzone.addEventListener('drop', e => {
    e.preventDefault()
    dropzone.classList.remove('dragover')
    const file = e.dataTransfer.files?.[0]
    if (file) readCsvFile(file)
  })

  dropzone.addEventListener('click', () => {
    if (!_fileInput) {
      _fileInput = document.createElement('input')
      _fileInput.type = 'file'
      _fileInput.accept = '.csv'
      _fileInput.addEventListener('change', () => {
        const file = _fileInput.files?.[0]
        if (file) readCsvFile(file)
      })
    }
    _fileInput.click()
  })

  dropzone.addEventListener('paste', e => {
    const text = e.clipboardData?.getData('text')
    if (text) handlePastedText(text)
  })

  dropzone.addEventListener('keydown', e => {
    if (e.key === 'v' && (e.ctrlKey || e.metaKey)) {
      // paste will fire naturally
    }
  })
}

function readCsvFile(file) {
  const reader = new FileReader()
  reader.onload = e => {
    const rows = parseCsv(e.target.result)
    _parsedCandidates = csvToObjects(rows)
    afterParse(file.name)
  }
  reader.readAsText(file)
}

function handlePastedText(text) {
  const rows = parseCsv(text)
  _parsedCandidates = csvToObjects(rows)
  afterParse('pasted data')
}

function afterParse(fileName) {
  if (_parsedCandidates.length === 0) {
    setBatchStatus('No candidates found in the data. Ensure the CSV has "First Name" and "Last Name" columns.', 'warn')
    return
  }

  const count = _parsedCandidates.length
  const label = `${count} candidate${count !== 1 ? 's' : ''}`
  const dropzone = $('batchDropzone')
  if (dropzone) {
    dropzone.innerHTML = `<span class="file-pill">📄 ${fileName} — ${label}</span>`
    dropzone.classList.add('compact')
  }

  const preview = $('batchImportPreview')
  if (preview) preview.textContent = `${label} detected`

  const form = $('batchImportForm')
  if (form) form.style.display = 'block'

  const firstProject = _parsedCandidates.find(c => c.active_project)?.active_project || ''
  const nameInput = $('batchCampaignName')
  if (nameInput && !nameInput.value.trim() && firstProject) nameInput.value = firstProject

  checkImportReady()
}

function checkImportReady() {
  const importBtn = $('batchImportBtn')
  if (!importBtn) return
  const hasName = ($('batchCampaignName')?.value || '').trim().length > 0
  const hasCandidates = _parsedCandidates.length > 0
  const hasJob = !!$('batchJobSelect')?.value
  importBtn.disabled = !(hasName && hasCandidates && hasJob)
}

// ── Import candidates ────────────────────────────────────────────────────────
async function doImport() {
  const nameInput = $('batchCampaignName')
  const name = (nameInput?.value || '').trim()
  if (!name || _parsedCandidates.length === 0) return

  const jobId = $('batchJobSelect')?.value || null
  if (!jobId) {
    setBatchStatus('Please select a saved job first.', 'error')
    return
  }

  const importBtn = $('batchImportBtn')
  if (importBtn) { importBtn.disabled = true; importBtn.textContent = 'Importing…' }
  setBatchStatus('', '')

  try {
    const result = await importCampaign({
      campaignName: name,
      jobId,
      candidates: _parsedCandidates,
    })

    if (result.creditWarning) {
      showCreditWarning(result.creditWarning.message, result.creditWarning.available)
    }

    _parsedCandidates = []
    if (nameInput) nameInput.value = ''
    const preview = $('batchImportPreview')
    if (preview) preview.textContent = ''
    const form = $('batchImportForm')
    if (form) form.style.display = 'none'
    const dropzone = $('batchDropzone')
    if (dropzone) {
      dropzone.classList.remove('compact')
      dropzone.innerHTML = '<div class="batch-dropzone-icon">📄</div><div>Drag & drop a LinkedIn CSV here</div><div class="batch-dropzone-hint">or click and paste (Cmd+V / Ctrl+V) rows from your ATS</div>'
    }

    await loadCampaignsList()
    if (result.campaign?.id) {
      await openCampaign(result.campaign.id, result.campaign)
    }
  } catch (e) {
    setBatchStatus(_batchErrorMessage(e, 'Import failed. Try again.'), 'error')
    if (importBtn) { importBtn.disabled = false; importBtn.textContent = 'Import candidates' }
  }
}

// ── Candidates panel (Step 3) ───────────────────────────────────────────────
async function loadCandidatePanel(campaignId) {
  if (!campaignId) return
  const list = $('batchCandidateList')
  if (!list) return
  list.innerHTML = '<div class="batch-loading">Loading candidates…</div>'

  try {
    const { candidates } = await getCampaignCandidates({ campaignId })
    _allCandidates = candidates || []
    renderCandidateList(_allCandidates)
    updateBatchActionButtons()
  } catch {
    list.innerHTML = '<div class="batch-empty">Could not load candidates.</div>'
  }
}

function renderCandidateList(candidates) {
  const list = $('batchCandidateList')
  if (!list) return
  list.innerHTML = ''

  if (candidates.length === 0) {
    list.innerHTML = '<div class="batch-empty">No candidates imported yet.</div>'
    return
  }

  candidates.forEach(c => {
    const row = document.createElement('div')
    row.className = 'batch-candidate-row'
    row.dataset.id = c.id
    const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—'
    const titleLine = [c.enriched_title || c.current_title, c.enriched_company || c.current_company].filter(Boolean).join(' · ')
    const email = c.work_email || c.personal_email || c.csv_email || null
    const emailBadge = email
      ? `<span class="batch-badge ok-sm">${_esc(email)}</span>`
      : `<span class="batch-badge gray-sm">No email</span>`

    row.innerHTML = `
      <div class="batch-candidate-info">
        <div class="batch-candidate-name">${_esc(name)}</div>
        <div class="batch-candidate-meta">${_esc(titleLine)}</div>
        <div class="batch-candidate-email">${emailBadge} ${_statusBadge(c.status)}</div>
      </div>
      <div class="batch-candidate-actions">
        ${c.linkedin_url ? `<a href="${_esc(c.linkedin_url)}" target="_blank" class="batch-link-btn" title="Open LinkedIn">↗</a>` : ''}
        ${['imported','failed'].includes(c.status) ? `<button class="batch-btn batch-btn-xs" data-enrich="${c.id}">Enrich</button>` : ''}
        ${c.status === 'enriched' ? `<button class="batch-btn batch-btn-xs" data-draft="${c.id}">Draft</button>` : ''}
      </div>`

    row.querySelector('[data-enrich]')?.addEventListener('click', async e => {
      e.stopPropagation()
      await runSingleEnrich(c.id, row)
    })
    row.querySelector('[data-draft]')?.addEventListener('click', async e => {
      e.stopPropagation()
      await runSingleDraft(c.id, row)
    })

    list.appendChild(row)
  })
}

function updateBatchActionButtons() {
  const needsEnrich = _allCandidates.filter(c => ['imported','failed'].includes(c.status)).length
  const needsDraft  = _allCandidates.filter(c => c.status === 'enriched').length
  const enrichBtn = $('batchEnrichAllBtn')
  const draftBtn  = $('batchDraftAllBtn')
  if (enrichBtn) {
    enrichBtn.disabled = needsEnrich === 0
    enrichBtn.textContent = needsEnrich > 0 ? `🔍 Find ${needsEnrich} emails` : '🔍 All emails found'
  }
  if (draftBtn) {
    draftBtn.disabled = needsDraft === 0
    draftBtn.textContent = needsDraft > 0 ? `✨ Draft ${needsDraft} candidates` : '✨ All drafted'
  }
}

// ── Single enrich/draft ────────────────────────────────────────────────────────
async function runSingleEnrich(candidateId, rowEl) {
  if (rowEl) rowEl.classList.add('batch-row-processing')
  try {
    const result = await enrichCampaignCandidate({ candidateId })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) {
      _allCandidates[idx].status = result.status || 'enriched'
      _allCandidates[idx].work_email = result.email || _allCandidates[idx].work_email
    }
    if (rowEl) rowEl.classList.remove('batch-row-processing')
    renderCandidateList(_allCandidates)
    updateBatchActionButtons()
  } catch (e) {
    if (rowEl) rowEl.classList.remove('batch-row-processing')
    if (e.code === 'CREDIT_LIMIT_REACHED') {
      showCreditWarning('Credit limit reached. Upgrade to continue enriching.', 0)
    }
  }
}

async function runSingleDraft(candidateId, rowEl) {
  if (rowEl) rowEl.classList.add('batch-row-processing')
  try {
    const result = await draftCampaignCandidate({ candidateId })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) {
      _allCandidates[idx].status = 'drafted'
      _allCandidates[idx].draft_subject = result.draft?.subject || ''
      _allCandidates[idx].draft_body = result.draft?.body || ''
      _allCandidates[idx].draft_confidence = result.draft?.confidence || 0
    }
    if (rowEl) rowEl.classList.remove('batch-row-processing')
    renderCandidateList(_allCandidates)
    updateBatchActionButtons()
  } catch {
    if (rowEl) rowEl.classList.remove('batch-row-processing')
  }
}

// ── Batch enrich all ──────────────────────────────────────────────────────────
async function runEnrichAll() {
  if (!_activeCampaignId) return
  const toEnrich = _allCandidates.filter(c => ['imported','failed'].includes(c.status))
  if (toEnrich.length === 0) return
  const myRunId = ++_batchRunId

  const enrichBtn = $('batchEnrichAllBtn')
  const progressEl = $('batchEnrichProgress')
  if (enrichBtn) { enrichBtn.disabled = true; enrichBtn.textContent = 'Finding emails…' }

  let done = 0
  for (const candidate of toEnrich) {
    if (_batchRunId !== myRunId) break
    if (progressEl) progressEl.textContent = `${done} / ${toEnrich.length} checked…`
    try {
      const result = await enrichCampaignCandidate({ candidateId: candidate.id })
      const idx = _allCandidates.findIndex(c => c.id === candidate.id)
      if (idx !== -1) {
        _allCandidates[idx].status = result.status || 'enriched'
        _allCandidates[idx].work_email = result.email || _allCandidates[idx].work_email
      }
    } catch (e) {
      const idx = _allCandidates.findIndex(c => c.id === candidate.id)
      if (idx !== -1) _allCandidates[idx].status = 'failed'
      if (e.code === 'CREDIT_LIMIT_REACHED') {
        showCreditWarning('Credit limit reached. Upgrade to continue enriching.', 0)
        break
      }
    }
    done++
    renderCandidateList(_allCandidates)
  }

  if (progressEl) progressEl.textContent = `${done} / ${toEnrich.length} checked`
  updateBatchActionButtons()
  if (enrichBtn) enrichBtn.disabled = false
  setTimeout(() => { if (progressEl) progressEl.textContent = '' }, 3000)
}

// ── Batch draft all ────────────────────────────────────────────────────────────
async function runDraftAll() {
  if (!_activeCampaignId) return
  const toDraft = _allCandidates.filter(c => c.status === 'enriched')
  if (toDraft.length === 0) return
  const myRunId = ++_batchRunId

  const draftBtn = $('batchDraftAllBtn')
  const progressEl = $('batchDraftProgress')
  if (draftBtn) { draftBtn.disabled = true; draftBtn.textContent = 'Generating drafts…' }

  let done = 0
  for (const candidate of toDraft) {
    if (_batchRunId !== myRunId) break
    if (progressEl) progressEl.textContent = `${done} / ${toDraft.length} drafted…`
    try {
      const result = await draftCampaignCandidate({ candidateId: candidate.id })
      const idx = _allCandidates.findIndex(c => c.id === candidate.id)
      if (idx !== -1) {
        _allCandidates[idx].status = 'drafted'
        _allCandidates[idx].draft_subject = result.draft?.subject || ''
        _allCandidates[idx].draft_body = result.draft?.body || ''
        _allCandidates[idx].draft_confidence = result.draft?.confidence || 0
      }
    } catch {
      // skip failed drafts
    }
    done++
    renderCandidateList(_allCandidates)
  }

  if (progressEl) progressEl.textContent = `${done} / ${toDraft.length} drafted`
  updateBatchActionButtons()
  if (draftBtn) draftBtn.disabled = false
  setTimeout(() => { if (progressEl) progressEl.textContent = '' }, 3000)

  if (done > 0) {
    loadReviewQueue()
    showStep(4)
  }
}

// ── Review queue (one-at-a-time, Step 4) ─────────────────────────────────────
function loadReviewQueue() {
  _reviewIndex = 0
  renderCurrentReview()
}

function renderCurrentReview() {
  const drafted = _allCandidates.filter(c => c.status === 'drafted')
  const queue = $('batchReviewQueue')
  const counter = $('batchReviewCounter')
  if (!queue) return

  if (drafted.length === 0) {
    queue.innerHTML = '<div class="batch-review-done">All drafts reviewed!</div>'
    if (counter) counter.textContent = ''
    return
  }

  if (_reviewIndex >= drafted.length) {
    queue.innerHTML = '<div class="batch-review-done">All drafts reviewed!</div>'
    if (counter) counter.textContent = ''
    return
  }

  const c = drafted[_reviewIndex]
  if (counter) counter.textContent = `${_reviewIndex + 1} of ${drafted.length}`

  const name = [c.first_name, c.last_name].filter(Boolean).join(' ') || '—'
  const email = c.work_email || c.personal_email || c.csv_email || ''
  const confPct = Math.round((c.draft_confidence || 0) * 100)

  queue.innerHTML = ''
  const card = document.createElement('div')
  card.className = 'batch-review-card'
  card.innerHTML = `
    <div class="batch-review-header">
      <div>
        <div class="batch-review-name">${_esc(name)}</div>
        <div class="batch-review-meta">${_esc(email)} ${confPct > 0 ? `<span class="batch-conf-badge ${confPct >= 80 ? 'high' : confPct >= 60 ? 'mid' : 'low'}">${confPct}%</span>` : ''}</div>
      </div>
    </div>
    <div class="batch-review-subject">${_esc(c.draft_subject || '')}</div>
    <textarea class="batch-review-body">${_esc(c.draft_body || '')}</textarea>
    <div class="batch-review-actions">
      <button class="batch-btn batch-btn-gmail" id="batchReviewGmail">Gmail</button>
      <button class="batch-btn batch-btn-outlook" id="batchReviewOutlook">Outlook</button>
      <button class="batch-btn batch-btn-sm" id="batchReviewSkip">Skip</button>
    </div>`

  queue.appendChild(card)

  const bodyEl = card.querySelector('.batch-review-body')
  const subject = c.draft_subject || `Reaching out — ${name}`

  $('batchReviewGmail')?.addEventListener('click', async () => {
    const body = bodyEl?.value || c.draft_body || ''
    await approveCandidate(c.id)
    chrome.tabs.create({ url: `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(email)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` })
    advanceReview()
  })

  $('batchReviewOutlook')?.addEventListener('click', async () => {
    const body = bodyEl?.value || c.draft_body || ''
    await approveCandidate(c.id)
    chrome.tabs.create({ url: `https://outlook.office.com/mail/deeplink/compose?to=${encodeURIComponent(email)}&subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}` })
    advanceReview()
  })

  $('batchReviewSkip')?.addEventListener('click', async () => {
    await skipCandidate(c.id)
    advanceReview()
  })
}

function advanceReview() {
  _reviewIndex++
  renderCurrentReview()
}

async function approveCandidate(candidateId) {
  try {
    await updateCandidateStatus({ candidateId, status: 'approved' })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) _allCandidates[idx].status = 'approved'
  } catch {}
}

async function skipCandidate(candidateId) {
  try {
    await updateCandidateStatus({ candidateId, status: 'skipped' })
    const idx = _allCandidates.findIndex(c => c.id === candidateId)
    if (idx !== -1) _allCandidates[idx].status = 'skipped'
  } catch {}
}

// ── Helpers ────────────────────────────────────────────────────────────────────
function _esc(s) {
  return String(s || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

function _statusBadge(status) {
  const map = {
    imported:  ['gray-sm', 'Pending'],
    enriching: ['info-sm', 'Finding email…'],
    enriched:  ['ok-sm', 'Email found'],
    no_email:  ['warn-sm', 'No email'],
    drafting:  ['info-sm', 'Writing draft…'],
    drafted:   ['ok-sm', 'Draft ready'],
    approved:  ['green-sm', 'Approved'],
    skipped:   ['gray-sm', 'Skipped'],
    failed:    ['err-sm', 'Failed'],
  }
  const [cls, label] = map[status] || ['gray-sm', status]
  return `<span class="batch-badge ${cls}">${label}</span>`
}

const _MISLEADING_CODES = ['NO_LINKEDIN_URL', 'UNKNOWN_ACTION']
function _batchErrorMessage(e, fallback) {
  if (e && _MISLEADING_CODES.includes(e.code)) return fallback
  return e?.message || fallback
}

function setBatchStatus(msg, type) {
  const el = $('batchStatus')
  if (!el) return
  el.textContent = msg
  el.className = `batch-status-bar${msg ? ' ' + type : ''}`
}

function showCreditWarning(message, available) {
  const el = $('batchCreditWarning')
  const msgEl = $('batchCreditWarningMsg')
  if (!el || !msgEl) return
  msgEl.textContent = message
  el.style.display = 'block'
  $('batchCreditUpgradeBtn')?.addEventListener('click', () => openUpgradePage(), { once: true })
  setTimeout(() => { el.style.display = 'none' }, 12000)
}

// ── Init ───────────────────────────────────────────────────────────────────────
export function initBatch() {
  $('batchDrawerClose')?.addEventListener('click', closeBatchDrawer)

  const prevToggle = $('batchPrevToggle')
  const prevList = $('batchPrevCampaigns')
  if (prevToggle && prevList) {
    prevToggle.addEventListener('click', () => {
      const open = prevList.style.display !== 'none'
      prevList.style.display = open ? 'none' : 'block'
      prevToggle.textContent = open ? 'Previous campaigns' : 'Hide previous campaigns'
    })
  }

  const jobSel = $('batchJobSelect')
  if (jobSel) {
    jobSel.addEventListener('change', () => {
      const confirm = $('batchJobConfirm')
      if (confirm) {
        const opt = jobSel.options[jobSel.selectedIndex]
        confirm.style.display = jobSel.value ? 'block' : 'none'
        confirm.textContent = jobSel.value ? `Job: ${opt.textContent}` : ''
      }
      checkImportReady()
    })
  }

  setupDropzone()

  $('batchCampaignName')?.addEventListener('input', checkImportReady)
  $('batchImportBtn')?.addEventListener('click', doImport)

  $('batchEnrichAllBtn')?.addEventListener('click', async () => {
    if (!_activeCampaignId) { setBatchStatus('Select a campaign first.', 'warn'); return }
    await runEnrichAll()
  })

  $('batchDraftAllBtn')?.addEventListener('click', async () => {
    if (!_activeCampaignId) { setBatchStatus('Select a campaign first.', 'warn'); return }
    await runDraftAll()
  })

  const linkJobSel = $('batchLinkJobSelect')
  const linkJobBtn = $('batchLinkJobBtn')
  if (linkJobSel && linkJobBtn) {
    linkJobBtn.addEventListener('click', async () => {
      const jobId = linkJobSel.value
      if (!jobId || !_activeCampaignId) return
      try {
        await linkCampaignJob({ campaignId: _activeCampaignId, jobId })
        setBatchStatus('Job linked. You can now enrich and draft candidates.', 'success')
        linkJobSel.value = ''
        $('batchLinkJobRow').style.display = 'none'
        await loadCandidatePanel(_activeCampaignId)
      } catch { setBatchStatus('Could not link job.', 'error') }
    })
  }
}
