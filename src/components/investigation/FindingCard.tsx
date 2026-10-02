import { useState } from 'react'
import { useUserLookup } from 'deepspace'
import { Badge, Button, Textarea, useToast } from '@/components/ui'
import type { Factor } from '../../investigation/assess'
import { callAction } from '../../investigation/client'
import { eventKey } from '../../investigation/timeline'
import type { FindingData, IntelData, ReviewData, Severity } from '../../investigation/types'

type Row<T> = { recordId: string; data: T }

export function FindingCard({
  finding,
  reviews,
  intel,
  readOnly,
  onShowEvent,
  onAsked,
}: {
  finding: Row<FindingData>
  /** This finding's decisions, newest first. */
  reviews: Row<ReviewData>[]
  /** Web lookups for this finding's IPs. */
  intel: Row<IntelData>[]
  readOnly: boolean
  onShowEvent: (eventKey: string) => void
  /** Called after the assistant answers, so the page can bring the answer into view. */
  onAsked: () => void
}) {
  const { error } = useToast()
  const { getName } = useUserLookup()
  const [busy, setBusy] = useState<string | null>(null)
  const [rejecting, setRejecting] = useState(false)
  const [note, setNote] = useState('')
  const { data } = finding
  const factors = data.factors ?? []
  const open = data.status === 'draft' || data.status === 'investigating'
  const firstRef = factors.flatMap((factor) => factor.refs)[0]

  async function decide(decision: ReviewData['decision'], decisionNote = '') {
    setBusy(decision)
    try {
      await callAction('reviewFinding', { findingId: finding.recordId, decision, note: decisionNote })
      setRejecting(false)
      setNote('')
      if (decision === 'investigating' && firstRef) onShowEvent(eventKey(firstRef.evidenceId, firstRef.loc))
    } catch (err) {
      error('Could not save the decision', err instanceof Error ? err.message : 'Try again.')
    } finally {
      setBusy(null)
    }
  }

  async function lookUp() {
    setBusy('intel')
    try {
      await callAction('lookupIntel', { findingId: finding.recordId })
    } catch (err) {
      error('Lookup failed', err instanceof Error ? err.message : 'Try again.')
    } finally {
      setBusy(null)
    }
  }

  async function askAssistant() {
    setBusy('ask')
    try {
      const question = `Is "${data.hypothesis ?? data.title}" (${data.indicator}) supported by the evidence? What should I check before confirming or rejecting it?`
      await callAction('askAssistant', { caseId: data.caseId, question })
      onAsked()
    } catch (err) {
      error('The assistant could not answer', err instanceof Error ? err.message : 'Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <article data-testid="finding-card" className="grid gap-4 px-4 py-4">
      <header className="grid gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">Suggested finding</span>
          <Badge variant={severityVariant(data.severity)} size="sm">
            {data.severity}
          </Badge>
          <StatusBadge status={data.status} />
        </div>
        <h3 className="text-base font-semibold leading-snug">{data.hypothesis ?? data.title}</h3>
        <p className="text-sm text-muted-foreground">{data.detail}</p>
      </header>

      {data.confidence !== undefined ? <ConfidenceMeter value={data.confidence} /> : (
        <p className="text-xs text-muted-foreground">Not scored. This finding was generated before confidence scoring existed.</p>
      )}

      {factors.length > 0 && <FactorList factors={factors} onShowEvent={onShowEvent} />}

      {(intel.length > 0 || (!readOnly && open)) && (
        <ThreatIntel intel={intel} canLookUp={!readOnly && open} busy={busy === 'intel'} disabled={busy !== null} onLookUp={() => void lookUp()} />
      )}

      {data.decidedAt && data.status !== 'draft' && (
        <div className="rounded-md border border-border bg-background px-3 py-2 text-sm">
          <p>
            <span className="font-medium">{statusVerb(data.status)}</span>
            <span className="text-muted-foreground">
              {' '}
              by {data.decidedBy ? getName(data.decidedBy) || 'an investigator' : 'an investigator'} · {new Date(data.decidedAt).toLocaleString()}
            </span>
          </p>
          {data.decisionNote && <p className="mt-1 text-muted-foreground">“{data.decisionNote}”</p>}
        </div>
      )}

      {!readOnly && open && !rejecting && (
        <div className="flex flex-wrap gap-2">
          <Button size="sm" onClick={() => void decide('accepted')} loading={busy === 'accepted'} disabled={busy !== null}>
            Confirm finding
          </Button>
          <Button size="sm" variant="outline" onClick={() => setRejecting(true)} disabled={busy !== null}>
            Reject
          </Button>
          {data.status === 'draft' ? (
            <Button size="sm" variant="secondary" onClick={() => void decide('investigating')} loading={busy === 'investigating'} disabled={busy !== null}>
              Investigate
            </Button>
          ) : (
            <Button size="sm" variant="secondary" onClick={() => void askAssistant()} loading={busy === 'ask'} disabled={busy !== null}>
              Ask the assistant
            </Button>
          )}
        </div>
      )}

      {!readOnly && open && rejecting && (
        <form
          className="grid gap-2"
          onSubmit={(event) => {
            event.preventDefault()
            void decide('dismissed', note)
          }}
        >
          <label className="grid gap-1.5 text-sm">
            <span className="text-muted-foreground">Why is this not a real finding?</span>
            <Textarea
              value={note}
              onChange={(event) => setNote(event.target.value)}
              rows={2}
              maxLength={1000}
              placeholder="e.g. Known VPN egress address; user confirmed the sign-in."
              autoFocus
            />
          </label>
          <div className="flex gap-2">
            <Button type="submit" size="sm" variant="destructive" loading={busy === 'dismissed'} disabled={note.trim().length === 0}>
              Reject finding
            </Button>
            <Button type="button" size="sm" variant="ghost" onClick={() => setRejecting(false)}>
              Cancel
            </Button>
          </div>
        </form>
      )}

      {reviews.length > 1 && (
        <details className="text-xs text-muted-foreground">
          <summary className="cursor-pointer">Decision history ({reviews.length})</summary>
          <ol className="mt-2 grid gap-1.5 border-l border-border pl-3">
            {reviews.map((review) => (
              <li key={review.recordId}>
                <span className="text-foreground">{statusVerb(review.data.decision)}</span> by {getName(review.data.reviewer) || 'an investigator'} ·{' '}
                {new Date(review.data.decidedAt).toLocaleString()} · shown {review.data.confidenceShown}%
                {review.data.note && <span className="block">“{review.data.note}”</span>}
              </li>
            ))}
          </ol>
        </details>
      )}
    </article>
  )
}

function ThreatIntel({
  intel,
  canLookUp,
  busy,
  disabled,
  onLookUp,
}: {
  intel: Row<IntelData>[]
  canLookUp: boolean
  busy: boolean
  disabled: boolean
  onLookUp: () => void
}) {
  return (
    <div className="grid gap-2">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h4 className="text-xs uppercase tracking-wide text-muted-foreground">Threat intel</h4>
        {canLookUp && (
          <Button size="sm" variant="ghost" onClick={onLookUp} loading={busy} disabled={disabled}>
            {intel.length > 0 ? 'Refresh lookup' : 'Look up IPs on the web'}
          </Button>
        )}
      </div>
      {intel.length === 0 ? (
        <p className="text-xs text-muted-foreground">Search the web for reports about this finding's IP addresses. Only the IPs are sent, never account names.</p>
      ) : (
        <div className="grid gap-3 rounded-md border border-dashed border-border px-3 py-2.5">
          <p className="text-[11px] text-muted-foreground">External web results via Exa. Unverified and not evidence; use them to decide what to check.</p>
          {intel.map((row) => (
            <div key={row.recordId} className="grid gap-1.5">
              <p className="font-mono text-xs">
                {row.data.indicator}
                <span className="text-muted-foreground"> · looked up {new Date(row.data.lookedUpAt).toLocaleDateString()}</span>
              </p>
              {row.data.results.length === 0 ? (
                <p className="text-xs text-muted-foreground">No public reports found.</p>
              ) : (
                <ul className="grid gap-2">
                  {row.data.results.slice(0, 3).map((result) => (
                    <li key={result.url} className="text-xs">
                      <a href={result.url} target="_blank" rel="noopener noreferrer" className="font-medium underline-offset-4 hover:underline">
                        {result.title}
                      </a>
                      <span className="ml-1.5 text-muted-foreground">{hostname(result.url)}</span>
                      {result.snippet && <p className="mt-0.5 line-clamp-2 text-muted-foreground">{result.snippet}</p>}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  )
}

function hostname(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, '')
  } catch {
    return ''
  }
}

function ConfidenceMeter({ value }: { value: number }) {
  const band = value >= 80 ? 'High' : value >= 60 ? 'Medium' : 'Low'
  const tone = value >= 80 ? 'bg-destructive' : value >= 60 ? 'bg-warning' : 'bg-muted-foreground'
  return (
    <div className="grid gap-1.5">
      <div className="flex items-baseline justify-between gap-2">
        <span className="text-xs uppercase tracking-wide text-muted-foreground">Confidence</span>
        <span className="font-mono text-sm tabular-nums">
          {value}% <span className="text-muted-foreground">· {band}</span>
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-muted"
        role="meter"
        aria-valuenow={value}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label="Confidence"
      >
        <div className={`h-full rounded-full ${tone}`} style={{ width: `${value}%` }} />
      </div>
      <p className="text-[11px] text-muted-foreground">Computed from the checklist below, not the AI's opinion.</p>
    </div>
  )
}

function FactorList({ factors, onShowEvent }: { factors: Factor[]; onShowEvent: (eventKey: string) => void }) {
  return (
    <div>
      <h4 className="text-xs uppercase tracking-wide text-muted-foreground">Evidence</h4>
      <ul className="mt-2 grid gap-1">
        {factors.map((factor) => (
          <li key={factor.label} className="flex items-start gap-2 text-sm">
            <span aria-hidden className={`mt-px w-4 shrink-0 text-center ${factor.present ? 'text-success' : 'text-muted-foreground/60'}`}>
              {factor.present ? '✓' : '–'}
            </span>
            <span className={`flex-1 ${factor.present ? '' : 'text-muted-foreground line-through decoration-muted-foreground/40'}`}>
              <span className="sr-only">{factor.present ? 'Present: ' : 'Not present: '}</span>
              {factor.label}
              {factor.present && <span className="ml-1.5 font-mono text-[11px] text-muted-foreground">+{factor.weight}</span>}
            </span>
            {factor.present && factor.refs.length > 0 && (
              <button
                type="button"
                onClick={() => onShowEvent(eventKey(factor.refs[0].evidenceId, factor.refs[0].loc))}
                className="shrink-0 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
              >
                Show {factor.refs.length > 1 ? `${factor.refs.length} events` : 'event'}
              </button>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}

function StatusBadge({ status }: { status: FindingData['status'] }) {
  if (status === 'accepted') return <Badge variant="success" size="sm">Confirmed</Badge>
  if (status === 'dismissed') return <Badge variant="outline" size="sm">Rejected</Badge>
  if (status === 'investigating') return <Badge variant="info" size="sm">Investigating</Badge>
  return <Badge variant="warning" size="sm">Needs review</Badge>
}

function statusVerb(status: FindingData['status']): string {
  if (status === 'accepted') return 'Confirmed'
  if (status === 'dismissed') return 'Rejected'
  if (status === 'investigating') return 'Marked for investigation'
  return 'Draft'
}

function severityVariant(severity: Severity): 'destructive' | 'warning' | 'outline' {
  if (severity === 'high') return 'destructive'
  if (severity === 'medium') return 'warning'
  return 'outline'
}
