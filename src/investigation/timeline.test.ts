import { describe, expect, it } from 'vitest'
import { sourceExcerpt } from './analyze'
import { buildTimeline, describeAction } from './timeline'
import { SAMPLE_EVIDENCE } from './sample'
import type { BriefData, EvidenceData, FindingData } from './types'

const csv = [
  'time,actor,action,ip,result',
  '2026-04-02T10:45:01Z,a@example.com,auth.success,203.0.113.10,success',
  '2026-04-02T10:42:13Z,a@example.com,auth.failure,203.0.113.10,failure',
  '2026-04-02T10:43:02Z,a@example.com,auth.failure,203.0.113.10,failure',
  '2026-04-02T10:43:19Z,a@example.com,auth.failure,203.0.113.10,failure',
].join('\n')
const ndjson = '{"time":"2026-04-02T10:47:33Z","actor":"a@example.com","action":"file.read"}\n{"time":"2026-04-02T10:51:20Z","actor":"a@example.com","action":"file.download"}\n'

const evidence = [
  { recordId: 'ev1', data: { fileName: 'login.csv', content: csv, sha256: 'aa' } as EvidenceData },
  { recordId: 'ev2', data: { fileName: 'files.jsonl', content: ndjson, sha256: 'bb' } as EvidenceData },
]

describe('buildTimeline', () => {
  it('merges every file onto one clock with plain-language labels', () => {
    const timeline = buildTimeline({ evidence, findings: [] })
    expect(timeline.map((item) => [item.event.time.slice(11, 19), item.label])).toEqual([
      ['10:42:13', 'Failed login'],
      ['10:43:02', 'Failed login'],
      ['10:43:19', 'Failed login'],
      ['10:45:01', 'Successful login'],
      ['10:47:33', 'File accessed'],
      ['10:51:20', 'Data exported'],
    ])
  })

  it('ties events to signals, verdicts, and the assistant statements citing them', () => {
    const findings = [
      { recordId: 'f', data: { evidenceId: 'ev1', indicator: 'auth.after-failures:a@example.com', status: 'accepted' } as FindingData },
    ]
    const briefs = [
      {
        recordId: 'b',
        data: {
          question: 'What happened?',
          statements: [
            {
              text: 'Login after failures.',
              kind: 'evidence',
              unsupported: false,
              citations: [{ evidenceId: 'ev1', fileName: 'login.csv', label: 'line 2', ids: ['F1:L2'] }],
            },
          ],
        } as unknown as BriefData,
      },
    ]
    const timeline = buildTimeline({ evidence, findings, briefs })
    const success = timeline.find((item) => item.label === 'Successful login')!
    expect(success.key).toBe('ev1:line:2')
    expect(success.signals[0]).toMatchObject({ severity: 'high', verdict: 'accepted' })
    expect(success.citedBy).toEqual([{ question: 'What happened?', text: 'Login after failures.', kind: 'evidence' }])
    expect(timeline.find((item) => item.label === 'File accessed')!.signals).toEqual([])
  })

  it('falls back to a readable version of unknown actions', () => {
    expect(describeAction({ action: 'group.member_removed' } as never)).toBe('Group member removed')
  })
})

describe('sourceExcerpt', () => {
  it('returns the cited line with context', () => {
    const excerpt = sourceExcerpt(csv, { kind: 'line', n: 3 }, 1)
    expect(excerpt).toEqual({
      kind: 'lines',
      lines: [
        { n: 2, text: csv.split('\n')[1], cited: false },
        { n: 3, text: csv.split('\n')[2], cited: true },
        { n: 4, text: csv.split('\n')[3], cited: false },
      ],
    })
  })

  it('returns the cited JSON array element', () => {
    const excerpt = sourceExcerpt(SAMPLE_EVIDENCE, { kind: 'event', n: 5 })
    expect(excerpt?.kind).toBe('json')
    expect(excerpt && 'text' in excerpt ? excerpt.text : '').toContain('Global Administrator')
  })
})
