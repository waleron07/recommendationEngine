import type { CandidateSet } from '../../domain/candidate.js'
import type { Explanation, ScoreTrace } from '../../domain/explanation.js'
import type { FeatureMatrix } from '../../domain/matrix.js'
import type { Recommendation } from '../../domain/recommendation.js'
import type { ScoreBoard, ScoreContribution } from '../../domain/score.js'
import { RecoError } from '../../kernel/errors.js'
import type { RequestContext } from '../../ports/context.js'
import type { Explainer } from '../../ports/explainer.js'
import { type PolicyContext, rethrowIfAborted, warn } from '../policy.js'

/**
 * Internal [0..1] → the 0..100 people actually read. One place, so it cannot drift.
 *
 * Rounded, as §11.2 requires: the presentation scale is a number a human reads and a
 * threshold a rule compares against (`score > 80 → push`), and `96.55172413793103` is
 * neither. Rounding lives here rather than at each call site so `score` and `baseScore`
 * are rounded the same way and cannot disagree.
 */
export const toPresentation = (score: number): number => Math.round(score * 100)

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
  matrix: FeatureMatrix,
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
      explanation: explanationFor(row, explainer, board, set, matrix, ctx, policy),
    })
  }

  return out
}

/** The engine's own `explain(itemId)` reuses this: one item's explanation, trace and all. */
export function explanationForRow<P>(
  row: number,
  explainer: Explainer<P> | undefined,
  board: ScoreBoard,
  set: CandidateSet<P>,
  matrix: FeatureMatrix,
  ctx: RequestContext,
  policy: PolicyContext,
): Explanation {
  return explanationFor(row, explainer, board, set, matrix, ctx, policy)
}

function explanationFor<P>(
  row: number,
  explainer: Explainer<P> | undefined,
  board: ScoreBoard,
  set: CandidateSet<P>,
  matrix: FeatureMatrix,
  ctx: RequestContext,
  policy: PolicyContext,
): Explanation {
  // `explain: 'none'` is not a reason to skip the contributions: they are already in
  // hand, they cost nothing to hand over, and they are what makes Σ contributions = score
  // checkable by the caller. What it skips is the explainer's policy work.
  const base =
    explainer === undefined || ctx.explain === 'none'
      ? bare(row, board)
      : runExplainer(row, explainer, board, set, ctx, policy)

  // The full trace is the pipeline's to attach, not the explainer's: it needs the feature
  // matrix and schema, which the Explainer port deliberately does not receive. Attaching
  // it here also means every explainer — default or custom — gets `'full'` for free.
  return ctx.explain === 'full' ? { ...base, trace: traceFor(row, board, matrix) } : base
}

function runExplainer<P>(
  row: number,
  explainer: Explainer<P>,
  board: ScoreBoard,
  set: CandidateSet<P>,
  ctx: RequestContext,
  policy: PolicyContext,
): Explanation {
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

/**
 * The stage-by-stage record of how one score was built (§16, `explain: 'full'`).
 *
 * Reconstructed from the board's own contributions rather than computed anew: `base` is
 * the weighted-sum result, then every multiplicative and boost contribution is one line
 * showing what it did, ending at `final`. `features` is every scalar the matrix holds for
 * this row. Nothing here is a new source of truth — it is the fold of §11.2, itemised.
 */
function traceFor(row: number, board: ScoreBoard, matrix: FeatureMatrix): ScoreTrace {
  const features: Record<string, number> = {}
  for (const descriptor of matrix.schema.descriptors()) {
    if (matrix.schema.arityOf(descriptor.key) === 1)
      features[descriptor.key] = matrix.get(descriptor.key, row)
  }

  const stages: { stage: string; value: number; note?: string }[] = [
    { stage: 'base', value: toPresentation(board.base(row)), note: 'Σ(weight×normalized) / Σ weight' },
  ]
  for (const c of board.contributions(row) as readonly ScoreContribution[]) {
    if (c.kind === 'additive') continue // Already folded into base; listing it again would double-count.
    stages.push({ stage: c.strategyId, value: c.contribution, note: c.kind })
  }
  stages.push({
    stage: 'final',
    value: toPresentation(board.final(row)),
    note: 'clamp(base × Π mult + Σ boost)',
  })

  return { schemaVersion: matrix.schema.version, stages, features }
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
