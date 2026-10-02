import { useEffect, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuthProfileReady, useQuery, useR2Files } from 'deepspace'
import { Badge, Button, buttonVariants, Modal, useToast } from '@/components/ui'
import { callAction } from '../../investigation/client'
import { needsAnalysis } from '../../investigation/evidence-state'
import { AssistantPanel } from './AssistantPanel'
import { DeleteCaseButton } from './DeleteCaseButton'
import { EvidenceRow } from './EvidenceRow'
import { FindingCard } from './FindingCard'
import { TimelinePanel } from './TimelinePanel'
import { SAMPLE_EVIDENCE, SAMPLE_EVIDENCE_NAME } from '../../investigation/sample'
import type { CaseData, EvidenceData, FindingData, IntelData, ReportData, ReviewData } from '../../investigation/types'
import { MAX_EVIDENCE_CHARS } from '../../investigation/types'

const STEPS = ['Create case', 'Upload evidence', 'Analyze evidence', 'Generate findings', 'Investigator review', 'Export report']

export function CaseWorkspace({ caseId }: { caseId: string }) {
  const { user } = useAuthProfileReady({ requireUser: true })
  const readOnly = user?.role === 'viewer'
  const { error, success } = useToast()
  const { upload, isUploading } = useR2Files()
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [selectedEvent, setSelectedEvent] = useState<string | null>(null)
  const [assistantOpen, setAssistantOpen] = useState(false)
  const [previewing, setPreviewing] = useState(false)
  const wide = useMediaQuery('(min-width: 1024px)')

  const cases = useQuery<CaseData>('cases', { where: { recordId: caseId }, limit: 1 })
  const evidenceQuery = useQuery<EvidenceData>('evidence', { where: { caseId }, limit: 100 })
  const findingsQuery = useQuery<FindingData>('findings', { where: { caseId }, limit: 200 })
  const reportsQuery = useQuery<ReportData>('reports', { where: { caseId }, limit: 5 })
  const intelQuery = useQuery<IntelData>('intel', { where: { caseId }, limit: 100 })
  const reviewsQuery = useQuery<ReviewData>('reviews', { where: { caseId }, orderBy: 'createdAt', orderDir: 'desc', limit: 500 })

  const caseRecord = cases.records[0]
  const evidence = evidenceQuery.records
  const findings = findingsQuery.records
  const report = reportsQuery.records[0]
  const reviews = reviewsQuery.records
  const intel = intelQuery.records

  const analyzeDone = evidence.length > 0 && evidence.every((item) => item.data.analysisStatus === 'complete')
  const generated = findings.length > 0 || (analyzeDone && (caseRecord?.data.stage === 'review' || caseRecord?.data.stage === 'exported'))
  const reviewed = generated && findings.every((item) => item.data.status === 'accepted' || item.data.status === 'dismissed')
  const uncovered = evidence.some((item) =>
    (item.data.signals ?? []).some(
      (signal) =>
        !findings.some(
          (finding) => finding.data.evidenceId === item.recordId && finding.data.indicator === signal.indicator && finding.data.status !== 'draft',
        ),
    ),
  )
  const exported = Boolean(report)
  const pdfReady = Boolean(report?.data.pdfUrl && report.data.pdfExpiresAt && Date.parse(report.data.pdfExpiresAt) > Date.now())
  const done = [true, evidence.length > 0, analyzeDone, generated, reviewed, exported]
  const current = done.findIndex((step) => !step)

  function showEvent(key: string) {
    setSelectedEvent(key)
    document.getElementById('case-timeline')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
  }

  async function run(name: string, task: () => Promise<void>) {
    setBusy(name)
    try {
      await task()
    } catch (err) {
      error('Case update failed', err instanceof Error ? err.message : 'Try again.')
    } finally {
      setBusy(null)
    }
  }

  async function storeEvidence(fileName: string, content: string, byteSize: number, fileKey = '') {
    if (content.length > MAX_EVIDENCE_CHARS) {
      throw new Error(`Evidence must be under ${MAX_EVIDENCE_CHARS.toLocaleString()} characters.`)
    }
    await callAction('addEvidence', { caseId, fileName, content, byteSize, fileKey })
  }

  async function onFiles(files: FileList | null) {
    const file = files?.[0]
    if (!file) return
    await run('upload', async () => {
      const content = await file.text()
      // Catch a duplicate before the file locker copy is made; the server checks again.
      const digest = await sha256Hex(content.replace(/^\uFEFF/, ''))
      const twin = evidence.find((item) => item.data.sha256 === digest)
      if (twin) throw new Error(`Duplicate evidence: this file is identical to "${twin.data.fileName}", which is already on the case.`)
      let fileKey = ''
      const stored = await upload(file, file.name, { key: `cases/${caseId}/${file.name.replace(/[^\w.\-]+/g, '_')}` })
      if (stored.success && stored.key) fileKey = stored.key
      await storeEvidence(file.name, content, file.size, fileKey)
      success('Evidence stored', fileKey ? file.name : `${file.name} is saved on the case. The file locker did not accept the copy.`)
    })
    if (fileRef.current) fileRef.current.value = ''
  }

  if (cases.status === 'loading') {
    return <p className="px-6 py-10 text-sm text-muted-foreground">Loading case…</p>
  }
  if (!caseRecord) {
    return (
      <div className="px-6 py-10">
        <p className="text-sm text-muted-foreground">This case does not exist.</p>
        <Link to="/home" className="mt-3 inline-block text-sm underline-offset-4 hover:underline">
          Back to cases
        </Link>
      </div>
    )
  }

  const { caseNumber, title, summary, stage } = caseRecord.data

  const assistant = (
    <AssistantPanel
      caseId={caseId}
      readOnly={readOnly}
      hasEvidence={evidence.length > 0}
      onCite={(key) => {
        setAssistantOpen(false)
        showEvent(key)
      }}
      onClose={wide ? undefined : () => setAssistantOpen(false)}
      className={wide ? 'h-full rounded-none border-0' : 'h-full rounded-none border-0 sm:rounded-l-lg sm:border-l'}
    />
  )

  return (
    <div data-testid="case-workspace" className="lg:flex lg:h-full">
      <div id="case-scroll" className="min-w-0 lg:flex-1 lg:overflow-y-auto">
        <div className="mx-auto flex w-full max-w-6xl flex-col gap-8 px-4 py-8 sm:px-6">
          <header className="flex flex-col gap-3">
            <Link to="/home" className="text-xs uppercase tracking-[0.16em] text-muted-foreground hover:text-foreground">
              Cases
            </Link>
            <div className="flex flex-wrap items-end justify-between gap-3">
              <div>
                <p className="font-mono text-sm text-primary" data-testid="case-id">
                  {caseNumber}
                </p>
                <h1 className="mt-1 text-2xl font-semibold tracking-tight">{title}</h1>
                {summary && <p className="mt-2 max-w-2xl text-sm text-muted-foreground">{summary}</p>}
              </div>
              <div className="flex items-center gap-3">
                <p className="text-xs uppercase tracking-wide text-muted-foreground">Stage {stage}</p>
            {user?.role === 'admin' && <DeleteCaseButton caseId={caseId} caseNumber={caseNumber} title={title} />}
                {!wide && (
                  <Button size="sm" variant="outline" onClick={() => setAssistantOpen(true)} aria-expanded={assistantOpen}>
                    Assistant
                  </Button>
                )}
              </div>
            </div>
          </header>

          <ol className="grid gap-2 sm:grid-cols-3 lg:grid-cols-6">
            {STEPS.map((label, index) => {
              const state = done[index] ? 'done' : index === current ? 'current' : 'waiting'
              return (
                <li
                  key={label}
                  className={`rounded-md border px-3 py-2 text-xs ${
                    state === 'current' ? 'border-primary text-foreground' : 'border-border text-muted-foreground'
                  }`}
                >
                  <span className="block font-mono text-[10px] uppercase tracking-wide">
                    {String(index + 1).padStart(2, '0')} {state === 'done' ? 'Done' : state === 'current' ? 'Now' : ''}
                  </span>
                  {label}
                </li>
              )
            })}
          </ol>

          {!readOnly && (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() =>
                  run('analyze', async () => {
                    const result = await callAction<{ analyzed: number; failed: number }>('analyzeEvidence', { caseId })
                    success(
                      'Analysis finished',
                      `${result.analyzed} file${result.analyzed === 1 ? '' : 's'} read${result.failed ? `, ${result.failed} failed` : ''}.`,
                    )
                  })
                }
                loading={busy === 'analyze'}
                disabled={!evidence.some((item) => needsAnalysis(item.data))}
              >
                Analyze evidence
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  run('findings', async () => {
                    const result = await callAction<{ created: number }>('generateFindings', { caseId })
                    success(
                      result.created > 0 ? 'Findings ready for review' : 'No indicators',
                      result.created > 0
                        ? `${result.created} draft${result.created === 1 ? '' : 's'} need an accept or dismiss.`
                        : 'Analysis found nothing to confirm. You can export that result.',
                    )
                  })
                }
                loading={busy === 'findings'}
                disabled={
                  !analyzeDone || (generated && findings.length === 0) || (!uncovered && findings.some((item) => item.data.status !== 'draft'))
                }
              >
                Generate findings
              </Button>
              <Button
                variant="secondary"
                onClick={() =>
                  run('export', async () => {
                    await callAction('exportReport', { caseId })
                    success('Report exported', 'Preview it or download it as Markdown or PDF from the report bar.')
                  })
                }
                loading={busy === 'export'}
                disabled={!analyzeDone || !reviewed}
              >
                Export report
              </Button>
            </div>
          )}

          {report && (
            <div
              data-testid="report-bar"
              className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border bg-card px-4 py-3"
            >
              <div className="min-w-0">
                <p className="text-sm font-medium">Report exported</p>
                <p className="text-xs text-muted-foreground">{new Date(report.data.exportedAt).toLocaleString()} · confirmed findings only</p>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="ghost" onClick={() => setPreviewing(true)}>
                  Preview
                </Button>
                <Button size="sm" variant="outline" onClick={() => downloadReport(report.data.body, caseNumber)}>
                  Markdown
                </Button>
                {pdfReady ? (
                  <a href={report.data.pdfUrl} target="_blank" rel="noopener noreferrer" className={buttonVariants({ size: 'sm' })}>
                    Download PDF
                  </a>
                ) : (
                  !readOnly && (
                    <Button
                      size="sm"
                      loading={busy === 'pdf'}
                      onClick={() =>
                        run('pdf', async () => {
                          await callAction('createReportPdf', { caseId })
                          success('PDF ready', 'The download link works for about a day; create it again after that.')
                        })
                      }
                    >
                      Create PDF
                    </Button>
                  )
                )}
              </div>
            </div>
          )}

          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1.3fr)_minmax(18rem,0.9fr)]">
            <section className="rounded-lg border border-border bg-card">
              <div className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3">
                <h2 className="text-sm font-medium">Evidence</h2>
                {!readOnly && (
                  <div className="flex flex-wrap gap-2">
                    <Button
                      size="sm"
                      variant="outline"
                      disabled={isUploading || busy === 'upload'}
                      onClick={() =>
                        run('sample', async () => {
                          await storeEvidence(SAMPLE_EVIDENCE_NAME, SAMPLE_EVIDENCE, SAMPLE_EVIDENCE.length)
                          success('Sample stored', 'A fictional sign-in log is on the case.')
                        })
                      }
                    >
                      Use sample log
                    </Button>
                    <Button size="sm" variant="outline" loading={isUploading || busy === 'upload'} onClick={() => fileRef.current?.click()}>
                      Upload
                    </Button>
                    <input
                      ref={fileRef}
                      type="file"
                      accept=".json,.csv,.txt,.log,.ndjson,application/json,text/csv,text/plain"
                      className="sr-only"
                      onChange={(event) => void onFiles(event.target.files)}
                    />
                  </div>
                )}
              </div>
              <div data-testid="evidence-list">
                {evidence.length === 0 && (
                  <p className="px-4 py-8 text-sm text-muted-foreground">Upload a JSON, CSV, or text log, or load the sample sign-in log.</p>
                )}
                <ul className="divide-y divide-border">
                  {evidence.map((item) => (
                    <EvidenceRow
                      key={item.recordId}
                      item={item}
                      readOnly={readOnly}
                      retrying={busy === `retry-${item.recordId}`}
                      onRetry={() =>
                        run(`retry-${item.recordId}`, async () => {
                          const result = await callAction<{ analyzed: number; failed: number }>('analyzeEvidence', {
                            caseId,
                            evidenceId: item.recordId,
                          })
                          if (result.failed > 0) error('Analysis failed again', 'The reason is shown on the file. Fix the file and upload it again.')
                          else success('Analysis finished', `${item.data.fileName} was read.`)
                        })
                      }
                    />
                  ))}
                </ul>
              </div>
            </section>

            <section data-testid="findings-panel" className="rounded-lg border border-border bg-card">
              <div className="border-b border-border px-4 py-3">
                <h2 className="text-sm font-medium">Findings</h2>
                <p className="mt-1 text-xs text-muted-foreground">
                  Suggestions from the detector. Nothing reaches the report until an investigator confirms it.
                </p>
              </div>
              {findings.length === 0 ? (
                <p className="px-4 py-8 text-sm text-muted-foreground">
                  {analyzeDone ? 'Analysis is finished. Generate findings to review them.' : 'Findings appear after evidence is analyzed.'}
                </p>
              ) : (
                <ul className="divide-y divide-border">
                  {findings.map((item) => (
                    <li key={item.recordId}>
                      <FindingCard
                        finding={item}
                        reviews={reviews.filter((review) => review.data.findingId === item.recordId)}
                        intel={intel.filter((row) => row.data.findingId === item.recordId)}
                        readOnly={readOnly}
                        onShowEvent={showEvent}
                    onAsked={() => setAssistantOpen(true)}
                      />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          </div>

          <TimelinePanel caseId={caseId} evidence={evidence} findings={findings} selectedKey={selectedEvent} onSelect={setSelectedEvent} />
        </div>
      </div>

      {wide ? (
        <aside className="h-full w-[26rem] shrink-0 border-l border-border bg-card xl:w-[28rem]">{assistant}</aside>
      ) : (
        assistantOpen && (
          <div className="fixed inset-0 z-40 flex justify-end" role="dialog" aria-modal="true" aria-label="Investigation assistant">
            <button type="button" aria-label="Close assistant" className="absolute inset-0 bg-black/40" onClick={() => setAssistantOpen(false)} />
            <div className="relative h-full w-full sm:w-[26rem]">{assistant}</div>
          </div>
        )
      )}

      {report && (
        <Modal open={previewing} onClose={() => setPreviewing(false)} size="xl">
          <Modal.Header>
            <Modal.Title>{caseNumber} report</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <pre data-testid="report-body" className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-foreground">
              {report.data.body}
            </pre>
          </Modal.Body>
          <Modal.Footer>
            <Button variant="outline" onClick={() => setPreviewing(false)}>
              Close
            </Button>
          </Modal.Footer>
        </Modal>
      )}
    </div>
  )
}

function downloadReport(body: string, caseNumber: string) {
  const url = URL.createObjectURL(new Blob([body], { type: 'text/markdown' }))
  const link = document.createElement('a')
  link.href = url
  link.download = `${caseNumber}.md`
  link.click()
  URL.revokeObjectURL(url)
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text))
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function useMediaQuery(query: string): boolean {
  const [matches, setMatches] = useState(() => typeof window !== 'undefined' && window.matchMedia(query).matches)
  useEffect(() => {
    const media = window.matchMedia(query)
    const update = () => setMatches(media.matches)
    update()
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [query])
  return matches
}
