import { useEffect, useRef, useState } from 'react'
import { formatFileSize } from 'deepspace'
import { Badge, Button, Modal } from '@/components/ui'
import { evidenceState, type EvidenceState } from '../../investigation/evidence-state'
import type { EvidenceData } from '../../investigation/types'

type Row<T> = { recordId: string; data: T }

/** Lines shown in the raw viewer; enough to read any realistic log around an error. */
const RAW_LINE_LIMIT = 3_000

export function EvidenceRow({
  item,
  readOnly,
  retrying,
  onRetry,
}: {
  item: Row<EvidenceData>
  readOnly: boolean
  retrying: boolean
  onRetry: () => void
}) {
  const [viewing, setViewing] = useState(false)
  const now = useNow(item.data.analysisStatus === 'running')
  const state = evidenceState(item.data, now)
  const warnings = item.data.analysisWarnings ?? []
  const problem = state === 'failed' || state === 'timed-out'

  return (
    <li data-testid="evidence-row" className="grid gap-2 px-4 py-3">
      <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-center">
        <div className="min-w-0">
          <p className="truncate text-sm">{item.data.fileName}</p>
          <p className="mt-1 font-mono text-[11px] text-muted-foreground">
            {formatFileSize(item.data.byteSize || 0)}
            {item.data.sha256 ? ` · ${item.data.sha256.slice(0, 12)}` : ''}
            {item.data.fileKey ? '' : ' · case copy only'}
          </p>
          {state === 'complete' && item.data.analysisSummary && (
            <p className="mt-1 text-xs text-muted-foreground">{item.data.analysisSummary}</p>
          )}
          {state === 'running' && <p className="mt-1 text-xs text-muted-foreground">Analyzing…</p>}
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Badge variant="outline" size="sm">
            Evidence {item.data.status}
          </Badge>
          <Badge variant={stateVariant(state)} size="sm">
            {stateLabel(state)}
          </Badge>
        </div>
      </div>

      {problem && (
        <div role="alert" className="grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5">
          <p className="text-sm font-medium">{state === 'timed-out' ? 'Analysis timed out' : 'Analysis failed'}</p>
          <p className="text-sm text-muted-foreground">
            <span className="text-foreground">Reason: </span>
            {state === 'timed-out'
              ? `Analysis of ${item.data.fileName} started but did not finish. The server may have stopped mid-run.`
              : `Unable to parse ${item.data.fileName}. ${item.data.analysisSummary || 'No details were recorded.'}`}
          </p>
          <div className="flex flex-wrap gap-2">
            {!readOnly && (
              <Button size="sm" variant="outline" onClick={onRetry} loading={retrying}>
                Retry
              </Button>
            )}
            <Button size="sm" variant="ghost" onClick={() => setViewing(true)}>
              View raw evidence
            </Button>
          </div>
        </div>
      )}

      {state === 'complete' && warnings.length > 0 && (
        <ul className="grid gap-0.5 text-xs text-warning">
          {warnings.map((warning) => (
            <li key={warning}>⚠ {warning}</li>
          ))}
        </ul>
      )}

      {!problem && (
        <div>
          <button
            type="button"
            onClick={() => setViewing(true)}
            className="text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
          >
            View raw evidence
          </button>
        </div>
      )}

      <RawEvidenceModal
        open={viewing}
        onClose={() => setViewing(false)}
        fileName={item.data.fileName}
        content={item.data.content ?? ''}
        highlightLine={state === 'failed' ? item.data.analysisErrorLine || undefined : undefined}
      />
    </li>
  )
}

function RawEvidenceModal({
  open,
  onClose,
  fileName,
  content,
  highlightLine,
}: {
  open: boolean
  onClose: () => void
  fileName: string
  content: string
  highlightLine?: number
}) {
  const lines = content.split(/\r?\n/)
  const shown = lines.slice(0, Math.max(RAW_LINE_LIMIT, highlightLine ?? 0))
  const target = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (open && highlightLine) requestAnimationFrame(() => target.current?.scrollIntoView({ block: 'center' }))
  }, [open, highlightLine])

  return (
    <Modal open={open} onClose={onClose} size="xl">
      <Modal.Header>
        <Modal.Title>{fileName}</Modal.Title>
      </Modal.Header>
      <Modal.Body>
        <p className="mb-2 text-xs text-muted-foreground">
          Exactly as stored on the case{highlightLine ? `. The parser stopped at line ${highlightLine}.` : '.'}
        </p>
        <pre className="overflow-x-auto rounded-md border border-border bg-background py-2 font-mono text-[11px] leading-5" data-testid="raw-evidence">
          {shown.map((text, index) => {
            const n = index + 1
            const hit = n === highlightLine
            return (
              <div key={n} ref={hit ? target : undefined} className={`flex gap-3 px-3 ${hit ? 'bg-destructive/15 text-foreground' : ''}`}>
                <span className="w-10 shrink-0 select-none text-right tabular-nums text-muted-foreground">{n}</span>
                <span className="whitespace-pre">{text || ' '}</span>
              </div>
            )
          })}
        </pre>
        {lines.length > shown.length && (
          <p className="mt-2 text-xs text-muted-foreground">
            Showing the first {shown.length.toLocaleString('en-US')} of {lines.length.toLocaleString('en-US')} lines.
          </p>
        )}
      </Modal.Body>
      <Modal.Footer>
        <Button variant="outline" onClick={onClose}>
          Close
        </Button>
      </Modal.Footer>
    </Modal>
  )
}

/** Re-renders every 15 s while a file is running, so a stuck run flips to "timed out" on screen. */
function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (!active) return
    const timer = setInterval(() => setNow(Date.now()), 15_000)
    return () => clearInterval(timer)
  }, [active])
  return now
}

function stateLabel(state: EvidenceState): string {
  if (state === 'timed-out') return 'Analysis timed out'
  if (state === 'running') return 'Analyzing'
  return `Analysis ${state}`
}

function stateVariant(state: EvidenceState): 'outline' | 'warning' | 'success' | 'destructive' | 'info' {
  if (state === 'complete') return 'success'
  if (state === 'failed' || state === 'timed-out') return 'destructive'
  if (state === 'running') return 'info'
  return 'warning'
}
