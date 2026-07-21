import type { Explanation, ItemExplanation } from '../domain/explanation.js'
import type { ItemId } from '../domain/ids.js'
import { timestamp } from '../domain/ids.js'
import type { RecommendationResult } from '../domain/recommendation.js'
import { type EngineBlueprint, EngineBuilder } from '../kernel/builder.js'
import type { Container } from '../kernel/container.js'
import { BuilderSealedError } from '../kernel/errors.js'
import type { ResolvedRegistry } from '../kernel/registry.js'
import { CLOCK, LOGGER, METRICS, RNG } from '../kernel/token.js'
import { Xoshiro128 } from '../math/rng.js'
import { type PipelineDeps, type PipelineProbe, runPipeline } from '../pipeline/pipeline.js'
import type { RecommendationRequest } from '../pipeline/request.js'
import type { Clock, Logger, Rng } from '../ports/infra.js'
import type { ScoreCombiner } from '../ports/score-combiner.js'
import type { ScoreNormalizer } from '../ports/score-normalizer.js'
import { isDomainStrategy } from '../ports/scoring-strategy.js'
import { assertCombinerId, DEFAULT_COMBINERS, DEFAULT_NORMALIZERS } from './defaults.js'

/**
 * The engine. Immutable, and safe to share across concurrent requests.
 *
 * Not because it locks anything — because there is nothing left to lock. The registry and
 * both schemas froze at `build()`, the context freezes at stage 0, and every port is
 * stateless by contract. Everything that changes during a request lives in the request.
 */
export interface RecommendationEngine<P = unknown, UP = unknown> {
  recommend(request: RecommendationRequest<P, UP>): Promise<RecommendationResult<P>>
  /**
   * "Why is this item where it is?" — including "why is it *not* in the feed" (§16).
   *
   * Runs the pipeline the request would and reports the item's fate: never retrieved,
   * filtered, out-ranked, or on the page. The direct analogue of Elasticsearch's
   * `_explain`, and what turns the engine from a black box into a tool.
   */
  explain(itemId: ItemId, request: RecommendationRequest<P, UP>): Promise<ItemExplanation<P>>
  /** What this engine is made of. For diagnostics and docs, not for reaching into. */
  inspect(): EngineDescription
  /** Disposes plugins in reverse dependency order: dependents die before dependencies. */
  dispose(): Promise<void>
}

export interface EngineDescription {
  readonly schemaVersion: string
  readonly profileSchemaVersion: string
  readonly features: readonly string[]
  readonly profileFeatures: readonly string[]
  readonly plugins: readonly { readonly name: string; readonly version: string }[]
  /**
   * Each strategy, and whether it reached for the domain escape hatch.
   *
   * §19 promises that a `DomainScoringStrategy` is "visible in engine.inspect()", and the
   * promise is the point: the hatch is allowed, but taking it trades portability, and a
   * trade nobody can see is one nobody will revisit. A list of bare ids would have left
   * that claim unmet.
   */
  readonly strategies: readonly { readonly id: string; readonly domain: boolean }[]
  readonly stages: Readonly<Record<string, readonly string[]>>
}

class Engine<P, UP> implements RecommendationEngine<P, UP> {
  private readonly blueprint: EngineBlueprint<P>
  private readonly normalizers: ReadonlyMap<string, ScoreNormalizer>
  private readonly combiners: ReadonlyMap<string, ScoreCombiner>
  private disposed = false

  constructor(
    blueprint: EngineBlueprint<P>,
    normalizers: ReadonlyMap<string, ScoreNormalizer>,
    combiners: ReadonlyMap<string, ScoreCombiner>,
  ) {
    this.blueprint = blueprint
    this.normalizers = normalizers
    this.combiners = combiners
  }

  async recommend(request: RecommendationRequest<P, UP>): Promise<RecommendationResult<P>> {
    return runPipeline<P, UP>(this.blueprint, request, this.depsFor())
  }

