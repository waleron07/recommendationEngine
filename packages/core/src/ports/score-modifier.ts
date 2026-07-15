import type { CandidateSet } from '../domain/candidate.js'
import type { ContributionKind, MutableScoreBoard } from '../domain/score.js'
import type { RequestContext } from './context.js'

/**
 * Stage 8. Corrections on top of the combined score: fatigue, novelty, boost, penalty.
 *
 * Modifiers are not strategies, and the split is load-bearing. A strategy answers "how
 * well does this fit"; a modifier answers "is it appropriate to show right now". Adding
 * those together is wrong: fatigue must *multiply*. Subtract 0.3 from a track scoring
 * 0.98 and it stays on top after the 300th play; multiply by 0.1 and it leaves, while
 * the order of everything else survives intact. `kind` is where that choice is declared.
 */
export interface ScoreModifier {
  readonly id: string
  readonly kind: ContributionKind
  /**
   * Writes contributions; it does not overwrite scores.
   *
   * §6 typed `board` as the frozen `ScoreBoard` and returned `void`, which cannot work:
   * there was no operation such a modifier could perform. The write view is the fix, and
   * it also keeps explainability structural — a modifier cannot move a score without
   * leaving the record of why.
   */
  apply(board: MutableScoreBoard, set: CandidateSet, ctx: RequestContext): void
}
