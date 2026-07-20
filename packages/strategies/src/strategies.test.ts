/**
 * Golden tests for the nine standard strategies (§22 acceptance criterion).
 *
 * Every test drives a real `createEngine(...).recommend(...)` over synthetic features, so
 * it proves two things at once: that the strategy ranks the way its docstring claims, and
 * that the dependency rule `core ← strategies` holds in practice — these strategies reach
 * the engine through nothing but the public ports.
 *
 * The "domain" here is deliberately trivial: an item's payload *is* its feature row, and
 * one extractor copies payload fields into columns. That keeps every test about the
 * strategy under test and nothing else.
 */
import { createEngine, userId } from '@recoengine/core'
import {
  assertScoringStrategy,
  catalogueOf,
  events,
  type FeatureRow,
  historyOf,
  payloadExtractor,
  profileExtractor,
  request,
  TEST_LIMITS,
} from '@recoengine/testing'
import { describe, expect, it } from 'vitest'
import {
  affinityStrategy,
  contextStrategy,
  coOccurrenceStrategy,
  discoveryStrategy,
  historyStrategy,
  noveltyStrategy,
  popularityStrategy,
  recencyStrategy,
  similarityStrategy,
} from './index.js'

type Row = FeatureRow

// Fixtures now live in @recoengine/testing (Этап 6а); these thin aliases keep the golden
// tests below reading as before while the synthetic engine parts moved into the shared kit.
const provider = catalogueOf
const itemFeatures = payloadExtractor
const profileSaturation = (value: number) => profileExtractor('profile_saturation', value)
const LIMITS = { limits: TEST_LIMITS }
const withHistory = (n: number) => events('seed', n)
const listen = request

/** Ranked item ids, top first — the thing golden tests assert on. */
const order = (recommendations: readonly { item: { payload: Row } }[]) =>
  recommendations.map((r) => r.item.payload.id)

describe('popularityStrategy', () => {
  const rows: Row[] = [
    { id: 'a', popularity_global: 10, popularity_cohort: 0 },
    { id: 'b', popularity_global: 5_000, popularity_cohort: 0 },
    { id: 'c', popularity_global: 900, popularity_cohort: 0 },
    { id: 'd', popularity_global: 50, popularity_cohort: 0 },
  ]

  const engine = () =>
    createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['popularity_global']))
      .use(popularityStrategy({ cohortFeature: null }))
      .configure(LIMITS)
      .build()

  it('ranks by global popularity, and one viral item does not flatten the rest', async () => {
    const { recommendations } = await engine().recommend(listen())
    expect(order(recommendations)).toEqual(['b', 'c', 'd', 'a'])
    // Percentile spacing, not raw: b..a land on 100/67/33/0, so c and d stay distinct
    // even though 5000 dwarfs them both. (Rounded here: the presentation scale is not yet
    // rounded in core — PROGRESS §5.)
    expect(recommendations.map((r) => Math.round(r.score))).toEqual([100, 67, 33, 0])
  })

  it('emits a `popular` reason with a percentile for the top item', async () => {
    const [top] = (await engine().recommend(listen())).recommendations
    expect(top?.explanation.reasons).toContainEqual(
      expect.objectContaining({ code: 'popular', params: { percentile: 100 } }),
    )
  })

  it('works with no cohort model when cohort is disabled', async () => {
    const built = createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['popularity_global']))
      .use(popularityStrategy({ cohortFeature: null }))
      .configure(LIMITS)
      .build()
    expect(order((await built.recommend(listen())).recommendations)).toEqual(['b', 'c', 'd', 'a'])
  })

  it('blends cohort in when asked: a cohort favourite climbs over a global favourite', async () => {
    const cohortRows: Row[] = [
      { id: 'global-star', popularity_global: 10_000, popularity_cohort: 1 },
      { id: 'cohort-star', popularity_global: 100, popularity_cohort: 500 },
    ]
    const built = createEngine<Row>()
      .use(provider(cohortRows))
      .use(itemFeatures(['popularity_global', 'popularity_cohort']))
      .use(popularityStrategy({ cohortWeight: 0.9 }))
      .configure(LIMITS)
      .build()
    expect(order((await built.recommend(listen())).recommendations)).toEqual(['cohort-star', 'global-star'])
  })
})

