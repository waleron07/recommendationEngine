import { describe, expect, it, vi } from 'vitest'
import { type PluginName, pluginName, strategyId } from '../domain/ids.js'
import type { RecoError } from './errors.js'
import { asPlugin, dedupePlugins, isPlugin, type Plugin, sortPlugins, type Usable } from './plugin.js'
import type { Registry } from './registry.js'

const plugin = (name: string, dependsOn: string[] = [], version = '1.0.0'): Plugin => ({
  name: pluginName(name),
  version,
  ...(dependsOn.length > 0 ? { dependsOn: dependsOn.map(pluginName) } : {}),
  register: () => {},
})

const names = (plugins: readonly Plugin[]): string[] => plugins.map((p) => p.name)

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    return (error as RecoError).code
  }
  throw new Error('expected a throw, got none')
}

/** A registry that only records which slot was called. */
const spyRegistry = () => {
  const calls: string[] = []
  const record =
    (name: string) =>
    (...args: unknown[]) => {
      calls.push(`${name}:${(args[0] as { id?: string })?.id}`)
    }
  const registry = {
    addProvider: record('addProvider'),
    addPreFilter: record('addPreFilter'),
    addPostFilter: record('addPostFilter'),
    addExtractor: record('addExtractor'),
    addUserExtractor: record('addUserExtractor'),
    addTransform: record('addTransform'),
    addStrategy: record('addStrategy'),
    addModifier: record('addModifier'),
    addDiversifier: record('addDiversifier'),
    addMiddleware: record('addMiddleware'),
    setCombiner: record('setCombiner'),
    setRanker: record('setRanker'),
    setExplainer: record('setExplainer'),
    setBlender: record('setBlender'),
    setWeightProvider: record('setWeightProvider'),
  } as unknown as Registry
  return { registry, calls }
}

const dispatch = (port: object): string => {
  const { registry, calls } = spyRegistry()
  asPlugin(port as Usable).register(registry, {} as never)
  return calls[0] as string
}

describe('isPlugin', () => {
  it('checks for a register() method rather than instanceof', () => {
    // instanceof would break the moment two copies of the package land in node_modules,
    // and would force every plugin to be a class. A method is a fact about the object.
    expect(isPlugin({ name: pluginName('p'), version: '1', register: () => {} })).toBe(true)
    expect(isPlugin({ id: 'x', score: () => ({}) } as unknown as Usable)).toBe(false)
  })
})

describe('asPlugin — one registration path for ports and plugins', () => {
  it('passes a real plugin through untouched', () => {
    const real = plugin('music')
    expect(asPlugin(real)).toBe(real)
  })

  it.each([
    ['provider', { id: 'library', version: '1', provide: async () => [] }, 'addProvider:library'],
    ['pre-filter', { id: 'blacklist', failClosed: true, approve: () => true }, 'addPreFilter:blacklist'],
    [
      'post-filter',
      { id: 'licence', failClosed: true, requires: [], approve: () => true },
      'addPostFilter:licence',
    ],
    [
      'extractor',
      { id: 'artist', version: '1', provides: [], extract: async () => {} },
      'addExtractor:artist',
    ],
    [
      'user extractor',
      { id: 'taste', version: '1', scope: 'user', provides: [], extract: async () => {} },
      'addUserExtractor:taste',
    ],
    [
      'transform',
      { id: 'log1p', version: '1', requires: [], provides: [], apply: () => {} },
      'addTransform:log1p',
    ],
    ['modifier', { id: 'fatigue', kind: 'multiplicative', apply: () => {} }, 'addModifier:fatigue'],
    ['strategy', { id: strategyId('genre'), requires: [], score: () => ({}) }, 'addStrategy:genre'],
    ['diversifier', { id: 'mmr', diversify: () => [] }, 'addDiversifier:mmr'],
    ['middleware', { id: 'tracing', intercept: async () => undefined }, 'addMiddleware:tracing'],
    ['combiner', { id: 'rrf', combine: () => ({}) }, 'setCombiner:rrf'],
    ['ranker', { id: 'topk', rank: () => [] }, 'setRanker:topk'],
    ['explainer', { id: 'default', explain: () => ({}) }, 'setExplainer:default'],
    ['blender', { id: 'epsilon', blend: () => [] }, 'setBlender:epsilon'],
    ['weight provider', { id: 'bandit', weights: () => new Map() }, 'setWeightProvider:bandit'],
  ])('routes a bare %s to its slot', (_label, port, expected) => {
    expect(dispatch(port)).toBe(expected)
  })

  it('tells the two extractors apart by their marker, not by argument count', () => {
    // Both ports are structurally { id, version, provides, extract }. Counting extract's
    // parameters would be a guess that a default argument silently breaks.
    const item = { id: 'a', version: '1', provides: [], extract: async () => {} }
    expect(dispatch(item)).toBe('addExtractor:a')
    expect(dispatch({ ...item, scope: 'user' })).toBe('addUserExtractor:a')
  })

  it('tells a post-filter from a pre-filter by requires', () => {
    const base = { id: 'f', failClosed: true, approve: () => true }
    expect(dispatch(base)).toBe('addPreFilter:f')
    expect(dispatch({ ...base, requires: [] })).toBe('addPostFilter:f')
  })

  it('tells a transform from a modifier by what it provides', () => {
    const base = { id: 't', version: '1', apply: () => {} }
    expect(dispatch({ ...base, requires: [], provides: [] })).toBe('addTransform:t')
    expect(dispatch({ ...base, kind: 'multiplicative' })).toBe('addModifier:t')
  })

  it('namespaces an auto-wrapped port so it cannot collide with a real plugin', () => {
    expect(asPlugin({ id: 'mmr', diversify: () => [] } as unknown as Usable).name).toBe('auto:mmr')
  })

  it('explains that a normalizer belongs to a strategy rather than to the registry', () => {
    const error = codeOf(() =>
      asPlugin({ id: 'minmax', normalize: (x: Float64Array) => x } as unknown as Usable),
    )
    expect(error).toBe('INVALID_CONFIG')
    expect(() => asPlugin({ id: 'minmax', normalize: (x: Float64Array) => x } as unknown as Usable)).toThrow(
      /strategy knows its own scale/i,
    )
  })

  it('refuses an object with no id, because every error would then name nothing', () => {
    expect(codeOf(() => asPlugin({ score: () => ({}) } as unknown as Usable))).toBe('INVALID_CONFIG')
  })

  it('lists the methods it looked for when nothing matches', () => {
    expect(() => asPlugin({ id: 'mystery' } as unknown as Usable)).toThrow(/matches no port/i)
  })

  it('defaults a version-less port to 0.0.0 rather than failing', () => {
    expect(asPlugin({ id: 'mmr', diversify: () => [] } as unknown as Usable).version).toBe('0.0.0')
  })
})

