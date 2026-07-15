import { describe, expect, it, vi } from 'vitest'
import { type StrategyId, strategyId, timestamp, userId } from '../domain/ids.js'
import { ConfigResolver, type ResolvedConfig } from '../kernel/config.js'
import type { RecoError } from '../kernel/errors.js'
import type { Clock, Logger, Rng } from '../ports/infra.js'
import type { WeightProvider } from '../ports/weight-provider.js'
import { deadlineOf, type RecommendationRequest, type RequestDeps, resolveRequest } from './request.js'
import { DiagnosticsCollector } from './stage.js'

const NOW = 1_700_000_000_000

const config = (strategies: string[] = []): ResolvedConfig =>
  new ConfigResolver().resolve(
    { limits: { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 } },
    strategies.map(strategyId),
  )

const rng = (): Rng => {
  const make = (seed: string): Rng => ({
    next: () => 0.5,
    int: () => 0,
    fork: (child) => make(`${seed}/${child}`),
    // Exposed for the test only: what this stream was seeded with.
    ...({ seed } as object),
  })
  return make('root')
}

const deps = (overrides: Partial<RequestDeps> = {}): RequestDeps => ({
  config: config(),
  clock: { now: () => timestamp(NOW) } as Clock,
  rng: rng(),
  logger: { debug: vi.fn(), warn: vi.fn() } as Logger,
  diagnostics: new DiagnosticsCollector(),
  weightProvider: undefined,
  ...overrides,
})

const request = (overrides: Partial<RecommendationRequest> = {}): RecommendationRequest => ({
  user: { id: userId('u1'), payload: {} },
  history: { userId: userId('u1'), events: [] },
  limit: 10,
  ...overrides,
})

/** Resolves when the signal aborts. No deadline of its own: vitest already has one. */
const aborted = (signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve()
    signal.addEventListener('abort', () => resolve(), { once: true })
  })

