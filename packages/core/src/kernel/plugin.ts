import { type PluginName, pluginName } from '../domain/ids.js'
import type { Blender } from '../ports/blender.js'
import type { PostFilter, PreFilter } from '../ports/candidate-filter.js'
import type { CandidateProvider } from '../ports/candidate-provider.js'
import type { Diversifier } from '../ports/diversifier.js'
import type { Explainer } from '../ports/explainer.js'
import type { FeatureExtractor, UserFeatureExtractor } from '../ports/feature-extractor.js'
import type { FeatureTransform } from '../ports/feature-transform.js'
import type { StageMiddleware } from '../ports/middleware.js'
import type { Ranker } from '../ports/ranker.js'
import type { ScoreCombiner } from '../ports/score-combiner.js'
import type { ScoreModifier } from '../ports/score-modifier.js'
import type { AnyScoringStrategy } from '../ports/scoring-strategy.js'
import type { WeightProvider } from '../ports/weight-provider.js'
import type { ConfigSchema } from './config.js'
import type { Container } from './container.js'
import { RecoError } from './errors.js'
import type { Registry } from './registry.js'

export interface Plugin<P = unknown> {
  readonly name: PluginName
  readonly version: string
  /** Names, not references: a plugin never holds another plugin (§8.5). */
  readonly dependsOn?: readonly PluginName[]
  readonly configSchema?: ConfigSchema
  /** Called once, by `build()`, in dependency order. Writes into the registry. */
  register(registry: Registry<P>, container: Container): void
  /** Called in reverse order when the engine is disposed. */
  dispose?(): Promise<void>
}

/** Anything `use()` accepts: a full plugin, or a bare port it wraps into one. */
export type Usable<P = unknown> =
  | Plugin<P>
  | CandidateProvider<P>
  | PreFilter<P>
  | PostFilter
  | FeatureExtractor<P>
  | UserFeatureExtractor
  | FeatureTransform
  | AnyScoringStrategy<P>
  | ScoreModifier
  | Diversifier<P>
  | StageMiddleware
  | ScoreCombiner
  | Ranker
  | Explainer<P>
  | Blender
  | WeightProvider

/**
 * Structural check, never `instanceof`.
 *
 * `instanceof` would require a plugin to be a class instance and would break the moment
 * two copies of the package end up in `node_modules` — a real and common failure that
 * looks like "my plugin is not a plugin". A method named `register` is a fact about the
 * object, not about which realm it was constructed in.
 */
export function isPlugin<P>(value: Usable<P>): value is Plugin<P> {
  return typeof (value as Plugin<P>).register === 'function'
}

/**
 * Plugins the engine invented rather than the author declaring them: a wrapped bare port,
 * or a direct write to the builder.
 *
 * Tracked outside the `Plugin` contract because being anonymous is a fact about where the
 * object came from, not part of what a plugin is — a field would put it in the public
 * interface and invite someone to set it.
 *
 * The distinction matters for identity. A real plugin has a name it declares, so name is
 * identity and two arrivals of one name are the same plugin. An anonymous one has a name
 * the engine derived (`auto:mmr`), so two of them sharing a name means two different
 * objects, not one thing twice.
 */
const anonymous = new WeakSet<object>()

function markAnonymous<P>(plugin: Plugin<P>): Plugin<P> {
  anonymous.add(plugin)
  return plugin
}

export function isAnonymous<P>(plugin: Plugin<P>): boolean {
  return anonymous.has(plugin)
}

/** Wraps one write to the registry as a plugin, so `build()` keeps a single code path. */
export function directPlugin<P>(operation: string, apply: (registry: Registry<P>) => void): Plugin<P> {
  return markAnonymous({
    name: pluginName(`direct:${operation}`),
    version: '0.0.0',
    register: (registry) => apply(registry),
  })
}

const has = (value: object, key: string): boolean => key in value

