import type { CandidateSet } from '../domain/candidate.js'
import type { FeatureDescriptor } from '../domain/feature.js'
import type { ItemId } from '../domain/ids.js'
import type { FeatureMatrix } from '../domain/matrix.js'
import type { MutableProfileVector } from '../domain/profile.js'
import type { Criticality, RequestContext } from './context.js'

/**
 * Stage 3. Domain knowledge lives here and nowhere else.
 *
 * `extract` is batched over the whole set on purpose: a per-candidate signature invites
 * one query per candidate, and the difference between one `IN (...)` and 5000 round
 * trips is the difference between a library and a toy. The contract makes the fast shape
 * the only shape.
 */
export interface FeatureExtractor<P = unknown> extends Criticality {
  readonly id: string
  /** Feeds `schema.version`, and through it every feature cache key. */
  readonly version: string
  /** Declared, not inferred. `build()` registers these into the schema and checks them. */
  readonly provides: readonly FeatureDescriptor[]
  extract(set: CandidateSet<P>, out: FeatureMatrix, ctx: RequestContext): Promise<void>
  readonly cache?: {
    readonly ttlMs: number
    key(id: ItemId, ctx: RequestContext): string
  }
}

/**
 * Stage 3, user side: taste centroid, session embedding, profile saturation, a PPR seed
 * vector.
 *
 * These are features of the *user*, not of a candidate, so they belong in a vector of
 * their own rather than in a column repeated across every row. It also closes the gap a
 * candidate-only matrix leaves open: without it a strategy sees candidates but has no
 * vector view of the history it is supposed to compare them against.
 */
export interface UserFeatureExtractor<UP = unknown> extends Criticality {
  readonly id: string
  readonly version: string
  /**
   * Literal marker, in the same spirit as `PreFilter.failClosed` and
   * `DomainScoringStrategy.domain`.
   *
   * `use()` dispatches on structure, and this port is structurally identical to
   * `FeatureExtractor` — both are `{ id, version, provides, extract }`. Telling them
   * apart by `extract.length` would be a guess that a default parameter silently breaks.
   * One literal field turns the guess into a fact the compiler checks.
   */
  readonly scope: 'user'
  readonly provides: readonly FeatureDescriptor[]
  extract(out: MutableProfileVector, ctx: RequestContext<UP>): Promise<void>
}
