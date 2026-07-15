import type { FeatureDescriptor, FeatureSchema, MutableFeatureSchema } from '../domain/feature.js'
import { FeatureSchemaBuilder } from '../domain/feature.js'

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
import { ConfigResolver, type DeepPartial, type EngineConfig, type ResolvedConfig } from './config.js'
import { type Container, DefaultContainer } from './container.js'
import { BuilderSealedError, RecoError } from './errors.js'
import { resolveFeatureGraph } from './graph.js'
import { asPlugin, dedupePlugins, directPlugin, type Plugin, sortPlugins, type Usable } from './plugin.js'
import type { Registry, ResolvedRegistry, SlotOptions } from './registry.js'
import type { Token } from './token.js'

/**
 * The frozen output of `build()`: everything the pipeline needs and nothing that can
 * still change.
 *
 * Stage 3 turns this into `RecommendationEngine` — `build()` will return the engine and
 * this will become an internal step. The seam is here rather than inside the pipeline
 * because assembling the registry and executing it are two jobs, and only the first one
 * is finished.
 */
export interface EngineBlueprint<P = unknown> {
  readonly registry: ResolvedRegistry<P>
  readonly config: ResolvedConfig
  readonly container: Container
  /** Dependency order. Dispose walks it backwards. */
  readonly plugins: readonly Plugin<P>[]
}

/** A single slot and who claimed it. Replacing one is only legal with `override: true`. */
interface Slot<T> {
  value: T
  owner: string
}

/**
 * One object, two interfaces.
 *
 * A plugin holds it as `Registry` and can only write; the caller holds it as
 * `EngineBuilder` and can also `build()`. Version 0.1 had these as separate levels, and
 * the "Plugin → Registry → Builder, and Registry knows Plugins" loop in the diagram was
 * not a design problem — it was one object described under two names. There is no loop:
 * the builder *calls* the plugin, the plugin *writes* to an interface. One direction.
 *
 * Everything here is mutable, and everything after `build()` is not. That is one boundary
 * for two guarantees: no races on a shared engine, and a feature matrix that always
 * matches `schema.version`.
 */
export class EngineBuilder<P = unknown> implements Registry<P> {
  private readonly schemaBuilder = new FeatureSchemaBuilder()
  private readonly profileSchemaBuilder = new FeatureSchemaBuilder()
  private readonly rootContainer = new DefaultContainer()
  private readonly configResolver = new ConfigResolver()

  private readonly pending: Plugin<P>[] = []
  private readonly providers: CandidateProvider<P>[] = []
  private readonly preFilters: PreFilter<P>[] = []
  private readonly postFilters: PostFilter[] = []
  private readonly extractors: FeatureExtractor<P>[] = []
  private readonly userExtractors: UserFeatureExtractor[] = []
  private readonly transforms: FeatureTransform[] = []
  private readonly strategies: AnyScoringStrategy<P>[] = []
  private readonly modifiers: ScoreModifier[] = []
  private readonly diversifiers: Diversifier<P>[] = []
  private readonly middleware: StageMiddleware[] = []

  private combiner: Slot<ScoreCombiner> | undefined
  private ranker: Slot<Ranker> | undefined
  private explainer: Slot<Explainer<P>> | undefined
  private blender: Slot<Blender> | undefined
  private weightProvider: Slot<WeightProvider> | undefined

  private configPatch: DeepPartial<EngineConfig> = {}
  private sealed = false
  /** Set while a plugin's `register()` runs. Names the port's owner in errors. */
  private registering: string | undefined

  get schema(): MutableFeatureSchema {
    return this.schemaBuilder
  }

  get profileSchema(): MutableFeatureSchema {
    return this.profileSchemaBuilder
  }

  /**
   * Accepts a plugin or a bare port; the port is wrapped into an anonymous plugin, so
   * there is one registration path rather than two.
   */
  use(usable: Usable<P>): this {
    this.assertOpen('use')
    this.pending.push(asPlugin(usable))
    return this
  }

  /** Merges into what previous calls accumulated. Last value wins, leaf by leaf. */
  configure(patch: DeepPartial<EngineConfig>): this {
    this.assertOpen('configure')
    this.configPatch = mergePatch(this.configPatch, patch)
    return this
  }

  /**
   * Binds infrastructure: clock, rng, logger, metrics, cache.
   *
   * Not in §8.0's interface, and it has to be: the container is reachable by plugins and
   * by nobody else, which leaves the host application unable to inject its own clock —
   * the one thing that makes the engine testable.
   */
  provide<T>(token: Token<T>, value: T): this {
    this.assertOpen('provide')
    this.rootContainer.bind(token).toValue(value)
    return this
  }

  addProvider(provider: CandidateProvider<P>): void {
    if (this.defer('addProvider', (r) => r.addProvider(provider))) return
    this.providers.push(provider)
  }

  addPreFilter(filter: PreFilter<P>): void {
    if (this.defer('addPreFilter', (r) => r.addPreFilter(filter))) return
    this.preFilters.push(filter)
  }

  addPostFilter(filter: PostFilter): void {
    if (this.defer('addPostFilter', (r) => r.addPostFilter(filter))) return
    this.postFilters.push(filter)
  }

