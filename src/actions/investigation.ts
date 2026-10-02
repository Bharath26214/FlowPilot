import { generateText } from 'ai'
import { createDeepSpaceAI, isAnonymousUserId, resolveAppMembership } from 'deepspace/worker'
import type { ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import { analyzeEvidence, unusableText } from '../investigation/analyze'
import { assessSignal, type FileEvents } from '../investigation/assess'
import { needsAnalysis } from '../investigation/evidence-state'
import { DEFAULT_QUESTION, buildContext, runAssistant } from '../investigation/assistant'
import { intelQuery, normalizeIntel, searchableIps } from '../investigation/intel'
import { buildReport } from '../investigation/report'
import { reportHtml, toBase64 } from '../investigation/report-html'
import { buildSeedCases } from '../investigation/seed'
import type {
  BriefData,
  CaseData,
  CaseStage,
  EvidenceData,
  FindingData,
  IntelData,
  ReportData,
  ReviewData,
  Signal,
} from '../investigation/types'
import { CASE_STAGES, MAX_EVIDENCE_CHARS } from '../investigation/types'

const STAGE_INDEX = new Map(CASE_STAGES.map((stage, index) => [stage, index]))

type Row<T> = { recordId: string; data: T }

export const createCase: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const denied = await requireAnalyst(env, userId)
  if (denied) return fail(denied)

  const title = clip(params.title, 120)
  if (!title) return fail('Give the case a title.')
  const summary = optionalClip(params.summary, 2_000)

  const created = await tools.create<CaseData>('cases', {
    caseNumber: mintCaseNumber(),
    title,
    summary,
    stage: 'intake',
  })
  if (!created.success) return created
  return { success: true, data: { caseId: created.data.recordId } }
}

export const addEvidence: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const denied = await requireAnalyst(env, userId)
  if (denied) return fail(denied)

  const caseId = clip(params.caseId, 80)
  const fileName = clip(params.fileName, 180)
  const content = typeof params.content === 'string' ? params.content.replace(/^\uFEFF/, '') : ''
  const fileKey = typeof params.fileKey === 'string' ? params.fileKey.slice(0, 500) : ''
  const byteSize = typeof params.byteSize === 'number' && Number.isFinite(params.byteSize) ? params.byteSize : content.length

  if (!caseId || !fileName) return fail('Choose a case and a file name.')
  const unusable = unusableText(content)
  if (unusable) return fail(unusable)
  if (content.length > MAX_EVIDENCE_CHARS) {
    return fail(`Evidence must be under ${MAX_EVIDENCE_CHARS.toLocaleString('en-US')} characters.`)
  }

  const caseRow = await loadCase(tools, caseId)
  if (!caseRow) return fail('Case not found.')

  // The same bytes twice would double-count every event and signal.
  const digest = await sha256(content)
  const same = await tools.query<EvidenceData>('evidence', { where: { caseId, sha256: digest }, limit: 1 })
  if (!same.success) return same
  const original = same.data.records[0]
  if (original) {
    return fail(`Duplicate evidence: this file is identical to "${original.data.fileName}", which is already on the case.`)
  }

  const created = await tools.create<EvidenceData>('evidence', {
    caseId,
    fileName,
    fileKey,
    byteSize,
    sha256: digest,
    status: 'stored',
    analysisStatus: 'pending',
    analysisSummary: '',
    eventCount: 0,
    signals: [],
    content,
  })
  if (!created.success) return created
  await advance(tools, caseRow, 'evidence')
  return { success: true, data: { evidenceId: created.data.recordId } }
}

/**
 * Analyzes a case's waiting evidence — pending, failed, or timed out — or one
 * file when `evidenceId` is given (Retry). Each file is marked `running` with a
 * start time first, so a run the Worker never finishes shows as timed out
 * instead of spinning forever. A crash inside the analyzer fails only that file.
 */
