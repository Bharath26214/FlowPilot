import type { NormalizedEvent, Severity, Signal } from './types'

const FIELD_ALIASES: Record<keyof NormalizedEvent, string[]> = {
  time: ['time', 'timestamp', 'created_at', 'createdat', 'date', 'datetime', 'eventtime', 'event_time'],
  actor: ['actor', 'user', 'email', 'userprincipalname', 'account', 'username', 'upn', 'userid', 'user_id'],
  action: ['action', 'event', 'operation', 'activity', 'eventtype', 'event_type', 'actiontype'],
  ip: ['ip', 'ipaddress', 'ip_address', 'clientip', 'client_ip', 'sourceip', 'source_ip'],
  result: ['result', 'status', 'outcome'],
  detail: ['detail', 'message', 'description', 'reason'],
}

const MAX_EVENTS = 5_000

export type Analysis = {
  events: NormalizedEvent[]
  signals: Signal[]
  summary: string
  truncated: boolean
  error?: string
}

export function analyzeEvidence(raw: string): Analysis {
  const text = raw.replace(/^\uFEFF/, '').trim()
  if (!text) {
    return empty('The file is empty.')
  }
  if (text.includes('\u0000')) {
    return empty('This file looks binary. Upload a JSON, CSV, or text log.')
  }

  const rows = readRows(text)
  if (!rows) {
    return empty('No events found. Use a JSON array, CSV with a header, or one event per line.')
  }

  const truncated = rows.length > MAX_EVENTS
  const events = rows.slice(0, MAX_EVENTS).map(normalizeEvent).filter(isEvent)
  if (events.length === 0) {
    return empty('Rows were present, but none had an actor and an action.')
  }

  const signals = detectSignals(events)
  const summary = [
    `${events.length} event${events.length === 1 ? '' : 's'}`,
    `${signals.length} indicator${signals.length === 1 ? '' : 's'}`,
    truncated ? `stopped at ${MAX_EVENTS} rows` : '',
  ]
    .filter(Boolean)
    .join(', ')

  return { events, signals, summary, truncated }
}

function empty(error: string): Analysis {
  return { events: [], signals: [], summary: error, truncated: false, error }
}

function isEvent(event: NormalizedEvent): boolean {
  return event.actor.length > 0 && event.action.length > 0
}

function readRows(text: string): Array<Record<string, unknown>> | null {
  const json = readJson(text)
  if (json) return json
  const ndjson = readNdjson(text)
  if (ndjson) return ndjson
  const csv = readCsv(text)
  if (csv) return csv
  const lines = readLines(text)
  if (lines) return lines
  return null
}

function readJson(text: string): Array<Record<string, unknown>> | null {
  if (!text.startsWith('{') && !text.startsWith('[')) return null
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  if (Array.isArray(parsed)) return parsed.filter(isRecord)
  if (!isRecord(parsed)) return null
  for (const key of ['events', 'records', 'value', 'items', 'logs', 'data']) {
    const value = parsed[key]
    if (Array.isArray(value)) return value.filter(isRecord)
  }
  return null
}

function readNdjson(text: string): Array<Record<string, unknown>> | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  if (lines.length < 2 || !lines.every((line) => line.startsWith('{'))) return null
  const rows: Array<Record<string, unknown>> = []
  for (const line of lines) {
    try {
      const parsed = JSON.parse(line) as unknown
      if (isRecord(parsed)) rows.push(parsed)
    } catch {
      return null
    }
  }
  return rows.length > 0 ? rows : null
}

function readCsv(text: string): Array<Record<string, unknown>> | null {
  if (!text.includes(',')) return null
  const table = parseCsvTable(text)
  if (table.length < 2) return null
  const headers = table[0].map((cell) => cell.trim())
  if (!headers.some((header) => aliasTarget(header))) return null
  const rows: Array<Record<string, unknown>> = []
  for (const cells of table.slice(1)) {
    if (cells.every((cell) => cell.trim() === '')) continue
    const row: Record<string, unknown> = {}
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? ''
    })
    rows.push(row)
  }
  return rows.length > 0 ? rows : null
}

function readLines(text: string): Array<Record<string, unknown>> | null {
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)
  const rows: Array<Record<string, unknown>> = []
  for (const line of lines) {
    if (line.includes('=') && /(?:actor|user|email|action|event)=/i.test(line)) {
      const row: Record<string, unknown> = {}
      for (const part of line.split(/\s+/)) {
        const eq = part.indexOf('=')
        if (eq > 0) row[part.slice(0, eq)] = part.slice(eq + 1)
      }
      rows.push(row)
      continue
    }
    const parts = line.split(/\s+/)
    if (parts.length < 3) continue
    const time = parts[0]
    const actor = parts[1]
    const action = parts[2]
    const dated = /^\d{4}-\d{2}-\d{2}/.test(time)
    if (!actor.includes('@') && !action.includes('.') && !dated) continue
    rows.push({
      time,
      actor,
      action,
      ip: parts[3] ?? '',
      result: parts[4] ?? '',
      detail: parts.slice(5).join(' '),
    })
  }
  return rows.length > 0 ? rows : null
}

function normalizeEvent(row: Record<string, unknown>): NormalizedEvent {
  return {
    time: field(row, 'time'),
    actor: field(row, 'actor'),
    action: field(row, 'action'),
    ip: field(row, 'ip'),
    result: field(row, 'result'),
    detail: field(row, 'detail'),
  }
}

