/**
 * Investigation assistant: turns a case's evidence and findings into a
 * structured, citable context for the model, and checks what comes back.
 *
 * The model never reads raw files. It sees the detector's signals, the
 * analyst's verdict on each, and the specific source events behind them —
 * every event under a citation id like `F2:L14` (file 2, line 14) or `F1:E7`
 * (file 1, JSON event 7). It must label each statement `evidence` (directly
 * observed in cited events) or `inference` (its interpretation). The server,
 * not the model, has the last word: unknown citation ids are dropped, and an
 * `evidence` statement left with no valid citation is downgraded to an
 * unsupported inference.
 */
import { z } from 'zod/v4'
import { analyzeEvidence } from './analyze'
import { DEFAULT_QUESTION } from './types'
import type { CaseData, EventLoc, EvidenceData, FindingData, FindingStatus, IntelData, NormalizedEvent } from './types'

export { DEFAULT_QUESTION }

/** Per-signal cap on events shown to the model; the rest are counted, not listed. */
const MAX_EVENTS_PER_SIGNAL = 12

type Row<T> = { recordId: string; data: T }

export type CitableEvent = { evidenceId: string; fileName: string; loc: EventLoc }

export type WebSource = { id: string; title: string; url: string }

export type AssistantContext = {
  /** JSON-serializable brief handed to the model. */
  brief: Record<string, unknown>
  /** Every event citation id the model may use. */
  catalog: Map<string, CitableEvent>
  /** Every web-result id (`W1`…) the model may use — external, never evidence. */
  web: Map<string, WebSource>
}

export function buildContext(input: {
  case: CaseData
  evidence: Row<EvidenceData>[]
  findings: Row<FindingData>[]
  intel?: Row<IntelData>[]
}): AssistantContext {
  const catalog = new Map<string, CitableEvent>()
  const web = new Map<string, WebSource>()
  const verdicts = new Map(input.findings.map((row) => [`${row.data.evidenceId}:${row.data.indicator}`, row.data.status]))

  const files = input.evidence.map((row, index) => {
    const fileId = `F${index + 1}`
    // Re-run the deterministic analyzer so every signal carries source
    // locations, including on records analyzed before locations existed.
    const analysis = analyzeEvidence(row.data.content ?? '')
    const byPosition = new Map(analysis.events.map((event) => [event.loc.n, event]))
    const times = analysis.events.map((event) => event.time).filter(Boolean).sort()

    const signals = analysis.signals.map((signal) => {
      const refs = signal.refs ?? []
      const events = refs.slice(0, MAX_EVENTS_PER_SIGNAL).flatMap((loc) => {
        const event = byPosition.get(loc.n)
        if (!event) return []
        const id = citationId(fileId, loc)
        catalog.set(id, { evidenceId: row.recordId, fileName: row.data.fileName, loc })
        return [{ id, ...eventFields(event) }]
      })
      return {
        severity: signal.severity,
        title: signal.title,
        detail: signal.detail,
        analystVerdict: verdictLabel(verdicts.get(`${row.recordId}:${signal.indicator}`)),
        supportingEvents: events,
        supportingEventsNotShown: Math.max(0, refs.length - events.length),
      }
    })

    return {
      fileId,
      fileName: row.data.fileName,
      sha256: row.data.sha256 ? row.data.sha256.slice(0, 16) : undefined,
      parseError: analysis.error,
      eventCount: analysis.events.length,
      timeRange: times.length > 0 ? { first: times[0], last: times[times.length - 1] } : undefined,
      signals,
    }
  })

  const findingTitles = new Map(input.findings.map((row) => [row.recordId, row.data.hypothesis ?? row.data.title]))
  const externalContext = (input.intel ?? []).flatMap((row) =>
    row.data.results.slice(0, 5).map((result) => {
      const id = `W${web.size + 1}`
      web.set(id, { id, title: result.title, url: result.url })
      return {
        id,
        aboutIp: row.data.indicator,
        forFinding: findingTitles.get(row.data.findingId) ?? 'unknown finding',
        title: result.title,
        url: result.url,
        snippet: result.snippet,
      }
    }),
  )

  return {
    brief: {
      case: { caseNumber: input.case.caseNumber, title: input.case.title, summary: input.case.summary, stage: input.case.stage },
      files,
      ...(externalContext.length > 0 ? { externalContext } : {}),
    },
    catalog,
    web,
  }
}