/**
 * Wraps a bare port into an anonymous plugin, so that `build()` has exactly one code
 * path: everything is a plugin.
 *
 * The dispatch is a ladder of structural checks, and the order matters where two ports
 * share a shape. Two of those overlaps are resolved by literal markers the ports carry
 * for this purpose (`scope: 'user'`, `requires` on a `PostFilter`) rather than by
 * guessing from `fn.length`, which a default parameter silently breaks.
 */
export function asPlugin<P>(usable: Usable<P>): Plugin<P> {
  if (isPlugin(usable)) return usable

  // Named optional fields rather than an index signature: the dispatch reads three of
  // them by name, and `Record<string, unknown>` would force `port['id']` everywhere.
  const port = usable as unknown as { id?: unknown; version?: unknown; scope?: unknown }
  const id = typeof port.id === 'string' ? port.id : undefined
  if (id === undefined) {
    throw new RecoError(
      'INVALID_CONFIG',
      `use() was given an object with no "id". Every port needs one: it names the port in errors, ` +
        `diagnostics and explanations. If this was meant to be a plugin, it needs a register() method.`,
    )
  }

  const attach = (register: (registry: Registry<P>) => void): Plugin<P> =>
    markAnonymous({
      // Namespaced so an auto-wrapped port cannot collide with a real plugin's name. The
      // name is for diagnostics only: this plugin is anonymous, so two ports sharing a
      // derived name are still two registrations, and whichever slot they claim is what
      // reports the clash — precisely, and in terms of the port rather than the wrapper.
      name: pluginName(`auto:${id}`),
      version: typeof port.version === 'string' ? port.version : '0.0.0',
      register,
    })

  // Ordered so that the more specific shape is tested first.
  if (has(port, 'provide')) return attach((r) => r.addProvider(usable as CandidateProvider<P>))
  if (has(port, 'approve')) {
    return has(port, 'requires')
      ? attach((r) => r.addPostFilter(usable as PostFilter))
      : attach((r) => r.addPreFilter(usable as PreFilter<P>))
  }
  if (has(port, 'extract')) {
    return port.scope === 'user'
      ? attach((r) => r.addUserExtractor(usable as UserFeatureExtractor))
      : attach((r) => r.addExtractor(usable as FeatureExtractor<P>))
  }
  // A transform declares what it produces; a modifier declares how it folds. Both `apply`.
  if (has(port, 'apply')) {
    return has(port, 'provides')
      ? attach((r) => r.addTransform(usable as FeatureTransform))
      : attach((r) => r.addModifier(usable as ScoreModifier))
  }
  if (has(port, 'score')) return attach((r) => r.addStrategy(usable as AnyScoringStrategy<P>))
  if (has(port, 'diversify')) return attach((r) => r.addDiversifier(usable as Diversifier<P>))
  if (has(port, 'intercept')) return attach((r) => r.addMiddleware(usable as StageMiddleware))
  if (has(port, 'combine')) return attach((r) => r.setCombiner(usable as ScoreCombiner))
  if (has(port, 'rank')) return attach((r) => r.setRanker(usable as Ranker))
  if (has(port, 'explain')) return attach((r) => r.setExplainer(usable as Explainer<P>))
  if (has(port, 'blend')) return attach((r) => r.setBlender(usable as Blender))
  if (has(port, 'weights')) return attach((r) => r.setWeightProvider(usable as WeightProvider))

  if (has(port, 'normalize')) {
    // Reachable and worth its own message: a normalizer is not a registry slot. Handing
    // one to use() means the author expects it to apply globally, and it would not.
    throw new RecoError(
      'INVALID_CONFIG',
      `"${id}" looks like a ScoreNormalizer, which is not a registry slot: a strategy knows its own ` +
        `scale, so pass it as that strategy's "normalizer" field, or set normalization.default in config.`,
    )
  }

  throw new RecoError(
    'INVALID_CONFIG',
    `use() could not tell what "${id}" is: it matches no port. A port is identified by its method — ` +
      `provide, approve, extract, apply, score, diversify, intercept, combine, rank, explain, blend or weights.`,
  )
}

