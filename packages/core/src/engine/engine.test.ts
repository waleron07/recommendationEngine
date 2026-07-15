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
    // Rank is the position on this page, 1-based.
    expect(result.recommendations.map((r) => r.rank)).toEqual([1, 2])
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
    expect(description.strategies).toEqual(['popularity'])
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