  async explain(itemId: ItemId, request: RecommendationRequest<P, UP>): Promise<ItemExplanation<P>> {
    // The probe collects each stage's survivors as the pipeline runs; `explain: 'full'`
    // forces the trace on so a scored item carries its whole story. Same pipeline as
    // recommend(), same answer — this only watches one item through it.
    const probe: PipelineProbe<P> = {}
    const result = await runPipeline<P, UP>(
      this.blueprint,
      { ...request, explain: 'full' },
      { ...this.depsFor(), probe },
    )
    return interpretProbe<P>(itemId, probe, result.diagnostics)
  }

  /**
   * Resolved per request rather than cached in a field: a host may rebind the clock on a
   * child container, and reading through the container is what makes that work.
   */
  private depsFor(): PipelineDeps<P> {
    const container: Container = this.blueprint.container
    return {
      clock: container.tryGet(CLOCK) ?? systemClock,
      rng: container.tryGet(RNG) ?? defaultRng,
      logger: container.tryGet(LOGGER) ?? silentLogger,
      metrics: container.tryGet(METRICS),
      normalizers: this.normalizers,
      combiners: this.combiners,
    }
  }

  inspect(): EngineDescription {
    const registry: ResolvedRegistry<P> = this.blueprint.registry
    return {
      schemaVersion: registry.schema.version,
      profileSchemaVersion: registry.profileSchema.version,
      features: registry.schema.descriptors().map((d) => d.key),
      profileFeatures: registry.profileSchema.descriptors().map((d) => d.key),
      plugins: this.blueprint.plugins.map((p) => ({ name: p.name, version: p.version })),
      strategies: registry.strategies.map((s) => ({ id: s.id, domain: isDomainStrategy(s) })),
      stages: {
        retrieval: registry.providers.map((p) => p.id),
        prefilter: registry.preFilters.map((f) => f.id),
        extraction: [...registry.extractors, ...registry.userExtractors].map((e) => e.id),
        engineering: registry.transforms.map((t) => t.id),
        postfilter: registry.postFilters.map((f) => f.id),
        modifiers: registry.modifiers.map((m) => m.id),
        diversification: registry.diversifiers.map((d) => d.id),
        middleware: registry.middleware.map((m) => m.id),
      },
    }
  }

  async dispose(): Promise<void> {
    if (this.disposed) return
    this.disposed = true

    // Reverse of registration: a plugin's dependencies must outlive it, or the last thing
    // it does on the way out is reach for something already gone.
    for (const plugin of [...this.blueprint.plugins].reverse()) {
      await plugin.dispose?.()
    }
  }
}

/**
 * `build()` returns the engine, as §18 promises.
 *
 * The kernel's `resolve()` does the assembling and refuses to invent a ranker; this fills
 * the slots nobody claimed and wraps the result. Two jobs, two places — which is what lets
 * the kernel stay honest about knowing no maths, while an empty engine still runs.
 */
class DefaultingEngineBuilder<P, UP> extends EngineBuilder<P> {
  private readonly normalizers = new Map<string, ScoreNormalizer>(DEFAULT_NORMALIZERS)
  private readonly combiners = new Map<string, ScoreCombiner>(DEFAULT_COMBINERS)
  private built = false

  /**
   * Registers a normalizer under its id, for `normalization.default` to find.
   *
   * Sealed like every other write. It was not, and `build()` handed this map to the engine
   * by reference — so a call after build() reached into a live engine and changed how it
   * scores, past the one boundary §8.3 says everything stops at.
   */
  addNormalizer(normalizer: ScoreNormalizer): this {
    this.assertNotBuilt('addNormalizer')
    this.normalizers.set(normalizer.id, normalizer)
    return this
  }

  /** Registers a combiner under its id, for `combiner.id` to find. */
  addCombiner(combiner: ScoreCombiner): this {
    this.assertNotBuilt('addCombiner')
    this.combiners.set(combiner.id, combiner)
    return this
  }

  build(): RecommendationEngine<P, UP> {
    const blueprint = this.resolve()
    // At build(), not at the first request: a typo'd combiner id must stop the
    // application from starting, like every other config mistake here.
    assertCombinerId(blueprint.config.combiner.id, this.combiners)
    this.built = true

    // Copied, not handed over. The engine must not share a mutable map with the builder
    // that made it: "immutable, and safe to share across concurrent requests" is a claim
    // this class makes about itself, and a live reference back to the builder falsifies it.
    return new Engine<P, UP>(blueprint, new Map(this.normalizers), new Map(this.combiners))
  }

