import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useQuery } from 'deepspace'
import { Badge, Button } from '@/components/ui'
import { sourceExcerpt } from '../../investigation/analyze'
import { buildTimeline, type TimelineEvent, type TimelineSignal } from '../../investigation/timeline'
import type { BriefData, EvidenceData, FindingData, Severity } from '../../investigation/types'

type Row<T> = { recordId: string; data: T }

const PAGE = 300

export function TimelinePanel({
  caseId,
  evidence,
  findings,
  selectedKey,
  onSelect,
}: {
  caseId: string
  evidence: Row<EvidenceData>[]
  findings: Row<FindingData>[]
  selectedKey: string | null
  onSelect: (key: string) => void
}) {
  const briefs = useQuery<BriefData>('briefs', { where: { caseId }, limit: 20 })
  const timeline = useMemo(
    () => buildTimeline({ evidence, findings, briefs: briefs.records }),
    [evidence, findings, briefs.records],
  )
  const flaggedCount = timeline.filter((item) => item.signals.length > 0).length
  const [flaggedOnly, setFlaggedOnly] = useState(false)
  const [limit, setLimit] = useState(PAGE)
  const listRef = useRef<HTMLOListElement>(null)

  const visible = flaggedOnly ? timeline.filter((item) => item.signals.length > 0 || item.key === selectedKey) : timeline
  const shown = visible.slice(0, Math.max(limit, visible.findIndex((item) => item.key === selectedKey) + 1))
  const selected = timeline.find((item) => item.key === selectedKey) ?? null

  // Bring a selection made elsewhere (an assistant citation) into view.
  useEffect(() => {
    if (!selectedKey) return
    listRef.current?.querySelector(`[data-key="${CSS.escape(selectedKey)}"]`)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  }, [selectedKey])

  function onKeyDown(event: KeyboardEvent) {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return
    event.preventDefault()
    const index = shown.findIndex((item) => item.key === selectedKey)
    const next = shown[Math.min(shown.length - 1, Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)))]
    if (next) onSelect(next.key)
  }

  if (evidence.length === 0) return null

  return (
    <section id="case-timeline" data-testid="timeline-panel" className="rounded-lg border border-border bg-card">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
        <div>
          <h2 className="text-sm font-medium">Timeline</h2>
          <p className="mt-1 text-xs text-muted-foreground">
            {timeline.length} event{timeline.length === 1 ? '' : 's'} from {evidence.length} file{evidence.length === 1 ? '' : 's'}
            {flaggedCount > 0 && ` · ${flaggedCount} flagged`} · times in UTC. Select an event to see its source.
          </p>
        </div>
        <div className="flex gap-1" role="group" aria-label="Timeline filter">
          <Button size="sm" variant={flaggedOnly ? 'outline' : 'secondary'} onClick={() => setFlaggedOnly(false)} aria-pressed={!flaggedOnly}>
            All events
          </Button>
          <Button
            size="sm"
            variant={flaggedOnly ? 'secondary' : 'outline'}
            onClick={() => setFlaggedOnly(true)}
            aria-pressed={flaggedOnly}
            disabled={flaggedCount === 0}
          >
            Flagged only
          </Button>
        </div>
      </div>

      <div className="grid lg:grid-cols-[minmax(0,1fr)_minmax(20rem,0.9fr)]">
        <div className="max-h-[36rem] overflow-y-auto lg:border-r lg:border-border">
          {shown.length === 0 ? (
            <p className="px-4 py-8 text-sm text-muted-foreground">No events could be read from the evidence.</p>
          ) : (
            <ol ref={listRef} aria-label="Case timeline" onKeyDown={onKeyDown} className="py-2">
              {shown.map((item, index) => {
                const day = dayLabel(item.at)
                const newDay = index === 0 || dayLabel(shown[index - 1].at) !== day
                return (
                  <li key={item.key} data-key={item.key}>
                    {newDay && (
                      <p className="sticky top-0 z-10 bg-card px-4 pb-1 pt-3 font-mono text-[11px] uppercase tracking-wide text-muted-foreground">
                        {day}
                      </p>
                    )}
                    <TimelineRow item={item} selected={item.key === selectedKey} onSelect={onSelect} />
                  </li>
                )
              })}
            </ol>
          )}
          {visible.length > shown.length && (
            <div className="px-4 pb-3">
              <Button size="sm" variant="ghost" onClick={() => setLimit((value) => value + PAGE)}>
                Show {Math.min(PAGE, visible.length - shown.length)} more
              </Button>
            </div>
          )}
        </div>

        <div className="border-t border-border lg:border-t-0">
          {selected ? (
            <EventDetail item={selected} content={evidence.find((row) => row.recordId === selected.evidenceId)?.data.content ?? ''} />
          ) : (
            <p className="px-4 py-8 text-sm text-muted-foreground">
              Select an event to see the exact line it came from, the signals it supports, and what the assistant said about it.
            </p>
          )}
        </div>
      </div>
    </section>
  )
}

