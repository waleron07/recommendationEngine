import type { Candidate } from '../domain/candidate.js'
import type { FeatureKey } from '../domain/ids.js'
import type { RequestContext } from './context.js'
import type { ScoringView } from './scoring-strategy.js'

/**
 * Stage 2. Hard rules decidable from `payload` alone: blacklist, already owned, 18+,
 * region.
 *
 * FAIL-CLOSED BY CONTRACT, not by configuration. The guarantee rests on four structural
 * properties rather than a paragraph of documentation:
 *
 * 1. There is no `criticality`. Offering the choice would itself be the bug — nobody
 *    should be able to configure the licence check into `optional`.
 * 2. `approve` is synchronous. You cannot call a service for the verdict, so
 *    "the licence service timed out, let it through" cannot happen. The data must
 *    already be here: in `payload` from retrieval, or in a feature from a `required`
 *    extractor. If the licence service is down, the request fails loudly on stage 3
 *    instead of quietly opening the gate on stage 2.
 * 3. The function is total: exactly two outcomes. A throw is not a third one — the
 *    engine reads it as refusal. What is not explicitly approved does not pass.
 * 4. The method is named for its polarity: not "check", but "approve".
 */
export interface PreFilter<P = unknown> {
  readonly id: string
  /** Literal, and not optional: the compiler makes you type the guarantee out. */
  readonly failClosed: true
  /** `true` = APPROVE. Runs before expensive features, so keep it cheap. */
  approve(candidate: Candidate<P>, ctx: RequestContext): boolean
}

/**
 * Stage 4b. The same fail-closed contract, for rules that need features.
 *
 * Split from `PreFilter` because a safety rule ("not licensed in this region") sometimes
 * needs a feature, and dragging the network into a filter is exactly what property 2
 * above forbids. So: filter what you can from `payload` before paying for features,
 * filter the rest right after — but still before scoring. Computing a score for a
 * candidate that will not be shown is pure waste.
 */
export interface PostFilter {
  readonly id: string
  readonly failClosed: true
  /** Validated at `build()`: a filter requiring a feature nobody provides never starts. */
  readonly requires: readonly FeatureKey[]
  /** `true` = APPROVE. Reads the feature row, not the payload. */
  approve(row: number, view: ScoringView): boolean
}
