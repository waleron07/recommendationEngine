/**
 * Golden and property tests for stage-10 diversification and stage-11 blending.
 *
 * The load-bearing one is MMR(λ=1) ≡ ranking (§22 acceptance criterion): every test drives
 * a real engine so the diversifier reorders an actual ranked list over real features, and
 * the identity holds against the pipeline, not a mock. Fixtures come from
 * `@recoengine/testing`; the base score is a payload feature, so the ranking is known and
 * every reordering is the diversifier's doing.
 */
import { createEngine } from '@recoengine/core'
import {
  assertHonoursCancellation,
  catalogueOf,
  type FeatureRow,
  passthroughStrategy,
  payloadExtractor,
  rankedIds,
  request,
  TEST_LIMITS,
} from '@recoengine/testing'
import { describe, expect, it } from 'vitest'
import {
  attributeQuotaDiversifier,
  bucketBlender,
  cosineSimilarity,
  jaccardSimilarity,
  mmrDiversifier,
} from './index.js'

const LIMITS = { limits: TEST_LIMITS }

/** Engine that ranks by `score` (payload feature) then applies the given plugins. */
const engineWith = (rows: FeatureRow[], features: string[], ...plugins: unknown[]) =>
  plugins
    .reduce(
      (acc: ReturnType<typeof createEngine<FeatureRow>>, plugin) => acc.use(plugin as never),
      createEngine<FeatureRow>()
        .use(catalogueOf(rows))
        .use(payloadExtractor(['score', ...features]))
        .use(passthroughStrategy('score')),
    )
    .configure(LIMITS)
    .build()

describe('mmrDiversifier', () => {
  // Two clusters: a/b/c share a direction, x/y/z share the opposite one.
  const rows: FeatureRow[] = [
    { id: 'a', score: 100, f1: 1, f2: 0 },
    { id: 'b', score: 90, f1: 1, f2: 0.1 },
    { id: 'c', score: 80, f1: 1, f2: 0.05 },
    { id: 'x', score: 70, f1: 0, f2: 1 },
    { id: 'y', score: 60, f1: 0, f2: 0.9 },
    { id: 'z', score: 50, f1: 0.05, f2: 1 },
  ]
  const sim = cosineSimilarity({ features: ['f1', 'f2'] })

  it('λ=1 is exactly the input ranking (the §22 acceptance criterion)', async () => {
    const plain = engineWith(rows, ['f1', 'f2'])
    const mmr = engineWith(rows, ['f1', 'f2'], mmrDiversifier({ similarity: sim, lambda: 1 }))
    const expected = rankedIds(await plain.recommend(request()))
    expect(rankedIds(await mmr.recommend(request()))).toEqual(expected)
    expect(expected).toEqual(['a', 'b', 'c', 'x', 'y', 'z']) // pure score order
  })

  it('λ<1 pulls a dissimilar candidate up the list', async () => {
    const mmr = engineWith(rows, ['f1', 'f2'], mmrDiversifier({ similarity: sim, lambda: 0.5 }))
    const order = rankedIds(await mmr.recommend(request()))
    expect(order[0]).toBe('a') // top score still leads
    // The second pick is no longer 'b' (near-identical to 'a') — a member of the other
    // cluster is promoted for diversity.
    expect(['x', 'y', 'z']).toContain(order[1])
  })

  it('λ=0 maximises diversity: the second pick is the least similar candidate', async () => {
    const mmr = engineWith(rows, ['f1', 'f2'], mmrDiversifier({ similarity: sim, lambda: 0 }))
    const order = rankedIds(await mmr.recommend(request()))
    expect(['x', 'y', 'z']).toContain(order[1])
  })

  it('leaves the list a permutation — nothing dropped, nothing invented', async () => {
    const mmr = engineWith(rows, ['f1', 'f2'], mmrDiversifier({ similarity: sim, lambda: 0.7 }))
    const order = rankedIds(await mmr.recommend(request()))
    expect([...order].sort()).toEqual(['a', 'b', 'c', 'x', 'y', 'z'])
  })

  it('honours cancellation (§17.1)', () =>
    assertHonoursCancellation(
      engineWith(rows, ['f1', 'f2'], mmrDiversifier({ similarity: sim, lambda: 0.7 })),
    ))

  it('rejects a lambda outside [0..1]', () => {
    expect(() => mmrDiversifier({ similarity: sim, lambda: 2 })).toThrow()
  })
})

