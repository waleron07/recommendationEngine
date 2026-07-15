import type { CandidateSet } from '../../domain/candidate.js'
import type { Explanation } from '../../domain/explanation.js'
import type { Recommendation } from '../../domain/recommendation.js'
import type { ScoreBoard } from '../../domain/score.js'
import { RecoError } from '../../kernel/errors.js'
import type { RequestContext } from '../../ports/context.js'
import type { Explainer } from '../../ports/explainer.js'
import { type PolicyContext, rethrowIfAborted, warn } from '../policy.js'

/** Internal [0..1] → the 0..100 people actually read. One place, so it cannot drift. */
export const toPresentation = (score: number): number => score * 100

/**
 * Stage 13. The trail the board already carries, turned into an explanation.
 *
 * Nothing is computed here — the board recorded every contribution as the score was
 * built, because it has no way to hold one without the other. What the explainer owns is
 * policy: which reasons clear the noise floor, how many survive, in what order.
 *
 * A failing explainer costs the explanation, never the score. That is the one degradation
 * in the matrix that is obviously right: the ranking is correct, and refusing to serve it
 * because the "why" is missing would be a strange kind of purity.
 */
export function explain<P>(
  rows: readonly number[],
  explainer: Explainer<P> | undefined,
  board: ScoreBoard,
  set: CandidateSet<P>,
  ctx: RequestContext,
  policy: PolicyContext,
): readonly Recommendation<P>[] {
  const out: Recommendation<P>[] = []

  for (let position = 0; position < rows.length; position++) {
    const row = rows[position] as number
    out.push({
      item: set.at(row).item,
      // Position in the ranking, not in the page: 1-based, and offset by where the page
      // starts. Without the offset every page came back ranked 1..N, so a caller stitching
      // two pages together held five items all claiming to be first.
      rank: ctx.offset + position + 1,
      score: toPresentation(board.final(row)),
      explanation: explanationFor(row, explainer, board, set, ctx, policy),
    })
  }

  return out
}

function explanationFor<P>(
  row: number,
  explainer: Explainer<P> | undefined,
  board: ScoreBoard,
  set: CandidateSet<P>,
  ctx: RequestContext,
  policy: PolicyContext,
): Explanation {
  // `explain: 'none'` is not a reason to skip the contributions: they are already in
  // hand, they cost nothing to hand over, and they are what makes Σ contributions = score
  // checkable by the caller. What it skips is the explainer's policy work.
  if (explainer === undefined || ctx.explain === 'none') return bare(row, board)

  try {
    return explainer.explain(row, board, set, ctx)
  } catch (error) {
    rethrowIfAborted(error)
    if (policy.errorPolicy === 'strict') {
      throw new RecoError('PORT_FAILED', `explanation: explainer "${explainer.id}" failed for row ${row}`, {
        cause: error,
      })
    }
    warn(policy, {
      stage: 'explanation',
      port: explainer.id,
      code: 'degraded',
      message: `explainer "${explainer.id}" threw on row ${row}; the score stands, the reasons do not.`,
      cause: error,
    })
    return bare(row, board)
  }
}

/** Everything the board knows, with no policy applied: no reasons selected, no trace. */
function bare(row: number, board: ScoreBoard): Explanation {
  return {
    score: toPresentation(board.final(row)),
    baseScore: toPresentation(board.base(row)),
    contributions: board.contributions(row),
    reasons: [],
  }
}
