import type { CandidateSet } from '../domain/candidate.js'
import type { FeatureMatrix } from '../domain/matrix.js'
import type { ScoreBoard } from '../domain/score.js'
import type { RequestContext } from './context.js'

/**
 * Stage 10. Reorders an already-ranked list so the top is not eight songs by one artist.
 *
 * After ranking, because greedy algorithms like MMR need the order to work against.
 * Takes and returns row indices, so a diversifier that does nothing is the identity
 * function and MMR at λ=1 is provably plain ranking.
 *
 * Receives the `FeatureMatrix` because feature-based diversity is the whole point of the
 * stage: MMR reads it through a `SimilarityProvider`, `AttributeQuota` groups on a
 * categorical column. A diversifier that needs no features simply ignores it.
 */
export interface Diversifier<P = unknown> {
  readonly id: string
  diversify(
    ranked: readonly number[],
    set: CandidateSet<P>,
    board: ScoreBoard,
    ctx: RequestContext,
    matrix: FeatureMatrix,
  ): readonly number[]
}

/**
 * "How similar are these two candidates" — the one question MMR cannot answer alone.
 *
 * A separate port because similarity is domain-shaped (two tracks by the same artist;
 * two products in one category) while MMR is not. Keeping them apart is what lets one
 * MMR implementation serve music and e-commerce.
 */
export interface SimilarityProvider<P = unknown> {
  readonly id: string
  /** Rows, not ids. Result in [0..1]. */
  similarity(a: number, b: number, set: CandidateSet<P>, matrix: FeatureMatrix): number
}
