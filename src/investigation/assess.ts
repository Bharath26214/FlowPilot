/**
 * Turns a detector signal into a reviewable finding: a plain-language
 * hypothesis and a confidence computed from an explicit evidence checklist.
 *
 * Confidence is deliberately NOT a number the model makes up. It is base +
 * the weights of the checklist items that are present in the evidence, and
 * every present item cites the source events that satisfy it — so an
 * investigator can see exactly why it is 87% and not 60%, and check it.
 */
import type { EventLoc, NormalizedEvent, Signal } from './types'

/** A cited source event; corroboration can come from a different file than the finding's. */
export type FactorRef = { evidenceId: string; loc: EventLoc }

export type Factor = {
  label: string
  present: boolean
  /** Points this factor adds to confidence when present. */
  weight: number
  refs: FactorRef[]
}

export type Assessment = {
  hypothesis: string
  confidence: number
  factors: Factor[]
}

/** One file's analysis, as `analyzeEvidence` returns it. */
export type FileEvents = { evidenceId: string; events: NormalizedEvent[] }

const BASE: Record<string, { hypothesis: string; base: number }> = {
  'auth.after-failures': { hypothesis: 'Possible credential compromise', base: 40 },
  'auth.repeated-failure': { hypothesis: 'Password guessing against one account', base: 45 },
  'auth.shared-source': { hypothesis: 'Password spray from a single address', base: 50 },
  'privilege.change': { hypothesis: 'Unauthorized privilege escalation', base: 40 },
  'account.control-change': { hypothesis: 'Attacker persistence on the account', base: 40 },
}

const MAX_CONFIDENCE = 97
const PRIVILEGED = /role\.?grant|add member to role|global admin|privilege|administrator|permission grant|owner assigned/
const CONTROL = /mfa|multi-factor|inbox\.?rule|forward|oauth|consent|authenticator/
const FAILURE = /fail|denied|invalid|locked|blocked|error/
const SIGN_IN = /auth|login|logon|signin|sign-in|session/

export function assessSignal(signal: Signal, file: FileEvents, allFiles: FileEvents[]): Assessment {
  const { hypothesis, base } = BASE[signal.kind] ?? { hypothesis: signal.title, base: 40 }
  const refs = new Set((signal.refs ?? []).map((loc) => loc.n))
  const cited = file.events.filter((event) => refs.has(event.loc.n))
  const citedSet = new Set(cited)
  const owner = ownerIndex(allFiles)
  const factor = (label: string, present: boolean, weight: number, events: NormalizedEvent[]): Factor => ({
    label,
    present,
    weight,
    refs: present ? citeAll(events, owner) : [],
  })
  const actors = new Set(cited.map((event) => event.actor.toLowerCase()))
  const failures = cited.filter(isFailure)
  // Sign-ins only: a role grant in the same burst is a different factor.
  const nonFailures = cited.filter((event) => !isFailure(event))
  const signIns = nonFailures.filter((event) => SIGN_IN.test(event.action.toLowerCase()))
  const successes = signIns.length > 0 ? signIns : nonFailures
  const factors: Factor[] = []

  if (signal.kind === 'auth.after-failures' || signal.kind === 'auth.repeated-failure') {
    factors.push(factor(`${failures.length} failed login${plural(failures.length)}`, failures.length >= 3, 15, failures))
    if (signal.kind === 'auth.after-failures') {
      factors.push(factor(`${successes.length} successful login${plural(successes.length)} afterwards`, successes.length > 0, 15, successes))
    } else {
      factors.push(factor('8 or more failures in a row', failures.length >= 8, 15, failures))
    }
  }
  if (signal.kind === 'auth.shared-source') {
    factors.push(factor(`${actors.size} different accounts targeted`, actors.size >= 4, 15, failures))
    factors.push(factor('10 or more accounts targeted', actors.size >= 10, 10, failures))
  }
  if (signal.kind === 'privilege.change' || signal.kind === 'account.control-change') {
    factors.push(factor(`${cited.length} change${plural(cited.length)} recorded`, cited.length > 0, 10, cited))
  }

  // An address the actor has never succeeded from before this signal.
  const newIp = cited.filter((event) => event.ip && !isFailure(event) && !seenBefore(event, allFiles))
  factors.push(factor('New IP address', newIp.length > 0, 15, newIp))

  // Corroboration: a sensitive action by the same actor after the signal, in any file.
  const lastTime = cited.map((event) => event.time).sort().at(-1) ?? ''
  const after = allFiles.flatMap((item) =>
    item.events.filter(
      (event) => actors.has(event.actor.toLowerCase()) && event.time > lastTime && !isFailure(event) && !citedSet.has(event),
    ),
  )
  if (signal.kind !== 'privilege.change') {
    const escalation = after.filter((event) => PRIVILEGED.test(blob(event)))
    factors.push(factor('Admin rights granted afterwards', escalation.length > 0, 15, escalation))
  }
  if (signal.kind !== 'account.control-change') {
    const control = after.filter((event) => CONTROL.test(blob(event)))
    factors.push(factor('Mailbox, MFA, or consent change afterwards', control.length > 0, 10, control))
  }

  const offHours = cited.filter((event) => {
    const hour = new Date(event.time).getUTCHours()
    return !Number.isNaN(hour) && (hour < 6 || hour >= 22)
  })
  factors.push(factor('Outside business hours (22:00–06:00 UTC)', offHours.length > 0, 5, offHours))

  const score = base + factors.filter((item) => item.present).reduce((sum, item) => sum + item.weight, 0)
  return { hypothesis, confidence: Math.min(MAX_CONFIDENCE, score), factors }
}

function ownerIndex(files: FileEvents[]): Map<NormalizedEvent, string> {
  const index = new Map<NormalizedEvent, string>()
  for (const file of files) for (const event of file.events) index.set(event, file.evidenceId)
  return index
}

function citeAll(events: NormalizedEvent[], owner: Map<NormalizedEvent, string>): FactorRef[] {
  const seen = new Set<string>()
  const refs: FactorRef[] = []
  for (const event of events) {
    const evidenceId = owner.get(event)
    if (!evidenceId) continue
    const key = `${evidenceId}:${event.loc.n}`
    if (seen.has(key)) continue
    seen.add(key)
    refs.push({ evidenceId, loc: event.loc })
  }
  return refs
}

function seenBefore(event: NormalizedEvent, files: FileEvents[]): boolean {
  const actor = event.actor.toLowerCase()
  return files.some((file) =>
    file.events.some(
      (other) =>
        other !== event &&
        other.actor.toLowerCase() === actor &&
        other.ip === event.ip &&
        !isFailure(other) &&
        other.time !== '' &&
        other.time < event.time,
    ),
  )
}

function isFailure(event: NormalizedEvent): boolean {
  return FAILURE.test(`${event.action} ${event.result} ${event.detail}`.toLowerCase())
}

function blob(event: NormalizedEvent): string {
  return `${event.action} ${event.detail}`.toLowerCase()
}

function plural(count: number): string {
  return count === 1 ? '' : 's'
}