describe('sortPlugins', () => {
  it('registers a plugin after the ones it depends on', () => {
    const sorted = sortPlugins([plugin('c', ['b']), plugin('a'), plugin('b', ['a'])])
    expect(names(sorted)).toEqual(['a', 'b', 'c'])
  })

  it('keeps registration order among independent plugins, so builds are reproducible', () => {
    // Two builds of one use() chain must produce one pipeline, or a golden test measures luck.
    expect(names(sortPlugins([plugin('x'), plugin('y'), plugin('z')]))).toEqual(['x', 'y', 'z'])
  })

  it('reports a cycle as the path that closes it', () => {
    const cyclic = [plugin('a', ['c']), plugin('b', ['a']), plugin('c', ['b'])]

    expect(codeOf(() => sortPlugins(cyclic))).toBe('DEPENDENCY_CYCLE')
    expect(() => sortPlugins(cyclic)).toThrow(/a → c → b → a|b → a → c → b|c → b → a → c/)
  })

  it('catches a plugin depending on itself', () => {
    expect(codeOf(() => sortPlugins([plugin('a', ['a'])]))).toBe('DEPENDENCY_CYCLE')
  })

  it('names the dependency that was never registered', () => {
    const error = codeOf(() => sortPlugins([plugin('a', ['missing'])]))
    expect(error).toBe('INVALID_CONFIG')
    expect(() => sortPlugins([plugin('a', ['missing'])])).toThrow(/"missing", which is not registered/)
  })

  it('visits a shared dependency once', () => {
    const sorted = sortPlugins([plugin('b', ['a']), plugin('c', ['a']), plugin('a')])
    expect(names(sorted)).toEqual(['a', 'b', 'c'])
    expect(sorted).toHaveLength(3)
  })
})

describe('dedupePlugins', () => {
  it('is idempotent for one plugin arriving twice through two dependency paths', () => {
    // The node_modules duplication case (§8.2). Registering it twice would double every
    // extractor it owns and collide its own feature keys against themselves.
    const deduped = dedupePlugins([plugin('music'), plugin('music')])
    expect(names(deduped)).toEqual(['music'])
  })

  it('refuses two versions of one name instead of silently picking a winner', () => {
    expect(codeOf(() => dedupePlugins([plugin('music', [], '1.0.0'), plugin('music', [], '2.0.0')]))).toBe(
      'SLOT_CONFLICT',
    )
  })

  it('keeps distinct plugins', () => {
    expect(names(dedupePlugins([plugin('a'), plugin('b')]))).toEqual(['a', 'b'])
  })
})

describe('registration order', () => {
  it('hands the registry and the container to every plugin', () => {
    const register = vi.fn()
    const { registry } = spyRegistry()
    const container = {} as never
    const custom: Plugin = { name: 'p' as PluginName, version: '1', register }

    custom.register(registry, container)
    expect(register).toHaveBeenCalledWith(registry, container)
  })
})
