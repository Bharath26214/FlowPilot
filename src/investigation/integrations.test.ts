import { describe, expect, it } from 'vitest'
import { buildContext, checkAnswer } from './assistant'
import { normalizeIntel, searchableIps } from './intel'
import { reportHtml, toBase64 } from './report-html'
import type { CaseData, EvidenceData, IntelData } from './types'

describe('searchableIps', () => {
  it('keeps public addresses only, deduped and capped at three', () => {
    expect(
      searchableIps(['10.0.4.12', '192.168.1.5', '172.20.0.1', '127.0.0.1', '100.64.0.1', '185.220.101.1', '185.220.101.1', '203.0.113.44', '8.8.8.8', '1.1.1.1']),
    ).toEqual(['185.220.101.1', '203.0.113.44', '8.8.8.8'])
  })

  it('never passes non-IP text such as account names', () => {
    expect(searchableIps(['morgan@example.com', 'not an ip', '999.1.1.1', 'fe80::1', '2001:db8::1'])).toEqual(['2001:db8::1'])
  })
})

describe('normalizeIntel', () => {
  it('keeps title, url, and a trimmed snippet, dropping non-http links', () => {
    const results = normalizeIntel({
      results: [
        { title: 'Spam report', url: 'https://cleantalk.org/x', publishedDate: null, highlights: ['Listed   for\nspam ... activity'] },
        { title: 'Bad', url: 'javascript:alert(1)', publishedDate: null },
      ],
    })
    expect(results).toEqual([{ title: 'Spam report', url: 'https://cleantalk.org/x', publishedDate: null, snippet: 'Listed for spam … activity' }])
  })
})

describe('reportHtml', () => {
  it('renders the report structure and escapes log-derived text', () => {
    const html = reportHtml(
      ['# FP-1', '', 'Title <script>alert(1)</script>', '', '## Evidence', '', '- login.csv', '  - SHA-256: abc', '', '### Finding', '- [x] New IP address (+15)', '- [ ] Admin rights granted afterwards'].join('\n'),
      'FP-1',
    )
    expect(html).toContain('<h1>FP-1</h1>')
    expect(html).toContain('&lt;script&gt;')
    expect(html).not.toContain('<script>')
    expect(html).toMatch(/<ul>\s*<li>login.csv<\/li>\s*<ul>\s*<li>SHA-256: abc<\/li>/)
    expect(html).toContain('<li class="check yes">✓ New IP address (+15)</li>')
    expect(html).toContain('<li class="check no">– Admin rights granted afterwards</li>')
  })

  it('base64-encodes UTF-8 safely', () => {
    expect(atob(toBase64('✓ é'))).toBe(String.fromCharCode(...new TextEncoder().encode('✓ é')))
  })
})

describe('assistant with web context', () => {
  const csv = 'time,actor,action,ip,result\n2026-04-02T01:00:00Z,a@x.com,role.grant,185.220.101.1,success\n'
  const context = buildContext({
    case: { caseNumber: 'FP-1', title: 't', summary: '', stage: 'review' } as CaseData,
    evidence: [{ recordId: 'ev1', data: { fileName: 'audit.csv', content: csv } as EvidenceData }],
    findings: [],
    intel: [
      {
        recordId: 'i1',
        data: {
          findingId: 'f1',
          indicator: '185.220.101.1',
          results: [{ title: 'Tor exit relay', url: 'https://example.org/tor', publishedDate: null, snippet: 'Tor relay' }],
        } as IntelData,
      },
    ],
  })

  it('gives web results W ids, separate from event citations', () => {
    expect([...context.web.keys()]).toEqual(['W1'])
    expect(JSON.stringify(context.brief)).toContain('"externalContext"')
  })

  it('never lets a web result alone make a statement evidence', () => {
    const answer = checkAnswer(
      JSON.stringify({
        statements: [
          { text: 'The IP is a Tor exit.', kind: 'evidence', cites: ['W1'] },
          { text: 'Admin granted from a Tor exit.', kind: 'inference', cites: ['F1:L2', 'W1'] },
        ],
      }),
      context.catalog,
      context.web,
    )
    if ('error' in answer) throw new Error(answer.error)
    expect(answer.statements[0]).toMatchObject({ kind: 'inference', unsupported: true, web: [{ id: 'W1' }] })
    expect(answer.statements[1]).toMatchObject({ kind: 'inference', unsupported: false })
    expect(answer.statements[1].citations[0].label).toBe('line 2')
    expect(answer.droppedCitations).toBe(0)
  })
})
