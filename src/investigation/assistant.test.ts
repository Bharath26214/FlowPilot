import { describe, expect, it } from 'vitest'
import { analyzeEvidence } from './analyze'
import { buildContext, checkAnswer } from './assistant'
import { SAMPLE_EVIDENCE } from './sample'
import type { CaseData, EvidenceData, FindingData } from './types'

const caseData: CaseData = { caseNumber: 'FP-TEST', title: 'Sign-in review', summary: '', stage: 'review' }

function evidenceRow(recordId: string, fileName: string, content: string) {
  return { recordId, data: { fileName, content, sha256: 'abc' } as EvidenceData }
}

const csv = [
  'time,actor,action,ip,result',
  '2026-04-02T01:00:00Z,a@example.com,auth.failure,203.0.113.10,failure',
  '2026-04-02T01:01:00Z,a@example.com,auth.failure,203.0.113.10,failure',
  '2026-04-02T01:02:00Z,a@example.com,auth.failure,203.0.113.10,failure',
  '2026-04-02T01:03:00Z,a@example.com,auth.success,203.0.113.10,success',
].join('\n')

describe('event locations', () => {
  it('cites CSV file lines, counting the header', () => {
    const signal = analyzeEvidence(csv).signals.find((item) => item.kind === 'auth.after-failures')
    expect(signal?.refs).toEqual([2, 3, 4, 5].map((n) => ({ kind: 'line', n })))
  })

  it('cites JSON array positions', () => {
    const signal = analyzeEvidence(SAMPLE_EVIDENCE).signals.find((item) => item.kind === 'privilege.change')
    expect(signal?.refs).toEqual([{ kind: 'event', n: 5 }])
  })

  it('cites NDJSON lines including blank lines', () => {
    const ndjson = '{"actor":"a@example.com","action":"x.y"}\n\n{"actor":"b@example.com","action":"role.grant","result":"success"}\n'
    const signal = analyzeEvidence(ndjson).signals.find((item) => item.kind === 'privilege.change')
    expect(signal?.refs).toEqual([{ kind: 'line', n: 3 }])
  })
})

describe('buildContext', () => {
  it('hands the model citable events and analyst verdicts, never raw files', () => {
    const finding = {
      recordId: 'f1',
      data: { evidenceId: 'ev1', indicator: 'auth.after-failures:a@example.com', status: 'dismissed' } as FindingData,
    }
    const context = buildContext({ case: caseData, evidence: [evidenceRow('ev1', 'login.csv', csv)], findings: [finding] })
    expect([...context.catalog.keys()]).toEqual(['F1:L2', 'F1:L3', 'F1:L4', 'F1:L5'])
    const text = JSON.stringify(context.brief)
    expect(text).toContain('dismissed by analyst')
    expect(text).not.toContain('time,actor,action')
  })
})

describe('checkAnswer', () => {
  const context = buildContext({ case: caseData, evidence: [evidenceRow('ev1', 'login.csv', csv)], findings: [] })

  it('keeps cited evidence and renders line ranges', () => {
    const answer = checkAnswer(
      JSON.stringify({
        statements: [{ text: 'Three failures, then a success.', kind: 'evidence', cites: ['F1:L2', 'F1:L3', 'F1:L4', 'F1:L5'] }],
        openQuestions: ['Was MFA enforced?'],
      }),
      context.catalog,
    )
    if ('error' in answer) throw new Error(answer.error)
    expect(answer.statements[0]).toMatchObject({ kind: 'evidence', unsupported: false })
    expect(answer.statements[0].citations[0]).toMatchObject({ fileName: 'login.csv', label: 'lines 2–5' })
    expect(answer.openQuestions).toEqual(['Was MFA enforced?'])
  })

  it('drops invented citations and downgrades unsupported evidence to inference', () => {
    const answer = checkAnswer(
      '```json\n{"statements":[{"text":"Attacker exfiltrated mail.","kind":"evidence","cites":["F1:L999","F9:E1"]}]}\n```',
      context.catalog,
    )
    if ('error' in answer) throw new Error(answer.error)
    expect(answer.statements[0]).toMatchObject({ kind: 'inference', unsupported: true, citations: [] })
    expect(answer.droppedCitations).toBe(2)
  })

  it('rejects malformed output', () => {
    expect(checkAnswer('I think the account was compromised.', context.catalog)).toHaveProperty('error')
  })
})
