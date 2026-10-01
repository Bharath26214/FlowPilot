import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import {
  addEvidence,
  analyzeEvidenceAction,
  createCase,
  exportReport,
  generateFindings,
  reviewFinding,
} from './investigation'

export const actions: Record<string, ActionHandler<Env>> = {
  createCase,
  addEvidence,
  analyzeEvidence: analyzeEvidenceAction,
  generateFindings,
  reviewFinding,
  exportReport,
}
