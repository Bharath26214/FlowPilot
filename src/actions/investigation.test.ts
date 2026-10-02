/**
 * Failure handling through the real server actions, against an in-memory
 * stand-in for the record room. Platform calls (membership, the AI provider)
 * are mocked; everything between them is the production code path.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ActionTools } from 'deepspace/worker'

const ai = vi.hoisted(() => ({ generateText: vi.fn() }))
const analyzer = vi.hoisted(() => ({ crash: false }))
const membership = vi.hoisted(() => ({ role: 'member' }))

vi.mock('deepspace/worker', () => ({
  isAnonymousUserId: () => false,
  resolveAppMembership: async () => ({ role: membership.role }),
  createDeepSpaceAI: () => () => ({}),
}))
vi.mock('ai', () => ({ generateText: ai.generateText }))
vi.mock('../investigation/analyze', async (importOriginal) => {
  const real = await importOriginal<typeof import('../investigation/analyze')>()
  return {
    ...real,
    analyzeEvidence: (raw: string) => {
      if (analyzer.crash) throw new RangeError('Maximum call stack size exceeded')
      return real.analyzeEvidence(raw)
    },
  }
})

const { addEvidence, analyzeEvidenceAction, askAssistant, deleteCase } = await import('./investigation')

type Store = Map<string, Map<string, Record<string, unknown>>>

function fakeTools(store: Store): ActionTools {
  let next = 0
  const table = (name: string) => {
    if (!store.has(name)) store.set(name, new Map())
    return store.get(name)!
  }
  const matches = (data: Record<string, unknown>, where: Record<string, unknown> = {}) =>
    Object.entries(where).every(([key, value]) => data[key] === value)
  const tools = {
    create: async (collection: string, data: Record<string, unknown>, recordId?: string) => {
      const id = recordId ?? `${collection}-${++next}`
      table(collection).set(id, { ...(table(collection).get(id) ?? {}), ...data })
      return { success: true, data: { recordId: id } }
    },
    update: async (collection: string, recordId: string, data: Record<string, unknown>) => {
      const row = table(collection).get(recordId)
      if (!row) return { success: false, error: 'not found' }
      table(collection).set(recordId, { ...row, ...data })
      return { success: true, data: {} }
    },
    get: async (collection: string, recordId: string) => {
      const row = table(collection).get(recordId)
      return row ? { success: true, data: { record: { recordId, data: row } } } : { success: false, error: 'not found' }
    },
    query: async (collection: string, options: { where?: Record<string, unknown>; limit?: number } = {}) => ({
      success: true,
      data: {
        records: [...table(collection)]
          .filter(([, data]) => matches(data, options.where))
          .slice(0, options.limit ?? 100)
          .map(([recordId, data]) => ({ recordId, data })),
      },
    }),
    deleteWhere: async (collection: string, where: Record<string, unknown>, limit = 100) => {
      let deleted = 0
      for (const [id, data] of [...table(collection)]) {
        if (deleted === limit) break
        if (matches(data, where)) {
          table(collection).delete(id)
          deleted += 1
        }
      }
      return { success: true, data: { deleted } }
    },
    remove: async (collection: string, recordId: string) => {
      table(collection).delete(recordId)
      return { success: true, data: {} }
    },
    integration: async () => ({ success: false, error: 'not used' }),
    registerUser: async () => ({ success: false, error: 'not used' }),
  }
  return tools as unknown as ActionTools
}

let store: Store
let tools: ActionTools
const env = {} as never
const call = (action: typeof addEvidence, params: Record<string, unknown>) =>
  action({ userId: 'analyst-1', params, tools, env, callerJwt: 'jwt' })

const goodCsv = 'time,actor,action,ip,result\n2026-04-02T01:00:00Z,a@x.com,auth.failure,1.2.3.4,failure\n2026-04-02T01:01:00Z,a@x.com,auth.failure,1.2.3.4,failure\n2026-04-02T01:02:00Z,a@x.com,auth.failure,1.2.3.4,failure\n2026-04-02T01:03:00Z,a@x.com,auth.success,1.2.3.4,success\n'

beforeEach(async () => {
  store = new Map()
  tools = fakeTools(store)
  analyzer.crash = false
  membership.role = 'member'
  ai.generateText.mockReset()
  await tools.create('cases', { caseNumber: 'FP-T', title: 'Test', summary: '', stage: 'intake' }, 'case-1')
})

const evidenceRows = () => [...(store.get('evidence') ?? new Map()).values()]

describe('addEvidence', () => {
  it('rejects empty evidence', async () => {
    expect(await call(addEvidence, { caseId: 'case-1', fileName: 'empty.log', content: '  \n ' })).toEqual({ success: false, error: 'The file is empty.' })
    expect(evidenceRows()).toHaveLength(0)
  })

  it('rejects an invalid (binary) file', async () => {
    const result = await call(addEvidence, { caseId: 'case-1', fileName: 'logs.zip', content: 'PK\u0003\u0004\u0000' })
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/binary/) })
  })

  it('rejects duplicate evidence by content, whatever the file name', async () => {
    expect(await call(addEvidence, { caseId: 'case-1', fileName: 'login.csv', content: goodCsv })).toMatchObject({ success: true })
    const again = await call(addEvidence, { caseId: 'case-1', fileName: 'login (1).csv', content: goodCsv })
    expect(again).toEqual({
      success: false,
      error: 'Duplicate evidence: this file is identical to "login.csv", which is already on the case.',
    })
    expect(evidenceRows()).toHaveLength(1)
  })

  it('allows the same file on a different case', async () => {
    await tools.create('cases', { caseNumber: 'FP-U', title: 'Other', summary: '', stage: 'intake' }, 'case-2')
    await call(addEvidence, { caseId: 'case-1', fileName: 'login.csv', content: goodCsv })
    expect(await call(addEvidence, { caseId: 'case-2', fileName: 'login.csv', content: goodCsv })).toMatchObject({ success: true })
  })
})

describe('analyzeEvidence', () => {
  async function upload(fileName: string, content: string): Promise<string> {
    const result = await call(addEvidence, { caseId: 'case-1', fileName, content })
    if (!result.success) throw new Error(result.error)
    return (result.data as { evidenceId: string }).evidenceId
  }

  it('records a malformed file as failed with the reason and line, and keeps going', async () => {
    const bad = await upload('evidence.json', '[\n {"actor":"a@x.com","action":"auth.failure"},\n {"actor":')
    const good = await upload('login.csv', goodCsv)
    expect(await call(analyzeEvidenceAction, { caseId: 'case-1' })).toEqual({ success: true, data: { analyzed: 1, failed: 1 } })
    expect(store.get('evidence')!.get(bad)).toMatchObject({
      analysisStatus: 'failed',
      analysisSummary: expect.stringMatching(/^Unable to parse the JSON: .*\(line 3, column \d+\)\.$/),
      analysisErrorLine: 3,
    })
    expect(store.get('evidence')!.get(good)).toMatchObject({ analysisStatus: 'complete', eventCount: 4 })
  })

  it('retries one file on request', async () => {
    const id = await upload('login.csv', goodCsv)
    await tools.update('evidence', id, { analysisStatus: 'failed', analysisSummary: 'earlier failure' })
    expect(await call(analyzeEvidenceAction, { caseId: 'case-1', evidenceId: id })).toEqual({ success: true, data: { analyzed: 1, failed: 0 } })
    expect(store.get('evidence')!.get(id)).toMatchObject({ analysisStatus: 'complete', analysisErrorLine: 0 })
  })

  it('recovers a run that timed out, but leaves a fresh run alone', async () => {
    const stuck = await upload('stuck.csv', goodCsv)
    const fresh = await upload('fresh.csv', goodCsv.replace('1.2.3.4', '5.6.7.8'))
    await tools.update('evidence', stuck, { analysisStatus: 'running', analysisStartedAt: new Date(Date.now() - 10 * 60_000).toISOString() })
    await tools.update('evidence', fresh, { analysisStatus: 'running', analysisStartedAt: new Date().toISOString() })
    expect(await call(analyzeEvidenceAction, { caseId: 'case-1' })).toEqual({ success: true, data: { analyzed: 1, failed: 0 } })
    expect(store.get('evidence')!.get(stuck)).toMatchObject({ analysisStatus: 'complete' })
    expect(store.get('evidence')!.get(fresh)).toMatchObject({ analysisStatus: 'running' })
  })

  it('contains an analyzer crash to the one file', async () => {
    const id = await upload('login.csv', goodCsv)
    analyzer.crash = true
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    expect(await call(analyzeEvidenceAction, { caseId: 'case-1' })).toEqual({ success: true, data: { analyzed: 0, failed: 1 } })
    expect(store.get('evidence')!.get(id)).toMatchObject({ analysisStatus: 'failed', analysisSummary: expect.stringMatching(/internal error/) })
    errors.mockRestore()
  })

  it('says so when nothing is waiting', async () => {
    expect(await call(analyzeEvidenceAction, { caseId: 'case-1' })).toEqual({ success: false, error: 'Nothing is waiting for analysis.' })
  })
})

describe('askAssistant', () => {
  beforeEach(async () => {
    await call(addEvidence, { caseId: 'case-1', fileName: 'login.csv', content: goodCsv })
    await call(analyzeEvidenceAction, { caseId: 'case-1' })
  })

  it('fails cleanly and stores nothing when the AI is unavailable', async () => {
    ai.generateText.mockRejectedValue(new Error('upstream 503'))
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    const result = await call(askAssistant, { caseId: 'case-1' })
    expect(result).toMatchObject({ success: false, error: expect.stringMatching(/AI service is unavailable/) })
    expect(store.get('briefs')?.size ?? 0).toBe(0)
    errors.mockRestore()
  })

  it('stores an unsupported conclusion downgraded, with a warning', async () => {
    ai.generateText.mockResolvedValue({
      text: JSON.stringify({ statements: [{ text: 'Payroll data was stolen.', kind: 'evidence', cites: ['F1:L42'] }] }),
    })
    expect(await call(askAssistant, { caseId: 'case-1' })).toMatchObject({ success: true })
    const [brief] = [...store.get('briefs')!.values()]
    expect(brief).toMatchObject({
      statements: [{ kind: 'inference', unsupported: true, citations: [] }],
      droppedCitations: 1,
      warning: expect.stringMatching(/No statement in this answer is tied to a source line/),
    })
  })
})

describe('deleteCase', () => {
  beforeEach(async () => {
    await call(addEvidence, { caseId: 'case-1', fileName: 'login.csv', content: goodCsv, fileKey: 'cases/case-1/login.csv' })
    await tools.create('findings', { caseId: 'case-1', evidenceId: 'x', status: 'draft' })
    await tools.create('reviews', { caseId: 'case-1', findingId: 'f' })
    await tools.create('briefs', { caseId: 'case-1', question: 'q' })
    await tools.create('cases', { caseNumber: 'FP-KEEP', title: 'Other', summary: '', stage: 'intake' }, 'case-2')
    await tools.create('findings', { caseId: 'case-2', evidenceId: 'y', status: 'draft' })
  })

  it('refuses non-admins', async () => {
    expect(await call(deleteCase, { caseId: 'case-1', confirmCaseNumber: 'FP-T' })).toEqual({ success: false, error: 'Only admins can delete a case.' })
    expect(store.get('cases')!.has('case-1')).toBe(true)
  })

  it('requires the case number as confirmation', async () => {
    membership.role = 'admin'
    expect(await call(deleteCase, { caseId: 'case-1', confirmCaseNumber: 'FP-X' })).toEqual({ success: false, error: 'Type FP-T to confirm.' })
    expect(store.get('cases')!.has('case-1')).toBe(true)
  })

  it('removes the case and everything on it, and nothing else', async () => {
    membership.role = 'admin'
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})
    const result = await call(deleteCase, { caseId: 'case-1', confirmCaseNumber: 'FP-T' })
    expect(result).toMatchObject({ success: true, data: { fileKeys: ['cases/case-1/login.csv'], removed: { evidence: 1, findings: 1, reviews: 1, briefs: 1 } } })
    expect(store.get('cases')!.has('case-1')).toBe(false)
    for (const collection of ['evidence', 'findings', 'reviews', 'briefs']) {
      expect([...store.get(collection)!.values()].some((row) => row.caseId === 'case-1')).toBe(false)
    }
    expect(store.get('cases')!.has('case-2')).toBe(true)
    expect([...store.get('findings')!.values()].filter((row) => row.caseId === 'case-2')).toHaveLength(1)
    info.mockRestore()
  })
})
