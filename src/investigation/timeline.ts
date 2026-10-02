/**
 * Case timeline: every event from every evidence file on one clock, each tied
 * back to its source line, the signals it supports, the analyst's verdict on
 * those signals, and any assistant statement that cites it.
 */
import { analyzeEvidence } from './analyze'
import type { BriefData, EventLoc, EvidenceData, FindingData, FindingStatus, NormalizedEvent, Severity } from './types'

type Row<T> = { recordId: string; data: T }

export type TimelineSignal = {
  title: string
  detail: string
  severity: Severity
  indicator: string
  verdict: FindingStatus | 'none'
}

export type TimelineEvent = {
  /** Stable id: `<evidenceId>:<line|event>:<n>`. */
  key: string
  evidenceId: string
  fileName: string
  sha256: string
  loc: EventLoc
  event: NormalizedEvent
  label: string
  outcome: 'failure' | 'success' | 'neutral'
  /** Epoch ms, or null when the time could not be parsed. */
  at: number | null
  signals: TimelineSignal[]
  /** Assistant statements that cite this event. */
  citedBy: Array<{ question: string; text: string; kind: 'evidence' | 'inference' }>
}

export function eventKey(evidenceId: string, loc: EventLoc): string {
  return `${evidenceId}:${loc.kind}:${loc.n}`
}

export function buildTimeline(input: {
  evidence: Row<EvidenceData>[]
  findings: Row<FindingData>[]
  briefs?: Row<BriefData>[]
}): TimelineEvent[] {
  const verdicts = new Map(input.findings.map((row) => [`${row.data.evidenceId}:${row.data.indicator}`, row.data.status]))
  const citations = citationIndex(input.briefs ?? [])
  const events: TimelineEvent[] = []

  for (const row of input.evidence) {
    const analysis = analyzeEvidence(row.data.content ?? '')
    const signalsByPosition = new Map<number, TimelineSignal[]>()
    for (const signal of analysis.signals) {
      const item: TimelineSignal = {
        title: signal.title,
        detail: signal.detail,
        severity: signal.severity,
        indicator: signal.indicator,
        verdict: verdicts.get(`${row.recordId}:${signal.indicator}`) ?? 'none',
      }
      for (const loc of signal.refs ?? []) {
        const list = signalsByPosition.get(loc.n) ?? []
        list.push(item)
        signalsByPosition.set(loc.n, list)
      }
    }

    for (const event of analysis.events) {
      const key = eventKey(row.recordId, event.loc)
      const parsed = Date.parse(event.time)
      events.push({
        key,
        evidenceId: row.recordId,
        fileName: row.data.fileName,
        sha256: row.data.sha256 ?? '',
        loc: event.loc,
        event,
        label: describeAction(event),
        outcome: outcomeOf(event),
        at: Number.isNaN(parsed) ? null : parsed,
        signals: signalsByPosition.get(event.loc.n) ?? [],
        citedBy: citations.get(key) ?? [],
      })
    }
  }

  // Undated events sink to the end; ties keep file order so lines read naturally.
  return events.sort((a, b) => {
    if (a.at !== null && b.at !== null && a.at !== b.at) return a.at - b.at
    if (a.at === null && b.at !== null) return 1
    if (a.at !== null && b.at === null) return -1
    return 0
  })
}

const ACTION_LABELS: Array<[RegExp, string]> = [
  [/auth\.?failure|login\.?fail|signin\.?fail|logon\.?fail/, 'Failed login'],
  [/auth\.?success|login\.?success|signin\.?success|logon\.?success/, 'Successful login'],
  [/role\.?grant|add member to role/, 'Admin role granted'],
  [/inbox\.?rule/, 'Mailbox rule created'],
  [/oauth|consent/, 'App consent granted'],
  [/mfa|authenticator/, 'MFA method changed'],
  [/file\.?read|file\.?access|filepreviewed|fileaccessed/, 'File accessed'],
  [/file\.?download|export|filedownloaded/, 'Data exported'],
  [/mail\.?send|send/, 'Email sent'],
  [/session\.?refresh|token\.?refresh/, 'Session refreshed'],
  [/logout|signout|logoff/, 'Signed out'],
]

/** A plain-language name for an event's action, falling back to the raw action. */
export function describeAction(event: NormalizedEvent): string {
  const action = event.action.toLowerCase()
  for (const [pattern, label] of ACTION_LABELS) if (pattern.test(action)) return label
  const words = event.action.replace(/[._-]+/g, ' ').trim()
  return words ? words[0].toUpperCase() + words.slice(1) : 'Event'
}

function outcomeOf(event: NormalizedEvent): TimelineEvent['outcome'] {
  const blob = `${event.action} ${event.result}`.toLowerCase()
  if (/fail|denied|invalid|locked|blocked|error/.test(blob)) return 'failure'
  if (/success|succeeded|accepted|allow/.test(blob)) return 'success'
  return 'neutral'
}

/** Maps event keys to the assistant statements that cite them. */
function citationIndex(briefs: Row<BriefData>[]): Map<string, TimelineEvent['citedBy']> {
  const index = new Map<string, TimelineEvent['citedBy']>()
  for (const brief of briefs) {
    for (const statement of brief.data.statements ?? []) {
      for (const group of statement.citations ?? []) {
        for (const id of group.ids) {
          const loc = parseCitationId(id)
          if (!loc) continue
          const key = eventKey(group.evidenceId, loc)
          const list = index.get(key) ?? []
          list.push({ question: brief.data.question, text: statement.text, kind: statement.kind })
          index.set(key, list)
        }
      }
    }
  }
  return index
}

/** `F2:L14` → line 14, `F1:E7` → event 7. The file part is resolved by the citation group. */
export function parseCitationId(id: string): EventLoc | null {
  const match = /^F\d+:([LE])(\d+)$/.exec(id)
  if (!match) return null
  return { kind: match[1] === 'L' ? 'line' : 'event', n: Number(match[2]) }
}
