import type { ScoreBoard } from '../domain/score.js'
import type { RequestContext } from './context.js'
import type { NormalizedColumn } from './score-normalizer.js'

/**
 * Stage 7. Folds the normalized columns into one score per candidate.
 *
 * Single slot, and irreplaceable: weighted sum by default, product or RRF if you ask.
 * A failing combiner fails the request under both error policies — there is no such
 * thing as a partially combined score.
 */
export interface ScoreCombiner {
  readonly id: string
  combine(columns: readonly NormalizedColumn[], ctx: RequestContext): ScoreBoard
}
