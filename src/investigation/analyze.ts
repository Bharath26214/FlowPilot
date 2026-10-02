import { findJsonError } from './json-error'
import type { EventLoc, NormalizedEvent, Severity, Signal } from './types'

type EventField = Exclude<keyof NormalizedEvent, 'loc'>
type SourceRow = { row: Record<string, unknown>; loc: EventLoc }

const FIELD_ALIASES: Record<EventField, string[]> = {
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
  /** Problems that did not stop analysis, e.g. unreadable lines that were skipped. */
  warnings: string[]
  error?: string
  /** 1-based line the error points at, when known. */
  errorLine?: number
}

/** What a reader made of the file: rows, or a precise reason it could not. */
type ReadResult = { rows: SourceRow[]; warnings: string[] } | { error: string; line?: number }

/** Fraction of U+FFFD replacement characters above which text is treated as undecodable. */
const MAX_GARBLED = 0.02

export function analyzeEvidence(raw: string): Analysis {
  // Keep leading blank lines: cited line numbers must match the file as stored.
  const text = raw.replace(/^\uFEFF/, '').trimEnd()
  const unusable = unusableText(text)
  if (unusable) return failed(unusable)

  const read = readRows(text)
  if ('error' in read) return failed(read.error, read.line)

  const truncated = read.rows.length > MAX_EVENTS
  const kept = read.rows.slice(0, MAX_EVENTS)
  const normalized = kept.map(normalizeEvent)
  const events = normalized.filter(isEvent)
  if (events.length === 0) {
    return failed('Rows were present, but none had an actor (user, email, account) and an action (event, operation).')
  }

  const warnings = [...read.warnings]
  const skipped = normalized.filter((event) => !isEvent(event))
  if (skipped.length > 0) {
    warnings.push(`${skipped.length} row${skipped.length === 1 ? '' : 's'} skipped: no actor or action (first at ${locLabel(skipped[0].loc)}).`)
  }
  if (truncated) warnings.push(`Only the first ${MAX_EVENTS.toLocaleString('en-US')} of ${read.rows.length.toLocaleString('en-US')} rows were analyzed.`)

  const signals = detectSignals(events)
  const summary = [
    `${events.length} event${events.length === 1 ? '' : 's'}`,
    `${signals.length} indicator${signals.length === 1 ? '' : 's'}`,
    truncated ? `stopped at ${MAX_EVENTS} rows` : '',
  ]
    .filter(Boolean)
    .join(', ')

  return { events, signals, summary, truncated, warnings }
}

/** Why text cannot be analyzed at all, or null when it can. Shared with upload validation. */
export function unusableText(text: string): string | null {
  if (!text.trim()) return 'The file is empty.'
  if (text.includes('\u0000')) return 'This file looks binary. Upload a JSON, CSV, or text log.'
  const garbled = (text.match(/\uFFFD/g) ?? []).length
  if (garbled > 0 && garbled / text.length > MAX_GARBLED) {
    return 'This file is not readable text (it may be compressed or in another encoding). Upload a UTF-8 JSON, CSV, or text log.'
  }
  return null
}

function failed(error: string, errorLine?: number): Analysis {
  return { events: [], signals: [], summary: error, truncated: false, warnings: [], error, errorLine }
}

function locLabel(loc: EventLoc): string {
  return loc.kind === 'line' ? `line ${loc.n}` : `event #${loc.n}`
}

function isEvent(event: NormalizedEvent): boolean {
  return event.actor.length > 0 && event.action.length > 0
}

function readRows(text: string): ReadResult {
  const body = text.trimStart()
  const lines = numberedLines(text)

  if (body.startsWith('[') || body.startsWith('{')) {
    const whole = tryJson(text)
    if (whole.ok) return jsonResult(whole.value)
    // JSON lines: several lines, the first of which is a complete object on its own.
    if (body.startsWith('{') && lines.length >= 2 && isRecord(tryJson(lines[0].line).ok ? JSON.parse(lines[0].line) : null)) {
      return readNdjson(lines)
    }
    return { error: `Unable to parse the JSON: ${whole.message}`, line: whole.line }
  }
  const csv = readCsv(text)
  if (csv) return csv
  const plain = readLines(lines)
  if (plain) return { rows: plain, warnings: [] }
  return { error: 'No events found. Use a JSON array, CSV with a header row, JSON lines, or one event per line (time user action ip result).' }
}

function tryJson(text: string): { ok: true; value: unknown } | { ok: false; message: string; line?: number } {
  try {
    return { ok: true, value: JSON.parse(text) }
  } catch {
    const where = findJsonError(text)
    if (!where) return { ok: false, message: 'the file contains invalid syntax.' }
    return { ok: false, message: `${where.reason} (line ${where.line}, column ${where.column}).`, line: where.line }
  }
}

