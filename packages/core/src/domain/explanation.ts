import type { FeatureSchemaVersion } from './feature.js'
import type { Reason } from './reason.js'
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
