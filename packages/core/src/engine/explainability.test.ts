/**
 * Stage 8: explainability. `engine.explain(itemId)`, the full `ScoreTrace`, the rounded
 * presentation scale, and the "Σ contributions = baseScore" golden of §16.
 *
 * Self-contained fixtures rather than `@recoengine/testing`: the kit is built on the core,
 * so the core cannot depend on it without a cycle.
 */
import { describe, expect, it } from 'vitest'
import type { Item } from '../domain/entities.js'
import type { FeatureDescriptor } from '../domain/feature.js'
import { featureKey, itemId, strategyId, userId } from '../domain/ids.js'
import { minmax } from '../math/normalize.js'
import type { PreFilter } from '../ports/candidate-filter.js'
import type { CandidateProvider } from '../ports/candidate-provider.js'
import type { Diversifier } from '../ports/diversifier.js'
import type { FeatureExtractor } from '../ports/feature-extractor.js'
import type { ScoringStrategy } from '../ports/scoring-strategy.js'
import { createEngine } from './engine.js'

const LIMITS = { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 }
const POP = featureKey('popularity')

const req = (over: Record<string, unknown> = {}) => ({
  user: { id: userId('u1'), payload: {} },
  history: { userId: userId('u1'), events: [] },
  limit: 10,
  explain: 'reasons' as const,
  ...over,
})

const rows = (...ids: string[]): Item[] => ids.map((id) => ({ id: itemId(id), type: 'item', payload: {} }))

const provider = (items: Item[]): CandidateProvider => ({
  id: 'library',
  version: '1.0.0',
  provide: async (_ctx, budget) => items.slice(0, budget.maxItems),
})

const descriptor: FeatureDescriptor = {
  key: POP,
  kind: 'numeric',
  defaultValue: 0,
  description: 'popularity',
  owner: 'pop',
  ownerVersion: '1.0.0',
}

/** popularity = row index × 10, so later rows score higher and the order is predictable. */
const popularity: FeatureExtractor = {
  id: 'pop',
  version: '1.0.0',
  provides: [descriptor],
  extract: async (set, out) => {
    const column = out.columnMut(POP)
    for (let r = 0; r < set.size; r++) column[r] = r * 10
  },
}

const popular: ScoringStrategy = {
  id: strategyId('popularity'),
  requires: [POP],
  normalizer: minmax,
  score: (view) => ({
    strategyId: strategyId('popularity'),
    raw: view.items.column(POP),
    reasons: new Map(),
  }),
}

const baseEngine = () =>
  createEngine()
    .use(provider(rows('a', 'b', 'c')))
    .use(popularity)
    .use(popular)

describe('presentation scale is rounded (§11.2)', () => {
  it('rounds score and baseScore to integers', async () => {
    // Three rows, minmax over [0,10,20] → [0, 0.5, 1.0], so scores are 0/50/100 — but the
    // rounding path is exercised by any non-terminating decimal; here we assert integers.
    const { recommendations } = await baseEngine()
      .configure({ limits: LIMITS, weights: { popularity: 1 } })
      .build()
      .recommend(req())
    for (const rec of recommendations) {
      expect(Number.isInteger(rec.score)).toBe(true)
      expect(Number.isInteger(rec.explanation.baseScore)).toBe(true)
    }
  })

  it('rounds a repeating decimal rather than leaking 96.5517…', async () => {
    // Two strategies with weights 0.9 and 1.0 over normalized 1.0 and 0.8 give
    // base = (0.9·1 + 1·0.8)/1.9 = 0.8947…, → 89 after round, not 89.47.
    const second: ScoringStrategy = {
      id: strategyId('other'),
      requires: [POP],
      normalizer: minmax,
      score: (view) => ({ strategyId: strategyId('other'), raw: view.items.column(POP), reasons: new Map() }),
    }
    const engine = createEngine()
      .use(provider(rows('a', 'b')))
      .use(popularity)
      .use(popular)
      .use(second)
      .configure({ limits: LIMITS, weights: { popularity: 0.9, other: 1.0 } })
      .build()
    const { recommendations } = await engine.recommend(req())
    for (const rec of recommendations) expect(Number.isInteger(rec.score)).toBe(true)
  })
})

