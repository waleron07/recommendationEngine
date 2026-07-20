import type { CandidateSet } from '../../domain/candidate.js'
import type { FeatureMatrix } from '../../domain/matrix.js'
import type { ScoreBoard } from '../../domain/score.js'
import { RecoError } from '../../kernel/errors.js'
import type { Blender } from '../../ports/blender.js'
import type { RequestContext } from '../../ports/context.js'
import type { Diversifier } from '../../ports/diversifier.js'
import type { Ranker } from '../../ports/ranker.js'
import { type PolicyContext, rethrowIfAborted, warn } from '../policy.js'

/**
 * Stage 9. Score into order.
 *
 * Irreplaceable, like the combiner: there is no degraded ranking, only a wrong one. Both
 * policies fail the request.
 */
export function rank(
  ranker: Ranker,
  board: ScoreBoard,
  set: CandidateSet,
  ctx: RequestContext,
): readonly number[] {
  let ranked: readonly number[]
  try {
    ranked = ranker.rank(board, set, ctx)
  } catch (error) {
    rethrowIfAborted(error)
    throw new RecoError('PORT_FAILED', `ranking: ranker "${ranker.id}" failed. There is no degraded order.`, {
      cause: error,
    })
  }

  assertRows('ranking', ranker.id, ranked, board.rows)
  return ranked
}

/**
 * Stage 10. Reorders so the top is not eight songs by one artist.
 *
 * Skippable, and that is the difference from ranking: without it the feed is correct but
 * samey, which is a worse feed rather than a wrong one. So `degrade` drops it and says so.
 */
export function diversify<P>(
  diversifiers: readonly Diversifier<P>[],
  ranked: readonly number[],
  set: CandidateSet<P>,
  board: ScoreBoard,
  ctx: RequestContext,
  matrix: FeatureMatrix,
  policy: PolicyContext,
): readonly number[] {
  let current = ranked

  for (const diversifier of diversifiers) {
    ctx.signal.throwIfAborted()
    const before = current

    try {
      current = diversifier.diversify(current, set, board, ctx, matrix)
      assertRows('diversification', diversifier.id, current, board.rows)
      assertSubsetOf(diversifier.id, current, before)
    } catch (error) {
      rethrowIfAborted(error)
      if (policy.errorPolicy === 'strict') {
        throw new RecoError('PORT_FAILED', `diversification: diversifier "${diversifier.id}" failed`, {
          cause: error,
        })
      }
      warn(policy, {
        stage: 'diversification',
        port: diversifier.id,
        code: 'degraded',
        message: `diversifier "${diversifier.id}" threw; the plain ranking stands.`,
        cause: error,
      })
      current = before
    }
  }

  return current
}

/**
 * Stage 11. Exploration mixed into an already-diverse list.
 *
 * After diversification, or the two would compete for the same slots and whichever ran
 * last would win in silence.
 */
export function blend(
  blender: Blender | undefined,
  ranked: readonly number[],
  board: ScoreBoard,
  ctx: RequestContext,
  policy: PolicyContext,
): readonly number[] {
  if (blender === undefined) {
    if (ctx.config.exploration.enabled) {
      // Configured to explore with nothing that explores. Not an error — the config is
      // valid and the feed is fine — but silence here would be a setting that does nothing.
      warn(policy, {
        stage: 'blending',
        port: 'engine',
        code: 'quota_unfilled',
        message: `exploration.enabled is true but no Blender is registered, so nothing explores.`,
      })
    }
    return ranked
  }

  try {
    const blended = blender.blend(ranked, board, ctx)
    assertRows('blending', blender.id, blended, board.rows)
    assertSubsetOf(blender.id, blended, ranked)
    return blended
  } catch (error) {
    rethrowIfAborted(error)
    if (policy.errorPolicy === 'strict') {
      throw new RecoError('PORT_FAILED', `blending: blender "${blender.id}" failed`, { cause: error })
    }
    warn(policy, {
      stage: 'blending',
      port: blender.id,
      code: 'degraded',
      message: `blender "${blender.id}" threw; the list stands unexplored.`,
      cause: error,
    })
    return ranked
  }
}

/**
 * Stage 12. `limit` and `offset`, and nothing else.
 *
 * The only stage with no port. Paging is not a policy anyone should be able to replace:
 * a "creative" truncation is just a bug with an extension point.
 */
export function truncate(ranked: readonly number[], ctx: RequestContext): readonly number[] {
  return ranked.slice(ctx.offset, ctx.offset + ctx.limit)
}

/**
 * Rows must exist and appear once.
 *
 * A duplicated row is the same item twice in one feed — the kind of bug a user reports
 * and nobody can reproduce. A row out of range reads somebody else's score, or crashes at
 * assembly, depending on luck. Both are cheap to check and expensive to find later.
 */
function assertRows(stage: string, portId: string, rows: readonly number[], total: number): void {
  const seen = new Set<number>()
  for (const row of rows) {
    if (!Number.isInteger(row) || row < 0 || row >= total) {
      throw new RecoError(
        'PORT_FAILED',
        `${stage}: "${portId}" returned row ${row}, which is not a candidate (0..${total - 1}).`,
      )
    }
    if (seen.has(row)) {
      throw new RecoError(
        'PORT_FAILED',
        `${stage}: "${portId}" returned row ${row} twice, which would show one item twice in the feed.`,
      )
    }
    seen.add(row)
  }
}

/** A reorderer may drop rows and must not invent them. */
function assertSubsetOf(portId: string, output: readonly number[], input: readonly number[]): void {
  const allowed = new Set(input)
  for (const row of output) {
    if (!allowed.has(row)) {
      throw new RecoError(
        'PORT_FAILED',
        `"${portId}" returned row ${row}, which was not in the list it was given. A reorderer may drop ` +
          `candidates, never resurrect ones an earlier stage removed — a filter's verdict is final.`,
      )
    }
  }
}
