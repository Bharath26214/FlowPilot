import { useState, type FormEvent } from 'react'
import { useQuery } from 'deepspace'
import { Badge, Button, Input, useToast } from '@/components/ui'
import type { Statement } from '../../investigation/assistant'
import { callAction } from '../../investigation/client'
import { eventKey, parseCitationId } from '../../investigation/timeline'
import { DEFAULT_QUESTION, type BriefData } from '../../investigation/types'

export function AssistantPanel({
  caseId,
  readOnly,
  hasEvidence,
  onCite,
  onClose,
  className = '',
}: {
  caseId: string
  readOnly: boolean
  hasEvidence: boolean
  /** Called with a timeline event key when a citation is clicked. */
  onCite: (eventKey: string) => void
  /** Shown as a close button when the panel is in a drawer. */
  onClose?: () => void
  className?: string
}) {
  const { error } = useToast()
  const [question, setQuestion] = useState(DEFAULT_QUESTION)
  const [asking, setAsking] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const briefs = useQuery<BriefData>('briefs', {
    where: { caseId },
    orderBy: 'createdAt',
    orderDir: 'desc',
    limit: 5,
  })
  const [latest, ...earlier] = briefs.records

  async function ask() {
    setAsking(true)
    setFailure(null)
    try {
      await callAction('askAssistant', { caseId, question })
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Try again.'
      setFailure(message)
      error('The assistant could not answer', message)
    } finally {
      setAsking(false)
    }
  }

  function onAsk(event: FormEvent) {
    event.preventDefault()
    void ask()
  }

  return (
    <section
      id="assistant-panel"
      data-testid="assistant-panel"
      aria-label="Investigation assistant"
      className={`flex min-h-0 flex-col rounded-lg border border-border bg-card ${className}`}
    >
      <div className="shrink-0 border-b border-border px-4 py-3">
        <div className="flex items-center justify-between gap-2">
          <h2 className="text-sm font-medium">Investigation assistant</h2>
          {onClose && (
            <Button size="sm" variant="ghost" onClick={onClose} aria-label="Close assistant">
              Close
            </Button>
          )}
        </div>
        <p className="mt-1 text-xs text-muted-foreground">
          Answers from detected signals and your verdicts, never raw files. <strong className="font-medium text-foreground">Evidence</strong> is seen
          in cited lines; <strong className="font-medium text-foreground">inference</strong> is the assistant's reading. Verify before relying on it.
        </p>
      </div>

      {!readOnly && (
        <form onSubmit={onAsk} className="flex shrink-0 gap-2 border-b border-border px-4 py-3">
          <Input
            value={question}
            onChange={(event) => setQuestion(event.target.value)}
            maxLength={500}
            aria-label="Question for the assistant"
            className="flex-1"
          />
          <Button type="submit" loading={asking} disabled={!hasEvidence || question.trim().length === 0}>
            Ask
          </Button>
        </form>
      )}

      <div className="min-h-0 flex-1 overflow-y-auto">
        {failure && (
          <div role="alert" className="mx-4 mt-3 grid gap-2 rounded-md border border-destructive/40 bg-destructive/5 px-3 py-2.5">
            <p className="text-sm font-medium">The assistant could not answer</p>
            <p className="text-sm text-muted-foreground">
              <span className="text-foreground">Reason: </span>
              {failure}
            </p>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" onClick={() => void ask()} loading={asking}>
                Retry
              </Button>
              <Button size="sm" variant="ghost" onClick={() => setFailure(null)}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {!latest ? (
          <p className="px-4 py-8 text-sm text-muted-foreground">
            {hasEvidence ? 'Ask a question to get a cited summary of this case.' : 'Add evidence first; the assistant only answers from it.'}
          </p>
        ) : (
          <BriefView brief={latest.data} onCite={onCite} />
        )}

        {earlier.length > 0 && (
          <details className="border-t border-border px-4 py-3">
            <summary className="cursor-pointer text-xs text-muted-foreground">Earlier answers ({earlier.length})</summary>
            <div className="mt-2 divide-y divide-border">
              {earlier.map((row) => (
                <BriefView key={row.recordId} brief={row.data} onCite={onCite} />
              ))}
            </div>
          </details>
        )}
      </div>
    </section>
  )
}

function BriefView({ brief, onCite }: { brief: BriefData; onCite: (eventKey: string) => void }) {
  const statements = brief.statements ?? []
  const evidence = statements.filter((item) => item.kind === 'evidence')
  const inference = statements.filter((item) => item.kind === 'inference')

  return (
    <div className="grid gap-4 px-4 py-4">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="text-sm font-medium">{brief.question}</p>
        <p className="font-mono text-[11px] text-muted-foreground">{new Date(brief.askedAt).toLocaleString()}</p>
      </div>

      {brief.warning && (
        <p role="status" className="rounded-md border border-warning/40 bg-warning/10 px-3 py-2 text-xs text-foreground">
          ⚠ {brief.warning}
        </p>
      )}

      {evidence.length > 0 && <StatementList title="Evidence" statements={evidence} onCite={onCite} />}
      {inference.length > 0 && <StatementList title="Inference" statements={inference} onCite={onCite} />}

      {(brief.openQuestions ?? []).length > 0 && (
        <div>
          <h3 className="text-xs uppercase tracking-wide text-muted-foreground">Open questions</h3>
          <ul className="mt-2 list-disc space-y-1 pl-5 text-sm text-muted-foreground">
            {brief.openQuestions.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      )}

      {brief.droppedCitations > 0 && (
        <p className="text-xs text-muted-foreground">
          Removed {brief.droppedCitations} citation
          {brief.droppedCitations === 1 ? '' : 's'} that pointed at lines not in this case.
        </p>
      )}
    </div>
  )
}

function StatementList({
  title,
  statements,
  onCite,
}: {
  title: 'Evidence' | 'Inference'
  statements: Statement[]
  onCite: (eventKey: string) => void
}) {
  return (
    <div>
      <h3 className="text-xs uppercase tracking-wide text-muted-foreground">{title}</h3>
      <ul className="mt-2 grid gap-3">
        {statements.map((item, index) => (
          <li key={index} className="grid gap-1.5">
            <div className="flex items-start gap-2">
              <Badge variant={item.kind === 'evidence' ? 'success' : item.unsupported ? 'warning' : 'info'} size="sm" className="mt-0.5 shrink-0">
                {item.kind === 'evidence' ? 'Evidence' : item.unsupported ? 'Unsupported' : 'Inference'}
              </Badge>
              <p className="text-sm">{item.text}</p>
            </div>
            {item.citations.length > 0 && (
              <ul className="ml-1 space-y-0.5 border-l border-border pl-3">
                {item.citations.map((citation) => {
                  const first = citation.ids.map(parseCitationId).find((loc) => loc !== null)
                  return (
                    <li key={citation.evidenceId}>
                      <button
                        type="button"
                        disabled={!first}
                        onClick={() => first && onCite(eventKey(citation.evidenceId, first))}
                        className="font-mono text-[11px] text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:no-underline"
                        title="Show on the timeline"
                      >
                        {citation.fileName} — {citation.label}
                      </button>
                    </li>
                  )
                })}
              </ul>
            )}
            {item.web && item.web.length > 0 && (
              <ul className="ml-1 space-y-0.5 border-l border-dashed border-border pl-3">
                {item.web.map((source) => (
                  <li key={source.url} className="text-[11px] text-muted-foreground">
                    <span className="mr-1 uppercase tracking-wide">Web, unverified:</span>
                    <a
                      href={source.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline-offset-4 hover:text-foreground hover:underline"
                    >
                      {source.title}
                    </a>
                  </li>
                ))}
              </ul>
            )}
            {item.unsupported && (
              <p className="ml-1 text-xs text-muted-foreground">Stated as fact, but no matching line was cited. Treat as unverified.</p>
            )}
          </li>
        ))}
      </ul>
    </div>
  )
}
