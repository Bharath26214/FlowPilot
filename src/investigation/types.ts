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
export type FindingStatus = 'draft' | 'accepted' | 'dismissed'
export type Severity = 'low' | 'medium' | 'high'

export type Signal = {
  kind: string
  severity: Severity
  title: string
  detail: string
  indicator: string
}

export type NormalizedEvent = {
  time: string
  actor: string
  action: string
  ip: string
  result: string
  detail: string
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
}

export type FindingData = {
  caseId: string
  evidenceId: string
  title: string
  detail: string
  severity: Severity
  status: FindingStatus
  indicator: string
}

export type ReportData = {
  caseId: string
  body: string
  exportedAt: string
}

export const MAX_EVIDENCE_CHARS = 200_000