function TimelineRow({ item, selected, onSelect }: { item: TimelineEvent; selected: boolean; onSelect: (key: string) => void }) {
  const severity = topSeverity(item.signals)
  return (
    <button
      type="button"
      onClick={() => onSelect(item.key)}
      aria-current={selected ? 'true' : undefined}
      className={`group grid w-full grid-cols-[4.5rem_1rem_minmax(0,1fr)] items-start gap-2 px-4 py-1.5 text-left transition-colors hover:bg-accent focus-visible:bg-accent focus-visible:outline-none ${
        selected ? 'bg-accent' : ''
      }`}
    >
      <span className="pt-0.5 font-mono text-xs tabular-nums text-muted-foreground">{clockLabel(item)}</span>
      <span className="flex justify-center pt-1.5" aria-hidden>
        <span className={`size-2 rounded-full ${dotClass(item, severity)}`} />
      </span>
      <span className="min-w-0">
        <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
          <span className={`text-sm ${severity ? 'font-medium' : ''}`}>{item.label}</span>
          {severity && (
            <Badge variant={severityVariant(severity)} size="sm">
              {item.signals.length > 1 ? `${item.signals.length} signals` : item.signals[0].title}
            </Badge>
          )}
          {item.citedBy.length > 0 && (
            <Badge variant="outline" size="sm">
              Cited by assistant
            </Badge>
          )}
        </span>
        <span className="block truncate font-mono text-[11px] text-muted-foreground">
          {[item.event.actor, item.event.ip, item.fileName].filter(Boolean).join(' · ')}
        </span>
      </span>
    </button>
  )
}

