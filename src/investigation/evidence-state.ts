/**
 * Evidence analysis lifecycle, shared by the server action and the UI so both
 * agree on when a run is stuck.
 *
 * A file is marked `running` (with `analysisStartedAt`) before it is analyzed.
 * If the Worker dies mid-run — CPU limit, deploy, crash — nothing ever flips it
 * back, so a `running` record older than ANALYSIS_TIMEOUT_MS is treated as
 * timed out: shown as such, and eligible for retry.
 */
import type { EvidenceData } from './types'

export const ANALYSIS_TIMEOUT_MS = 2 * 60_000

export type EvidenceState = 'pending' | 'running' | 'timed-out' | 'failed' | 'complete'

export function evidenceState(data: Pick<EvidenceData, 'analysisStatus' | 'analysisStartedAt'>, now = Date.now()): EvidenceState {
  if (data.analysisStatus !== 'running') return data.analysisStatus
  const started = data.analysisStartedAt ? Date.parse(data.analysisStartedAt) : NaN
  // A running record with no start time predates timeouts; treat it as stuck.
  if (Number.isNaN(started) || now - started > ANALYSIS_TIMEOUT_MS) return 'timed-out'
  return 'running'
}

/** Whether the analyze action should (re)run this file. */
export function needsAnalysis(data: Pick<EvidenceData, 'analysisStatus' | 'analysisStartedAt'>, now = Date.now()): boolean {
  const state = evidenceState(data, now)
  return state === 'pending' || state === 'failed' || state === 'timed-out'
}
