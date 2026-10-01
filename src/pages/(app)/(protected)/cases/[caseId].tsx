import { useParams } from 'react-router-dom'
import { CaseWorkspace } from '@/components/investigation/CaseWorkspace'

export default function CasePage() {
  const { caseId } = useParams()
  if (!caseId) return null
  return <CaseWorkspace caseId={caseId} />
}