export const analyzeEvidenceAction: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const denied = await requireAnalyst(env, userId)
  if (denied) return fail(denied)

  const caseId = clip(params.caseId, 80)
  if (!caseId) return fail('Case not found.')
  const onlyId = params.evidenceId === undefined ? null : clip(params.evidenceId, 80)
  const caseRow = await loadCase(tools, caseId)
  if (!caseRow) return fail('Case not found.')

  const evidence = await loadEvidence(tools, caseId)
  if (!evidence.ok) return fail(evidence.error)
  const now = Date.now()
  const pending = evidence.records.filter((row) => (onlyId ? row.recordId === onlyId : true) && needsAnalysis(row.data, now))
  if (pending.length === 0) return fail(onlyId ? 'That file is not waiting for analysis.' : 'Nothing is waiting for analysis.')

  await advance(tools, caseRow, 'analysis')

  let analyzed = 0
  let failed = 0
  for (const row of pending) {
    await tools.update('evidence', row.recordId, { analysisStatus: 'running', analysisStartedAt: new Date().toISOString() })
    let analysis: ReturnType<typeof analyzeEvidence>
    try {
      analysis = analyzeEvidence(row.data.content ?? '')
    } catch (err) {
      console.error(`[analyzeEvidence] analyzer crashed on ${row.recordId}: ${err instanceof Error ? err.message : String(err)}`)
      analysis = { events: [], signals: [], summary: '', truncated: false, warnings: [], error: 'The analyzer hit an internal error on this file. Retry, or report the file to the FlowPilot team.' }
    }
    if (analysis.error) {
      failed += 1
      await tools.update('evidence', row.recordId, {
        analysisStatus: 'failed',
        analysisSummary: analysis.error,
        analysisErrorLine: analysis.errorLine ?? 0,
        analysisWarnings: [],
        eventCount: 0,
        signals: [],
      })
      continue
    }
    analyzed += 1
    await tools.update('evidence', row.recordId, {
      analysisStatus: 'complete',
      analysisSummary: analysis.summary,
      analysisErrorLine: 0,
      analysisWarnings: analysis.warnings,
      eventCount: analysis.events.length,
      signals: analysis.signals,
    })
  }

  return { success: true, data: { analyzed, failed } }
}

export const generateFindings: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const denied = await requireAnalyst(env, userId)
  if (denied) return fail(denied)

  const caseId = clip(params.caseId, 80)
  if (!caseId) return fail('Case not found.')
  const caseRow = await loadCase(tools, caseId)
  if (!caseRow) return fail('Case not found.')

  const evidence = await loadEvidence(tools, caseId)
  if (!evidence.ok) return fail(evidence.error)
  if (evidence.records.length === 0) return fail('Upload evidence first.')
  if (evidence.records.some((row) => row.data.analysisStatus !== 'complete')) {
    return fail('Analyze every file before generating findings.')
  }

  const existing = await loadFindings(tools, caseId)
  if (!existing.ok) return fail(existing.error)
  const kept = new Set(
    existing.records
      .filter((row) => row.data.status !== 'draft')
      .map((row) => `${row.data.evidenceId}:${row.data.indicator}`),
  )
  if (existing.records.some((row) => row.data.status === 'draft')) {
    let deleted = 0
    do {
      const removed = await tools.deleteWhere('findings', { caseId, status: 'draft' }, 200)
      if (!removed.success) return removed
      deleted = removed.data.deleted
    } while (deleted === 200)
  }

  // Re-analyze so signals carry source locations, then score each one
  // against every file in the case (corroboration can cross files).
  const files: Array<FileEvents & { signals: Signal[] }> = evidence.records.map((row) => {
    const analysis = analyzeEvidence(row.data.content ?? '')
    return { evidenceId: row.recordId, events: analysis.events, signals: analysis.signals }
  })

  let created = 0
  for (const file of files) {
    for (const item of file.signals) {
      if (kept.has(`${file.evidenceId}:${item.indicator}`)) continue
      const assessment = assessSignal(item, file, files)
      const written = await tools.create<FindingData>('findings', {
        caseId,
        evidenceId: file.evidenceId,
        title: item.title,
        detail: item.detail,
        severity: item.severity,
        status: 'draft',
        indicator: item.indicator,
        hypothesis: assessment.hypothesis,
        confidence: assessment.confidence,
        factors: assessment.factors,
      })
      if (!written.success) return written
      created += 1
    }
  }

  if (created > 0) {
    await tools.update('cases', caseId, { stage: 'findings' })
  } else if (kept.size === 0) {
    await advance(tools, caseRow, 'review')
  }
  return { success: true, data: { created } }
}

