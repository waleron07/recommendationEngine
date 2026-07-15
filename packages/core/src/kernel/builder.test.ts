import { describe, expect, it, vi } from 'vitest'
import type { FeatureDescriptor } from '../domain/feature.js'
import { featureKey, type PluginName, pluginName, strategyId } from '../domain/ids.js'
import type { FeatureExtractor, UserFeatureExtractor } from '../ports/feature-extractor.js'
import type { FeatureTransform } from '../ports/feature-transform.js'
import type { Clock } from '../ports/infra.js'
import {
  type DomainScoringStrategy,
  isDomainStrategy,
  type ScoringStrategy,
} from '../ports/scoring-strategy.js'
import { createRegistry, type EngineBuilder } from './builder.js'
import type { RecoError } from './errors.js'
import type { Plugin } from './plugin.js'
import type { Registry } from './registry.js'
import { CLOCK } from './token.js'

const LIMITS = { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 }

const descriptor = (key: string, owner: string, ownerVersion = '1.0.0'): FeatureDescriptor => ({
  key: featureKey(key),
  kind: 'numeric',
  defaultValue: 0,
  description: key,
  owner,
  ownerVersion,
})

const extractor = (id: string, provides: string[]): FeatureExtractor => ({
  id,
  version: '1.0.0',
  provides: provides.map((key) => descriptor(key, id)),
  extract: async () => {},
})

const userExtractor = (id: string, provides: string[]): UserFeatureExtractor => ({
  id,
  version: '1.0.0',
  scope: 'user',
  provides: provides.map((key) => descriptor(key, id)),
  extract: async () => {},
})

const transform = (id: string, requires: string[], provides: string[]): FeatureTransform => ({
  id,
  version: '1.0.0',
  requires: requires.map(featureKey),
  provides: provides.map((key) => descriptor(key, id)),
  apply: () => {},
})

const strategy = (id: string, requires: string[] = [], requiresProfile?: string[]): ScoringStrategy => ({
  id: strategyId(id),
  requires: requires.map(featureKey),
  ...(requiresProfile === undefined ? {} : { requiresProfile: requiresProfile.map(featureKey) }),
  score: () => ({ strategyId: strategyId(id), raw: new Float64Array(0), reasons: new Map() }),
})

const ranker = (id: string) => ({ id, rank: () => [] })

const configured = (): EngineBuilder => createRegistry().configure({ limits: LIMITS })