  addExtractor(extractor: FeatureExtractor<P>): void {
    if (this.defer('addExtractor', (r) => r.addExtractor(extractor))) return
    this.declare(extractor, this.schemaBuilder)
    this.extractors.push(extractor)
  }

  addUserExtractor(extractor: UserFeatureExtractor): void {
    if (this.defer('addUserExtractor', (r) => r.addUserExtractor(extractor))) return
    this.declare(extractor, this.profileSchemaBuilder)
    this.userExtractors.push(extractor)
  }

  addTransform(transform: FeatureTransform): void {
    if (this.defer('addTransform', (r) => r.addTransform(transform))) return
    this.declare(transform, this.schemaBuilder)
    this.transforms.push(transform)
  }

  addStrategy(strategy: AnyScoringStrategy<P>): void {
    if (this.defer('addStrategy', (r) => r.addStrategy(strategy))) return
    const clash = this.strategies.find((existing) => existing.id === strategy.id)
    if (clash !== undefined) {
      // Ids are also weight keys, so two strategies under one id means one of them scores
      // with a weight meant for the other, and `weights.artist` becomes ambiguous in a way
      // no error would ever mention. AffinityStrategy is designed to be used several times
      // — with different ids.
      throw new RecoError(
        'SLOT_CONFLICT',
        `Two strategies share the id "${strategy.id}". The id is also the key its weight is configured ` +
          `under, so one of them would be scored with the other's weight. Give each instance its own id.`,
      )
    }
    this.strategies.push(strategy)
  }

  addModifier(modifier: ScoreModifier): void {
    if (this.defer('addModifier', (r) => r.addModifier(modifier))) return
    this.modifiers.push(modifier)
  }

  addDiversifier(diversifier: Diversifier<P>): void {
    if (this.defer('addDiversifier', (r) => r.addDiversifier(diversifier))) return
    this.diversifiers.push(diversifier)
  }

  addMiddleware(middleware: StageMiddleware): void {
    if (this.defer('addMiddleware', (r) => r.addMiddleware(middleware))) return
    this.middleware.push(middleware)
  }

  setCombiner(combiner: ScoreCombiner, options?: SlotOptions): void {
    if (this.defer('setCombiner', (r) => r.setCombiner(combiner, options))) return
    this.combiner = this.claim('combiner', this.combiner, combiner, options)
  }

  setRanker(ranker: Ranker, options?: SlotOptions): void {
    if (this.defer('setRanker', (r) => r.setRanker(ranker, options))) return
    this.ranker = this.claim('ranker', this.ranker, ranker, options)
  }

  setExplainer(explainer: Explainer<P>, options?: SlotOptions): void {
    if (this.defer('setExplainer', (r) => r.setExplainer(explainer, options))) return
    this.explainer = this.claim('explainer', this.explainer, explainer, options)
  }

  setBlender(blender: Blender, options?: SlotOptions): void {
    if (this.defer('setBlender', (r) => r.setBlender(blender, options))) return
    this.blender = this.claim('blender', this.blender, blender, options)
  }

  setWeightProvider(provider: WeightProvider, options?: SlotOptions): void {
    if (this.defer('setWeightProvider', (r) => r.setWeightProvider(provider, options))) return
    this.weightProvider = this.claim('weightProvider', this.weightProvider, provider, options)
  }

  /**
   * Runs the lifecycle of §8.3 and seals the builder.
   *
   * The order differs from the document in one place, deliberately: config is validated
   * *after* `register()`, not before. It has to be — `weights` are checked against the
   * registered strategies, and before `register()` there are none. Validating in two
   * passes instead would report the plugin's own options now and the weight typo later,
   * which is exactly the "fix one thing per restart" experience the resolver's issue list
   * exists to avoid.
   */
  build(): EngineBlueprint<P> {
    this.assertOpen('build')
    // Sealed up front, so build() is one-shot whatever the outcome. Registration mutates
    // the schema and the slots as it goes, so a build that failed halfway leaves a
    // half-registered builder; running it again would replay every write on top of that
    // and report the replay ("two strategies share the id artist") instead of the real
    // fault. A failed build is a failed startup — fix the cause and construct a new
    // builder, which is what the error says.
    this.sealed = true
    const plugins = sortPlugins(dedupePlugins(this.pending))

    for (const plugin of plugins) {
      if (plugin.configSchema !== undefined) this.configResolver.addSchema(plugin.configSchema, plugin.name)
    }

    for (const plugin of plugins) {
      this.registering = plugin.name
      try {
        plugin.register(this, this.rootContainer)
      } finally {
        this.registering = undefined
      }
    }

    const transforms = resolveFeatureGraph({
      extractors: this.extractors,
      userExtractors: this.userExtractors,
      transforms: this.transforms,
      strategies: this.strategies,
      postFilters: this.postFilters,
    })

    const config = this.configResolver.resolve(
      this.configPatch,
      this.strategies.map((strategy) => strategy.id),
    )

    // Freeze, in this order: nothing below may still be able to register a feature.
    this.rootContainer.seal()
    const schema: FeatureSchema = this.schemaBuilder.freeze()
    const profileSchema: FeatureSchema = this.profileSchemaBuilder.freeze()

    const registry: ResolvedRegistry<P> = Object.freeze({
      schema,
      profileSchema,
      providers: Object.freeze([...this.providers]),
      preFilters: Object.freeze([...this.preFilters]),
      postFilters: Object.freeze([...this.postFilters]),
      extractors: Object.freeze([...this.extractors]),
      userExtractors: Object.freeze([...this.userExtractors]),
      transforms: Object.freeze([...transforms]),
      strategies: Object.freeze([...this.strategies]),
      modifiers: Object.freeze([...this.modifiers]),
      diversifiers: Object.freeze([...this.diversifiers]),
      middleware: Object.freeze([...this.middleware]),
      combiner: this.combiner?.value,
      ranker: this.ranker?.value,
      explainer: this.explainer?.value,
      blender: this.blender?.value,
      weightProvider: this.weightProvider?.value,
    })

    return Object.freeze({ registry, config, container: this.rootContainer, plugins })
  }

