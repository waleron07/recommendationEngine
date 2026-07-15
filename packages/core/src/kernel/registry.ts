import type { FeatureSchema, MutableFeatureSchema } from '../domain/feature.js'
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

/** A single-slot port replaces rather than joins, so replacing it must be deliberate. */
export interface SlotOptions {
  readonly override: boolean
}

/**
 * What a PLUGIN sees. Write only.
 *
 * There is no `build()` here, and that is the whole reason this interface exists
 * separately from `EngineBuilder` — which is the same object. A plugin holding a
 * reference that can build the engine it is being registered into is a loop waiting to
 * be written. One object, two roles, and the role decides what you can reach.
 */
export interface Registry<P = unknown> {
  /**
   * Features of candidates. Extractors' `provides` are registered here automatically;
   * this is the escape hatch for the rare descriptor that has no port to declare it.
   */
  readonly schema: MutableFeatureSchema
  /**
   * Features of the user/session — a separate space, not a section of the item schema.
   *
   * Two schemas rather than the one in §8.0: `affinity_genre` means "how well this track
   * matches the user" as an item feature and "how much of the user's taste is this genre"
   * as a profile feature. Both are legitimate, both are natural under that name, and one
   * namespace would call the pair a collision and force a rename to say the same thing.
   * They are different vector spaces; the engine now says so.
   */
  readonly profileSchema: MutableFeatureSchema

  addProvider(provider: CandidateProvider<P>): void
  addPreFilter(filter: PreFilter<P>): void
  addPostFilter(filter: PostFilter): void
  addExtractor(extractor: FeatureExtractor<P>): void
  addUserExtractor(extractor: UserFeatureExtractor): void
  addTransform(transform: FeatureTransform): void
  addStrategy(strategy: AnyScoringStrategy<P>): void
  addModifier(modifier: ScoreModifier): void
  addDiversifier(diversifier: Diversifier<P>): void
  addMiddleware(middleware: StageMiddleware): void

  setCombiner(combiner: ScoreCombiner, options?: SlotOptions): void
  setRanker(ranker: Ranker, options?: SlotOptions): void
  setExplainer(explainer: Explainer<P>, options?: SlotOptions): void
  setBlender(blender: Blender, options?: SlotOptions): void
  setWeightProvider(provider: WeightProvider, options?: SlotOptions): void
}

/**
 * What the PIPELINE sees: the frozen result of `build()`.
 *
 * Nothing here is mutable, and that is what makes one engine instance safe under
 * concurrent requests without a lock: there is no write path left to race on. The
 * mutability boundary is exactly `build()` — one boundary, which also happens to be the
 * one that guarantees the matrix always matches `schema.version`.
 */
export interface ResolvedRegistry<P = unknown> {
  readonly schema: FeatureSchema
  readonly profileSchema: FeatureSchema
  readonly providers: readonly CandidateProvider<P>[]
  readonly preFilters: readonly PreFilter<P>[]
  readonly postFilters: readonly PostFilter[]
  readonly extractors: readonly FeatureExtractor<P>[]
  readonly userExtractors: readonly UserFeatureExtractor[]
  /** Topologically sorted: every transform runs after whoever provides its inputs. */
  readonly transforms: readonly FeatureTransform[]
  readonly strategies: readonly AnyScoringStrategy<P>[]
  readonly modifiers: readonly ScoreModifier[]
  readonly diversifiers: readonly Diversifier<P>[]
  readonly middleware: readonly StageMiddleware[]
  /**
   * Optional here, mandatory at runtime: stage 3 fills the empty slots from
   * `engine/defaults.ts`. The kernel refuses to invent a ranker — it only records that
   * nobody claimed the slot.
   */
  readonly combiner: ScoreCombiner | undefined
  readonly ranker: Ranker | undefined
  readonly explainer: Explainer<P> | undefined
  readonly blender: Blender | undefined
  readonly weightProvider: WeightProvider | undefined
}
