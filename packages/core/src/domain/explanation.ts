import type { Item } from './entities.js'
import type { FeatureSchemaVersion } from './feature.js'
import type { ItemId } from './ids.js'
import type { Reason } from './reason.js'
import type { Diagnostics } from './recommendation.js'
import type { ScoreContribution } from './score.js'

/**
 * The full record of one candidate's score, produced on stage 13.
 *
 * `contributions` is the single source of truth: the score is a fold over them, so an
 * explanation cannot drift from the number it explains. `reasons` looks derivable from
 * it and is not — see below.
 */
export interface Explanation {
  /** Presentation scale (0..100), not the internal [0..1]. */
  readonly score: number
  /** Before modifiers. Together with `score` this shows what fatigue and novelty did. */
  readonly baseScore: number
  readonly contributions: readonly ScoreContribution[]
  /**
   * Kept as a field although it looks like a projection of `contributions`.
   *
   * It is not a projection but a *policy*: which reasons to show (`minContribution`),
   * how many (`maxReasons`), in what order, whether negatives appear at all. That policy
   * belongs to the `Explainer` port. Deriving it client-side would smear one decision
   * across every consumer of the API.
   */
  readonly reasons: readonly Reason[]
  /** Only under `explain: 'full'`. Debugging tool, not a UI payload. */
  readonly trace?: ScoreTrace
}

/** Stage-by-stage record of how a score was built. */
export interface ScoreTrace {
  /** Which schema produced these features. Makes a stale trace recognisable as stale. */
  readonly schemaVersion: FeatureSchemaVersion
  readonly stages: readonly { readonly stage: string; readonly value: number; readonly note?: string }[]
  readonly features: Readonly<Record<string, number>>
}

/**
 * Where one item ended up, and if it is not in the feed, where it fell out (§16).
 *
 * The answer to "why is this track *not* in the recommendations?" — the direct analogue of
 * Elasticsearch's `_explain`. `engine.explain(itemId, request)` runs the same pipeline the
 * request would and reports the item's fate: never retrieved, filtered at stage 2 or 4b,
 * scored but out-ranked, or on the page. Once it reaches scoring it carries a full
 * `Explanation` (trace and all), so "dropped by fatigue" and "below the fold" are
 * distinguishable rather than both being "absent".
 */
export interface ItemExplanation<P = unknown> {
  readonly itemId: ItemId
  /** The item, once retrieval found it. Undefined only for `not_retrieved`. */
  readonly item: Item<P> | undefined
  readonly status:
    | 'recommended' // on the page the request would return
    | 'not_retrieved' // no provider returned it
    | 'filtered' // removed by a pre- or post-filter
    | 'diversified_out' // scored, then dropped by a diversifier (e.g. an attribute quota)
    | 'blended_out' // dropped by the blender
    | 'truncated' // ranked below the requested page
  /** The stage id it fell out at; undefined when `recommended`. */
  readonly lostAt?: string
  /** 1-based rank, when it is on the page (`recommended`). */
  readonly rank?: number
  /** Present once it reached scoring — for every status except `not_retrieved` and `filtered`. */
  readonly explanation?: Explanation
  readonly diagnostics: Diagnostics
}