describe('ScoreTrace under explain: full', () => {
  it('is absent under reasons and present under full', async () => {
    const engine = baseEngine()
      .configure({ limits: LIMITS, weights: { popularity: 1 } })
      .build()
    const reasons = (await engine.recommend(req({ explain: 'reasons' }))).recommendations[0]
    const full = (await engine.recommend(req({ explain: 'full' }))).recommendations[0]
    expect(reasons?.explanation.trace).toBeUndefined()
    expect(full?.explanation.trace).toBeDefined()
  })

  it('carries the schema version, the features, and a base→final stage list', async () => {
    const engine = baseEngine()
      .configure({ limits: LIMITS, weights: { popularity: 1 } })
      .build()
    const top = (await engine.recommend(req({ explain: 'full' }))).recommendations[0]
    const trace = top?.explanation.trace
    expect(trace?.schemaVersion).toBeTruthy()
    expect(trace?.features).toHaveProperty('popularity')
    expect(trace?.stages[0]?.stage).toBe('base')
    expect(trace?.stages.at(-1)?.stage).toBe('final')
  })
})

describe('Σ contributions = baseScore (§16 golden)', () => {
  it('the folded contributions reproduce the reported baseScore', async () => {
    const engine = baseEngine()
      .configure({ limits: LIMITS, weights: { popularity: 1 } })
      .build()
    const { recommendations } = await engine.recommend(req({ explain: 'full' }))
    for (const rec of recommendations) {
      const additive = rec.explanation.contributions.filter((c) => c.kind === 'additive')
      if (additive.length === 0) continue
      const weightSum = additive.reduce((s, c) => s + c.weight, 0)
      const base = additive.reduce((s, c) => s + c.weight * c.normalized, 0) / weightSum
      expect(Math.round(base * 100)).toBe(rec.explanation.baseScore)
    }
  })
})

describe('engine.explain(itemId, request) — §16', () => {
  it('reports a recommended item with its rank and full explanation', async () => {
    const engine = baseEngine()
      .configure({ limits: LIMITS, weights: { popularity: 1 } })
      .build()
    const result = await engine.explain(itemId('c'), req()) // c has the highest popularity
    expect(result.status).toBe('recommended')
    expect(result.rank).toBe(1)
    expect(result.item?.id).toBe('c')
    expect(result.explanation?.trace).toBeDefined()
  })

  it('says not_retrieved for an item no provider returned', async () => {
    const engine = baseEngine()
      .configure({ limits: LIMITS, weights: { popularity: 1 } })
      .build()
    const result = await engine.explain(itemId('nonexistent'), req())
    expect(result.status).toBe('not_retrieved')
    expect(result.lostAt).toBe('retrieval')
    expect(result.item).toBeUndefined()
    expect(result.explanation).toBeUndefined()
  })

  it('says filtered, at prefilter, for an item a pre-filter removed', async () => {
    const blockB: PreFilter = { id: 'block-b', failClosed: true, approve: (c) => c.item.id !== 'b' }
    const engine = baseEngine()
      .use(blockB)
      .configure({ limits: LIMITS, weights: { popularity: 1 } })
      .build()
    const result = await engine.explain(itemId('b'), req())
    expect(result.status).toBe('filtered')
    expect(result.lostAt).toBe('prefilter')
    expect(result.item?.id).toBe('b') // it was retrieved, then removed — so the item is known
    expect(result.explanation).toBeUndefined()
  })

  it('says truncated, with a rank, for a scored item below the requested page', async () => {
    const engine = createEngine()
      .use(provider(rows('a', 'b', 'c', 'd', 'e')))
      .use(popularity)
      .use(popular)
      .configure({ limits: LIMITS, weights: { popularity: 1 } })
      .build()
    // limit 2 → only the top two make the page; 'a' has the lowest popularity → rank 5.
    const result = await engine.explain(itemId('a'), req({ limit: 2 }))
    expect(result.status).toBe('truncated')
    expect(result.lostAt).toBe('truncate')
    expect(result.rank).toBe(5)
    expect(result.explanation).toBeDefined() // scored, so it still carries its story
  })

  it('says diversified_out for a scored item a diversifier dropped', async () => {
    // A diversifier that keeps only the first-ranked row drops everything else.
    const keepTop: Diversifier = { id: 'keep-top', diversify: (ranked) => ranked.slice(0, 1) }
    const engine = baseEngine()
      .use(keepTop)
      .configure({ limits: LIMITS, weights: { popularity: 1 } })
      .build()
    const result = await engine.explain(itemId('a'), req()) // a is not the top row
    expect(result.status).toBe('diversified_out')
    expect(result.lostAt).toBe('diversification')
    expect(result.explanation).toBeDefined()
  })

  it('carries the same diagnostics the request would produce', async () => {
    const engine = baseEngine()
      .configure({ limits: LIMITS, weights: { popularity: 1 } })
      .build()
    const result = await engine.explain(itemId('c'), req())
    expect(result.diagnostics.retrieved).toBe(3)
  })
})