const failure = (fn: () => unknown): RecoError => {
  try {
    fn()
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected a throw, got none')
}

describe('the context is built once and frozen', () => {
  it('freezes it, so no stage can mutate what the others read', () => {
    // This is what lets one engine serve concurrent requests without a lock: the registry
    // froze at build(), the context freezes here, and nothing is left to race on.
    expect(Object.isFrozen(resolveRequest(request(), deps()))).toBe(true)
  })

  it('indexes the history once, for every stage to read in O(1)', () => {
    const ctx = resolveRequest(request(), deps())

    expect(ctx.history.userId).toBe('u1')
    expect(ctx.history.size).toBe(0)
  })

  it('takes the clock from the port rather than from Date.now()', () => {
    expect(resolveRequest(request(), deps()).now).toBe(NOW)
  })

  it('defaults offset, explain and signals so a port never sees undefined', () => {
    const ctx = resolveRequest(request(), deps())

    expect(ctx.offset).toBe(0)
    expect(ctx.explain).toBe('none')
    expect(ctx.signals.size).toBe(0)
  })

  it('forks the rng per user, so exploration is replayable', () => {
    // An unseeded exploration bucket cannot be debugged, and an A/B test over it measures
    // noise rather than the variant.
    const ctx = resolveRequest(request(), deps())
    expect((ctx.rng as unknown as { seed: string }).seed).toContain('u1')
  })
})

describe('limits belong to the operator, not to the caller', () => {
  it('rejects a page bigger than maxLimit with its own code', () => {
    const error = failure(() => resolveRequest(request({ limit: 5_000 }), deps()))

    expect(error.code).toBe('REQUEST_LIMIT_EXCEEDED')
    expect(error.message).toContain('100')
  })

  it.each([
    ['negative', -1],
    ['fractional', 1.5],
  ])('rejects a %s limit', (_label, limit) => {
    expect(failure(() => resolveRequest(request({ limit }), deps())).code).toBe('INVALID_CONFIG')
  })

  it('allows a limit exactly at the ceiling', () => {
    expect(() => resolveRequest(request({ limit: 100 }), deps())).not.toThrow()
  })

  it('allows an empty page', () => {
    expect(() => resolveRequest(request({ limit: 0 }), deps())).not.toThrow()
  })

  it('hands providers a deadline rather than cutting them off', () => {
    expect(deadlineOf(resolveRequest(request(), deps()))).toBe(NOW + 200)
  })
})

describe('cancellation (§17.1)', () => {
  it('always builds a signal, even when the caller brought none', () => {
    // A port author can never say "no signal was given".
    expect(resolveRequest(request(), deps()).signal.aborted).toBe(false)
  })

  it('honours the caller signal', () => {
    const controller = new AbortController()
    const ctx = resolveRequest(request({ signal: controller.signal }), deps())

    controller.abort()
    expect(ctx.signal.aborted).toBe(true)
  })

  it('applies the engine timeout on top of the caller signal, not instead of it', async () => {
    // timeoutMs is the ceiling the operator set: passing a signal must not lift it.
    const short = new ConfigResolver().resolve(
      { limits: { maxCandidates: 10, maxLimit: 10, timeoutMs: 1 } },
      [],
    )
    const ctx = resolveRequest(request({ signal: new AbortController().signal }), deps({ config: short }))

    // Waits for the abort event rather than sleeping and hoping. A fixed sleep is a race
    // with the scheduler: it held here every time and lost on a loaded CI runner, which is
    // the worst way to learn a test is timing-dependent. If the signal never fires, the
    // test times out — which is the failure we actually want to hear about.
    await aborted(ctx.signal)
    expect(ctx.signal.aborted).toBe(true)
  })
})

describe('config layering (§10)', () => {
  it('applies per-request overrides over the engine config', () => {
    const ctx = resolveRequest(request({ overrides: { diversity: { lambda: 0.1 } } }), deps())
    expect(ctx.config.diversity.lambda).toBe(0.1)
  })

  it('lets a WeightProvider adjust weights — the door left open for a bandit', () => {
    const provider: WeightProvider = {
      id: 'bandit',
      weights: () => new Map([[strategyId('artist'), 0.1]]),
    }
    const ctx = resolveRequest(
      request(),
      deps({ config: config(['artist', 'genre']), weightProvider: provider }),
    )

    expect(ctx.config.weights.get(strategyId('artist'))).toBe(0.1)
    // A provider that knows about one strategy must not silence the others.
    expect(ctx.config.weights.get(strategyId('genre'))).toBe(1)
  })

  it('ignores a weight for a strategy that is not registered', () => {
    const provider: WeightProvider = {
      id: 'bandit',
      weights: () => new Map([['ghost' as StrategyId, 0.9]]),
    }
    const ctx = resolveRequest(request(), deps({ config: config(['artist']), weightProvider: provider }))

    expect(ctx.config.weights.has('ghost' as StrategyId)).toBe(false)
  })

  it('hands the provider a whole context, not a half-built one', () => {
    // Its type promises a RequestContext; one missing rng away from that promise is a
    // crash inside somebody else's plugin.
    const seen: unknown[] = []
    const provider: WeightProvider = {
      id: 'spy',
      weights: (ctx) => (seen.push(ctx), new Map()),
    }
    resolveRequest(request(), deps({ weightProvider: provider }))

    expect(seen[0]).toMatchObject({ now: NOW, limit: 10 })
    expect((seen[0] as { rng: unknown; signal: unknown }).rng).toBeDefined()
    expect((seen[0] as { signal: unknown }).signal).toBeDefined()
  })

  it('leaves the config alone when the provider has nothing to say', () => {
    const provider: WeightProvider = { id: 'quiet', weights: () => new Map() }
    const ctx = resolveRequest(request(), deps({ config: config(['artist']), weightProvider: provider }))

    expect(ctx.config.weights.get(strategyId('artist'))).toBe(1)
  })
})

describe('diagnostics', () => {
  it('routes port warnings into the request collector', () => {
    const collector = new DiagnosticsCollector()
    const ctx = resolveRequest(request(), deps({ diagnostics: collector }))

    ctx.diagnostics.warn({ stage: 'scoring', port: 'artist', code: 'not_applicable', message: 'cold start' })
    expect(collector.collected).toHaveLength(1)
  })
})
