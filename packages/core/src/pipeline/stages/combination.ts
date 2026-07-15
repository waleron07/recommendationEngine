import type { CandidateSet } from '../../domain/candidate.js'
import type { MutableScoreBoard, ScoreContribution } from '../../domain/score.js'
import { type ScoreBoard, ScoreBoardBuilder } from '../../domain/score.js'
import { RecoError } from '../../kernel/errors.js'
import type { RequestContext } from '../../ports/context.js'
import type { ScoreCombiner } from '../../ports/score-combiner.js'
import type { ScoreModifier } from '../../ports/score-modifier.js'
import type { NormalizedColumn } from '../../ports/score-normalizer.js'
import { type PolicyContext, rethrowIfAborted, warn } from '../policy.js'

/**
 * Stage 7. Columns in, one score per candidate out.
 *
 * Irreplaceable under both policies: there is no such thing as a partially combined
 * score, so a failing combiner fails the request. Same for the ranker.
 */
export function combine(
  columns: readonly NormalizedColumn[],
  combiner: ScoreCombiner,
  ctx: RequestContext,
  rows: number,
): ScoreBoard {
  if (columns.length === 0) {
    // No columns is not no candidates. Every combiner infers its row count from
    // `columns[0]`, because that is all the port gives it — so with nothing to combine it
    // would build a board of zero rows and the feed would come back empty, having
    // retrieved thousands. That is the cold start of §17.3 arriving at the wrong answer:
    // when every strategy stands down, §11.2 already says what to do — `weights === 0`, so
    // base is 0 for everyone — and an unranked feed is exactly what a new user should get.
    return new ScoreBoardBuilder(rows).build()
  }

  let board: ScoreBoard
  try {
    board = combiner.combine(columns, ctx)
  } catch (error) {
    rethrowIfAborted(error)
    throw new RecoError(
      'PORT_FAILED',
      `combination: combiner "${combiner.id}" failed. Nothing downstream can run without a score.`,
      { cause: error },
    )
  }

  if (board.rows !== rows) {
    // A board shorter than the candidate set truncates the feed in silence: the missing
    // rows are simply never ranked, and the diagnostics still report them as retrieved.
    throw new RecoError(
      'PORT_FAILED',
      `combination: combiner "${combiner.id}" returned a board of ${board.rows} rows for ${rows} candidates. ` +
        `Rows are positional — a short board drops the candidates below it without a word.`,
    )
  }

  return board
}

/**
 * Stage 8. Fatigue, novelty, boosts — "is it appropriate to show this now".
 *
 * The board arrives already folded, and modifiers need to add to it. Rather than reopen
 * the fold or make the combiner write into a builder, the board is *rebuilt*: every
 * contribution it recorded is poured into a fresh builder, the modifiers add theirs, and
 * the whole thing folds once at the end. Explainability is what makes this possible —
 * the board cannot hold a score without holding what produced it, so its contributions
 * are a complete description of itself.
 *
 * The cost, accepted knowingly: `ScoreBoardBuilder` folds by §11.2 and nothing else, so a
 * combiner with a fold of its own (a `product`) loses it on the way through. Weighted sum
 * survives trivially; RRF survives too (its ranks are additive contributions, and the
 * Σ weights denominator is identical for every row, so the order is untouched). The day a
 * product combiner actually exists, this is where it will hurt, and it will be visible
 * rather than silent.
 */
export function modify(
  board: ScoreBoard,
  modifiers: readonly ScoreModifier[],
  set: CandidateSet,
  ctx: RequestContext,
  policy: PolicyContext,
): ScoreBoard {
  if (modifiers.length === 0) return board

  const builder = new ScoreBoardBuilder(board.rows)
  for (let row = 0; row < board.rows; row++) {
    for (const contribution of board.contributions(row)) builder.add(row, contribution)
  }

  for (const modifier of modifiers) {
    ctx.signal.throwIfAborted()

    // Staged, not written straight through. A modifier that fatigued 50 of 5000
    // candidates and then threw would otherwise leave half the feed damped and half not —
    // and under `degrade` it would do so silently, which is the exact failure this design
    // is against. All of a modifier's contributions land, or none of them do.
    const staged = new StagedContributions(board.rows)
    try {
      modifier.apply(staged, set, ctx)
    } catch (error) {
      rethrowIfAborted(error)
      if (policy.errorPolicy === 'strict') {
        throw new RecoError('PORT_FAILED', `modifiers: modifier "${modifier.id}" failed`, { cause: error })
      }
      // A modifier that never spoke is a modifier of 1.0 — neutral by construction, since
      // its contribution is simply absent from the fold. Nothing to substitute.
      warn(policy, {
        stage: 'modifiers',
        port: modifier.id,
        code: 'degraded',
        message:
          `modifier "${modifier.id}" threw partway; every contribution it made was discarded, ` +
          `so scores stand unmodified by it rather than half-modified.`,
        cause: error,
      })
      continue
    }
    staged.commitTo(builder)
  }

  return builder.build()
}

/** A modifier's write view, held back until the modifier finishes without throwing. */
class StagedContributions implements MutableScoreBoard {
  readonly rows: number
  private readonly pending: { row: number; contribution: ScoreContribution }[] = []

  constructor(rows: number) {
    this.rows = rows
  }

  /**
   * Validates on the way in rather than on the way out.
   *
   * `ScoreBoardBuilder.add` rejects a non-finite contribution and an out-of-range row, and
   * deferring those checks to `commitTo` would defeat the staging twice over: the throw
   * would land outside the modifier's try (so the policy could not name the culprit), and
   * a bad contribution halfway through the replay would leave the earlier ones committed —
   * the partial write this class exists to prevent.
   */
  add(row: number, contribution: ScoreContribution): void {
    if (!Number.isInteger(row) || row < 0 || row >= this.rows) {
      throw new RecoError('PORT_FAILED', `Row ${row} is out of range for a board with ${this.rows} rows.`)
    }
    if (!Number.isFinite(contribution.contribution)) {
      throw new RecoError(
        'PORT_FAILED',
        `Modifier "${contribution.strategyId}" produced a non-finite contribution for row ${row}.`,
      )
    }
    this.pending.push({ row, contribution })
  }

  commitTo(builder: ScoreBoardBuilder): void {
    for (const { row, contribution } of this.pending) builder.add(row, contribution)
  }
}