export const SYSTEM_PROMPT = `You are an investigation assistant for security analysts. You answer questions about one case using ONLY the structured case brief you are given.

The brief lists evidence files. Each file has signals found by a deterministic detector, the analyst's verdict on each signal, and the source events behind it. Every event has a citation id such as "F2:L14" (file F2, line 14) or "F1:E7" (file F1, JSON event 7).

Write the answer as a list of short statements. Label every statement:
- "evidence": a fact directly visible in the events you cite — who did what, when, from which address, how many times. Cite every event id the fact rests on. Do not round or generalize counts beyond what the cited events show.
- "inference": your interpretation — intent, likely cause, attacker behavior, impact, what probably happened next. Cite the events it is based on when there are any.

Rules:
- Never state as evidence anything not shown in a cited event. If you are unsure, it is an inference.
- Use only citation ids that appear in the brief. Never invent ids, line numbers, files, users, or addresses.
- A signal the analyst dismissed was judged not to be malicious; do not present it as part of an attack. A draft or under-investigation signal is not yet confirmed; say so when it matters.
- "supportingEventsNotShown" counts events you cannot see. Do not describe their contents.
- "externalContext", when present, is unverified web search results about IP addresses (ids "W1", "W2", …). It is NOT evidence. You may use it only for inference statements, citing its W id alongside any event ids. An evidence statement must cite at least one event id. Say "web sources suggest", never "the evidence shows", for anything that comes from it.
- Put what the evidence cannot answer, and what an analyst should check next, in openQuestions.
- Be concise: 3 to 8 statements, each one or two sentences.

Respond with JSON only, no prose and no code fences, in exactly this shape:
{"statements":[{"text":"...","kind":"evidence","cites":["F1:L12"]},{"text":"...","kind":"inference","cites":["F1:L12","W2"]}],"openQuestions":["..."]}`

export function buildUserPrompt(question: string, context: AssistantContext): string {
  return `Question: ${question}\n\nCase brief:\n${JSON.stringify(context.brief, null, 2)}`
}

const modelAnswerSchema = z.object({
  statements: z
    .array(
      z.object({
        text: z.string().min(1),
        kind: z.enum(['evidence', 'inference']),
        cites: z.array(z.string()).default([]),
      }),
    )
    .min(1),
  openQuestions: z.array(z.string()).default([]),
})

export type CitationGroup = { evidenceId: string; fileName: string; label: string; ids: string[] }

export type Statement = {
  text: string
  kind: 'evidence' | 'inference'
  /** True when the model claimed evidence but cited no source event that exists. */
  unsupported: boolean
  citations: CitationGroup[]
  /** External web results the statement leans on. Never counts as evidence. */
  web?: WebSource[]
}

export type CheckedAnswer = { statements: Statement[]; openQuestions: string[]; droppedCitations: number }

/** Parses the model's text and enforces the evidence/inference contract against the catalog. */
export function checkAnswer(
  text: string,
  catalog: Map<string, CitableEvent>,
  web: Map<string, WebSource> = new Map(),
): CheckedAnswer | { error: string } {
  const parsed = modelAnswerSchema.safeParse(parseJsonLoose(text))
  if (!parsed.success) return { error: 'The assistant returned an answer in an unexpected shape.' }

  let droppedCitations = 0
  const statements = parsed.data.statements.map((item): Statement => {
    const ids = [...new Set(item.cites.map((id) => id.trim().toUpperCase()))]
    const valid = ids.filter((id) => catalog.has(id))
    const sources = ids.filter((id) => web.has(id)).map((id) => web.get(id)!)
    droppedCitations += ids.length - valid.length - sources.length
    // Web results never make a statement evidence: it needs a real source event.
    const unsupported = item.kind === 'evidence' && valid.length === 0
    return {
      text: item.text.trim(),
      kind: unsupported ? 'inference' : item.kind,
      unsupported,
      citations: groupCitations(valid, catalog),
      ...(sources.length > 0 ? { web: sources } : {}),
    }
  })
  return {
    statements,
    openQuestions: parsed.data.openQuestions.map((question) => question.trim()).filter(Boolean),
    droppedCitations,
  }
}

/** Groups citation ids by file and renders "lines 142–149, 151" / "events #3–5". */
export function groupCitations(ids: string[], catalog: Map<string, CitableEvent>): CitationGroup[] {
  const groups = new Map<string, { evidenceId: string; fileName: string; ids: string[]; locs: EventLoc[] }>()
  for (const id of ids) {
    const item = catalog.get(id)
    if (!item) continue
    const group = groups.get(item.evidenceId) ?? { evidenceId: item.evidenceId, fileName: item.fileName, ids: [], locs: [] }
    group.ids.push(id)
    group.locs.push(item.loc)
    groups.set(item.evidenceId, group)
  }
  return [...groups.values()].map(({ evidenceId, fileName, ids: groupIds, locs }) => ({
    evidenceId,
    fileName,
    ids: groupIds,
    label: locationLabel(locs),
  }))
}

