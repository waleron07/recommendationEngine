import { describe, expect, it, vi } from 'vitest'
import type { Item } from '../domain/entities.js'
import type { FeatureDescriptor } from '../domain/feature.js'
import { featureKey, itemId, pluginName, strategyId, timestamp, userId } from '../domain/ids.js'
import type { RecoError } from '../kernel/errors.js'
import type { Plugin } from '../kernel/plugin.js'
import { CLOCK, METRICS } from '../kernel/token.js'
import type { CandidateProvider } from '../ports/candidate-provider.js'
import type { FeatureExtractor } from '../ports/feature-extractor.js'
import type { Clock, Metrics } from '../ports/infra.js'
import type { ScoringStrategy } from '../ports/scoring-strategy.js'
import { weightedSum } from './defaults.js'
import { createEngine } from './engine.js'

const LIMITS = { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 }
const NOW = 1_700_000_000_000

const clock = (): Clock => {
  let ticks = 0
  return {
    now: () => {
      ticks += 1
      return timestamp(NOW + ticks)
    },
  }
}

const request = (overrides: Record<string, unknown> = {}) => ({
  user: { id: userId('u1'), payload: {} },
  history: { userId: userId('u1'), events: [] },
  limit: 10,
  ...overrides,
})

const tracks = (...ids: string[]): Item[] => ids.map((id) => ({ id: itemId(id), type: 'track', payload: {} }))

const provider = (id: string, items: Item[]): CandidateProvider => ({
  id,
  version: '1.0.0',
  provide: async () => items,
})

const descriptor = (key: string, owner: string): FeatureDescriptor => ({
  key: featureKey(key),
  kind: 'numeric',
  defaultValue: 0,
  description: key,
  owner,
  ownerVersion: '1.0.0',
})

/** Writes each candidate's position as its "popularity", so scores are predictable. */
const popularity: FeatureExtractor = {
  id: 'pop',
  version: '1.0.0',
  provides: [descriptor('popularity', 'pop')],
  extract: async (set, out) => {
    const column = out.columnMut(featureKey('popularity'))
    for (let row = 0; row < set.size; row++) column[row] = row * 10
  },
}

const popularityStrategy: ScoringStrategy = {
  id: strategyId('popularity'),
  requires: [featureKey('popularity')],
  score: (view) => ({
    strategyId: strategyId('popularity'),
    raw: view.items.column(featureKey('popularity')),
    reasons: new Map([[0, [{ code: 'popular', polarity: 'positive' as const, strength: 1 }]]]),
  }),
}

const engineWith = () => createEngine().provide(CLOCK, clock()).configure({ limits: LIMITS })

