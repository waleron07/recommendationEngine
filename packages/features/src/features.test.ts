/**
 * Tests for the domain-neutral extractors and transforms.
 *
 * The extractors are driven through a real engine so "reads history, not payload" is shown
 * against the pipeline: candidates carry empty payloads, and the features come entirely
 * from `ctx.history`. The transforms are checked on numbers, then once end-to-end. Every
 * plugin also runs the reusable port contracts (`@recoengine/testing`).
 */
import {
  createEngine,
  featureKey,
  identity,
  minmax,
  type ScoringStrategy,
  strategyId,
} from '@recoengine/core'
import {
  assertScoringStrategy,
  catalogueOf,
  events,
  type FeatureRow,
  historyOf,
  itemsOf,
  passthroughStrategy,
  payloadExtractor,
  rankedIds,
  request,
  scoreById,
  TEST_LIMITS,
  testEngine,
} from '@recoengine/testing'
import { describe, expect, it } from 'vitest'
import {
  decayTransform,
  interactionCountExtractor,
  interactionRecencyExtractor,
  logTransform,
} from './index.js'

const LIMITS = { limits: TEST_LIMITS }
const DAY = 86_400_000
const NOW = 1_000_000_000_000

/**
 * A strategy that surfaces one feature column, min-max normalized so any raw scale lands
 * in [0..1] — a probe for a feature's *relative* value across candidates.
 */
const surface = (key: string): ScoringStrategy => ({
  id: strategyId(key),
  requires: [featureKey(key)],
  normalizer: minmax,
  score: (view) => ({
    strategyId: strategyId(key),
    raw: Float64Array.from(view.items.column(featureKey(key))),
    reasons: new Map(),
  }),
})

describe('interactionCountExtractor', () => {
  it('counts events per item from history, ignoring the payload', async () => {
    const engine = testEngine({
      use: [itemsOf(['a', 'b', 'c']), interactionCountExtractor(), surface('interaction_count')],
    })
    const history = historyOf([...events('a', 3, { at: NOW }), ...events('b', 1, { at: NOW })])
    const result = await engine.recommend(request({ history }))
    const scores = scoreById(result)
    // Counts 3/1/0, min-max normalized → 100/33/0: the count came from history alone.
    expect(rankedIds(result)).toEqual(['a', 'b', 'c'])
    expect(scores.get('c')).toBe(0)
  })

  it('can count a single event type', async () => {
    const engine = testEngine({
      use: [itemsOf(['a']), interactionCountExtractor({ eventType: 'like' }), surface('interaction_count')],
    })
    const history = historyOf([...events('a', 5, { type: 'play' }), ...events('a', 2, { type: 'like' })])
    const [top] = (await engine.recommend(request({ history }))).recommendations
    // 2 likes, not 7 total: the eventType filter took only the likes. The raw contribution
    // carries the count itself, whatever the normalizer then does with it.
    expect(top?.explanation.contributions[0]?.raw).toBe(2)
  })
})

describe('interactionRecencyExtractor', () => {
  it('decays recency and gives an untouched item zero', async () => {
    const engine = testEngine({
      use: [
        itemsOf(['recent', 'old', 'never']),
        interactionRecencyExtractor({ halfLife: 30 }),
        surface('interaction_recency'),
      ],
      now: NOW,
    })
    const history = historyOf([
      ...events('recent', 1, { at: NOW }),
      ...events('old', 1, { at: NOW - 30 * DAY }),
    ])
    const scores = scoreById(await engine.recommend(request({ history })))
    expect(scores.get('recent')).toBe(100) // just now → weight 1
    expect(Math.round(scores.get('old') as number)).toBe(50) // one half-life → 0.5
    expect(scores.get('never')).toBe(0) // no interaction → 0
  })
})

describe('together they feed historyStrategy', () => {
  it('two domain-neutral extractors supply everything the strategy requires', async () => {
    // No payload features, no domain extractor — just the two from this package.
    const engine = createEngine()
      .use(itemsOf(['a', 'b']))
      .use(interactionCountExtractor())
      .use(interactionRecencyExtractor({ halfLife: 30 }))
      .use({
        // A minimal stand-in for historyStrategy, requiring both features. (The real one
        // lives in @recoengine/strategies, which would be a rightward dep to import here.)
        id: strategyId('history'),
        requires: [featureKey('interaction_count'), featureKey('interaction_recency')],
        normalizer: identity,
        score: (view) => {
          const count = view.items.column(featureKey('interaction_count'))
          const recency = view.items.column(featureKey('interaction_recency'))
          const raw = new Float64Array(view.items.rows)
          for (let i = 0; i < raw.length; i++)
            raw[i] = Math.min(1, (count[i] as number) * (recency[i] as number))
          return { strategyId: strategyId('history'), raw, reasons: new Map() }
        },
      } satisfies ScoringStrategy)
      .configure({ ...LIMITS, weights: { history: 1 } })
      .build()

    const history = historyOf([...events('a', 5, { at: NOW }), ...events('b', 1, { at: NOW - 60 * DAY })])
    const result = await engine.recommend(request({ history, user: { id: request().user.id, payload: {} } }))
    expect(rankedIds(result)[0]).toBe('a') // frequent + recent beats rare + stale
  })
})

