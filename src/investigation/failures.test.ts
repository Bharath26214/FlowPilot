import { describe, expect, it } from 'vitest'
import { analyzeEvidence } from './analyze'
import { buildContext, runAssistant, type Generate } from './assistant'
import { ANALYSIS_TIMEOUT_MS, evidenceState, needsAnalysis } from './evidence-state'
import type { CaseData, EvidenceData } from './types'

describe('invalid evidence file', () => {
  it('rejects binary content', () => {
    expect(analyzeEvidence('PK\u0003\u0004\u0000\u0000binary').error).toMatch(/binary/)
  })

  it('rejects text that did not decode (compressed or wrong encoding)', () => {
    expect(analyzeEvidence('���x��').error).toMatch(/not readable text/)
  })

  it('explains prose that holds no events', () => {
    expect(analyzeEvidence('Dear team,\nplease see the incident notes.\nThanks').error).toMatch(/No events found/)
  })
})

describe('empty evidence', () => {
  it.each([['empty', ''], ['whitespace only', '  \n\n\t '], ['byte-order mark only', '﻿']])('rejects %s', (_, text) => {
    expect(analyzeEvidence(text).error).toBe('The file is empty.')
  })

  it('rejects an empty JSON list', () => {
    expect(analyzeEvidence('[]').error).toMatch(/empty or holds no objects/)
  })
})

describe('malformed JSON and logs', () => {
  it('reports truncated JSON with the line it broke on', () => {
    const text = '[\n  {"actor":"m@x.com","action":"auth.failure"},\n  {"actor":"m@x.com","action":"auth.fai'
    const analysis = analyzeEvidence(text)
    expect(analysis.error).toBe('Unable to parse the JSON: the file ends inside a string (line 3, column 40).')
    expect(analysis.errorLine).toBe(3)
  })

  it('reports a trailing comma', () => {
    const analysis = analyzeEvidence('[{"actor":"a@x.com","action":"auth.failure"},\n]')
    expect(analysis.error).toBe('Unable to parse the JSON: trailing comma before ] (line 2, column 1).')
    expect(analysis.errorLine).toBe(2)
  })

  it('explains JSON that has no event list', () => {
    expect(analyzeEvidence('{"hello":"world"}').error).toMatch(/no list of events/)
  })

  it('keeps readable JSON lines and reports the broken ones', () => {
    const analysis = analyzeEvidence('{"actor":"a@x.com","action":"auth.failure"}\n{"actor":"a@x.com", oops}\n{"actor":"a@x.com","action":"auth.success"}')
    expect(analysis.error).toBeUndefined()
    expect(analysis.events.map((event) => event.loc.n)).toEqual([1, 3])
    expect(analysis.warnings).toEqual(['1 line could not be read and was skipped (line 2).'])
  })

  it('pinpoints the first broken line when no JSON line is readable', () => {
    const analysis = analyzeEvidence('{oops}\n{nope}\n{bad}')
    expect(analysis.error).toBe('Unable to parse the JSON: expected a quoted key but found "o" (line 1, column 2).')
    expect(analysis.errorLine).toBe(1)
  })

  it('names the missing CSV column and the columns it found', () => {
    const analysis = analyzeEvidence('timestamp,host,bytes\n2026-04-02T01:00:00Z,web1,512\n2026-04-02T01:01:00Z,web2,128\n')
    expect(analysis.error).toBe('The CSV header has no user column (user, email, actor, account). Found: timestamp, host, bytes.')
    expect(analysis.errorLine).toBe(1)
  })

  it('warns about rows it had to skip instead of failing the file', () => {
    const analysis = analyzeEvidence('time,actor,action\n2026-04-02T01:00:00Z,a@x.com,auth.failure\n2026-04-02T01:01:00Z,,auth.failure\n')
    expect(analysis.events).toHaveLength(1)
    expect(analysis.warnings).toEqual(['1 row skipped: no actor or action (first at line 3).'])
  })

  it('keeps line numbers true when the file starts with blank lines', () => {
    const analysis = analyzeEvidence('\n\n{"actor":"a@x.com","action":"role.grant","result":"success"}\n{"actor":"b@x.com","action":"x.y"}')
    expect(analysis.events[0].loc).toEqual({ kind: 'line', n: 3 })
  })
})

