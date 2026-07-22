import { describe, expect, it } from 'vitest'
import { strategyId } from '../domain/ids.js'
import { ConfigResolver, type ConfigSchema, type DeepPartial, type EngineConfig } from './config.js'
import type { RecoError } from './errors.js'

const LIMITS = { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 }
const ids = (...names: string[]) => names.map(strategyId)

const resolve = (patch: DeepPartial<EngineConfig>, strategies: string[] = []) =>
  new ConfigResolver().resolve(patch, ids(...strategies))

const failure = (patch: DeepPartial<EngineConfig>, strategies: string[] = []): RecoError => {
  try {
    resolve(patch, strategies)
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected resolve() to throw, got none')
}

describe('limits — the one thing with no default (§23.3)', () => {
  it('refuses to start when limits are absent instead of inventing a ceiling', () => {
    const error = failure({})
    expect(error.code).toBe('INVALID_CONFIG')
    expect(error.message).toContain('limits')
    expect(error.message).toMatch(/will not guess/i)
  })

  it('names the individual limit that is missing', () => {
    const error = failure({ limits: { maxCandidates: 100, maxLimit: 10 } as EngineConfig['limits'] })
    expect(error.message).toContain('limits.timeoutMs')
  })

  it.each([
    ['zero', 0],
    ['negative', -1],
    ['infinite', Number.POSITIVE_INFINITY],
    ['NaN', Number.NaN],
  ])('rejects a %s timeout', (_label, timeoutMs) => {
    expect(failure({ limits: { ...LIMITS, timeoutMs } }).message).toContain('limits.timeoutMs')
  })

  it('rejects a page that retrieval can never fill', () => {
    const error = failure({ limits: { maxCandidates: 50, maxLimit: 100, timeoutMs: 200 } })
    expect(error.message).toMatch(/can never be filled/i)
  })

  it('accepts limits that hold together', () => {
    expect(resolve({ limits: LIMITS }).limits).toEqual(LIMITS)
  })
})

describe('weights', () => {
  it('rejects a weight naming no registered strategy — that key is a typo, and it does nothing', () => {
    const error = failure({ limits: LIMITS, weights: { popularty: 0.3 } }, ['popularity'])
    expect(error.code).toBe('INVALID_CONFIG')
    expect(error.message).toContain('weights.popularty')
    expect(error.message).toContain('popularity')
  })

  it('gives an unweighted strategy an equal vote rather than silencing it', () => {
    const config = resolve({ limits: LIMITS, weights: { artist: 0.9 } }, ['artist', 'genre'])

    expect(config.weights.get(strategyId('artist'))).toBe(0.9)
    expect(config.weights.get(strategyId('genre'))).toBe(1)
  })

  it('rejects a negative weight', () => {
    expect(failure({ limits: LIMITS, weights: { artist: -1 } }, ['artist']).message).toContain(
      'weights.artist',
    )
  })

  it('keys resolved weights by strategy id', () => {
    const config = resolve({ limits: LIMITS }, ['artist'])
    expect([...config.weights.keys()]).toEqual(ids('artist'))
  })
})

describe('reporting', () => {
  it('reports every problem at once, not one per restart', () => {
    const error = failure(
      { limits: { ...LIMITS, timeoutMs: 0 }, diversity: { enabled: true, lambda: 5 } },
      [],
    )

    expect(error.message).toContain('limits.timeoutMs')
    expect(error.message).toContain('diversity.lambda')
  })
})

describe('shares and ranges', () => {
  it.each([
    ['exploration.epsilon', { exploration: { enabled: false, buckets: [], epsilon: 2 } }],
    ['diversity.lambda', { diversity: { enabled: true, lambda: -0.5 } }],
    ['fatigue.floor', { fatigue: { floor: 1.5 } }],
    ['filterErrorBudget', { filterErrorBudget: 3 }],
  ])('rejects %s outside [0..1]', (path, patch) => {
    expect(failure({ limits: LIMITS, ...(patch as DeepPartial<EngineConfig>) }).message).toContain(path)
  })

  it('rejects exploration buckets that do not account for every slot', () => {
    const error = failure({
      limits: LIMITS,
      exploration: {
        enabled: true,
        epsilon: 0.1,
        buckets: [
          { id: 'exploit', share: 0.7 },
          { id: 'explore', share: 0.2 },
        ],
      },
    })
    expect(error.message).toContain('exploration.buckets')
    expect(error.message).toMatch(/sum to 0\.9/)
  })

  it('ignores bucket shares while exploration is off', () => {
    expect(() =>
      resolve({
        limits: LIMITS,
        exploration: { enabled: false, epsilon: 0, buckets: [{ id: 'x', share: 0.2 }] },
      }),
    ).not.toThrow()
  })

  it('accepts buckets that sum to 1 within float tolerance', () => {
    expect(() =>
      resolve({
        limits: LIMITS,
        exploration: {
          enabled: true,
          epsilon: 0.1,
          buckets: [
            { id: 'exploit', share: 0.7 },
            { id: 'explore', share: 0.2 },
            { id: 'discover', share: 0.1 },
          ],
        },
      }),
    ).not.toThrow()
  })
})

describe('merging', () => {
  it('replaces arrays instead of concatenating, so configure() stays idempotent', () => {
    const config = resolve({
      limits: LIMITS,
      exploration: { enabled: true, epsilon: 0.1, buckets: [{ id: 'all', share: 1 }] },
    })

    expect(config.exploration.buckets).toEqual([{ id: 'all', share: 1 }])
  })

  it('keeps core defaults for everything untouched', () => {
    const config = resolve({ limits: LIMITS })

    expect(config.errorPolicy).toBe('strict')
    expect(config.combiner.id).toBe('weighted-sum')
    expect(config.normalization.default).toBe('minmax')
    expect(config.filterErrorBudget).toBe(0.05)
  })

  it('merges nested objects rather than replacing them wholesale', () => {
    const config = resolve({ limits: LIMITS, fatigue: { threshold: 80 } })

    expect(config.fatigue.threshold).toBe(80)
    expect(config.fatigue.decay).toBe('exponential')
  })

  it('treats a null patch value as "no override" instead of crashing (§5 regression)', () => {
    // YAML `fatigue:` with an empty body deserializes to null. `null` used to replace the
    // fatigue object, and the next validator to read `fatigue.floor` threw a raw TypeError.
    // It is now treated like a missing key: the default survives, no crash.
    const config = resolve({ limits: LIMITS, fatigue: null } as DeepPartial<EngineConfig>)

    expect(config.fatigue.threshold).toBe(50)
    expect(config.fatigue.decay).toBe('exponential')
  })

  it('freezes the result — ctx.config is read by every stage of every request', () => {
    expect(Object.isFrozen(resolve({ limits: LIMITS }))).toBe(true)
  })
})

describe('plugin namespaces', () => {
  const musicSchema: ConfigSchema<{ halfLife: number }> = {
    namespace: 'music',
    defaults: { halfLife: 30 },
    validate: (value) => {
      const halfLife = (value as { halfLife?: unknown } | undefined)?.halfLife
      return typeof halfLife === 'number' && halfLife > 0
        ? []
        : [{ path: 'halfLife', message: 'must be positive.' }]
    },
  }

  it('applies plugin defaults under the host values', () => {
    const resolver = new ConfigResolver()
    resolver.addSchema(musicSchema as ConfigSchema, 'music-plugin')

    expect(resolver.resolve({ limits: LIMITS }, []).plugins.music).toEqual({ halfLife: 30 })
  })

  it('lets the host override a plugin default', () => {
    const resolver = new ConfigResolver()
    resolver.addSchema(musicSchema as ConfigSchema, 'music-plugin')

    const config = resolver.resolve({ limits: LIMITS, plugins: { music: { halfLife: 7 } } }, [])
    expect(config.plugins.music).toEqual({ halfLife: 7 })
  })

  it('reports a plugin issue under its namespace, so the owner is obvious', () => {
    const resolver = new ConfigResolver()
    resolver.addSchema(musicSchema as ConfigSchema, 'music-plugin')

    try {
      resolver.resolve({ limits: LIMITS, plugins: { music: { halfLife: -1 } } }, [])
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as RecoError).message).toContain('plugins.music.halfLife')
    }
  })

  it('refuses two plugins claiming one namespace, where one would validate the other', () => {
    const resolver = new ConfigResolver()
    resolver.addSchema(musicSchema as ConfigSchema, 'music-plugin')

    try {
      resolver.addSchema({ ...musicSchema, defaults: {} } as ConfigSchema, 'other-plugin')
      throw new Error('expected a throw')
    } catch (error) {
      expect((error as RecoError).code).toBe('SLOT_CONFLICT')
      expect((error as RecoError).message).toContain('other-plugin')
    }
  })
})

describe('per-request overrides', () => {
  it('layers overrides over the built config without touching it', () => {
    const base = resolve({ limits: LIMITS, weights: { artist: 0.9 } }, ['artist'])
    const overridden = ConfigResolver.override(base, { weights: { artist: 0.1 } })

    expect(overridden.weights.get(strategyId('artist'))).toBe(0.1)
    expect(base.weights.get(strategyId('artist'))).toBe(0.9)
  })

  it('keeps unrelated fields from the base', () => {
    const base = resolve({ limits: LIMITS }, [])
    const overridden = ConfigResolver.override(base, { diversity: { lambda: 0.2 } })

    expect(overridden.diversity.lambda).toBe(0.2)
    expect(overridden.limits).toEqual(LIMITS)
  })

  it('returns the base untouched when there is nothing to override', () => {
    const base = resolve({ limits: LIMITS }, [])
    expect(ConfigResolver.override(base, undefined)).toBe(base)
  })
})
