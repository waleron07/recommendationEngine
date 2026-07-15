import type { CandidateSet } from '../domain/candidate.js'
import type { Explanation } from '../domain/explanation.js'
import type { ScoreBoard } from '../domain/score.js'
import type { RequestContext } from './context.js'

/**
 * Stage 13. Turns the trail the board already carries into an `Explanation`.
 *
 * The explainer does not compute anything — the board recorded every contribution as the
 * score was built, because there is no way to score without recording. What the explainer
 * owns is *policy*: which reasons clear `minContribution`, how many survive `maxReasons`,
 * whether negatives are shown, what order they come in. That is why it is a swappable
 * port and why `Explanation.reasons` is a field rather than something the caller derives.
 */
export interface Explainer<P = unknown> {
  readonly id: string
  explain(row: number, board: ScoreBoard, set: CandidateSet<P>, ctx: RequestContext): Explanation
}