describe('analysis timeout', () => {
  const started = '2026-10-02T12:00:00.000Z'
  const at = (ms: number) => Date.parse(started) + ms

  it('treats a run older than the timeout as timed out and retryable', () => {
    const data = { analysisStatus: 'running' as const, analysisStartedAt: started }
    expect(evidenceState(data, at(ANALYSIS_TIMEOUT_MS - 1))).toBe('running')
    expect(needsAnalysis(data, at(ANALYSIS_TIMEOUT_MS - 1))).toBe(false)
    expect(evidenceState(data, at(ANALYSIS_TIMEOUT_MS + 1))).toBe('timed-out')
    expect(needsAnalysis(data, at(ANALYSIS_TIMEOUT_MS + 1))).toBe(true)
  })

  it('treats a running record without a start time as stuck', () => {
    expect(evidenceState({ analysisStatus: 'running' })).toBe('timed-out')
  })

  it('retries failed and pending files but not finished ones', () => {
    expect(needsAnalysis({ analysisStatus: 'failed' })).toBe(true)
    expect(needsAnalysis({ analysisStatus: 'pending' })).toBe(true)
    expect(needsAnalysis({ analysisStatus: 'complete' })).toBe(false)
  })

  it('analyzes the largest allowed single-actor file well inside the CPU budget', () => {
    // Worst case for the old cubic scan: every success before every failure.
    const rows = ['time,actor,action,ip,result']
    for (let i = 0; i < 2500; i++) rows.push(`2026-04-02T01:00:00Z,a@x.com,auth.success,1.2.3.4,success`)
    for (let i = 0; i < 2500; i++) rows.push(`2026-04-02T02:00:00Z,a@x.com,auth.failure,1.2.3.4,failure`)
    const start = performance.now()
    const analysis = analyzeEvidence(rows.join('\n'))
    expect(analysis.events).toHaveLength(5000)
    expect(performance.now() - start).toBeLessThan(1_000)
  })
})

describe('AI failures', () => {
  const csv = 'time,actor,action,ip,result\n2026-04-02T01:00:00Z,a@x.com,auth.failure,1.2.3.4,failure\n2026-04-02T01:01:00Z,a@x.com,auth.failure,1.2.3.4,failure\n2026-04-02T01:02:00Z,a@x.com,auth.failure,1.2.3.4,failure\n2026-04-02T01:03:00Z,a@x.com,auth.success,1.2.3.4,success\n'
  const context = buildContext({
    case: { caseNumber: 'FP-1', title: 't', summary: '', stage: 'analysis' } as CaseData,
    evidence: [{ recordId: 'ev1', data: { fileName: 'login.csv', content: csv } as EvidenceData }],
    findings: [],
  })
  const good = JSON.stringify({ statements: [{ text: 'Three failures then a success.', kind: 'evidence', cites: ['F1:L2', 'F1:L5'] }] })

  it('reports the AI service as unavailable without throwing', async () => {
    const generate: Generate = async () => {
      throw new Error('502 Bad Gateway')
    }
    const result = await runAssistant({ question: 'q', context, generate })
    expect(result).toMatchObject({ error: 'unavailable' })
    expect('message' in result && result.message).toMatch(/unavailable right now.*unaffected/)
  })

  it('times out a hung model call and aborts it', async () => {
    let aborted = false
    const generate: Generate = ({ signal }) =>
      new Promise((_, reject) => {
        signal.addEventListener('abort', () => {
          aborted = true
          reject(signal.reason)
        })
      })
    const result = await runAssistant({ question: 'q', context, generate, timeoutMs: 20 })
    expect(result).toMatchObject({ error: 'timeout' })
    expect(aborted).toBe(true)
  })

  it('repairs one malformed reply', async () => {
    const replies = ['Sure! Here is what happened…', good]
    const prompts: string[] = []
    const generate: Generate = async ({ prompt }) => {
      prompts.push(prompt)
      return replies.shift()!
    }
    const result = await runAssistant({ question: 'q', context, generate })
    expect(result).not.toHaveProperty('error')
    expect(prompts[1]).toMatch(/not JSON in the required shape/)
  })

  it('gives up after two malformed replies', async () => {
    const generate: Generate = async () => '{"statements": "nope"}'
    expect(await runAssistant({ question: 'q', context, generate })).toMatchObject({ error: 'malformed' })
  })

  it('flags an answer whose conclusions are not tied to any source line', async () => {
    const generate: Generate = async () =>
      JSON.stringify({
        statements: [
          { text: 'The attacker exfiltrated payroll data.', kind: 'evidence', cites: ['F1:L999'] },
          { text: 'This was likely a nation-state actor.', kind: 'inference', cites: [] },
        ],
      })
    const result = await runAssistant({ question: 'q', context, generate })
    if ('error' in result) throw new Error(result.message)
    expect(result.statements[0]).toMatchObject({ kind: 'inference', unsupported: true })
    expect(result.droppedCitations).toBe(1)
    expect(result.warning).toBe('No statement in this answer is tied to a source line. Treat all of it as unverified.')
  })

  it('names how many statements were unsupported when others are backed', async () => {
    const generate: Generate = async () =>
      JSON.stringify({
        statements: [
          { text: 'Three failures then a success.', kind: 'evidence', cites: ['F1:L2'] },
          { text: 'Payroll was exported.', kind: 'evidence', cites: [] },
        ],
      })
    const result = await runAssistant({ question: 'q', context, generate })
    if ('error' in result) throw new Error(result.message)
    expect(result.warning).toBe('1 statement was stated as fact without a valid citation and is marked Unsupported.')
  })
})