describe('recencyStrategy', () => {
  const rows: Row[] = [
    { id: 'old', item_age: 365 },
    { id: 'fresh', item_age: 1 },
    { id: 'mid', item_age: 30 },
    { id: 'future', item_age: -5 },
  ]
  const engine = () =>
    createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['item_age']))
      .use(recencyStrategy({ halfLife: 30 }))
      .configure(LIMITS)
      .build()

  it('ranks fresher items higher and never lets a future age beat the present', async () => {
    const { recommendations } = await engine().recommend(listen())
    // A future age (< 0) decays to exactly 1 — "not yet", the ceiling — so it edges out
    // 'fresh' (1 day → 0.977). Then mid (30d → 0.5), then old. What it cannot do is
    // exceed the ceiling and beat a brand-new (age 0) item.
    expect(order(recommendations)).toEqual(['future', 'fresh', 'mid', 'old'])
  })

  it('emits a `fresh` reason carrying the age', async () => {
    const [top] = (await engine().recommend(listen())).recommendations
    expect(top?.explanation.reasons).toContainEqual(expect.objectContaining({ code: 'fresh' }))
  })
})

describe('historyStrategy', () => {
  const rows: Row[] = [
    { id: 'often-old', interaction_count: 20, interaction_recency: 0.1 },
    { id: 'once-fresh', interaction_count: 1, interaction_recency: 1 },
    { id: 'often-fresh', interaction_count: 10, interaction_recency: 0.9 },
    { id: 'never', interaction_count: 0, interaction_recency: 0 },
  ]
  const build = () =>
    createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['interaction_count', 'interaction_recency']))
      .use(historyStrategy())
      .configure(LIMITS)

  it('weights interaction count by recency', async () => {
    const engine = build().build()
    const { recommendations } = await engine.recommend(
      listen({ history: { userId: userId('u'), events: withHistory(5) } }),
    )
    // count×recency: often-fresh 9, often-old 2, once-fresh 1, never 0.
    expect(order(recommendations)).toEqual(['often-fresh', 'often-old', 'once-fresh', 'never'])
  })

  it('stands down for a user with no history (cold start), dropping its column', async () => {
    const engine = build().build()
    const { recommendations, diagnostics } = await engine.recommend(listen())
    // With the only strategy inapplicable, every base score is 0 and the list falls back
    // to retrieval order — the §17.3 guarantee that zero columns is not zero candidates.
    expect(recommendations).toHaveLength(4)
    expect(recommendations.every((r) => r.score === 0)).toBe(true)
    expect(diagnostics.retrieved).toBe(4)
  })
})

describe('affinityStrategy', () => {
  const rows: Row[] = [
    { id: 'both', affinity_artist: 0.9, affinity_genre: 0.8 },
    { id: 'artist-only', affinity_artist: 0.9, affinity_genre: 0.0 },
    { id: 'neither', affinity_artist: 0.1, affinity_genre: 0.1 },
  ]

  it('runs two dimensions side by side, each under its own weight key', async () => {
    const engine = createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['affinity_artist', 'affinity_genre']))
      .use(affinityStrategy({ id: 'artist', feature: 'affinity_artist' }))
      .use(affinityStrategy({ id: 'genre', feature: 'affinity_genre' }))
      .configure({ ...LIMITS, weights: { artist: 0.9, genre: 0.6 } })
      .build()

    const { recommendations } = await engine.recommend(
      listen({ history: { userId: userId('u'), events: withHistory(5) } }),
    )
    expect(order(recommendations)).toEqual(['both', 'artist-only', 'neither'])
    const [top] = recommendations
    expect(top?.explanation.reasons).toContainEqual(
      expect.objectContaining({
        code: 'high_affinity',
        params: expect.objectContaining({ dimension: 'artist' }),
      }),
    )
  })

  it('rejects two affinity strategies fighting over one id', () => {
    expect(() =>
      createEngine<Row>()
        .use(provider(rows))
        .use(itemFeatures(['affinity_artist', 'affinity_genre']))
        .use(affinityStrategy({ id: 'affinity', feature: 'affinity_artist' }))
        .use(affinityStrategy({ id: 'affinity', feature: 'affinity_genre' }))
        .configure(LIMITS)
        .build(),
    ).toThrow()
  })
})

