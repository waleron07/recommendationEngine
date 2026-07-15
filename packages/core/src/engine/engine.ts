import { timestamp } from '../domain/ids.js'
import type { RecommendationResult } from '../domain/recommendation.js'
import { type EngineBlueprint, EngineBuilder } from '../kernel/builder.js'
import type { Container } from '../kernel/container.js'
import type { ResolvedRegistry } from '../kernel/registry.js'
import { CLOCK, LOGGER, METRICS, RNG } from '../kernel/token.js'
import { Xoshiro128 } from '../math/rng.js'
import { runPipeline } from '../pipeline/pipeline.js'
import type { RecommendationRequest } from '../pipeline/request.js'
import type { Clock, Logger, Rng } from '../ports/infra.js'
import type { ScoreNormalizer } from '../ports/score-normalizer.js'
import { DEFAULT_NORMALIZERS } from './defaults.js'

/**
 * The engine. Immutable, and safe to share across concurrent requests.
 *
 * Not because it locks anything — because there is nothing left to lock. The registry and
 * both schemas froze at `build()`, the context freezes at stage 0, and every port is
 * stateless by contract. Everything that changes during a request lives in the request.
 */
export interface RecommendationEngine<P = unknown, UP = unknown> {
  recommend(request: RecommendationRequest<P, UP>): Promise<RecommendationResult<P>>
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
  readonly strategies: readonly string[]
  readonly stages: Readonly<Record<string, readonly string[]>>
}

class Engine<P, UP> implements RecommendationEngine<P, UP> {
  private readonly blueprint: EngineBlueprint<P>
  private readonly normalizers: ReadonlyMap<string, ScoreNormalizer>
  private disposed = false

  constructor(blueprint: EngineBlueprint<P>, normalizers: ReadonlyMap<string, ScoreNormalizer>) {
    this.blueprint = blueprint
    this.normalizers = normalizers
  }

  async recommend(request: RecommendationRequest<P, UP>): Promise<RecommendationResult<P>> {
    const container: Container = this.blueprint.container

    return runPipeline<P, UP>(this.blueprint, request, {
      // Resolved per request rather than cached in a field: a host may rebind the clock on
      // a child container, and reading through the container is what makes that work.
      clock: container.tryGet(CLOCK) ?? systemClock,
      rng: container.tryGet(RNG) ?? defaultRng,
      logger: container.tryGet(LOGGER) ?? silentLogger,
      metrics: container.tryGet(METRICS),
      normalizers: this.normalizers,
    })
  }

  inspect(): EngineDescription {
    const registry: ResolvedRegistry<P> = this.blueprint.registry
    return {
      schemaVersion: registry.schema.version,
      profileSchemaVersion: registry.profileSchema.version,
      features: registry.schema.descriptors().map((d) => d.key),
      profileFeatures: registry.profileSchema.descriptors().map((d) => d.key),
      plugins: this.blueprint.plugins.map((p) => ({ name: p.name, version: p.version })),
      strategies: registry.strategies.map((s) => s.id),
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

  /** Registers a normalizer under its id, for `normalization.default` to find. */
  addNormalizer(normalizer: ScoreNormalizer): this {
    this.normalizers.set(normalizer.id, normalizer)
    return this
  }

  build(): RecommendationEngine<P, UP> {
    return new Engine<P, UP>(this.resolve(), this.normalizers)
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