const failure = (fn: () => unknown): RecoError => {
  try {
    fn()
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected a throw, got none')
}

describe('acceptance (§22, stage 2)', () => {
  it('fails at build() when a plugin requires a feature nobody provides', () => {
    const musicPlugin: Plugin = {
      name: pluginName('music'),
      version: '1.0.0',
      register: (registry) => {
        registry.addStrategy(strategy('artist', ['affinity_artist']))
      },
    }

    const error = failure(() => configured().use(musicPlugin).resolve())

    expect(error.code).toBe('MISSING_FEATURE')
    expect(error.message).toContain('affinity_artist')
  })

  it('rejects use() after build(), because a reference to the builder may have been kept', () => {
    const builder = configured()
    builder.resolve()

    const error = failure(() => builder.use(strategy('late')))
    expect(error.code).toBe('BUILDER_SEALED')
    expect(error.message).toContain('use')
  })
})

describe('the mutability boundary is build()', () => {
  it.each([
    ['use', (b: EngineBuilder) => b.use(strategy('late'))],
    ['configure', (b: EngineBuilder) => b.configure({ diversity: { lambda: 0.1 } })],
    ['provide', (b: EngineBuilder) => b.provide(CLOCK, { now: () => 0 } as unknown as Clock)],
    ['build', (b: EngineBuilder) => b.resolve()],
    ['addStrategy', (b: EngineBuilder) => b.addStrategy(strategy('late'))],
    ['addExtractor', (b: EngineBuilder) => b.addExtractor(extractor('late', []))],
    ['setRanker', (b: EngineBuilder) => b.setRanker(ranker('late'))],
  ])('rejects %s() once sealed', (_label, operation) => {
    const builder = configured()
    builder.resolve()

    expect(failure(() => operation(builder)).code).toBe('BUILDER_SEALED')
  })

  it('refuses to register a feature into the schema after the freeze', () => {
    const builder = configured()
    const blueprint = builder.resolve()

    expect(failure(() => builder.schema.register(descriptor('late', 'nobody'))).code).toBe('BUILDER_SEALED')
    expect(blueprint.registry.schema.has(featureKey('late'))).toBe(false)
  })

  it('freezes the blueprint and its registry, so concurrent requests cannot race on them', () => {
    const blueprint = configured().resolve()

    expect(Object.isFrozen(blueprint)).toBe(true)
    expect(Object.isFrozen(blueprint.registry)).toBe(true)
    expect(Object.isFrozen(blueprint.registry.strategies)).toBe(true)
  })

  it('seals the container: the engine binds before build(), never during a request', () => {
    const blueprint = configured().resolve()

    expect(
      failure(() => blueprint.container.bind(CLOCK).toValue({ now: () => 0 } as unknown as Clock)).code,
    ).toBe('BUILDER_SEALED')
  })

  it('is one-shot even when build() fails — a half-registered builder is not rebuildable', () => {
    // Registration mutates the schema and the slots as it goes. Replaying it over the
    // wreckage of a failed run would report the replay ("two strategies share the id")
    // rather than the fault. A failed build is a failed startup: fix it, build a new one.
    const builder = configured().use(strategy('artist', ['affinity_artist']))
    expect(failure(() => builder.resolve()).code).toBe('MISSING_FEATURE')

    expect(failure(() => builder.use(extractor('artist-extractor', ['affinity_artist']))).code).toBe(
      'BUILDER_SEALED',
    )
    expect(failure(() => builder.resolve()).code).toBe('BUILDER_SEALED')
  })

  it('sorts the builder into a fresh engine after a failed one, without shared state', () => {
    expect(() =>
      configured()
        .use(strategy('artist', ['affinity_artist']))
        .use(extractor('artist-extractor', ['affinity_artist']))
        .resolve(),
    ).not.toThrow()
  })
})

describe('feature declarations', () => {
  it('registers what a port provides, so a port cannot forget to declare its own features', () => {
    const blueprint = configured()
      .use(extractor('artist', ['affinity_artist']))
      .resolve()

    expect(blueprint.registry.schema.has(featureKey('affinity_artist'))).toBe(true)
    expect(blueprint.registry.schema.descriptor(featureKey('affinity_artist')).owner).toBe('artist')
  })

  it('refuses two extractors declaring one key rather than letting one win', () => {
    const error = failure(() =>
      configured()
        .use(extractor('global', ['popularity']))
        .use(extractor('cohort', ['popularity']))
        .resolve(),
    )

    expect(error.code).toBe('FEATURE_COLLISION')
    expect(error.message).toContain('popularity')
  })

  it('refuses a descriptor attributed to a port that did not declare it', () => {
    // owner feeds schema.version and through it every cache key: a misattributed
    // descriptor keeps serving cached values after its real owner changed.
    const liar: FeatureExtractor = {
      id: 'artist',
      version: '1.0.0',
      provides: [descriptor('affinity_artist', 'someone-else')],
      extract: async () => {},
    }

    const error = failure(() => configured().use(liar).resolve())
    expect(error.code).toBe('INVALID_CONFIG')
    expect(error.message).toMatch(/invalidates the feature cache/i)
  })

  it('refuses a descriptor claiming a version its port does not have', () => {
    const stale: FeatureExtractor = {
      id: 'artist',
      version: '2.0.0',
      provides: [descriptor('affinity_artist', 'artist', '1.0.0')],
      extract: async () => {},
    }

    expect(failure(() => configured().use(stale).resolve()).code).toBe('INVALID_CONFIG')
  })

  it('keeps item and profile features in separate schemas', () => {
    const blueprint = configured()
      .use(extractor('item-genre', ['affinity_genre']))
      .use(userExtractor('profile-genre', ['affinity_genre']))
      .use(strategy('genre', ['affinity_genre'], ['affinity_genre']))
      .resolve()

    expect(blueprint.registry.schema.has(featureKey('affinity_genre'))).toBe(true)
    expect(blueprint.registry.profileSchema.has(featureKey('affinity_genre'))).toBe(true)
    expect(blueprint.registry.schema.descriptor(featureKey('affinity_genre')).owner).toBe('item-genre')
    expect(blueprint.registry.profileSchema.descriptor(featureKey('affinity_genre')).owner).toBe(
      'profile-genre',
    )
  })

  it('sorts transforms topologically in the blueprint', () => {
    const blueprint = configured()
      .use(extractor('pop', ['popularity']))
      .use(transform('scale', ['popularity_log'], ['popularity_scaled']))
      .use(transform('log1p', ['popularity'], ['popularity_log']))
      .resolve()

    expect(blueprint.registry.transforms.map((t) => t.id)).toEqual(['log1p', 'scale'])
  })
})

describe('slots', () => {
  it('refuses a second claim on a single slot without an explicit override', () => {
    const error = failure(() => configured().use(ranker('first')).use(ranker('second')).resolve())

    expect(error.code).toBe('SLOT_CONFLICT')
    expect(error.message).toContain('ranker')
  })

  it('allows replacing a slot on purpose', () => {
    const builder = configured().use(ranker('default'))
    builder.setRanker(ranker('custom'), { override: true })

    expect(builder.resolve().registry.ranker?.id).toBe('custom')
  })

  it('names the plugin that claimed the slot first', () => {
    const claimant: Plugin = {
      name: pluginName('defaults'),
      version: '1.0.0',
      register: (registry: Registry) => registry.setRanker(ranker('default')),
    }

    const error = failure(() => configured().use(claimant).use(ranker('mine')).resolve())
    expect(error.message).toContain('defaults')
  })

  it('leaves unclaimed slots empty rather than inventing a ranker', () => {
    const blueprint = configured().resolve()

    expect(blueprint.registry.ranker).toBeUndefined()
    expect(blueprint.registry.combiner).toBeUndefined()
    expect(blueprint.registry.explainer).toBeUndefined()
  })

  it('refuses two strategies under one id, since the id is also the weight key', () => {
    const error = failure(() => configured().use(strategy('affinity')).use(strategy('affinity')).resolve())

    expect(error.code).toBe('SLOT_CONFLICT')
    expect(error.message).toMatch(/weight/i)
  })

  it('allows one strategy class registered twice under different ids', () => {
    const blueprint = configured().use(strategy('artist')).use(strategy('genre')).resolve()

    expect(blueprint.registry.strategies.map((s) => s.id)).toEqual(['artist', 'genre'])
  })
})

describe('every port reaches its own slot', () => {
  it('routes one of each kind, and keeps them apart', () => {
    const blueprint = configured()
      .use({ id: 'library', version: '1', provide: async () => [] })
      .use({ id: 'blacklist', failClosed: true, approve: () => true })
      .use({
        id: 'licence',
        failClosed: true,
        requires: [featureKey('affinity_artist')],
        approve: () => true,
      })
      .use(extractor('artist', ['affinity_artist']))
      .use(userExtractor('taste', ['taste_centroid']))
      .use(transform('log1p', ['affinity_artist'], ['affinity_artist_log']))
      .use(strategy('artist', ['affinity_artist'], ['taste_centroid']))
      .use({ id: 'fatigue', kind: 'multiplicative' as const, apply: () => {} })
      .use({ id: 'mmr', diversify: () => [] })
      .use({ id: 'tracing', intercept: async () => undefined })
      .use({ id: 'weighted-sum', combine: () => ({}) as never })
      .use({ id: 'topk', rank: () => [] })
      .use({ id: 'default-explainer', explain: () => ({}) as never })
      .use({ id: 'epsilon-greedy', blend: () => [] })
      .use({ id: 'bandit', weights: () => new Map() })
      .resolve()

    const { registry } = blueprint
    expect(registry.providers.map((p) => p.id)).toEqual(['library'])
    expect(registry.preFilters.map((f) => f.id)).toEqual(['blacklist'])
    expect(registry.postFilters.map((f) => f.id)).toEqual(['licence'])
    expect(registry.extractors.map((e) => e.id)).toEqual(['artist'])
    expect(registry.userExtractors.map((e) => e.id)).toEqual(['taste'])
    expect(registry.transforms.map((t) => t.id)).toEqual(['log1p'])
    expect(registry.strategies.map((s) => s.id)).toEqual(['artist'])
    expect(registry.modifiers.map((m) => m.id)).toEqual(['fatigue'])
    expect(registry.diversifiers.map((d) => d.id)).toEqual(['mmr'])
    expect(registry.middleware.map((m) => m.id)).toEqual(['tracing'])
    expect(registry.combiner?.id).toBe('weighted-sum')
    expect(registry.ranker?.id).toBe('topk')
    expect(registry.explainer?.id).toBe('default-explainer')
    expect(registry.blender?.id).toBe('epsilon-greedy')
    expect(registry.weightProvider?.id).toBe('bandit')
  })

  it('accepts a domain strategy, which is typed to the engine it registers in', () => {
    // The escape hatch of §11.1: allowed, but priced at the type level — a
    // DomainScoringStrategy<Track> will not compile into a createRegistry<Movie>().
    const domainStrategy: DomainScoringStrategy<{ title: string }> = {
      id: strategyId('title-length'),
      requires: [],
      domain: true,
      score: () => ({ strategyId: strategyId('title-length'), raw: new Float64Array(0), reasons: new Map() }),
    }

    const blueprint = createRegistry<{ title: string }>()
      .configure({ limits: LIMITS })
      .use(domainStrategy)
      .resolve()

    expect(blueprint.registry.strategies.map((s) => s.id)).toEqual(['title-length'])
    expect(
      isDomainStrategy(blueprint.registry.strategies[0] as DomainScoringStrategy<{ title: string }>),
    ).toBe(true)
  })

  it('keeps a plain strategy out of the domain-coupled bucket', () => {
    expect(isDomainStrategy(strategy('artist'))).toBe(false)
  })

  it('registers a write made directly on the builder in the order it was written', () => {
    // A direct add*/set* means the same as use(): both queue, both run in call order.
    // Before they shared a queue this failed, reporting the two claims back to front.
    const builder = configured()
    builder.use({ id: 'first', rank: () => [] })
    builder.setRanker({ id: 'second', rank: () => [] }, { override: true })

    expect(builder.resolve().registry.ranker?.id).toBe('second')
  })

  it('accepts every port written straight onto the builder, exactly as use() would', () => {
    const builder = configured()
    builder.addProvider({ id: 'library', version: '1', provide: async () => [] })
    builder.addPreFilter({ id: 'blacklist', failClosed: true, approve: () => true })
    builder.addPostFilter({ id: 'licence', failClosed: true, requires: [], approve: () => true })
    builder.addExtractor(extractor('artist', ['affinity_artist']))
    builder.addUserExtractor(userExtractor('taste', ['taste_centroid']))
    builder.addTransform(transform('log1p', ['affinity_artist'], ['affinity_artist_log']))
    builder.addStrategy(strategy('artist', ['affinity_artist']))
    builder.addModifier({ id: 'fatigue', kind: 'multiplicative', apply: () => {} })
    builder.addDiversifier({ id: 'mmr', diversify: () => [] })
    builder.addMiddleware({ id: 'tracing', intercept: async () => undefined })
    builder.setCombiner({ id: 'weighted-sum', combine: () => ({}) as never })
    builder.setRanker(ranker('topk'))
    builder.setExplainer({ id: 'default-explainer', explain: () => ({}) as never })
    builder.setBlender({ id: 'epsilon-greedy', blend: () => [] })
    builder.setWeightProvider({ id: 'bandit', weights: () => new Map() })

    const { registry } = builder.resolve()
    expect(registry.providers).toHaveLength(1)
    expect(registry.preFilters).toHaveLength(1)
    expect(registry.postFilters).toHaveLength(1)
    expect(registry.extractors).toHaveLength(1)
    expect(registry.userExtractors).toHaveLength(1)
    expect(registry.transforms).toHaveLength(1)
    expect(registry.strategies).toHaveLength(1)
    expect(registry.modifiers).toHaveLength(1)
    expect(registry.diversifiers).toHaveLength(1)
    expect(registry.middleware).toHaveLength(1)
    expect(registry.combiner?.id).toBe('weighted-sum')
    expect(registry.ranker?.id).toBe('topk')
    expect(registry.explainer?.id).toBe('default-explainer')
    expect(registry.blender?.id).toBe('epsilon-greedy')
    expect(registry.weightProvider?.id).toBe('bandit')
  })
})

describe('plugins', () => {
  it('registers plugins in dependency order', () => {
    const order: string[] = []
    const record = (name: string, dependsOn?: string[]): Plugin => ({
      name: pluginName(name),
      version: '1.0.0',
      ...(dependsOn === undefined ? {} : { dependsOn: dependsOn.map(pluginName) }),
      register: () => {
        order.push(name)
      },
    })

    configured()
      .use(record('features', ['base']))
      .use(record('base'))
      .resolve()
    expect(order).toEqual(['base', 'features'])
  })

  it('keeps the dependency order in the blueprint, so dispose can walk it backwards', () => {
    const blueprint = configured()
      .use({
        name: pluginName('b'),
        version: '1',
        dependsOn: [pluginName('a') as PluginName],
        register: () => {},
      })
      .use({ name: pluginName('a'), version: '1', register: () => {} })
      .resolve()

    expect(blueprint.plugins.map((p) => p.name)).toEqual(['a', 'b'])
  })

  it('hands the plugin the registry and the container', () => {
    const register = vi.fn()
    const blueprint = configured()
      .use({ name: pluginName('p'), version: '1', register })
      .resolve()

    expect(register).toHaveBeenCalledTimes(1)
    expect(register.mock.calls[0]?.[1]).toBe(blueprint.container)
  })

  it('lets a plugin read what the host provided', () => {
    const clock: Clock = { now: () => 1_700_000_000_000 as never }
    let seen: Clock | undefined

    configured()
      .provide(CLOCK, clock)
      .use({
        name: pluginName('needs-clock'),
        version: '1',
        register: (_registry, container) => {
          seen = container.get(CLOCK)
        },
      })
      .resolve()

    expect(seen).toBe(clock)
  })

  it('applies a plugin config schema and reports its issues under its namespace', () => {
    const withConfig: Plugin = {
      name: pluginName('music'),
      version: '1.0.0',
      configSchema: {
        namespace: 'music',
        defaults: { halfLife: 30 },
        validate: (value) => {
          const halfLife = (value as { halfLife?: unknown }).halfLife
          return typeof halfLife === 'number' && halfLife > 0
            ? []
            : [{ path: 'halfLife', message: 'must be positive' }]
        },
      },
      register: () => {},
    }

    expect(configured().use(withConfig).resolve().config.plugins.music).toEqual({ halfLife: 30 })

    const error = failure(() =>
      configured()
        .use(withConfig)
        .configure({ plugins: { music: { halfLife: -5 } } })
        .resolve(),
    )
    expect(error.message).toContain('plugins.music.halfLife')
  })

  it('deduplicates one plugin arriving twice', () => {
    const plugin: Plugin = {
      name: pluginName('music'),
      version: '1.0.0',
      register: (registry) => registry.addExtractor(extractor('artist', ['affinity_artist'])),
    }

    // Registered twice, its extractor would collide its own feature key against itself.
    const blueprint = configured().use(plugin).use(plugin).resolve()
    expect(blueprint.registry.extractors).toHaveLength(1)
  })
})

describe('config', () => {
  it('validates weights against strategies that only exist after register()', () => {
    // Why config is resolved after registration and not before it, as §8.3 had it.
    const error = failure(() =>
      createRegistry()
        .configure({ limits: LIMITS, weights: { artist: 0.9 } })
        .use({
          name: pluginName('music'),
          version: '1',
          register: (registry) => registry.addStrategy(strategy('genre')),
        })
        .resolve(),
    )

    expect(error.code).toBe('INVALID_CONFIG')
    expect(error.message).toContain('weights.artist')
  })

  it('resolves weights for the strategies a plugin registered', () => {
    const blueprint = createRegistry()
      .configure({ limits: LIMITS, weights: { genre: 0.6 } })
      .use({
        name: pluginName('music'),
        version: '1',
        register: (registry) => registry.addStrategy(strategy('genre')),
      })
      .resolve()

    expect(blueprint.config.weights.get(strategyId('genre'))).toBe(0.6)
  })

  it('merges repeated configure() calls leaf by leaf', () => {
    const blueprint = createRegistry()
      .configure({ limits: LIMITS, fatigue: { threshold: 50 } })
      .configure({ fatigue: { threshold: 80 } })
      .resolve()

    expect(blueprint.config.fatigue.threshold).toBe(80)
    expect(blueprint.config.limits).toEqual(LIMITS)
  })

  it('fails without limits, whatever else is configured', () => {
    expect(failure(() => createRegistry().use(ranker('topk')).resolve()).code).toBe('INVALID_CONFIG')
  })
})
