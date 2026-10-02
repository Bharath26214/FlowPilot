import type { ActionHandler } from 'deepspace/worker'
import type { Env } from '../../worker'
import {
  addEvidence,
  analyzeEvidenceAction,
  askAssistant,
  createCase,
  createReportPdf,
  deleteCase,
  exportReport,
  generateFindings,
  lookupIntel,
  reviewFinding,
  seedDemoCases,
} from './investigation'

export const actions: Record<string, ActionHandler<Env>> = {
  createCase,
  addEvidence,
  analyzeEvidence: analyzeEvidenceAction,
  generateFindings,
  reviewFinding,
  exportReport,
  seedDemoCases,
  askAssistant,
  lookupIntel,
  createReportPdf,
  deleteCase,
}