const DECISIONS = new Set(['accepted', 'dismissed', 'investigating'])

/**
 * Records an investigator's decision on a finding: confirm (`accepted`),
 * reject (`dismissed`), or hold it open while they dig (`investigating`).
 * Confirm and reject are final; `investigating` can later become either.
 * Every decision is also appended to `reviews` as an audit trail.
 */
export const reviewFinding: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const denied = await requireAnalyst(env, userId)
  if (denied) return fail(denied)

  const findingId = clip(params.findingId, 80)
  const decision = typeof params.decision === 'string' && DECISIONS.has(params.decision) ? (params.decision as ReviewData['decision']) : null
  if (!findingId || !decision) return fail('Choose confirm, reject, or investigate.')
  const note = optionalClip(params.note, 1_000)
  if (decision === 'dismissed' && !note) return fail('Say why you are rejecting this finding.')

  const loaded = await tools.get<FindingData>('findings', findingId)
  if (!loaded.success) return fail('Finding not found.')
  const finding = loaded.data.record
  if (finding.data.status === 'accepted' || finding.data.status === 'dismissed') return fail('This finding was already decided.')
  if (finding.data.status === decision) return fail('This finding is already under investigation.')

  const decidedAt = new Date().toISOString()
  const updated = await tools.update('findings', findingId, { status: decision, decidedBy: userId, decidedAt, decisionNote: note })
  if (!updated.success) return updated

  const logged = await tools.create<ReviewData>('reviews', {
    caseId: finding.data.caseId,
    findingId,
    decision,
    note,
    reviewer: userId,
    decidedAt,
    confidenceShown: finding.data.confidence ?? 0,
  })
  if (!logged.success) return logged

  const caseRow = await loadCase(tools, finding.data.caseId)
  if (caseRow) await advance(tools, caseRow, 'review')
  return { success: true, data: { status: decision } }
}

export const exportReport: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const denied = await requireAnalyst(env, userId)
  if (denied) return fail(denied)

  const caseId = clip(params.caseId, 80)
  if (!caseId) return fail('Case not found.')
  const caseRow = await loadCase(tools, caseId)
  if (!caseRow) return fail('Case not found.')

  const evidence = await loadEvidence(tools, caseId)
  if (!evidence.ok) return fail(evidence.error)
  if (evidence.records.length === 0) return fail('Upload evidence first.')
  if (evidence.records.some((row) => row.data.analysisStatus !== 'complete')) {
    return fail('Analyze every file before exporting.')
  }

  const findings = await loadFindings(tools, caseId)
  if (!findings.ok) return fail(findings.error)
  if (findings.records.some((row) => row.data.status === 'draft' || row.data.status === 'investigating')) {
    return fail('Confirm or reject every finding before exporting.')
  }

  const exportedAt = new Date().toISOString()
  const body = buildReport({
    case: caseRow.data,
    evidence: evidence.records.map((row) => row.data),
    findings: findings.records.map((row) => row.data),
    exportedAt,
  })

  const prior = await tools.query<ReportData>('reports', { where: { caseId }, limit: 1 })
  if (!prior.success) return prior
  const existing = prior.data.records[0]
  const saved = existing
    ? await tools.update('reports', existing.recordId, { body, exportedAt, pdfUrl: '', pdfExpiresAt: '' })
    : await tools.create<ReportData>('reports', { caseId, body, exportedAt })
  if (!saved.success) return saved

  await tools.update('cases', caseId, { stage: 'exported' })
  return { success: true, data: { exportedAt } }
}

/**
 * Searches the web (Exa) for the public IPs behind a finding and stores the
 * results on the case. Only IP addresses are sent — never account names.
 * One record per finding+IP, so a repeat lookup refreshes rather than piles up.
 */
