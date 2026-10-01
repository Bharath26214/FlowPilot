import { useState, type FormEvent } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { useQuery } from 'deepspace'
import { Button, Input, Textarea, useToast } from '@/components/ui'
import { callAction } from '../../../investigation/client'
import type { CaseData } from '../../../investigation/types'

const STAGE_LABEL: Record<CaseData['stage'], string> = {
  intake: 'Open',
  evidence: 'Evidence',
  analysis: 'Analysis',
  findings: 'Findings',
  review: 'Review',
  exported: 'Exported',
}

export default function CasesPage() {
  const { records, status } = useQuery<CaseData>('cases', { orderBy: 'createdAt', orderDir: 'desc', limit: 100 })
  const navigate = useNavigate()
  const { error } = useToast()
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [creating, setCreating] = useState(false)

  async function onCreate(event: FormEvent) {
    event.preventDefault()
    setCreating(true)
    try {
      const result = await callAction<{ caseId: string }>('createCase', { title, summary })
      setTitle('')
      setSummary('')
      navigate(`/cases/${result.caseId}`)
    } catch (err) {
      error('Could not create the case', err instanceof Error ? err.message : 'Try again.')
    } finally {
      setCreating(false)
    }
  }

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-10 px-6 py-10">
      <header className="flex flex-col gap-2">
        <p className="text-xs uppercase tracking-[0.18em] text-muted-foreground">Investigation</p>
        <h1 className="text-3xl font-semibold tracking-tight">Cases</h1>
        <p className="max-w-xl text-sm text-muted-foreground">
          Open a case, attach a sign-in or audit log, and confirm findings before anything is exported.
        </p>
      </header>

      <form
        onSubmit={onCreate}
        className="grid gap-4 rounded-lg border border-border bg-card p-5 sm:grid-cols-[minmax(0,1fr)_auto] sm:items-end"
      >
        <div className="grid gap-4 sm:grid-cols-2">
          <label className="grid gap-1.5 text-sm">
            <span className="text-muted-foreground">Title</span>
            <Input
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              placeholder="Mailbox rule on a finance account"
              required
              maxLength={120}
            />
          </label>
          <label className="grid gap-1.5 text-sm">
            <span className="text-muted-foreground">Summary</span>
            <Textarea
              value={summary}
              onChange={(event) => setSummary(event.target.value)}
              placeholder="What prompted the case"
              rows={2}
              maxLength={2000}
              className="min-h-10"
            />
          </label>
        </div>
        <Button type="submit" loading={creating} disabled={title.trim().length === 0}>
          Create case
        </Button>
      </form>

      <section data-testid="case-list" className="grid gap-2">
        {status === 'loading' && <p className="text-sm text-muted-foreground">Loading cases…</p>}
        {status === 'ready' && records.length === 0 && (
          <p className="rounded-lg border border-dashed border-border px-4 py-8 text-sm text-muted-foreground">
            No cases yet. Create one to start the workflow.
          </p>
        )}
        {records.map((record) => (
          <Link
            key={record.recordId}
            to={`/cases/${record.recordId}`}
            className="grid gap-1 rounded-lg border border-border bg-card px-4 py-3 transition-colors hover:bg-accent sm:grid-cols-[8rem_minmax(0,1fr)_auto] sm:items-center sm:gap-4"
          >
            <span className="font-mono text-sm text-foreground">{record.data.caseNumber}</span>
            <span className="truncate text-sm">{record.data.title}</span>
            <span className="text-xs uppercase tracking-wide text-muted-foreground">
              {STAGE_LABEL[record.data.stage] ?? record.data.stage}
            </span>
          </Link>
        ))}
      </section>
    </div>
  )
}
