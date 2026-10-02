import { describe, expect, it } from 'vitest'
import { analyzeEvidence } from './analyze'
import { buildSeedCases } from './seed'

describe('buildSeedCases', () => {
  const cases = buildSeedCases()

  it('builds 50–60 cases with 3–7 evidence files each', () => {
    expect(cases.length).toBeGreaterThanOrEqual(50)
    expect(cases.length).toBeLessThanOrEqual(60)
    for (const item of cases) {
      expect(item.evidence.length).toBeGreaterThanOrEqual(3)
      expect(item.evidence.length).toBeLessThanOrEqual(7)
    }
  })

  it('is deterministic with unique ids', () => {
    expect(buildSeedCases()).toEqual(cases)
    const ids = cases.flatMap((item) => [item.recordId, ...item.evidence.map((e) => e.recordId)])
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('produces evidence the analyzer can parse, with a signal in every case', () => {
    for (const item of cases) {
      const results = item.evidence.map((e) => analyzeEvidence(e.content))
      for (const result of results) expect(result.error).toBeUndefined()
      expect(results.some((result) => result.signals.length > 0)).toBe(true)
    }
  })
})