export const lookupIntel: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const denied = await requireAnalyst(env, userId)
  if (denied) return fail(denied)

  const findingId = clip(params.findingId, 80)
  if (!findingId) return fail('Finding not found.')
  const loaded = await tools.get<FindingData>('findings', findingId)
  if (!loaded.success) return fail('Finding not found.')
  const finding = loaded.data.record.data

  // Collect the IPs of every event the finding cites, across files.
  const refsByFile = new Map<string, Set<number>>()
  for (const factor of finding.factors ?? []) {
    for (const ref of factor.refs) {
      const set = refsByFile.get(ref.evidenceId) ?? new Set<number>()
      set.add(ref.loc.n)
      refsByFile.set(ref.evidenceId, set)
    }
  }
  if (refsByFile.size === 0) refsByFile.set(finding.evidenceId, new Set())
  const ips: string[] = []
  for (const [evidenceId, positions] of refsByFile) {
    const evidence = await tools.get<EvidenceData>('evidence', evidenceId)
    if (!evidence.success) continue
    const analysis = analyzeEvidence(evidence.data.record.data.content ?? '')
    const signal = analysis.signals.find((item) => item.indicator === finding.indicator)
    for (const loc of signal?.refs ?? []) positions.add(loc.n)
    for (const event of analysis.events) if (positions.has(event.loc.n) && event.ip) ips.push(event.ip)
  }
  const targets = searchableIps(ips)
  if (targets.length === 0) return fail('This finding has no public IP address to look up.')

  let stored = 0
  for (const ip of targets) {
    const searched = await tools.integration('exa/search', intelQuery(ip))
    if (!searched.success) {
      console.error(`[lookupIntel] exa/search failed: ${searched.error}`)
      return fail('The threat-intel lookup is unavailable right now. Try again.')
    }
    const saved = await tools.create<IntelData>(
      'intel',
      {
        caseId: finding.caseId,
        findingId,
        indicator: ip,
        results: normalizeIntel(searched.data),
        lookedUpBy: userId,
        lookedUpAt: new Date().toISOString(),
      },
      `intel-${findingId}-${ip.replace(/[^0-9a-f]/gi, '-')}`,
    )
    if (!saved.success) return saved
    stored += 1
  }
  return { success: true, data: { looked: stored, ips: targets } }
}

/** CloudConvert keeps the converted file for 24 hours; treat the link as stale a little earlier. */
const PDF_LINK_HOURS = 23

/**
 * Converts the case's exported report to PDF (CloudConvert) and stores the
 * download link with its expiry. Reuses a still-valid link instead of paying
 * for a second conversion.
 */
export const createReportPdf: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const denied = await requireAnalyst(env, userId)
  if (denied) return fail(denied)

  const caseId = clip(params.caseId, 80)
  if (!caseId) return fail('Case not found.')
  const caseRow = await loadCase(tools, caseId)
  if (!caseRow) return fail('Case not found.')
  const prior = await tools.query<ReportData>('reports', { where: { caseId }, limit: 1 })
  if (!prior.success) return prior
  const report = prior.data.records[0]
  if (!report) return fail('Export the report first.')

  const { pdfUrl, pdfExpiresAt } = report.data
  if (pdfUrl && pdfExpiresAt && Date.parse(pdfExpiresAt) > Date.now()) {
    return { success: true, data: { pdfUrl, pdfExpiresAt } }
  }

  const converted = await tools.integration<{ downloadUrl?: string }>('cloudconvert/convert-file', {
    input_format: 'html',
    output_format: 'pdf',
    file: toBase64(reportHtml(report.data.body, caseRow.data.caseNumber)),
  })
  if (!converted.success || !converted.data.downloadUrl) {
    console.error(`[createReportPdf] cloudconvert failed: ${converted.success ? 'no downloadUrl' : converted.error}`)
    return fail('PDF conversion is unavailable right now. Try again.')
  }
  const expiresAt = new Date(Date.now() + PDF_LINK_HOURS * 3_600_000).toISOString()
  const updated = await tools.update('reports', report.recordId, { pdfUrl: converted.data.downloadUrl, pdfExpiresAt: expiresAt })
  if (!updated.success) return updated
  return { success: true, data: { pdfUrl: converted.data.downloadUrl, pdfExpiresAt: expiresAt } }
}

const ASSISTANT_MODEL = 'claude-opus-5-5'