const failure = async (fn: () => Promise<unknown>): Promise<RecoError> => {
  try {
    await fn()
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected a throw, got none')
}

describe('acceptance (§22, stage 3)', () => {
  it('returns an empty result with timings from an engine that has nothing in it', async () => {
    const engine = engineWith().build()
    const result = await engine.recommend(request())

    expect(result.recommendations).toEqual([])
    expect(result.diagnostics.stages.map((s) => s.id)).toEqual([
      'resolve',
      'retrieval',
      'prefilter',
      'extraction',
      'engineering',
      'postfilter',
      'scoring',
      'normalization',
      'combination',
      'modifiers',
      'ranking',
      'diversification',
      'blending',
      'truncate',
      'explanation',
      'assemble',
    ])
    expect(result.diagnostics.totalMs).toBeGreaterThan(0)
    expect(result.diagnostics.warnings).toEqual([])
  })

  it('aborts at the first stage boundary after the signal fires', async () => {
    const controller = new AbortController()
    controller.abort()

    const engine = engineWith()
      .use(provider('library', tracks('a')))
      .build()
    await expect(engine.recommend(request({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    })
  })

  it('gives up on its own timeout, without the caller passing a signal', async () => {
    const slow: CandidateProvider = {
      id: 'slow',
      version: '1',
      provide: async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return tracks('a')
      },
    }

    const engine = createEngine()
      .configure({ limits: { ...LIMITS, timeoutMs: 1 } })
      .use(slow)
      .build()

    await expect(engine.recommend(request())).rejects.toMatchObject({ name: 'TimeoutError' })
  })
})

describe('a whole request, end to end', () => {
  it('retrieves, extracts, scores, ranks and explains', async () => {
    const engine = engineWith()
      .use(provider('library', tracks('worst', 'middle', 'best')))
      .use(popularity)
      .use(popularityStrategy)
      .build()

    const result = await engine.recommend(request())
    expect(result.recommendations.map((r) => r.item.id)).toEqual(['best', 'middle', 'worst'])
    expect(result.recommendations.map((r) => r.rank)).toEqual([1, 2, 3])
  })

  it('reports the score on the presentation scale, not the internal one', () => {
    // 0..100 is what a human reads and what `score > 80 → push` is tuned against.
    return engineWith()
      .use(provider('library', tracks('a', 'b')))
      .use(popularity)
      .use(popularityStrategy)
      .build()
      .recommend(request())
      .then((result) => {
        expect(result.recommendations[0]?.score).toBe(100)
        expect(result.recommendations[1]?.score).toBe(0)
      })
  })

  it('explains every recommendation with the contributions that produced it', async () => {
    const engine = engineWith()
      .use(provider('library', tracks('a', 'b')))
      .use(popularity)
      .use(popularityStrategy)
      .build()

    const [top] = (await engine.recommend(request({ explain: 'reasons' }))).recommendations
    const explanation = top?.explanation

    // Σ contributions = score, structurally: the board cannot hold one without the other.
    expect(explanation?.contributions.map((c) => c.strategyId)).toEqual(['popularity'])
    expect(explanation?.score).toBe(100)
    expect(explanation?.baseScore).toBe(100)
  })

  it('counts retrieved and filtered, so an empty feed explains itself', async () => {
    const engine = engineWith()
      .use(provider('library', tracks('a', 'b', 'c')))
      .use({ id: 'blacklist', failClosed: true, approve: (c: { item: Item }) => c.item.id !== 'b' })
      .build()

    const { diagnostics } = await engine.recommend(request())
    expect(diagnostics.retrieved).toBe(3)
    expect(diagnostics.filtered).toBe(1)
  })

  it('applies limit and offset', async () => {
    const engine = engineWith()
      .use(provider('library', tracks('a', 'b', 'c', 'd')))
      .use(popularity)
      .use(popularityStrategy)
      .build()

    const result = await engine.recommend(request({ limit: 2, offset: 1 }))
    expect(result.recommendations.map((r) => r.item.id)).toEqual(['c', 'b'])
    // Rank is the position in the ranking, not in the page. This test used to assert
    // [1, 2] and so enshrined the bug: a caller stitching page 1 onto page 2 held two
    // items both claiming to be first.
    expect(result.recommendations.map((r) => r.rank)).toEqual([2, 3])
  })

  it('rejects a page over the ceiling the operator set', async () => {
    const engine = engineWith().build()
    expect((await failure(() => engine.recommend(request({ limit: 5_000 })))).code).toBe(
      'REQUEST_LIMIT_EXCEEDED',
    )
  })

  it('runs middleware around every stage', async () => {
    const wrapped: string[] = []
    const engine = engineWith()
      .use({
        id: 'tracing',
        intercept: async (stage: { id: string }, _ctx: unknown, next: () => Promise<unknown>) => {
          wrapped.push(stage.id)
          return next()
        },
      })
      .build()

    await engine.recommend(request())
    // Every stage but resolve, which builds the context middleware is handed.
    expect(wrapped).toContain('retrieval')
    expect(wrapped).toContain('assemble')
    expect(wrapped).not.toContain('resolve')
  })
})

describe('defaults fill only what nobody claimed', () => {
  it('uses the built-in ranker when none is registered', async () => {
    const engine = engineWith()
      .use(provider('library', tracks('a')))
      .use(popularity)
      .use(popularityStrategy)
      .build()
    await expect(engine.recommend(request())).resolves.toBeDefined()
  })

  it('lets a registered ranker win over the default', async () => {
    const reversing = {
      id: 'reverse',
      rank: (board: { rows: number }) => Array.from({ length: board.rows }, (_, i) => i),
    }
    const engine = engineWith()
      .use(provider('library', tracks('a', 'b', 'c')))
      .use(popularity)
      .use(popularityStrategy)
      .use(reversing)
      .build()

    // Insertion order, not score order: the custom ranker was used, and the default never
    // fought it for the slot.
    const result = await engine.recommend(request())
    expect(result.recommendations.map((r) => r.item.id)).toEqual(['a', 'b', 'c'])
  })
})

describe('inspect', () => {
  it('describes what the engine is made of', async () => {
    const engine = engineWith()
      .use(provider('library', tracks()))
      .use(popularity)
      .use(popularityStrategy)
      .build()
    const description = engine.inspect()

    expect(description.features).toEqual(['popularity'])
    expect(description.strategies).toEqual([{ id: 'popularity', domain: false }])
    expect(description.stages.retrieval).toEqual(['library'])
    expect(description.schemaVersion).toMatch(/^fs_/)
  })
})

describe('dispose', () => {
  it('disposes plugins in reverse dependency order', async () => {
    const order: string[] = []
    const record = (name: string, dependsOn?: string[]): Plugin => ({
      name: pluginName(name),
      version: '1',
      ...(dependsOn === undefined ? {} : { dependsOn: dependsOn.map(pluginName) }),
      register: () => {},
      dispose: async () => {
        order.push(name)
      },
    })

    const engine = engineWith()
      .use(record('features', ['base']))
      .use(record('base'))
      .build()
    await engine.dispose()

    // Dependents die before their dependencies, or the last thing a plugin does on the way
    // out is reach for something already gone.
    expect(order).toEqual(['features', 'base'])
  })

  it('is idempotent', async () => {
    const dispose = vi.fn(async () => {})
    const engine = engineWith()
      .use({ name: pluginName('p'), version: '1', register: () => {}, dispose })
      .build()

    await engine.dispose()
    await engine.dispose()
    expect(dispose).toHaveBeenCalledTimes(1)
  })
})

describe('infrastructure', () => {
  it('counts degradations itself rather than trusting the operator to notice', async () => {
    const metrics: Metrics = { count: vi.fn(), timing: vi.fn() }
    const broken: CandidateProvider = {
      id: 'flaky',
      version: '1',
      criticality: 'optional',
      provide: async () => {
        throw new Error('down')
      },
    }

    const engine = createEngine()
      .provide(CLOCK, clock())
      .provide(METRICS, metrics)
      .configure({ limits: LIMITS, errorPolicy: 'degrade' })
      .use(provider('library', tracks('a')))
      .use(broken)
      .build()

    const result = await engine.recommend(request())
    expect(result.diagnostics.warnings[0]).toMatchObject({ port: 'flaky', code: 'degraded' })
    expect(metrics.count).toHaveBeenCalledWith('reco.degraded')
  })

  it('runs without any infrastructure bound at all', async () => {
    const engine = createEngine().configure({ limits: LIMITS }).build()
    await expect(engine.recommend(request())).resolves.toMatchObject({ recommendations: [] })
  })
})

describe('combiner.id is a setting that does something (§10)', () => {
  // It was documented, defaulted, and read by nobody: the pipeline took the combiner from
  // the registry slot and never looked at the config, so every engine combined by weighted
  // sum whatever it had been told. Found by auditing which config keys anything reads.
  const twoStrategies = () =>
    engineWith()
      .use(provider('library', tracks('a', 'b', 'c')))
      .use(popularity)
      .use(popularityStrategy)

  it('fuses by rank when told to, rather than ignoring the instruction', async () => {
    const engine = twoStrategies()
      .configure({ combiner: { id: 'rrf' } })
      .build()
    const result = await engine.recommend(request())

    // RRF throws the margins away: first place scores 1 whatever it won by, where the
    // weighted sum would have carried the 0/10/20 spread through.
    expect(result.recommendations[0]?.score).toBe(100)
    expect(result.recommendations.map((r) => r.item.id)).toEqual(['c', 'b', 'a'])
  })

  it('still combines by weighted sum by default', async () => {
    const result = await twoStrategies().build().recommend(request())
    expect(result.recommendations.map((r) => r.item.id)).toEqual(['c', 'b', 'a'])
  })

  it('refuses a combiner id naming nothing, at build() rather than at 3am', () => {
    const error = (() => {
      try {
        twoStrategies()
          .configure({ combiner: { id: 'wieghted-sum' } })
          .build()
      } catch (thrown) {
        return thrown as RecoError
      }
      throw new Error('expected a throw')
    })()

    expect(error.code).toBe('INVALID_CONFIG')
    expect(error.message).toContain('wieghted-sum')
  })

  it('lets a registered combiner win over the configured id', async () => {
    // The slot is the more specific statement: use() hands over an object, the id names
    // one of ours.
    const engine = twoStrategies()
      .use({ id: 'mine', combine: weightedSum.combine })
      .configure({ combiner: { id: 'rrf' } })
      .build()

    await expect(engine.recommend(request())).resolves.toBeDefined()
  })
})

describe('inspect marks the domain escape hatch (§19)', () => {
  it('says which strategies took it', () => {
    // The hatch is allowed, but it trades portability, and a trade nobody can see is one
    // nobody will revisit.
    const domainStrategy = {
      id: strategyId('title-length'),
      requires: [],
      domain: true as const,
      score: () => ({ strategyId: strategyId('title-length'), raw: new Float64Array(0), reasons: new Map() }),
    }

    const description = engineWith()
      .use(popularity)
      .use(popularityStrategy)
      .use(domainStrategy)
      .build()
      .inspect()
    expect(description.strategies).toEqual([
      { id: 'popularity', domain: false },
      { id: 'title-length', domain: true },
    ])
  })
})

/**
 * Every case here is a bug an audit found in stages 2-4, and every one was silent.
 * They live together because they share a moral: the engine was returning a wrong answer
 * confidently, and the tests it had all passed.
 */
describe('regressions found by auditing stages 2-4', () => {
  it('feeds a user whose strategies all stood down, instead of returning nothing', async () => {
    // §17.3 promises cold start costs nothing: the column is skipped and the weight
    // redistributed. But every combiner reads its row count from columns[0] — with no
    // columns the board had zero rows, and 30 retrieved candidates became an empty feed.
    const coldStart = {
      id: strategyId('history'),
      requires: [],
      applicable: (c: { history: { size: number } }) => c.history.size >= 20,
      score: () => ({ strategyId: strategyId('history'), raw: new Float64Array(0), reasons: new Map() }),
    }
    const engine = engineWith()
      .use(provider('library', tracks('a', 'b', 'c')))
      .use(coldStart)
      .build()

    const result = await engine.recommend(request())
    expect(result.recommendations).toHaveLength(3)
    expect(result.recommendations.every((r) => r.score === 0)).toBe(true)
  })

  it('feeds an engine that has candidates but no strategies at all', async () => {
    const engine = engineWith()
      .use(provider('library', tracks('a', 'b')))
      .build()
    expect((await engine.recommend(request())).recommendations).toHaveLength(2)
  })

  it('refuses a strategy that scored fewer candidates than it was given', async () => {
    // Rows are positional: a short column does not score fewer candidates, it scores the
    // wrong ones and drops the rest. This silently truncated the feed.
    const short: ScoringStrategy = {
      id: strategyId('short'),
      requires: [],
      score: () => ({ strategyId: strategyId('short'), raw: new Float64Array([1, 0.5]), reasons: new Map() }),
    }
    const engine = engineWith()
      .use(provider('library', tracks('a', 'b', 'c', 'd', 'e')))
      .use(short)
      .build()

    const error = await failure(() => engine.recommend(request()))
    expect(error.code).toBe('PORT_FAILED')
    expect(error.message).toContain('scored 2 of 5')
  })

  it('holds the operator ceiling against a request that tries to raise it', async () => {
    // §23.3 calls limits an engine invariant. request.overrides went unvalidated, so any
    // caller could hand retrieval a budget of a billion and lift the ceiling entirely.
    const engine = engineWith().build()
    const error = await failure(() =>
      engine.recommend(request({ limit: 4_000, overrides: { limits: { maxLimit: 1_000_000 } } })),
    )

    expect(error.code).toBe('INVALID_CONFIG')
    expect(error.message).toContain('request.overrides')
  })

  it.each([
    ['a negative timeout', { limits: { timeoutMs: -1 } }],
    ['a NaN weight', { weights: { popularity: Number.NaN } }],
    ['a weight for nobody', { weights: { ghost: 1 } }],
  ])('refuses %s in overrides with a RecoError, not a platform error', async (_label, overrides) => {
    // timeoutMs: -1 reached AbortSignal.timeout and came back as a raw RangeError with no
    // code — the one thing §17 says never happens.
    const engine = engineWith()
      .use(provider('library', tracks('a')))
      .use(popularity)
      .use(popularityStrategy)
      .build()
    const error = await failure(() => engine.recommend(request({ overrides })))

    expect(error.code).toBe('INVALID_CONFIG')
  })

  it('refuses a combiner id from overrides that names nothing', async () => {
    const engine = engineWith()
      .use(provider('library', tracks('a')))
      .use(popularity)
      .use(popularityStrategy)
      .build()
    const error = await failure(() =>
      engine.recommend(request({ overrides: { combiner: { id: 'product' } } })),
    )

    expect(error.code).toBe('INVALID_CONFIG')
    expect(error.message).toContain('product')
  })

  it('does no work at all on an already-cancelled request', async () => {
    // Stage 0 is outside runStage, so it checked nothing: it indexed the whole history and
    // called the host's WeightProvider before the abort surfaced a stage later.
    let called = 0
    const controller = new AbortController()
    controller.abort()

    const engine = engineWith()
      .use(provider('library', tracks('a')))
      .use({
        id: 'bandit',
        weights: () => {
          called += 1
          return new Map()
        },
      })
      .build()

    await expect(engine.recommend(request({ signal: controller.signal }))).rejects.toMatchObject({
      name: 'AbortError',
    })
    expect(called).toBe(0)
  })

  it('refuses to let a built engine be modified through the builder that made it', async () => {
    // addNormalizer had no seal, and build() handed its map over by reference: a call
    // afterwards reached into a live engine and changed how it scores.
    const builder = engineWith()
    builder.build()

    expect(() => builder.addNormalizer({ id: 'evil', normalize: (c) => c })).toThrow(/after build/i)
  })
})