  private assertNotBuilt(operation: string): void {
    if (this.built) throw new BuilderSealedError(operation)
  }
}

export type EngineBuilderWithDefaults<P = unknown, UP = unknown> = DefaultingEngineBuilder<P, UP>

/**
 * Entry point. `createEngine<Track>()` types the whole chain: a
 * `DomainScoringStrategy<Movie>` will not register here, and the compiler says so at the
 * `use()` that tried.
 */
export function createEngine<P = unknown, UP = unknown>(): DefaultingEngineBuilder<P, UP> {
  return new DefaultingEngineBuilder<P, UP>()
}

/**
 * Reads one item's fate out of the pipeline probe.
 *
 * Walks the stages in order and stops at the first that lost the item, so the reported
 * `lostAt` is the *earliest* explanation, not a later symptom. Once the item reached
 * scoring it carries a full explanation regardless of where it ended up — that is what
 * separates "dropped by fatigue" (scored 0, on the page) from "out-ranked" (scored well,
 * below the fold) from "quota'd out" (scored well, dropped by a diversifier).
 */
function interpretProbe<P>(
  itemId: ItemId,
  probe: PipelineProbe<P>,
  diagnostics: RecommendationResult<P>['diagnostics'],
): ItemExplanation<P> {
  const retrieved = probe.retrieved
  const retrievedRow = retrieved?.indexOf(itemId) ?? -1
  if (retrieved === undefined || retrievedRow < 0) {
    return { itemId, item: undefined, status: 'not_retrieved', lostAt: 'retrieval', diagnostics }
  }
  const item = retrieved.at(retrievedRow).item

  if (probe.prefiltered === undefined || probe.prefiltered.indexOf(itemId) < 0) {
    return { itemId, item, status: 'filtered', lostAt: 'prefilter', diagnostics }
  }

  const scored = probe.scored
  const row = scored?.indexOf(itemId) ?? -1
  if (scored === undefined || row < 0) {
    return { itemId, item, status: 'filtered', lostAt: 'postfilter', diagnostics }
  }

  // From here the item was scored, so it always carries a full explanation. `explainRow`
  // is set whenever `scored` is (both under `if (deps.probe)`), so this is not optional in
  // practice — the assertion states the invariant the two assignments share.
  const explanation = (probe.explainRow as (r: number) => Explanation)(row)
  const blendedIndex = probe.blended?.indexOf(row) ?? -1
  const onPage = probe.page?.includes(row) ?? false

  if (onPage) {
    return { itemId, item, status: 'recommended', rank: blendedIndex + 1, explanation, diagnostics }
  }
  if (blendedIndex >= 0) {
    return {
      itemId,
      item,
      status: 'truncated',
      lostAt: 'truncate',
      rank: blendedIndex + 1,
      explanation,
      diagnostics,
    }
  }
  // Scored but not in the blended order: a reorderer dropped it. Diversification is the
  // one that removes rows (an attribute quota); the blender only reorders, so a gap there
  // is reported distinctly rather than folded into "diversified out".
  if (probe.diversified?.includes(row) ?? false) {
    return { itemId, item, status: 'blended_out', lostAt: 'blending', explanation, diagnostics }
  }
  return { itemId, item, status: 'diversified_out', lostAt: 'diversification', explanation, diagnostics }
}

/** Last resorts, used only when the host bound nothing. */
const systemClock: Clock = { now: () => timestamp(Date.now()) }

const silentLogger: Logger = { debug: () => {}, warn: () => {} }

/**
 * Seeded, and therefore replayable, straight out of the box.
 *
 * The constant seed is the point rather than an oversight: an engine nobody configured
 * still produces the same feed for the same user twice, so a bug report can be reproduced
 * and an A/B test measures its variant. A host that wants different engines to explore
 * differently binds its own `RNG` with its own seed — but the default is reproducible,
 * because the unreproducible one is what §23.4 exists to forbid.
 *
 * `exploration.seed` from the config forks off this per request (see `resolveRequest`),
 * so the usual way to vary exploration is config, not a different generator.
 */
const defaultRng: Rng = new Xoshiro128('recoengine')