/**
 * Dependency order, deterministic.
 *
 * Depth-first with an explicit "in progress" mark, so a cycle is reported as the path
 * that closes it rather than as a stack overflow. Ties keep registration order: two
 * builds of the same `use()` chain must produce the same pipeline, or a golden test is
 * measuring luck.
 */
export function sortPlugins<P>(plugins: readonly Plugin<P>[]): readonly Plugin<P>[] {
  const byName = new Map<PluginName, Plugin<P>>()
  for (const plugin of plugins) byName.set(plugin.name, plugin)

  const sorted: Plugin<P>[] = []
  // Keyed by object, not by name. Anonymous plugins share derived names — two bare ports
  // both wrapped as `direct:addStrategy` are two registrations, and a name-keyed `done`
  // would drop the second one on the floor without a word.
  const done = new WeakSet<object>()
  const path: PluginName[] = []
  const onPath = new WeakSet<object>()

  const visit = (plugin: Plugin<P>): void => {
    if (done.has(plugin)) return
    if (onPath.has(plugin)) {
      const cycle = [...path.slice(path.indexOf(plugin.name)), plugin.name].join(' → ')
      throw new RecoError(
        'DEPENDENCY_CYCLE',
        `Plugin dependencies form a cycle: ${cycle}. There is no order in which all of these can be ` +
          `registered after the ones they depend on.`,
      )
    }

    onPath.add(plugin)
    path.push(plugin.name)
    for (const dependency of plugin.dependsOn ?? []) {
      const target = byName.get(dependency)
      if (target === undefined) {
        throw new RecoError(
          'INVALID_CONFIG',
          `Plugin "${plugin.name}" depends on "${dependency}", which is not registered. ` +
            `Add it with use(), or drop the dependency.`,
        )
      }
      visit(target)
    }
    path.pop()
    onPath.delete(plugin)

    done.add(plugin)
    sorted.push(plugin)
  }

  for (const plugin of plugins) visit(plugin)
  return sorted
}

/**
 * Deduplicates named plugins, and decides what a repeated name means.
 *
 * Same name and same version is the `node_modules` duplication case (§8.2): one plugin
 * arriving twice through two dependency paths. Registering it twice would double every
 * extractor it owns and collide its own feature keys against themselves, so it is
 * idempotent. Same name at a *different* version is not deduplication — it is two
 * incompatible things claiming one identity, and picking either one silently is how a
 * feature ends up computed by the version nobody expected.
 *
 * Anonymous plugins are exempt, and that exemption is the whole reason they are tracked.
 * Their names are derived, so `use(new AffinityStrategy({ id: 'artist' }))` and a second
 * one with the same id would look like one plugin twice and get silently merged — when it
 * is in fact two strategies fighting over one weight key, which `addStrategy` reports
 * properly. Deduplicating here would swallow the very error this design exists to raise.
 */
export function dedupePlugins<P>(plugins: readonly Plugin<P>[]): readonly Plugin<P>[] {
  const seen = new Map<PluginName, Plugin<P>>()
  const out: Plugin<P>[] = []

  for (const plugin of plugins) {
    if (isAnonymous(plugin)) {
      out.push(plugin)
      continue
    }
    const existing = seen.get(plugin.name)
    if (existing === undefined) {
      seen.set(plugin.name, plugin)
      out.push(plugin)
      continue
    }
    if (existing.version !== plugin.version) {
      throw new RecoError(
        'SLOT_CONFLICT',
        `Plugin "${plugin.name}" is registered twice with different versions ` +
          `(${existing.version} and ${plugin.version}). One of them would win silently. ` +
          `Deduplicate the dependency so a single version is installed.`,
      )
    }
  }

  return out
}
