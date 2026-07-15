import type { CandidateSet } from '../domain/candidate.js'
import type { ScoreBoard } from '../domain/score.js'
import type { RequestContext } from './context.js'

/**
 * Stage 9. Score → order.
 *
 * Returns row indices rather than candidates: the set is the source of truth for what a
 * row *is*, and copying objects around to express an ordering is how a rank and a
 * candidate drift apart. Top-K through a heap, not a full sort — the default ranker only
 * needs `limit` of 5000 rows ordered.
 */
export interface Ranker {
  readonly id: string
  /** Row indices, best first. */
  rank(board: ScoreBoard, set: CandidateSet, ctx: RequestContext): readonly number[]
}