describe('noveltyStrategy', () => {
  const rows: Row[] = [
    { id: 'known', item_familiarity: 1 },
    { id: 'half', item_familiarity: 0.5 },
    { id: 'new', item_familiarity: 0 },
  ]
  const build = (saturation: number) =>
    createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['item_familiarity']))
      .use(profileSaturation(saturation))
      .use(noveltyStrategy())
      .configure(LIMITS)
      .build()

  it('rewards the unfamiliar in proportion to how saturated the profile is', async () => {
    const { recommendations } = await build(1).recommend(listen())
    expect(order(recommendations)).toEqual(['new', 'half', 'known'])
    expect((await build(1).recommend(listen())).recommendations[0]?.score).toBe(100)
  })

  it('self-regulates: a broad profile (saturation 0) produces no novelty push', async () => {
    const { recommendations } = await build(0).recommend(listen())
    // Every novelty score collapses to 0, so the order is the deterministic tie-break —
    // retrieval (row) order — not a novelty ranking.
    expect(recommendations.every((r) => r.score === 0)).toBe(true)
    expect(order(recommendations)).toEqual(['known', 'half', 'new'])
  })

  it('will not build without a profile extractor supplying its profile feature', () => {
    expect(() =>
      createEngine<Row>()
        .use(provider(rows))
        .use(itemFeatures(['item_familiarity']))
        .use(noveltyStrategy())
        .configure(LIMITS)
        .build(),
    ).toThrow()
  })
})

describe('similarityStrategy', () => {
  const rows: Row[] = [
    { id: 'both', sim_to_recent: 0.9, sim_to_profile: 0.9 },
    { id: 'recent-only', sim_to_recent: 0.9, sim_to_profile: 0.1 },
    { id: 'profile-only', sim_to_recent: 0.1, sim_to_profile: 0.9 },
  ]
  it('blends session and profile similarity, tunable by recentWeight', async () => {
    const engine = createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['sim_to_recent', 'sim_to_profile']))
      .use(similarityStrategy({ recentWeight: 0.8 }))
      .configure(LIMITS)
      .build()
    const { recommendations } = await engine.recommend(
      listen({ history: { userId: userId('u'), events: withHistory(3) } }),
    )
    // recentWeight 0.8: both=0.9, recent-only=0.74, profile-only=0.26.
    expect(order(recommendations)).toEqual(['both', 'recent-only', 'profile-only'])
  })
})

describe('coOccurrenceStrategy', () => {
  const rows: Row[] = [
    { id: 'strong', cooc_score: 40 },
    { id: 'weak', cooc_score: 3 },
    { id: 'none', cooc_score: 0 },
  ]
  it('ranks by co-occurrence and gates its reason on percentile', async () => {
    const engine = createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['cooc_score']))
      .use(coOccurrenceStrategy())
      .configure(LIMITS)
      .build()
    const { recommendations } = await engine.recommend(
      listen({ history: { userId: userId('u'), events: withHistory(4) } }),
    )
    expect(order(recommendations)).toEqual(['strong', 'weak', 'none'])
    expect(recommendations[0]?.explanation.reasons).toContainEqual(
      expect.objectContaining({ code: 'often_taken_together' }),
    )
    expect(recommendations[2]?.explanation.reasons ?? []).not.toContainEqual(
      expect.objectContaining({ code: 'often_taken_together' }),
    )
  })
})

describe('discoveryStrategy', () => {
  const rows: Row[] = [
    { id: 'near', distance_from_profile: 0.1 },
    { id: 'sweet', distance_from_profile: 0.5 },
    { id: 'far', distance_from_profile: 0.95 },
  ]
  const events = { history: { userId: userId('u'), events: withHistory(3) } }

  it('with no target, rewards distance monotonically', async () => {
    const engine = createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['distance_from_profile']))
      .use(discoveryStrategy())
      .configure(LIMITS)
      .build()
    expect(order((await engine.recommend(listen(events))).recommendations)).toEqual(['far', 'sweet', 'near'])
  })

  it('with a target, rewards the sweet-spot band over the too-familiar and the too-alien', async () => {
    const engine = createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['distance_from_profile']))
      .use(discoveryStrategy({ target: 0.5, scale: 0.2 }))
      .configure(LIMITS)
      .build()
    expect(order((await engine.recommend(listen(events))).recommendations)).toEqual(['sweet', 'near', 'far'])
  })
})

