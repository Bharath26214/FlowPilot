import { useState, type FormEvent } from 'react'
import { useNavigate } from 'react-router-dom'
import { useR2Files } from 'deepspace'
import { Button, Input, Modal, useToast } from '@/components/ui'
import { callAction } from '../../investigation/client'

export function DeleteCaseButton({ caseId, caseNumber, title }: { caseId: string; caseNumber: string; title: string }) {
  const navigate = useNavigate()
  const { success, error } = useToast()
  const { deleteFile } = useR2Files()
  const [open, setOpen] = useState(false)
  const [typed, setTyped] = useState('')
  const [deleting, setDeleting] = useState(false)

  async function onDelete(event: FormEvent) {
    event.preventDefault()
    setDeleting(true)
    try {
      const result = await callAction<{ removed: Record<string, number>; fileKeys: string[] }>('deleteCase', {
        caseId,
        confirmCaseNumber: typed.trim(),
      })
      // Records are gone; uploaded copies are best-effort (only the uploader's own files can be removed).
      await Promise.allSettled(result.fileKeys.map((key) => deleteFile(key)))
      success('Case deleted', `${caseNumber} and its ${result.removed.evidence ?? 0} evidence file${result.removed.evidence === 1 ? '' : 's'} were removed.`)
      navigate('/home', { replace: true })
    } catch (err) {
      error('Could not delete the case', err instanceof Error ? err.message : 'Try again.')
      setDeleting(false)
    }
  }

  return (
    <>
      <Button size="sm" variant="ghost" className="text-destructive hover:text-destructive" onClick={() => setOpen(true)}>
        Delete case
      </Button>
      <Modal open={open} onClose={() => !deleting && setOpen(false)} size="sm">
        <form onSubmit={onDelete} className="contents">
          <Modal.Header>
            <Modal.Title>Delete {caseNumber}?</Modal.Title>
          </Modal.Header>
          <Modal.Body>
            <div className="grid gap-3 text-sm">
              <p>
                This permanently deletes <span className="font-medium">{title}</span> and everything on it: evidence, findings, review history,
                assistant answers, threat intel, and the report. It cannot be undone.
              </p>
              <label className="grid gap-1.5">
                <span className="text-muted-foreground">
                  Type <span className="font-mono text-foreground">{caseNumber}</span> to confirm
                </span>
                <Input value={typed} onChange={(event) => setTyped(event.target.value)} autoComplete="off" autoFocus aria-label="Case number" />
              </label>
            </div>
          </Modal.Body>
          <Modal.Footer>
            <Button type="button" variant="outline" onClick={() => setOpen(false)} disabled={deleting}>
              Cancel
            </Button>
            <Button type="submit" variant="destructive" loading={deleting} disabled={typed.trim() !== caseNumber}>
              Delete case
            </Button>
          </Modal.Footer>
        </form>
      </Modal>
    </>
  )
}
