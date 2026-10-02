import type { Factor } from './assess'
import type { Statement } from './assistant'
import type { IntelResult } from './intel'

export const CASE_STAGES = [
  'intake',
  'evidence',
  'analysis',
  'findings',
  'review',
  'exported',
] as const

export type CaseStage = (typeof CASE_STAGES)[number]

export type AnalysisStatus = 'pending' | 'running' | 'complete' | 'failed'
export type FindingStatus = 'draft' | 'investigating' | 'accepted' | 'dismissed'
export type ReviewDecision = Exclude<FindingStatus, 'draft'>
export type Severity = 'low' | 'medium' | 'high'

/**
 * Where an event sits in its source file: a 1-based line for line-oriented
 * formats (CSV, NDJSON, text), or a 1-based position for a JSON array.
 */
export type EventLoc = { kind: 'line' | 'event'; n: number }

export type Signal = {
  kind: string
  severity: Severity
  title: string
  detail: string
  indicator: string
  /** The events that produced this signal. Absent on records analyzed before locations existed. */
  refs?: EventLoc[]
}

export type NormalizedEvent = {
  time: string
  actor: string
  action: string
  ip: string
  result: string
  detail: string
  loc: EventLoc
}

export type CaseData = {
  caseNumber: string
  title: string
  summary: string
  stage: CaseStage
}

export type EvidenceData = {
  caseId: string
  fileName: string
  fileKey: string
  byteSize: number
  sha256: string
  status: 'stored'
  analysisStatus: AnalysisStatus
  analysisSummary: string
  eventCount: number
  signals: Signal[]
  content: string
  /** Non-fatal problems from the last analysis, e.g. skipped lines. */
  analysisWarnings?: string[]
  /** The line a failed analysis points at, when known. */
  analysisErrorLine?: number
  /** When the current or last run began; a stale `running` means it timed out. */
  analysisStartedAt?: string
}

export type FindingData = {
  caseId: string
  evidenceId: string
  title: string
  detail: string
  severity: Severity
  status: FindingStatus
  indicator: string
  /** Plain-language hypothesis, e.g. "Possible credential compromise". Absent on older findings. */
  hypothesis?: string
  /** 0–100, computed from `factors`, never by the model. */
  confidence?: number
  factors?: Factor[]
  /** The investigator's latest decision; full history lives in `reviews`. */
  decidedBy?: string
  decidedAt?: string
  decisionNote?: string
}

/** One investigator decision. Append-only audit trail. */
export type ReviewData = {
  caseId: string
  findingId: string
  decision: ReviewDecision
  note: string
  reviewer: string
  decidedAt: string
  /** The confidence shown to the reviewer when they decided. */
  confidenceShown: number
}

export type ReportData = {
  caseId: string
  body: string
  exportedAt: string
  /** CloudConvert download link for the PDF of `body`; it stops working at `pdfExpiresAt`. */
  pdfUrl?: string
  pdfExpiresAt?: string
}

/** Web results for one IP on one finding. External and unverified. */
export type IntelData = {
  caseId: string
  findingId: string
  indicator: string
  results: IntelResult[]
  lookedUpBy: string
  lookedUpAt: string
}

export type BriefData = {
  caseId: string
  question: string
  statements: Statement[]
  openQuestions: string[]
  droppedCitations: number
  /** Set when the answer is weakly supported, e.g. no statement cites a source line. */
  warning?: string
  model: string
  askedBy: string
  askedAt: string
}

export const DEFAULT_QUESTION = 'What happened in this investigation?'

export const MAX_EVIDENCE_CHARS = 200_000