function EventDetail({ item, content }: { item: TimelineEvent; content: string }) {
  const excerpt = useMemo(() => sourceExcerpt(content, item.loc), [content, item.loc])
  const fields: Array<[string, string]> = [
    ['Time', item.event.time || 'Not recorded'],
    ['Actor', item.event.actor],
    ['Action', item.event.action],
    ['Source IP', item.event.ip || 'Not recorded'],
    ['Result', item.event.result || 'Not recorded'],
    ['Detail', item.event.detail || '—'],
  ]

  return (
    <div className="grid gap-5 px-4 py-4 lg:sticky lg:top-0" data-testid="event-detail">
      <div>
        <p className="text-base font-medium">{item.label}</p>
        <p className="mt-1 font-mono text-[11px] text-muted-foreground">
          {item.fileName} — {item.loc.kind === 'line' ? `line ${item.loc.n}` : `event #${item.loc.n}`}
        </p>
      </div>

      <dl className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-3 gap-y-1.5 text-sm">
        {fields.map(([label, value]) => (
          <div key={label} className="contents">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="break-words font-mono text-xs leading-5">{value}</dd>
          </div>
        ))}
      </dl>

      <div>
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Source evidence</h3>
        {excerpt?.kind === 'lines' && (
          <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-background py-2 font-mono text-[11px] leading-5">
            {excerpt.lines.map((line) => (
              <div key={line.n} className={`flex gap-3 px-3 ${line.cited ? 'bg-primary/15 text-foreground' : 'text-muted-foreground'}`}>
                <span className="w-8 shrink-0 select-none text-right tabular-nums opacity-70">{line.n}</span>
                <span className="whitespace-pre">{line.text || ' '}</span>
              </div>
            ))}
          </pre>
        )}
        {excerpt?.kind === 'json' && (
          <pre className="mt-2 overflow-x-auto rounded-md border border-border bg-background px-3 py-2 font-mono text-[11px] leading-5">{excerpt.text}</pre>
        )}
        {!excerpt && <p className="mt-2 text-sm text-muted-foreground">The original text for this event could not be located.</p>}
        {item.sha256 && (
          <p className="mt-2 font-mono text-[11px] text-muted-foreground" title={item.sha256}>
            File SHA-256 {item.sha256.slice(0, 16)}…
          </p>
        )}
      </div>

      <div>
        <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Signals</h3>
        {item.signals.length === 0 ? (
          <p className="mt-2 text-sm text-muted-foreground">Not part of any detected signal.</p>
        ) : (
          <ul className="mt-2 grid gap-3">
            {item.signals.map((signal) => (
              <li key={signal.indicator} className="grid gap-1">
                <div className="flex flex-wrap items-center gap-2">
                  <Badge variant={severityVariant(signal.severity)} size="sm">
                    {signal.severity}
                  </Badge>
                  <Badge variant="outline" size="sm">
                    {verdictLabel(signal)}
                  </Badge>
                </div>
                <p className="text-sm font-medium">{signal.title}</p>
                <p className="text-sm text-muted-foreground">{signal.detail}</p>
              </li>
            ))}
          </ul>
        )}
      </div>

      {item.citedBy.length > 0 && (
        <div>
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Assistant statements citing this event</h3>
          <ul className="mt-2 grid gap-2">
            {item.citedBy.map((cite, index) => (
              <li key={index} className="flex items-start gap-2 text-sm">
                <Badge variant={cite.kind === 'evidence' ? 'success' : 'info'} size="sm" className="mt-0.5 shrink-0">
                  {cite.kind === 'evidence' ? 'Evidence' : 'Inference'}
                </Badge>
                <span>{cite.text}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  )
}

function topSeverity(signals: TimelineSignal[]): Severity | null {
  if (signals.some((signal) => signal.severity === 'high')) return 'high'
  if (signals.some((signal) => signal.severity === 'medium')) return 'medium'
  return signals.length > 0 ? 'low' : null
}

function dotClass(item: TimelineEvent, severity: Severity | null): string {
  if (severity === 'high') return 'bg-destructive ring-4 ring-destructive/20'
  if (severity === 'medium') return 'bg-warning ring-4 ring-warning/20'
  if (item.outcome === 'failure') return 'bg-warning/70'
  if (item.outcome === 'success') return 'bg-success/70'
  return 'bg-muted-foreground/40'
}

function severityVariant(severity: Severity): 'destructive' | 'warning' | 'outline' {
  if (severity === 'high') return 'destructive'
  if (severity === 'medium') return 'warning'
  return 'outline'
}

function verdictLabel(signal: TimelineSignal): string {
  if (signal.verdict === 'accepted') return 'Confirmed'
  if (signal.verdict === 'dismissed') return 'Rejected'
  if (signal.verdict === 'investigating') return 'Under investigation'
  if (signal.verdict === 'draft') return 'Awaiting review'
  return 'No finding yet'
}

function clockLabel(item: TimelineEvent): string {
  if (item.at === null) return item.event.time.slice(0, 8) || '—'
  return new Date(item.at).toISOString().slice(11, 19)
}

function dayLabel(at: number | null): string {
  if (at === null) return 'Undated'
  return new Date(at).toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
}