  /**
   * Queues a write when it comes from outside a plugin, so that everything registers in
   * the order it was written.
   *
   * `use()` cannot register eagerly — dependency sorting needs every plugin in hand
   * first. That left two write paths with opposite timing: `use(port)` waited for
   * `build()` while a direct `setRanker()` applied at once, so
   * `.use(defaultRanker).setRanker(mine, { override: true })` failed with the two claims
   * reported back to front. The order in the source was not the order of execution.
   *
   * So a direct call means the same as `use()` and is queued the same way. The one method
   * behaves differently depending on who calls it, which reads odd and produces the only
   * result anyone expects: writes happen in the order they were written.
   *
   * @returns true if the write was queued and the caller should stop
   */
  private defer(operation: string, apply: (registry: Registry<P>) => void): boolean {
    // Inside register(): this *is* the plugin's turn, so do the work now. Checked before
    // the seal, because build() seals up front and then invites the plugins to write.
    if (this.registering !== undefined) return false
    this.assertOpen(operation)
    this.pending.push(directPlugin(operation, apply))
    return true
  }

  /**
   * Registers a port's declared features into a schema.
   *
   * The port declares them and the builder writes them, rather than the plugin calling
   * `schema.register()` itself. That is what lets `build()` know which schema a key
   * belongs to and who owns it — and a plugin that forgot to register what it `provides`
   * becomes impossible rather than mysterious.
   */
  private declare(
    owner: { readonly id: string; readonly version: string; readonly provides: readonly FeatureDescriptor[] },
    schema: FeatureSchemaBuilder,
  ): void {
    for (const descriptor of owner.provides) {
      if (descriptor.owner !== owner.id || descriptor.ownerVersion !== owner.version) {
        // `owner` feeds collision messages and `schema.version`, and through it every
        // cache key. A descriptor attributed to someone else would blame the wrong port in
        // an error and, worse, keep serving cached values after its real owner changed.
        throw new RecoError(
          'INVALID_CONFIG',
          `"${owner.id}@${owner.version}" provides feature "${descriptor.key}" but attributes it to ` +
            `"${descriptor.owner}@${descriptor.ownerVersion}". A descriptor must name the port that ` +
            `declares it: the owner is what invalidates the feature cache when that port changes.`,
        )
      }
      schema.register(descriptor)
    }
  }

  private claim<T extends { readonly id: string }>(
    name: string,
    current: Slot<T> | undefined,
    value: T,
    options: SlotOptions | undefined,
  ): Slot<T> {
    const owner = this.registering ?? `auto:${value.id}`

    if (current !== undefined && options?.override !== true) {
      throw new RecoError(
        'SLOT_CONFLICT',
        `Slot "${name}" is already claimed by "${current.owner}"; "${owner}" would replace it. ` +
          `A single-slot port is replaced whole and only on purpose: pass { override: true } if that is ` +
          `what you mean.`,
      )
    }
    return { value, owner }
  }

  private assertOpen(operation: string): void {
    // The compiler cannot catch this — a reference to the builder may have been kept, and
    // a plugin holds one by design. Second line of defence, and the only one there is.
    if (this.sealed) throw new BuilderSealedError(operation)
  }
}

/** Same merge semantics as the resolver's: objects deep, arrays and leaves replaced. */
function mergePatch<T>(base: DeepPartial<T>, patch: DeepPartial<T>): DeepPartial<T> {
  const isPlain = (value: unknown): value is Record<string, unknown> =>
    typeof value === 'object' && value !== null && !Array.isArray(value)

  if (!isPlain(base) || !isPlain(patch)) return patch

  const out: Record<string, unknown> = { ...base }
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue
    out[key] = key in base ? mergePatch(base[key] as never, value as never) : value
  }
  return out as DeepPartial<T>
}

/**
 * Entry point. `createEngine<Track>()` is what types the whole chain: a
 * `DomainScoringStrategy<Movie>` will not register here, and the compiler says so at the
 * `use()` that tried.
 */
export function createEngine<P = unknown>(): EngineBuilder<P> {
  return new EngineBuilder<P>()
}
