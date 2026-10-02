import { describe, expect, it } from 'vitest'
import { analyzeEvidence } from './analyze'
import { assessSignal, type FileEvents } from './assess'

function file(evidenceId: string, content: string) {
  const analysis = analyzeEvidence(content)
  return { evidenceId, events: analysis.events, signals: analysis.signals } satisfies FileEvents & { signals: unknown[] }
}

const login = file(
  'login',
  [
    'time,actor,action,ip,result',
    '2026-04-01T09:00:00Z,a@example.com,auth.success,10.0.0.5,success',
    '2026-04-02T02:42:13Z,a@example.com,auth.failure,203.0.113.10,failure',
    '2026-04-02T02:43:02Z,a@example.com,auth.failure,203.0.113.10,failure',
    '2026-04-02T02:43:19Z,a@example.com,auth.failure,203.0.113.10,failure',
    '2026-04-02T02:45:01Z,a@example.com,auth.success,203.0.113.10,success',
  ].join('\n'),
)

describe('assessSignal', () => {
  it('scores credential compromise from a cited checklist', () => {
    const signal = login.signals.find((item) => item.kind === 'auth.after-failures')!
    const result = assessSignal(signal, login, [login])
    expect(result.hypothesis).toBe('Possible credential compromise')
    const present = result.factors.filter((factor) => factor.present).map((factor) => factor.label)
    expect(present).toEqual([
      '3 failed logins',
      '1 successful login afterwards',
      'New IP address',
      'Outside business hours (22:00–06:00 UTC)',
    ])
    // base 40 + 15 + 15 + 15 + 5
    expect(result.confidence).toBe(90)
    const newIp = result.factors.find((factor) => factor.label === 'New IP address')!
    expect(newIp.refs).toEqual([{ evidenceId: 'login', loc: { kind: 'line', n: 6 } }])
  })

  it('does not count a known address as new', () => {
    const known = file(
      'known',
      [
        'time,actor,action,ip,result',
        '2026-04-01T09:00:00Z,a@example.com,auth.success,203.0.113.10,success',
        '2026-04-02T12:42:13Z,a@example.com,auth.failure,203.0.113.10,failure',
        '2026-04-02T12:43:02Z,a@example.com,auth.failure,203.0.113.10,failure',
        '2026-04-02T12:43:19Z,a@example.com,auth.failure,203.0.113.10,failure',
        '2026-04-02T12:45:01Z,a@example.com,auth.success,203.0.113.10,success',
      ].join('\n'),
    )
    const signal = known.signals.find((item) => item.kind === 'auth.after-failures')!
    const result = assessSignal(signal, known, [known])
    expect(result.factors.find((factor) => factor.label === 'New IP address')!.present).toBe(false)
    expect(result.confidence).toBe(70)
  })

  it('raises confidence with corroboration from another file and cites it there', () => {
    const audit = file('audit', '{"time":"2026-04-02T02:50:00Z","actor":"a@example.com","action":"role.grant","result":"success"}\n{"time":"2026-04-02T02:51:00Z","actor":"b@example.com","action":"file.read"}\n')
    const signal = login.signals.find((item) => item.kind === 'auth.after-failures')!
    const result = assessSignal(signal, login, [login, audit])
    const escalation = result.factors.find((factor) => factor.label === 'Admin rights granted afterwards')!
    expect(escalation.present).toBe(true)
    expect(escalation.refs).toEqual([{ evidenceId: 'audit', loc: { kind: 'line', n: 1 } }])
    expect(result.confidence).toBe(97) // capped
  })
})

describe('assessSignal sign-in counting', () => {
  it('does not count a role grant as a successful login', () => {
    const burst = file(
      'burst',
      [
        'time,actor,action,ip,result',
        '2026-04-02T01:00:00Z,m@example.com,auth.failure,203.0.113.44,failure',
        '2026-04-02T01:01:00Z,m@example.com,auth.failure,203.0.113.44,failure',
        '2026-04-02T01:02:00Z,m@example.com,auth.failure,203.0.113.44,failure',
        '2026-04-02T01:03:00Z,m@example.com,auth.success,203.0.113.44,success',
        '2026-04-02T01:08:00Z,m@example.com,role.grant,203.0.113.44,success',
      ].join('\n'),
    )
    const signal = burst.signals.find((item) => item.kind === 'auth.after-failures')!
    const labels = assessSignal(signal, burst, [burst]).factors.map((factor) => factor.label)
    expect(labels).toContain('1 successful login afterwards')
  })
})