function jsonResult(parsed: unknown): ReadResult {
  const items = jsonEventArray(parsed)
  if (!items) {
    return { error: 'The JSON has no list of events. Expected an array, or an object with an "events", "records", "value", "items", "logs", or "data" array.' }
  }
  const rows = jsonRows(items)
  if (rows.length === 0) return { error: 'The JSON event list is empty or holds no objects.' }
  const warnings = rows.length < items.length ? [`${items.length - rows.length} entr${items.length - rows.length === 1 ? 'y' : 'ies'} in the JSON list were not objects and were skipped.`] : []
  return { rows, warnings }
}

/** The event array in a parsed JSON export: the top-level array, or one under a common key. */
function jsonEventArray(parsed: unknown): unknown[] | null {
  if (Array.isArray(parsed)) return parsed
  if (!isRecord(parsed)) return null
  for (const key of ['events', 'records', 'value', 'items', 'logs', 'data']) {
    const value = parsed[key]
    if (Array.isArray(value)) return value
  }
  return null
}

export type SourceExcerpt =
  | { kind: 'lines'; lines: Array<{ n: number; text: string; cited: boolean }> }
  | { kind: 'json'; text: string }

/**
 * The raw source behind an event, exactly as it appears in the file: the cited
 * line with `context` lines either side, or the cited JSON array element.
 */
export function sourceExcerpt(raw: string, loc: EventLoc, context = 2): SourceExcerpt | null {
  const text = raw.replace(/^\uFEFF/, '')
  if (loc.kind === 'line') {
    const lines = text.split(/\r?\n/)
    if (loc.n < 1 || loc.n > lines.length) return null
    const start = Math.max(1, loc.n - context)
    const end = Math.min(lines.length, loc.n + context)
    const excerpt = []
    for (let n = start; n <= end; n += 1) excerpt.push({ n, text: lines[n - 1], cited: n === loc.n })
    return { kind: 'lines', lines: excerpt }
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(text.trim())
  } catch {
    return null
  }
  const item = jsonEventArray(parsed)?.[loc.n - 1]
  return item === undefined ? null : { kind: 'json', text: JSON.stringify(item, null, 2) }
}

function jsonRows(items: unknown[]): SourceRow[] {
  const rows: SourceRow[] = []
  items.forEach((item, index) => {
    if (isRecord(item)) rows.push({ row: item, loc: { kind: 'event', n: index + 1 } })
  })
  return rows
}

/** JSON lines: unreadable lines are skipped and reported, unless none can be read. */
function readNdjson(lines: Array<{ line: string; n: number }>): ReadResult {
  const rows: SourceRow[] = []
  const bad: number[] = []
  for (const { line, n } of lines) {
    try {
      const parsed = JSON.parse(line) as unknown
      if (isRecord(parsed)) rows.push({ row: parsed, loc: { kind: 'line', n } })
      else bad.push(n)
    } catch {
      bad.push(n)
    }
  }
  if (rows.length === 0) return { error: `Unable to parse the JSON lines: no line is a valid JSON object (first bad line ${bad[0]}).`, line: bad[0] }
  const shown = bad.slice(0, 5).join(', ')
  const warnings = bad.length > 0 ? [`${bad.length} line${bad.length === 1 ? '' : 's'} could not be read and ${bad.length === 1 ? 'was' : 'were'} skipped (line${bad.length === 1 ? '' : 's'} ${shown}${bad.length > 5 ? ', …' : ''}).`] : []
  return { rows, warnings }
}

/** Non-blank lines, trimmed, with their 1-based line number in the file. */
function numberedLines(text: string): Array<{ line: string; n: number }> {
  return text
    .split(/\r?\n/)
    .map((line, index) => ({ line: line.trim(), n: index + 1 }))
    .filter(({ line }) => line.length > 0)
}

/** CSV with a header row. Null when the text is not CSV-shaped at all. */
function readCsv(text: string): ReadResult | null {
  if (!text.includes(',')) return null
  const table = parseCsvTable(text).filter(({ cells }) => cells.some((cell) => cell.trim() !== ''))
  if (table.length < 2 || table[0].cells.length < 2) return null
  const headers = table[0].cells.map((cell) => cell.trim())
  const targets = new Set(headers.map(aliasTarget))
  if (!targets.has('actor') || !targets.has('action')) {
    // Only claim the file is a broken CSV when its rows are consistently comma-separated.
    const width = headers.length
    if (table.slice(1, 6).every(({ cells }) => cells.length === width)) {
      const found = headers.slice(0, 8).join(', ')
      return {
        error: `The CSV header has no ${!targets.has('actor') ? 'user column (user, email, actor, account)' : 'action column (action, event, operation)'}. Found: ${found}.`,
        line: table[0].line,
      }
    }
    return null
  }
  const rows: SourceRow[] = []
  for (const { cells, line } of table.slice(1)) {
    const row: Record<string, unknown> = {}
    headers.forEach((header, index) => {
      row[header] = cells[index] ?? ''
    })
    rows.push({ row, loc: { kind: 'line', n: line } })
  }
  return { rows, warnings: [] }
}

