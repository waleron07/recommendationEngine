/**
 * Dogfood: the kit tests itself. The fixtures build a working engine, the contracts pass
 * on conformant ports, and — the part that matters — they *throw* on ports that violate
 * the contract. A contract that never fails is a green light wired to nothing.
 */
import { contributionOf, type RecommendationEngine, type ScoreModifier, strategyId } from '@recoengine/core'
import { describe, expect, it } from 'vitest'
import {
  assertDeterministic,
  assertExplanationSums,
  assertExtractorErrorPolicy,
  assertHonoursCancellation,
  assertScoreModifier,
  assertScoringStrategy,
  catalogueOf,
  events,
  historyOf,
  passthroughStrategy,
  payloadExtractor,
  rankedIds,
  request,
  testEngine,
  throwingExtractor,
} from './index.js'

const rows = [
  { id: 'low', score: 1 },
  { id: 'high', score: 9 },
  { id: 'mid', score: 5 },
]

describe('fixtures', () => {
  it('assemble an engine that ranks by a payload feature', async () => {
    const engine = testEngine({
      use: [catalogueOf(rows), payloadExtractor(['score']), passthroughStrategy('score')],
    })
    expect(rankedIds(await engine.recommend(request()))).toEqual(['high', 'mid', 'low'])
  })

  it('events + historyOf build a usable history', async () => {
    const history = historyOf(events('high', 3))
    expect(history.events).toHaveLength(3)
    expect(history.events.every((e) => e.itemId === 'high')).toBe(true)
  })
})

describe('contracts pass on conformant ports', () => {
  it('assertScoringStrategy on a passthrough strategy', async () => {
    await assertScoringStrategy(passthroughStrategy('score'), { rows })
  })

  it('assertExplanationSums on a real engine', async () => {
    const engine = testEngine({
      use: [catalogueOf(rows), payloadExtractor(['score']), passthroughStrategy('score')],
    })
    await assertExplanationSums(engine)
  })

  it('assertScoreModifier on a well-behaved modifier', async () => {
    const damp: ScoreModifier = {
      id: 'damp',
      kind: 'multiplicative',
      apply(board, set) {
        for (let row = 0; row < set.size; row++) {
          if (set.at(row).item.id === 'a')
            board.add(row, contributionOf(strategyId('damp'), 'multiplicative', 1, 0.5, 1))
        }
      },
    }
    await assertScoreModifier(damp, { ids: ['a', 'b', 'c'] })
  })

  it('assertExtractorErrorPolicy for a required extractor (fails loud under both policies)', async () => {
    await assertExtractorErrorPolicy({ extractor: throwingExtractor('x'), feature: 'x' })
  })

  it('assertExtractorErrorPolicy for an optional extractor (degrades with a warning)', async () => {
    await assertExtractorErrorPolicy({
      extractor: throwingExtractor('x', { criticality: 'optional' }),
      feature: 'x',
    })
  })
})

describe('contracts catch violations', () => {
  const fakeResult = (id: string) => ({
    recommendations: [
      {
        rank: 1,
        item: { id, type: 'i', payload: {} },
        score: 1,
        explanation: { reasons: [], contributions: [] },
      },
    ],
    diagnostics: { totalMs: 0, retrieved: 1, filtered: 0, stages: [], warnings: [] },
  })

  it('assertHonoursCancellation throws when the engine ignores the signal', async () => {
    const ignoresSignal = { recommend: async () => fakeResult('a') } as unknown as RecommendationEngine
    await expect(assertHonoursCancellation(ignoresSignal)).rejects.toThrow(/pre-aborted signal/)
  })

  it('assertDeterministic throws when two runs disagree', async () => {
    let n = 0
    const flaky = {
      recommend: async () => fakeResult(n++ % 2 === 0 ? 'a' : 'b'),
    } as unknown as RecommendationEngine
    await expect(assertDeterministic(flaky)).rejects.toThrow(/different rankings/)
  })
})
