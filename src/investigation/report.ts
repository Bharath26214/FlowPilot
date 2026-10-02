import type { CaseData, EvidenceData, FindingData } from './types'

export function buildReport(input: {
  case: CaseData
  evidence: EvidenceData[]
  findings: FindingData[]
  exportedAt: string
}): string {
  const accepted = input.findings.filter((finding) => finding.status === 'accepted')
  const dismissed = input.findings.filter((finding) => finding.status === 'dismissed')
  const lines = [
    `# ${input.case.caseNumber}`,
    '',
    input.case.title,
    '',
    input.case.summary || 'No case summary.',
    '',
    `Exported ${input.exportedAt}`,
    '',
    '## Evidence',
    '',
  ]

  if (input.evidence.length === 0) {
    lines.push('No evidence was attached.')
  } else {
    for (const item of input.evidence) {
      lines.push(`- ${item.fileName}`)
      lines.push(`  - Status: ${item.status}`)
      lines.push(`  - Analysis: ${item.analysisStatus}`)
      lines.push(`  - SHA-256: ${item.sha256 || 'not computed'}`)
      lines.push(`  - ${item.analysisSummary || 'No analysis summary.'}`)
    }
  }

  lines.push('', '## Confirmed findings', '')
  if (accepted.length === 0) {
    lines.push('None. Unconfirmed drafts are omitted from this report.')
  } else {
    for (const finding of accepted) {
      lines.push(`### ${finding.hypothesis ?? finding.title}`, '', finding.detail, '', `Severity: ${finding.severity}`)
      if (finding.confidence !== undefined) lines.push(`Confidence: ${finding.confidence}% (computed from the evidence checklist below)`)
      lines.push(`Indicator: ${finding.indicator}`)
      if (finding.decidedAt) lines.push(`Confirmed by investigator: ${finding.decidedAt}`)
      if (finding.decisionNote) lines.push(`Investigator note: ${finding.decisionNote}`)
      const factors = finding.factors ?? []
      if (factors.length > 0) {
        lines.push('', 'Evidence checklist:')
        for (const factor of factors) lines.push(`- [${factor.present ? 'x' : ' '}] ${factor.label}${factor.present ? ` (+${factor.weight})` : ''}`)
      }
      lines.push('')
    }
  }

  lines.push('## Rejected by investigator', '')
  if (dismissed.length === 0) {
    lines.push('None.')
  } else {
    for (const finding of dismissed) {
      lines.push(`- ${finding.hypothesis ?? finding.title} (${finding.indicator})${finding.decisionNote ? ` — ${finding.decisionNote}` : ''}`)
    }
  }

  lines.push('')
  return lines.join('\n')
}