function readLines(lines: Array<{ line: string; n: number }>): SourceRow[] | null {
  const rows: SourceRow[] = []
  for (const { line, n } of lines) {
    const loc: EventLoc = { kind: 'line', n }
    if (line.includes('=') && /(?:actor|user|email|action|event)=/i.test(line)) {
      const row: Record<string, unknown> = {}
      for (const part of line.split(/\s+/)) {
        const eq = part.indexOf('=')
        if (eq > 0) row[part.slice(0, eq)] = part.slice(eq + 1)
      }
      rows.push({ row, loc })
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
      row: {
        time,
        actor,
        action,
        ip: parts[3] ?? '',
        result: parts[4] ?? '',
        detail: parts.slice(5).join(' '),
      },
      loc,
    })
  }
  return rows.length > 0 ? rows : null
}

function normalizeEvent({ row, loc }: SourceRow): NormalizedEvent {
  return {
    loc,
    time: field(row, 'time'),
    actor: field(row, 'actor'),
    action: field(row, 'action'),
    ip: field(row, 'ip'),
    result: field(row, 'result'),
    detail: field(row, 'detail'),
  }
}

function field(row: Record<string, unknown>, name: EventField): string {
  for (const [key, value] of Object.entries(row)) {
    if (aliasTarget(key) !== name) continue
    if (value == null) return ''
    if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
      return String(value).trim()
    }
  }
  return ''
}

function aliasTarget(key: string): EventField | null {
  const normalized = key.trim().toLowerCase().replace(/[\s-]+/g, '_')
  for (const [target, aliases] of Object.entries(FIELD_ALIASES) as Array<[EventField, string[]]>) {
    if (aliases.includes(normalized)) return target
  }
  return null
}

export function detectSignals(events: NormalizedEvent[]): Signal[] {
  const ordered = [...events].sort((a, b) => a.time.localeCompare(b.time))
  const signals: Signal[] = []
  const byActor = group(ordered, (event) => event.actor.toLowerCase())
  // Positions are looked up, never searched: an indexOf per comparison made a
  // large single-actor file cubic and could run past the Worker's CPU limit.
  const position = new Map(ordered.map((event, index) => [event, index]))

  for (const [actor, actorEvents] of byActor) {
    const failures = actorEvents.filter(isFailure)
    const successes = actorEvents.filter(isSuccess)
    // Events are time-ordered, so "after any failure" means "after the first one".
    const firstFailure = failures.length > 0 ? position.get(failures[0])! : Infinity
    const successesAfter = successes.filter((success) => position.get(success)! > firstFailure)
    const successAfterFailure = successesAfter.length > 0
    if (failures.length >= 3 && successAfterFailure) {
      signals.push(
        signal(
          'auth.after-failures',
          'high',
          'Sign-in succeeded after repeated failures',
          `${actor} failed ${failures.length} times, then signed in successfully.`,
          `auth.after-failures:${actor}`,
          [...failures, ...successesAfter],
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
          failures,
        ),
      )
    }
  }

  const failuresByIp = new Map<string, NormalizedEvent[]>()
  for (const event of ordered) {
    if (!event.ip || !isFailure(event)) continue
    const list = failuresByIp.get(event.ip) ?? []
    list.push(event)
    failuresByIp.set(event.ip, list)
  }
  for (const [ip, ipFailures] of failuresByIp) {
    const actors = new Set(ipFailures.map((event) => event.actor.toLowerCase()))
    if (actors.size < 4) continue
    signals.push(
      signal(
        'auth.shared-source',
        'high',
        'One address failed against several accounts',
        `${ip} recorded failed sign-ins for ${actors.size} accounts.`,
        `auth.shared-source:${ip}`,
        ipFailures,
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
        privileged,
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
        sensitive,
      ),
    )
  }

  return signals
}

function signal(
  kind: string,
  severity: Severity,
  title: string,
  detail: string,
  indicator: string,
  events: NormalizedEvent[],
): Signal {
  const byPosition = new Map(events.map((event) => [event.loc.n, event.loc]))
  const refs = [...byPosition.values()].sort((a, b) => a.n - b.n)
  return { kind, severity, title, detail, indicator, refs }
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

/** Rows of cells, each with the 1-based file line its record starts on. */
function parseCsvTable(text: string): Array<{ cells: string[]; line: number }> {
  const rows: Array<{ cells: string[]; line: number }> = []
  let row: string[] = []
  let cell = ''
  let quoted = false
  let line = 1
  let rowLine = 1
  for (let i = 0; i < text.length; i += 1) {
    const char = text[i]
    if (quoted) {
      if (char === '\n') line += 1
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
      rows.push({ cells: row, line: rowLine })
      row = []
      cell = ''
      line += 1
      rowLine = line
      continue
    }
    cell += char
  }
  if (cell.length > 0 || row.length > 0) {
    row.push(cell)
    rows.push({ cells: row, line: rowLine })
  }
  return rows
}