describe('contextStrategy', () => {
  const rows: Row[] = [
    { id: 'fits', context_match: 0.95 },
    { id: 'meh', context_match: 0.3 },
  ]
  const build = () =>
    createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['context_match']))
      .use(contextStrategy())
      .configure(LIMITS)
      .build()

  it('ranks by context fit when the request carries signals', async () => {
    const { recommendations } = await build().recommend(listen({ signals: new Map([['time', 'morning']]) }))
    expect(order(recommendations)).toEqual(['fits', 'meh'])
    expect(recommendations[0]?.explanation.reasons).toContainEqual(
      expect.objectContaining({ code: 'fits_context' }),
    )
  })

  it('stands down when the request carries no signals', async () => {
    const { recommendations } = await build().recommend(listen())
    expect(recommendations.every((r) => r.score === 0)).toBe(true)
  })
})

describe('cold-start reflow across strategies', () => {
  const rows: Row[] = [
    { id: 'a', popularity_global: 10, interaction_count: 5, interaction_recency: 1 },
    { id: 'b', popularity_global: 5_000, interaction_count: 0, interaction_recency: 0 },
  ]
  const engine = () =>
    createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['popularity_global', 'interaction_count', 'interaction_recency']))
      .use(popularityStrategy({ cohortFeature: null }))
      .use(historyStrategy())
      .configure(LIMITS)
      .build()

  it('drops history for a cold user and lets popularity alone decide, weight reflowed', async () => {
    const cold = await engine().recommend(listen())
    const warm = await engine().recommend(
      listen({ history: { userId: userId('u'), events: withHistory(5) } }),
    )
    // Cold: only popularity runs → b (5000) beats a (10).
    expect(order(cold.recommendations)).toEqual(['b', 'a'])
    // Warm: history lifts 'a' (5 recent plays) over 'b' once its column counts again.
    expect(order(warm.recommendations)).toEqual(['a', 'b'])
  })
})

describe('determinism', () => {
  it('produces byte-identical rankings across repeated runs', async () => {
    const rows: Row[] = [
      { id: 'x', popularity_global: 3 },
      { id: 'y', popularity_global: 3 },
      { id: 'z', popularity_global: 9 },
    ]
    const engine = createEngine<Row>()
      .use(provider(rows))
      .use(itemFeatures(['popularity_global']))
      .use(popularityStrategy({ cohortFeature: null }))
      .configure(LIMITS)
      .build()
    const first = order((await engine.recommend(listen())).recommendations)
    const second = order((await engine.recommend(listen())).recommendations)
    expect(first).toEqual(second)
    // The x/y tie resolves by retrieval (row) order, every time — never the mood of the sort.
    expect(first).toEqual(['z', 'x', 'y'])
  })
})

// Every strategy is also run through the reusable port contracts (@recoengine/testing):
// cancellation (§17.1), determinism, and well-formed scores. This is the "one line per
// port" of §21 — and it dogfoods the kit against the real strategies, not just synthetic ones.
describe('port-contract conformance', () => {
  const history = historyOf(events('seed', 25)) // clears any minHistory gate
  const rowsWith = (keys: readonly string[]): FeatureRow[] =>
    [0.2, 0.8].map((value, i) => {
      const fields: Record<string, number> = {}
      for (const key of keys) fields[key] = value
      return { id: `c${i}`, ...fields } as FeatureRow
    })

  it('history', () =>
    assertScoringStrategy(historyStrategy(), {
      rows: rowsWith(['interaction_count', 'interaction_recency']),
      history,
    }))
  it('affinity', () =>
    assertScoringStrategy(affinityStrategy({ feature: 'affinity_artist' }), {
      rows: rowsWith(['affinity_artist']),
      history,
    }))
  it('popularity', () =>
    assertScoringStrategy(popularityStrategy(), {
      rows: rowsWith(['popularity_global', 'popularity_cohort']),
    }))
  it('recency', () => assertScoringStrategy(recencyStrategy(), { rows: rowsWith(['item_age']) }))
  it('similarity', () =>
    assertScoringStrategy(similarityStrategy(), {
      rows: rowsWith(['sim_to_recent', 'sim_to_profile']),
      history,
    }))
  it('cooccurrence', () =>
    assertScoringStrategy(coOccurrenceStrategy(), { rows: rowsWith(['cooc_score']), history }))
  it('novelty', () =>
    assertScoringStrategy(noveltyStrategy(), {
      rows: rowsWith(['item_familiarity']),
      extraPlugins: [profileExtractor('profile_saturation', 0.8)],
    }))
  it('discovery', () =>
    assertScoringStrategy(discoveryStrategy(), { rows: rowsWith(['distance_from_profile']), history }))
  it('context', () =>
    assertScoringStrategy(contextStrategy(), {
      rows: rowsWith(['context_match']),
      signals: new Map([['time', 'x']]),
    }))
})