function field(row: Record<string, unknown>, name: keyof NormalizedEvent): string {
  for (const [key, value] of Object.entries(row)) {
    if (aliasTarget(key) !== name) continue
    if (value == null) return ''
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value).trim()
    }
  }
  return ''
}

function aliasTarget(key: string): keyof NormalizedEvent | null {
  const normalized = key.trim().toLowerCase().replace(/[\s-]+/g, '_')
  for (const [target, aliases] of Object.entries(FIELD_ALIASES) as Array<[keyof NormalizedEvent, string[]]>) {
    if (aliases.includes(normalized)) return target
  }
  return null
}

export function detectSignals(events: NormalizedEvent[]): Signal[] {
  const ordered = [...events].sort((a, b) => a.time.localeCompare(b.time))
  const signals: Signal[] = []
  const byActor = group(ordered, (event) => event.actor.toLowerCase())

  for (const [actor, actorEvents] of byActor) {
    const failures = actorEvents.filter(isFailure)
    const successes = actorEvents.filter(isSuccess)
    const successAfterFailure = successes.some((success) =>
      failures.some((failure) => ordered.indexOf(failure) < ordered.indexOf(success)),
    )
    if (failures.length >= 3 && successAfterFailure) {
      signals.push(
        signal(
          'auth.after-failures',
          'high',
          'Sign-in succeeded after repeated failures',
          `${actor} failed ${failures.length} times, then signed in successfully.`,
          `auth.after-failures:${actor}`,
        ),
      )
    } else if (failures.length >= 8 && successes.length === 0) {
      signals.push(
        signal(
          'auth.repeated-failure',
          'medium',
          'Repeated failed sign-ins',
          `${actor} failed ${failures.length} times and never succeeded in this file.`,
          `auth.repeated-failure:${actor}`,
        ),
      )
    }
  }

  const failuresByIp = new Map<string, Set<string>>()
  for (const event of ordered) {
    if (!event.ip || !isFailure(event)) continue
    const actors = failuresByIp.get(event.ip) ?? new Set<string>()
    actors.add(event.actor.toLowerCase())
    failuresByIp.set(event.ip, actors)
  }
  for (const [ip, actors] of failuresByIp) {
    if (actors.size < 4) continue
    signals.push(
      signal(
        'auth.shared-source',
        'high',
        'One address failed against several accounts',
        `${ip} recorded failed sign-ins for ${actors.size} accounts.`,
        `auth.shared-source:${ip}`,
      ),
    )
  }

  const privileged = ordered.filter((event) => !isFailure(event) && isPrivileged(event))
  if (privileged.length > 0) {
    const actors = unique(privileged.map((event) => event.actor))
    signals.push(
      signal(
        'privilege.change',
        'high',
        'Privileged role change',
        `${privileged.length} privileged change${privileged.length === 1 ? '' : 's'} by ${actors.join(', ')}.`,
        `privilege.change:${actors.join(',')}`,
      ),
    )
  }

  const sensitive = ordered.filter((event) => !isFailure(event) && isSensitive(event))
  if (sensitive.length > 0) {
    const actors = unique(sensitive.map((event) => event.actor))
    signals.push(
      signal(
        'account.control-change',
        'high',
        'Mailbox, MFA, or consent change',
        `${sensitive.length} control change${sensitive.length === 1 ? '' : 's'} by ${actors.join(', ')}.`,
        `account.control-change:${actors.join(',')}`,
      ),
    )
  }

  return signals
}

function signal(kind: string, severity: Severity, title: string, detail: string, indicator: string): Signal {
  return { kind, severity, title, detail, indicator }
}

function isFailure(event: NormalizedEvent): boolean {
  const blob = `${event.action} ${event.result} ${event.detail}`.toLowerCase()
  return /fail|denied|invalid|locked|blocked|error/.test(blob) && !/not failed|no error/.test(blob)
}

function isSuccess(event: NormalizedEvent): boolean {
  if (isFailure(event)) return false
  const blob = `${event.action} ${event.result}`.toLowerCase()
  return /success|succeeded|accepted|allow/.test(blob)
}

function isPrivileged(event: NormalizedEvent): boolean {
  const blob = `${event.action} ${event.detail}`.toLowerCase()
  return /role\.?grant|add member to role|global admin|privilege|administrator|permission grant|owner assigned/.test(blob)
}

function isSensitive(event: NormalizedEvent): boolean {
  const blob = `${event.action} ${event.detail}`.toLowerCase()
  return /mfa|multi-factor|inbox\.?rule|forward|oauth|consent|authenticator/.test(blob)
}

function group<T>(items: T[], key: (item: T) => string): Map<string, T[]> {
  const map = new Map<string, T[]>()
  for (const item of items) {
    const id = key(item)
    const list = map.get(id) ?? []
    list.push(item)
    map.set(id, list)
  }
  return map
}

function unique(values: string[]): string[] {
  return [...new Set(values)]
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function parseCsvTable(text: string): string[][] {
  const rows: string[][] = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          cell += '"'
          i += 1
        } else {
          quoted = false
        }
      } else {
        cell += char
      }
      continue
    }
    if (char === '"') {
      quoted = true
      continue
    }
    if (char === ',') {
      row.push(cell)
      cell = ''
      continue
    }
    if (char === '\n' || char === '\r') {
      if (char === '\r' && text[i + 1] === '\n') i += 1
      row.push(cell)
      rows.push(row)
      row = []
      cell = ''
      continue
    }
    cell += char
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push(row)
  }
  return rows
}
