/**
 * Deterministic demo data: fictional cases, each with 3–7 log files built so
 * the analyzer finds realistic signals. Same seed → same records, so the seed
 * action can upsert by fixed ids and re-running it never duplicates anything.
 */
import type { CaseStage } from './types'

export type SeedEvidence = { recordId: string; fileName: string; content: string }
export type SeedCase = {
  recordId: string
  caseNumber: string
  title: string
  summary: string
  stage: Extract<CaseStage, 'evidence' | 'analysis'>
  evidence: SeedEvidence[]
}

const FIRST = ['morgan', 'riley', 'sam', 'quinn', 'casey', 'jamie', 'avery', 'jordan', 'taylor', 'drew', 'parker', 'reese', 'skyler', 'emerson', 'rowan', 'harper']
const DOMAINS = ['example.com', 'example.org', 'contoso.example', 'fabrikam.example']
const HOSTILE_IPS = ['203.0.113.44', '203.0.113.87', '198.51.100.9', '198.51.100.201', '192.0.2.15', '192.0.2.66']
const OFFICE_IPS = ['10.0.4.12', '10.0.4.31', '10.0.8.7', '172.16.2.40', '172.16.9.3']

const SCENARIOS = [
  { title: 'Password spray against', summary: 'Several accounts saw failed sign-ins from one address within minutes.' },
  { title: 'Suspicious sign-in for', summary: 'User reported an MFA prompt they did not initiate.' },
  { title: 'Mailbox forwarding rule on', summary: 'A new inbox rule forwards mail to an external address.' },
  { title: 'Unexpected admin grant to', summary: 'Directory audit shows a privileged role assignment outside change control.' },
  { title: 'Brute force lockout for', summary: 'Account locked repeatedly overnight; helpdesk escalated.' },
  { title: 'OAuth consent granted by', summary: 'An unfamiliar third-party app received mailbox read consent.' },
  { title: 'MFA method changed for', summary: 'A new authenticator was registered from an unfamiliar device.' },
  { title: 'Impossible travel on', summary: 'Sign-ins from two distant regions within an hour.' },
] as const

const FILE_KINDS = ['sign-in', 'audit', 'mailbox', 'directory', 'vpn', 'mfa', 'proxy'] as const

export function buildSeedCases(count = 55): SeedCase[] {
  const rand = mulberry32(0x5eed_f10e)
  const pick = <T,>(items: readonly T[]): T => items[Math.floor(rand() * items.length)]
  const cases: SeedCase[] = []

  for (let i = 1; i <= count; i += 1) {
    const n = String(i).padStart(2, '0')
    const scenarioIndex = Math.floor(rand() * SCENARIOS.length)
    const scenario = SCENARIOS[scenarioIndex]
    const target = `${pick(FIRST)}@${pick(DOMAINS)}`
    const day = new Date(Date.UTC(2026, 3 + Math.floor(rand() * 5), 1 + Math.floor(rand() * 27)))
    const evidenceCount = 3 + Math.floor(rand() * 5) // 3..7

    const evidence: SeedEvidence[] = []
    for (let e = 1; e <= evidenceCount; e += 1) {
      const kind = FILE_KINDS[(e - 1 + i) % FILE_KINDS.length]
      const format = (['json', 'csv', 'ndjson'] as const)[(i + e) % 3]
      const events = buildEvents({ rand, pick, scenarioIndex, target, day, fileIndex: e })
      evidence.push({
        recordId: `demo-ev-${n}-${e}`,
        fileName: `${kind}-${isoDate(day)}-${e}.${format === 'ndjson' ? 'jsonl' : format}`,
        content: render(events, format),
      })
    }

    cases.push({
      recordId: `demo-case-${n}`,
      caseNumber: `FP-DEMO${n}`,
      title: `${scenario.title} ${target}`,
      summary: scenario.summary,
      stage: i % 3 === 0 ? 'evidence' : 'analysis',
      evidence,
    })
  }
  return cases
}

type Event = { time: string; actor: string; action: string; ip: string; result: string; detail: string }

function buildEvents(opts: {
  rand: () => number
  pick: <T>(items: readonly T[]) => T
  scenarioIndex: number
  target: string
  day: Date
  fileIndex: number
}): Event[] {
  const { rand, pick, scenarioIndex, target, day, fileIndex } = opts
  let clock = day.getTime() + Math.floor(rand() * 20) * 3_600_000
  const at = (minutes: number) => {
    clock += minutes * 60_000
    return new Date(clock).toISOString().replace('.000Z', 'Z')
  }
  const hostile = pick(HOSTILE_IPS)
  const office = pick(OFFICE_IPS)
  const domain = target.split('@')[1]
  const events: Event[] = []
  const ok = (actor: string, action: string, ip: string, detail: string) =>
    events.push({ time: at(1 + Math.floor(rand() * 9)), actor, action, ip, result: 'success', detail })
  const bad = (actor: string, ip: string, detail = 'invalid password') =>
    events.push({ time: at(1), actor, action: 'auth.failure', ip, result: 'failure', detail })

  // Background noise so every file reads like a real export.
  const noise = 4 + Math.floor(rand() * 8)
  for (let k = 0; k < noise; k += 1) {
    ok(`${pick(FIRST)}@${domain}`, pick(['auth.success', 'file.read', 'mail.send', 'session.refresh']), office, 'routine')
  }

  // The first file always carries the scenario's core signal; later files
  // carry it about half the time so some evidence comes back clean.
  if (fileIndex > 1 && rand() < 0.5) return events

  switch (scenarioIndex) {
    case 0: // spray: one IP, many accounts
      for (const name of FIRST.slice(0, 4 + Math.floor(rand() * 4))) bad(`${name}@${domain}`, hostile)
      break
    case 1: // success after failures
    case 7:
      for (let k = 0; k < 3 + Math.floor(rand() * 4); k += 1) bad(target, hostile)
      ok(target, 'auth.success', hostile, 'password')
      break
    case 2:
      ok(target, 'inbox.rule.create', hostile, 'forward all mail to offsite@example.net')
      break
    case 3:
      ok(target, 'role.grant', hostile, 'added to Global Administrator')
      break
    case 4: // repeated failure, never succeeds
      for (let k = 0; k < 8 + Math.floor(rand() * 6); k += 1) bad(target, hostile, 'account locked')
      break
    case 5:
      ok(target, 'oauth.consent', hostile, 'granted Mail.Read to "Inbox Helper" app')
      break
    case 6:
      ok(target, 'mfa.method.add', hostile, 'registered new authenticator device')
      break
  }
  return events
}

function render(events: Event[], format: 'json' | 'csv' | 'ndjson'): string {
  if (format === 'json') return `[\n${events.map((e) => `  ${JSON.stringify(e)}`).join(',\n')}\n]\n`
  if (format === 'ndjson') return `${events.map((e) => JSON.stringify(e)).join('\n')}\n`
  const header = 'time,actor,action,ip,result,detail'
  const rows = events.map((e) => [e.time, e.actor, e.action, e.ip, e.result, csvCell(e.detail)].join(','))
  return `${[header, ...rows].join('\n')}\n`
}

function csvCell(value: string): string {
  return /[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value
}

function isoDate(date: Date): string {
  return date.toISOString().slice(0, 10)
}

function mulberry32(seed: number): () => number {
  let a = seed
  return () => {
    a = (a + 0x6d2b79f5) | 0
    let t = Math.imul(a ^ (a >>> 15), 1 | a)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
