import type { CandidateSet } from '../domain/candidate.js'
import type { FeatureKey, StrategyId } from '../domain/ids.js'
import type { FeatureMatrix } from '../domain/matrix.js'
import type { ProfileVector } from '../domain/profile.js'
import type { ScoreColumn } from '../domain/score.js'
import type { RequestContext } from './context.js'
import type { ScoreNormalizer } from './score-normalizer.js'

/**
 * Everything a strategy can see. Extensible *without* changing any signature — that is
 * the whole point of passing a view rather than a matrix.
 *
 * Note `ctx` is in here, and `ctx` carries the `HistoryIndex`. The recurring objection
 * that "a strategy only gets a `Float64Array`" was never true.
 */
export interface ScoringView {
  /** Rows are candidates, in `CandidateSet` order. */
  readonly items: FeatureMatrix
  /** Features of the user/session, from `UserFeatureExtractor`. */
  readonly profile: ProfileVector
  readonly ctx: RequestContext
}

/**
 * Stage 5. One strategy produces one column of raw numbers plus its reasons.
 *
 * It does not know the domain — it works with numbers. It does not know its own scale
 * either: `PopularityStrategy` returns 4,200,000 plays and `RecencyStrategy` returns
 * 0.87, and normalization (stage 6) is what makes them comparable. That is why weights
 * stay human-readable: `artist: 0.9` against `popularity: 0.3` reads as "artist matters
 * three times more", and it is true.
 */
export interface ScoringStrategy {
  /** Also the key its weight is configured under. */
  readonly id: StrategyId
  /** Validated at `build()` against the item schema. */
  readonly requires: readonly FeatureKey[]
  /** Validated at `build()` against the profile schema. */
  readonly requiresProfile?: readonly FeatureKey[]
  /** The strategy knows its own scale; the engine does not guess it. */
  readonly normalizer?: ScoreNormalizer
  /**
   * Does this strategy apply to *this request*? Asked once per request, not per item.
   *
   * This is cold start, expressed declaratively: `ctx.history.size >= 20`. Returning
   * false drops the column, and `Σ weights` re-weights the rest for free — a user with
   * no history ends up on popularity and recency because the other strategies stood
   * down, not because someone wrote `if (isNewUser)` in the core.
   *
   * Deliberately not `supports()`/`canHandle()`: schema compatibility is settled at
   * `build()` (§8.4). This asks about the request, which is a different question and
   * gets a different name.
   */
  applicable?(ctx: RequestContext): boolean
  /**
   * Synchronous, forever (§23.2).
   *
   * Not an optimization — a guard on the I/O → extraction → maths separation. An
   * `async score()` is an open door, and "just fetch one value from Redis" walks
   * straight through it.
   */
  score(view: ScoringView): ScoreColumn
}

/**
 * Escape hatch: a strategy that does see domain objects.
 *
 * Not forbidden, but priced at the type level: a `DomainScoringStrategy<Track>` will not
 * register in a `createEngine<Movie>()`. The cost is visible in the signature and the
 * compiler collects it.
 */
export interface DomainScoringStrategy<P = unknown> {
  readonly id: StrategyId
  readonly requires: readonly FeatureKey[]
  readonly requiresProfile?: readonly FeatureKey[]
  /** Marker → `engine.inspect()` → docs. Domain coupling should be visible, not implied. */
  readonly domain: true
  readonly normalizer?: ScoreNormalizer
  applicable?(ctx: RequestContext): boolean
  score(view: ScoringView, set: CandidateSet<P>): ScoreColumn
}

/** Either kind. What the registry stores and the pipeline runs. */
export type AnyScoringStrategy<P = unknown> = ScoringStrategy | DomainScoringStrategy<P>

/** Narrows to the escape hatch. The marker is the discriminant, so this is not a guess. */
export function isDomainStrategy<P>(strategy: AnyScoringStrategy<P>): strategy is DomainScoringStrategy<P> {
  return (strategy as DomainScoringStrategy<P>).domain === true
}