/**
 * Answers a question about a case from its structured findings, labelling
 * each statement evidence or inference and citing source lines. The answer is
 * stored on the case so every collaborator sees it. Billed to the app owner.
 */
export const askAssistant: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const denied = await requireAnalyst(env, userId)
  if (denied) return fail(denied)

  const caseId = clip(params.caseId, 80)
  if (!caseId) return fail('Case not found.')
  const question = optionalClip(params.question, 500) || DEFAULT_QUESTION
  const caseRow = await loadCase(tools, caseId)
  if (!caseRow) return fail('Case not found.')

  const evidence = await loadEvidence(tools, caseId)
  if (!evidence.ok) return fail(evidence.error)
  if (evidence.records.length === 0) return fail('Upload evidence before asking the assistant.')
  const findings = await loadFindings(tools, caseId)
  if (!findings.ok) return fail(findings.error)

  const intel = await tools.query<IntelData>('intel', { where: { caseId }, limit: 50 })
  if (!intel.success) return fail(intel.error)

  const context = buildContext({
    case: caseRow.data,
    evidence: evidence.records,
    findings: findings.records,
    intel: intel.data.records.map(asRow),
  })

  const anthropic = createDeepSpaceAI(env, 'anthropic')
  const answer = await runAssistant({
    question,
    context,
    generate: async ({ system, prompt, signal }) => {
      const result = await generateText({ model: anthropic(ASSISTANT_MODEL), system, prompt, maxOutputTokens: 2_000, abortSignal: signal })
      return result.text
    },
  })
  if ('error' in answer) {
    console.error(`[askAssistant] ${answer.error} for case ${caseId}`)
    return fail(answer.message)
  }

  const created = await tools.create<BriefData>('briefs', {
    caseId,
    question,
    statements: answer.statements,
    openQuestions: answer.openQuestions,
    droppedCitations: answer.droppedCitations,
    warning: answer.warning ?? '',
    model: ASSISTANT_MODEL,
    askedBy: userId,
    askedAt: new Date().toISOString(),
  })
  if (!created.success) return created
  return { success: true, data: { briefId: created.data.recordId } }
}

/** Everything that hangs off a case, children before the evidence they cite. */
const CASE_CHILDREN = ['briefs', 'intel', 'reviews', 'findings', 'reports', 'evidence'] as const

/**
 * Permanently deletes a case and every record on it. Admin only, and the
 * caller must echo the case number back as confirmation, so a stray click or
 * a replayed request with just an id cannot wipe a case. Returns the uploaded
 * file keys so the client can remove its copies from the file locker.
 */
export const deleteCase: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  if (isAnonymousUserId(userId)) return fail('Sign in required.')
  const membership = await resolveAppMembership(env, userId)
  if (membership?.role !== 'admin') return fail('Only admins can delete a case.')

  const caseId = clip(params.caseId, 80)
  if (!caseId) return fail('Case not found.')
  const caseRow = await loadCase(tools, caseId)
  if (!caseRow) return fail('Case not found.')
  if (clip(params.confirmCaseNumber, 40) !== caseRow.data.caseNumber) {
    return fail(`Type ${caseRow.data.caseNumber} to confirm.`)
  }

  const evidence = await loadEvidence(tools, caseId)
  if (!evidence.ok) return fail(evidence.error)
  const fileKeys = evidence.records.map((row) => row.data.fileKey).filter(Boolean)

  const removed: Record<string, number> = {}
  for (const collection of CASE_CHILDREN) {
    removed[collection] = 0
    let deleted = 0
    do {
      const result = await tools.deleteWhere(collection, { caseId }, 500)
      if (!result.success) return result
      deleted = result.data.deleted
      removed[collection] += deleted
    } while (deleted === 500)
  }
  const gone = await tools.remove('cases', caseId)
  if (!gone.success) return gone

  console.info(`[deleteCase] ${JSON.stringify(caseRow.data.caseNumber)} deleted by ${userId}: ${JSON.stringify(removed)}`)
  return { success: true, data: { removed, fileKeys } }
}

