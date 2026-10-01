import { isAnonymousUserId, resolveAppMembership } from 'deepspace/worker'
import type { ActionHandler, ActionResult, ActionTools } from 'deepspace/worker'
import type { Env } from '../../worker'
import { analyzeEvidence } from '../investigation/analyze'
import { buildReport } from '../investigation/report'
import type {
  CaseData,
  CaseStage,
  EvidenceData,
  FindingData,
  ReportData,
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
  if (!content.trim()) return fail('The file is empty.')
  if (content.length > MAX_EVIDENCE_CHARS) {
    return fail(`Evidence must be under ${MAX_EVIDENCE_CHARS.toLocaleString()} characters.`)
  }
  if (content.includes('\u0000')) return fail('This file looks binary. Upload a JSON, CSV, or text log.')

  const caseRow = await loadCase(tools, caseId)
  if (!caseRow) return fail('Case not found.')

  const created = await tools.create<EvidenceData>('evidence', {
    caseId,
    fileName,
    fileKey,
    byteSize,
    sha256: await sha256(content),
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

export const analyzeEvidenceAction: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const denied = await requireAnalyst(env, userId)
  if (denied) return fail(denied)

  const caseId = clip(params.caseId, 80)
  if (!caseId) return fail('Case not found.')
  const caseRow = await loadCase(tools, caseId)
  if (!caseRow) return fail('Case not found.')

  const evidence = await loadEvidence(tools, caseId)
  if (!evidence.ok) return fail(evidence.error)
  const pending = evidence.records.filter((row) => row.data.analysisStatus === 'pending' || row.data.analysisStatus === 'failed')
  if (pending.length === 0) return fail('Nothing is waiting for analysis.')

  await advance(tools, caseRow, 'analysis')

  let analyzed = 0
  let failed = 0
  for (const row of pending) {
    await tools.update('evidence', row.recordId, { analysisStatus: 'running' })
    const analysis = analyzeEvidence(row.data.content ?? '')
    if (analysis.error) {
      failed += 1
      await tools.update('evidence', row.recordId, {
        analysisStatus: 'failed',
        analysisSummary: analysis.error,
        eventCount: 0,
        signals: [],
      })
      continue
    }
    analyzed += 1
    await tools.update('evidence', row.recordId, {
      analysisStatus: 'complete',
      analysisSummary: analysis.summary,
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

  let created = 0
  for (const row of evidence.records) {
    for (const item of asSignals(row.data.signals)) {
      if (kept.has(`${row.recordId}:${item.indicator}`)) continue
      const written = await tools.create<FindingData>('findings', {
        caseId,
        evidenceId: row.recordId,
        title: item.title,
        detail: item.detail,
        severity: item.severity,
        status: 'draft',
        indicator: item.indicator,
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

export const reviewFinding: ActionHandler<Env> = async ({ userId, params, tools, env }) => {
  const denied = await requireAnalyst(env, userId)
  if (denied) return fail(denied)

  const findingId = clip(params.findingId, 80)
  const decision = params.decision === 'accepted' || params.decision === 'dismissed' ? params.decision : null
  if (!findingId || !decision) return fail('Choose accept or dismiss.')

  const loaded = await tools.get<FindingData>('findings', findingId)
  if (!loaded.success) return fail('Finding not found.')
  const finding = loaded.data.record
  if (finding.data.status !== 'draft') return fail('This finding was already reviewed.')

  const updated = await tools.update('findings', findingId, { status: decision })
  if (!updated.success) return updated

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
  if (findings.records.some((row) => row.data.status === 'draft')) {
    return fail('Review every finding before exporting.')
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
    ? await tools.update('reports', existing.recordId, { body, exportedAt })
    : await tools.create<ReportData>('reports', { caseId, body, exportedAt })
  if (!saved.success) return saved

  await tools.update('cases', caseId, { stage: 'exported' })
  return { success: true, data: { exportedAt } }
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

function asSignals(value: unknown): Signal[] {
  if (!Array.isArray(value)) return []
  return value.filter((item): item is Signal => {
    if (!item || typeof item !== 'object') return false
    const signal = item as Signal
    return (
      typeof signal.title === 'string' &&
      typeof signal.detail === 'string' &&
      typeof signal.indicator === 'string' &&
      (signal.severity === 'low' || signal.severity === 'medium' || signal.severity === 'high')
    )
  })
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
