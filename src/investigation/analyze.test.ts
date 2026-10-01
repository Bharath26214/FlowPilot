import { describe, expect, it } from 'vitest'
import { analyzeEvidence } from './analyze'
import { buildReport } from './report'
import { SAMPLE_EVIDENCE } from './sample'

describe('analyzeEvidence', () => {
  it('reads the sample sign-in log into cited indicators', () => {
    const analysis = analyzeEvidence(SAMPLE_EVIDENCE)
    expect(analysis.error).toBeUndefined()
    expect(analysis.events.length).toBe(17)
    const kinds = analysis.signals.map((signal) => signal.kind).sort()
    expect(kinds).toEqual([
      'account.control-change',
      'auth.after-failures',
      'auth.repeated-failure',
      'auth.shared-source',
      'privilege.change',
    ])
  })

  it('reads a CSV with a header row', () => {
    const csv = [
      'timestamp,user,operation,clientIp,outcome',
      '2026-04-02T01:00:00Z,a@example.com,auth.failure,203.0.113.10,failure',
      '2026-04-02T01:01:00Z,a@example.com,auth.failure,203.0.113.10,failure',
      '2026-04-02T01:02:00Z,a@example.com,auth.failure,203.0.113.10,failure',
      '2026-04-02T01:03:00Z,a@example.com,auth.success,203.0.113.10,success',
    ].join('\n')
    const analysis = analyzeEvidence(csv)
    expect(analysis.events).toHaveLength(4)
    expect(analysis.signals.map((signal) => signal.kind)).toContain('auth.after-failures')
  })

  it('refuses a file with no events', () => {
    const analysis = analyzeEvidence('hello\nthis is a note\n')
    expect(analysis.error).toMatch(/No events/)
    expect(analysis.signals).toEqual([])
  })

  it('keeps drafts out of the exported report', () => {
    const body = buildReport({
      case: { caseNumber: 'FP-TEST', title: 'Finance mailbox', summary: '', stage: 'review' },
      evidence: [],
      findings: [
        {
          caseId: 'c',
          evidenceId: 'e',
          title: 'Draft only',
          detail: 'not confirmed',
          severity: 'high',
          status: 'draft',
          indicator: 'draft:1',
        },
        {
          caseId: 'c',
          evidenceId: 'e',
          title: 'Confirmed takeover',
          detail: 'Signed in after failures.',
          severity: 'high',
          status: 'accepted',
          indicator: 'auth.after-failures:morgan@example.com',
        },
      ],
      exportedAt: '2026-04-02T12:00:00.000Z',
    })
    expect(body).toContain('FP-TEST')
    expect(body).toContain('Confirmed takeover')
    expect(body).not.toContain('Draft only')
  })
})