async function requireAnalyst(env: Env, userId: string): Promise<string | null> {
  if (isAnonymousUserId(userId)) return 'Sign in required.'
  const membership = await resolveAppMembership(env, userId)
  if (!membership) return 'Could not verify your role. Try again.'
  if (membership.role !== 'member' && membership.role !== 'admin') {
    return 'Only analysts can change a case.'
  }
  return null
}

async function loadCase(tools: ActionTools, caseId: string): Promise<Row<CaseData> | null> {
  const result = await tools.get<CaseData>('cases', caseId)
  if (!result.success) return null
  return { recordId: result.data.record.recordId, data: result.data.record.data }
}

async function loadEvidence(
  tools: ActionTools,
  caseId: string,
): Promise<{ ok: true; records: Row<EvidenceData>[] } | { ok: false; error: string }> {
  const result = await tools.query<EvidenceData>('evidence', { where: { caseId }, limit: 100 })
  if (!result.success) return { ok: false, error: result.error }
  return { ok: true, records: result.data.records.map(asRow) }
}

async function loadFindings(
  tools: ActionTools,
  caseId: string,
): Promise<{ ok: true; records: Row<FindingData>[] } | { ok: false; error: string }> {
  const result = await tools.query<FindingData>('findings', { where: { caseId }, limit: 200 })
  if (!result.success) return { ok: false, error: result.error }
  return { ok: true, records: result.data.records.map(asRow) }
}

function asRow<T>(record: { recordId: string; data: T }): Row<T> {
  return { recordId: record.recordId, data: record.data }
}

async function advance(tools: ActionTools, caseRow: Row<CaseData>, next: CaseStage): Promise<void> {
  const current = STAGE_INDEX.get(caseRow.data.stage) ?? 0
  const target = STAGE_INDEX.get(next) ?? 0
  if (target <= current) return
  await tools.update('cases', caseRow.recordId, { stage: next })
  caseRow.data = { ...caseRow.data, stage: next }
}

function clip(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  if (!trimmed || trimmed.length > max) return null
  return trimmed
}

function optionalClip(value: unknown, max: number): string {
  if (typeof value !== 'string') return ''
  return value.trim().slice(0, max)
}

function mintCaseNumber(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  const bytes = crypto.getRandomValues(new Uint8Array(6))
  let id = 'FP-'
  for (const byte of bytes) id += alphabet[byte % alphabet.length]
  return id
}

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function fail(error: string): ActionResult<never> {
  return { success: false, error }
}

/**
 * Admin-only: load the deterministic demo dataset. Records use fixed ids, so
 * `tools.create(..., recordId)` upserts and re-running refreshes rather than
 * duplicating. Cases in the `analysis` stage get their evidence analyzed now;
 * `evidence`-stage cases are left pending for an analyst to run.
 */
export const seedDemoCases: ActionHandler<Env> = async ({ userId, tools, env }) => {
  if (isAnonymousUserId(userId)) return fail('Sign in required.')
  const membership = await resolveAppMembership(env, userId)
  if (membership?.role !== 'admin') return fail('Only admins can load demo data.')

  let cases = 0
  let evidenceCount = 0
  for (const seed of buildSeedCases()) {
    const created = await tools.create<CaseData>(
      'cases',
      { caseNumber: seed.caseNumber, title: seed.title, summary: seed.summary, stage: seed.stage },
      seed.recordId,
    )
    if (!created.success) return created
    cases += 1

    for (const item of seed.evidence) {
      const analysis = seed.stage === 'analysis' ? analyzeEvidence(item.content) : null
      const written = await tools.create<EvidenceData>(
        'evidence',
        {
          caseId: seed.recordId,
          fileName: item.fileName,
          fileKey: '',
          byteSize: item.content.length,
          sha256: await sha256(item.content),
          status: 'stored',
          analysisStatus: analysis ? (analysis.error ? 'failed' : 'complete') : 'pending',
          analysisSummary: analysis?.summary ?? '',
          analysisWarnings: analysis?.warnings ?? [],
          eventCount: analysis?.events.length ?? 0,
          signals: analysis?.signals ?? [],
          content: item.content,
        },
        item.recordId,
      )
      if (!written.success) return written
      evidenceCount += 1
    }
  }
  return { success: true, data: { cases, evidence: evidenceCount } }
}