function locationLabel(locs: EventLoc[]): string {
  const parts: string[] = []
  for (const kind of ['line', 'event'] as const) {
    const numbers = [...new Set(locs.filter((loc) => loc.kind === kind).map((loc) => loc.n))].sort((a, b) => a - b)
    if (numbers.length === 0) continue
    const ranges = toRanges(numbers).map(([start, end]) => {
      const prefix = kind === 'event' ? '#' : ''
      return start === end ? `${prefix}${start}` : `${prefix}${start}–${end}`
    })
    const plural = numbers.length > 1
    parts.push(`${kind === 'line' ? (plural ? 'lines' : 'line') : plural ? 'events' : 'event'} ${ranges.join(', ')}`)
  }
  return parts.join('; ')
}

function toRanges(sorted: number[]): Array<[number, number]> {
  const ranges: Array<[number, number]> = []
  for (const n of sorted) {
    const last = ranges[ranges.length - 1]
    if (last && n === last[1] + 1) last[1] = n
    else ranges.push([n, n])
  }
  return ranges
}

function citationId(fileId: string, loc: EventLoc): string {
  return `${fileId}:${loc.kind === 'line' ? 'L' : 'E'}${loc.n}`
}

function eventFields(event: NormalizedEvent) {
  return { time: event.time, actor: event.actor, action: event.action, ip: event.ip, result: event.result, detail: event.detail }
}

function verdictLabel(status: FindingStatus | undefined): string {
  if (status === 'accepted') return 'accepted by analyst'
  if (status === 'dismissed') return 'dismissed by analyst'
  if (status === 'draft') return 'draft, awaiting analyst review'
  if (status === 'investigating') return 'under investigation, not yet confirmed'
  return 'not yet reviewed'
}

function parseJsonLoose(text: string): unknown {
  const trimmed = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '')
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(trimmed.slice(start, end + 1))
  } catch {
    return null
  }
}

/** One model call. Implementations must honor `signal` so a timeout really stops the request. */
export type Generate = (input: { system: string; prompt: string; signal: AbortSignal }) => Promise<string>

export const ASSISTANT_TIMEOUT_MS = 60_000

export type AssistantFailure = { error: 'unavailable' | 'timeout' | 'malformed'; message: string }

/**
 * Asks the model, enforcing the evidence/inference contract and every way the
 * model can let us down: it is unreachable, it hangs, it returns something that
 * is not the required JSON (one repair attempt), or it answers without tying a
 * single claim to a source line (allowed through, but flagged).
 */
export async function runAssistant(input: {
  question: string
  context: AssistantContext
  generate: Generate
  timeoutMs?: number
}): Promise<(CheckedAnswer & { warning?: string }) | AssistantFailure> {
  const timeoutMs = input.timeoutMs ?? ASSISTANT_TIMEOUT_MS
  const prompt = buildUserPrompt(input.question, input.context)

  const call = async (userPrompt: string): Promise<string | AssistantFailure> => {
    const signal = AbortSignal.timeout(timeoutMs)
    try {
      return await input.generate({ system: SYSTEM_PROMPT, prompt: userPrompt, signal })
    } catch (err) {
      if (signal.aborted || (err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError'))) {
        return {
          error: 'timeout',
          message: `The assistant did not answer within ${Math.round(timeoutMs / 1000)} seconds. Try again, or ask a narrower question.`,
        }
      }
      return {
        error: 'unavailable',
        message: 'The AI service is unavailable right now. Your evidence, findings, and timeline are unaffected; try the assistant again shortly.',
      }
    }
  }

  let text = await call(prompt)
  if (typeof text !== 'string') return text
  let answer = checkAnswer(text, input.context.catalog, input.context.web)
  if ('error' in answer) {
    text = await call(
      `${prompt}\n\nYour previous reply could not be used because it was not JSON in the required shape. Reply again with the JSON object only.`,
    )
    if (typeof text !== 'string') return text
    answer = checkAnswer(text, input.context.catalog, input.context.web)
    if ('error' in answer) return { error: 'malformed', message: 'The assistant returned an unusable answer twice. Try again or rephrase the question.' }
  }

  const backed = answer.statements.filter((item) => item.kind === 'evidence').length
  const unsupported = answer.statements.filter((item) => item.unsupported).length
  const warning =
    backed === 0
      ? 'No statement in this answer is tied to a source line. Treat all of it as unverified.'
      : unsupported > 0
        ? `${unsupported} statement${unsupported === 1 ? ' was' : 's were'} stated as fact without a valid citation and ${unsupported === 1 ? 'is' : 'are'} marked Unsupported.`
        : undefined
  return { ...answer, ...(warning ? { warning } : {}) }
}