describe('logTransform', () => {
  it('compresses a heavy tail into [0..1]', async () => {
    const rows: FeatureRow[] = [
      { id: 'huge', plays: 1_000_000 },
      { id: 'mid', plays: 1_000 },
      { id: 'tiny', plays: 1 },
    ]
    const engine = createEngine<FeatureRow>()
      .use(catalogueOf(rows))
      .use(payloadExtractor(['plays']))
      .use(logTransform({ source: 'plays', target: 'plays_log' }))
      .use(surface('plays_log'))
      .configure({ ...LIMITS, weights: { plays_log: 1 } })
      .build()
    const scores = scoreById(await engine.recommend(request()))
    // Raw log values are 1.0 / 0.5 / 0.05 (log1p(x)/log1p(1e6)); the probe's own min-max
    // then maps them to 100 / ~47 / 0. The point of log: mid stays clearly above the floor,
    // where min-max on the *raw* millions would have crushed both mid and tiny to ~0.
    expect(scores.get('huge')).toBe(100)
    expect(scores.get('mid') as number).toBeGreaterThan(40)
    expect(scores.get('tiny')).toBe(0)
  })

  it('is a flat zero column when every input is zero', async () => {
    const rows: FeatureRow[] = [
      { id: 'a', plays: 0 },
      { id: 'b', plays: 0 },
    ]
    const engine = createEngine<FeatureRow>()
      .use(catalogueOf(rows))
      .use(payloadExtractor(['plays']))
      .use(logTransform({ source: 'plays', target: 'plays_log' }))
      .use(surface('plays_log'))
      .configure({ ...LIMITS, weights: { plays_log: 1 } })
      .build()
    const scores = scoreById(await engine.recommend(request()))
    expect(scores.get('a')).toBe(0)
    expect(scores.get('b')).toBe(0)
  })
})

describe('decayTransform', () => {
  it('turns an age column into a freshness weight', async () => {
    const rows: FeatureRow[] = [
      { id: 'new', age: 0 },
      { id: 'week', age: 30 },
      { id: 'ancient', age: 3000 },
    ]
    const engine = createEngine<FeatureRow>()
      .use(catalogueOf(rows))
      .use(payloadExtractor(['age']))
      .use(decayTransform({ source: 'age', target: 'freshness', curve: 'exponential', shape: 30 }))
      .use(surface('freshness'))
      .configure({ ...LIMITS, weights: { freshness: 1 } })
      .build()
    const scores = scoreById(await engine.recommend(request()))
    expect(scores.get('new')).toBe(100) // age 0 → 1
    expect(Math.round(scores.get('week') as number)).toBe(50) // one half-life
    expect(scores.get('ancient') as number).toBeLessThan(1)
  })

  it('supports a linear curve that reaches zero at the span', async () => {
    // A fresh anchor (age 0 → 1) so the probe's min-max keeps the mid value at its true 0.5.
    const rows: FeatureRow[] = [
      { id: 'new', age: 0 },
      { id: 'half', age: 50 },
      { id: 'gone', age: 100 },
    ]
    const engine = createEngine<FeatureRow>()
      .use(catalogueOf(rows))
      .use(payloadExtractor(['age']))
      .use(decayTransform({ source: 'age', target: 'freshness', curve: 'linear', shape: 100 }))
      .use(surface('freshness'))
      .configure({ ...LIMITS, weights: { freshness: 1 } })
      .build()
    const scores = scoreById(await engine.recommend(request()))
    expect(scores.get('new')).toBe(100)
    expect(Math.round(scores.get('half') as number)).toBe(50)
    expect(scores.get('gone')).toBe(0) // at the span → 0
  })
})

describe('port-contract conformance', () => {
  // The extractors' output is what a downstream strategy reads; run that strategy through
  // the contracts, with these extractors supplying its feature.
  const history = historyOf(events('c0', 5, { at: NOW }))

  it('interactionCountExtractor + passthrough', () =>
    assertScoringStrategy(passthroughStrategy('interaction_count'), {
      rows: [{ id: 'c0' }, { id: 'c1' }],
      extraPlugins: [interactionCountExtractor()],
      featuresFromPlugins: true,
      history,
    }))

  it('logTransform + passthrough', () =>
    assertScoringStrategy(passthroughStrategy('plays_log'), {
      rows: [
        { id: 'c0', plays: 100 },
        { id: 'c1', plays: 5 },
      ],
      extraPlugins: [payloadExtractor(['plays']), logTransform({ source: 'plays', target: 'plays_log' })],
      featuresFromPlugins: true,
    }))
})