describe('attributeQuotaDiversifier', () => {
  // group is a categorical hash: 1 = pop, 2 = rock. Ranked by score: p1 p2 p3 r1 p4.
  const rows: FeatureRow[] = [
    { id: 'p1', score: 100, artist: 1 },
    { id: 'p2', score: 90, artist: 1 },
    { id: 'p3', score: 80, artist: 1 },
    { id: 'r1', score: 70, artist: 2 },
    { id: 'p4', score: 60, artist: 1 },
  ]

  it('caps each group at "max", dropping the overflow', async () => {
    const engine = engineWith(rows, ['artist'], attributeQuotaDiversifier({ feature: 'artist', max: 2 }))
    // Group 1 keeps its top two (p1, p2); p3 and p4 dropped; r1 (group 2) stays.
    expect(rankedIds(await engine.recommend(request()))).toEqual(['p1', 'p2', 'r1'])
  })

  it('is a no-op when every group is within the cap', async () => {
    const engine = engineWith(rows, ['artist'], attributeQuotaDiversifier({ feature: 'artist', max: 10 }))
    expect(rankedIds(await engine.recommend(request()))).toEqual(['p1', 'p2', 'p3', 'r1', 'p4'])
  })

  it('rejects a max below 1', () => {
    expect(() => attributeQuotaDiversifier({ feature: 'artist', max: 0 })).toThrow()
  })

  it('honours cancellation (§17.1)', () =>
    assertHonoursCancellation(
      engineWith(rows, ['artist'], attributeQuotaDiversifier({ feature: 'artist', max: 2 })),
    ))
})

describe('bucketBlender', () => {
  // score also encodes the bucket: ≥ 0.5 (after minmax) is "familiar", below is "novel".
  const rows: FeatureRow[] = [
    { id: 'fam1', score: 100 },
    { id: 'fam2', score: 90 },
    { id: 'fam3', score: 80 },
    { id: 'nov1', score: 10 },
    { id: 'nov2', score: 5 },
  ]
  const buckets = [
    {
      id: 'familiar',
      share: 0.5,
      accepts: (row: number, board: import('@recoengine/core').ScoreBoard) => board.final(row) >= 0.5,
    },
    { id: 'novel', share: 0.5, accepts: () => true },
  ]

  it('interleaves buckets by quota rather than pure score', async () => {
    const engine = engineWith(rows, [], bucketBlender({ buckets }))
    const order = rankedIds(await engine.recommend(request()))
    // A 50/50 split lifts a novel item into the top few, where pure ranking would bury it.
    const topFour = order.slice(0, 4)
    expect(topFour.filter((id) => id.startsWith('nov')).length).toBeGreaterThanOrEqual(1)
    // Still a permutation of everything.
    expect([...order].sort()).toEqual(['fam1', 'fam2', 'fam3', 'nov1', 'nov2'])
  })

  it('is deterministic across runs (seeded rng)', async () => {
    const engine = engineWith(rows, [], bucketBlender({ buckets }))
    const a = rankedIds(await engine.recommend(request()))
    const b = rankedIds(await engine.recommend(request()))
    expect(a).toEqual(b)
  })

  it('warns quota_unfilled when a bucket runs dry', async () => {
    // The novel bucket claims half the slots but accepts nothing, so it cannot be filled —
    // its leftover slots spill to familiar and the underfill is reported, not hidden.
    const familiarOnly: FeatureRow[] = [
      { id: 'f1', score: 100 },
      { id: 'f2', score: 90 },
    ]
    const engine = engineWith(
      familiarOnly,
      [],
      bucketBlender({
        buckets: [
          { id: 'familiar', share: 0.5, accepts: () => true },
          { id: 'novel', share: 0.5, accepts: () => false },
        ],
      }),
    )
    const { diagnostics } = await engine.recommend(request())
    expect(diagnostics.warnings.map((w) => w.code)).toContain('quota_unfilled')
  })

  it('rejects an empty bucket list', () => {
    expect(() => bucketBlender({ buckets: [] })).toThrow()
  })
})

describe('similarity providers', () => {
  const rows: FeatureRow[] = [
    { id: 'a', score: 1, f1: 1, f2: 0, t1: 1, t2: 0 },
    { id: 'b', score: 1, f1: 1, f2: 0, t1: 1, t2: 1 },
  ]
  const engine = engineWith(rows, ['f1', 'f2', 't1', 't2'])

  it('cosine reports 1 for identical direction and is symmetric', async () => {
    // Reach the matrix via a diversifier that records a similarity call.
    let recorded = -1
    const probe = {
      id: 'probe',
      diversify: (ranked: readonly number[], set: never, _board: never, _ctx: never, matrix: never) => {
        const sim = cosineSimilarity({ features: ['f1', 'f2'] })
        recorded = sim.similarity(0, 0, set, matrix)
        expect(sim.similarity(0, 1, set, matrix)).toBe(sim.similarity(1, 0, set, matrix))
        return ranked
      },
    }
    await engineWith(rows, ['f1', 'f2'], probe).recommend(request())
    expect(recorded).toBeCloseTo(1, 10)
    await engine.recommend(request()) // keep the plain engine referenced
  })

  it('cosine rejects an empty subspace', () => {
    expect(() => cosineSimilarity({})).toThrow()
  })

  it('jaccard needs at least one feature', () => {
    expect(() => jaccardSimilarity({ features: [] })).toThrow()
  })
})
