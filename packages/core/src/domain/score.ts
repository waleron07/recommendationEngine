import { RecoError } from '../kernel/errors.js'
import type { StrategyId } from './ids.js'
import type { Reason } from './reason.js'

/**
 * How a contribution folds into the score.
 *
 * `multiplicative` is what fatigue and novelty use, and the distinction is not
 * cosmetic. Subtracting 0.3 from a track scoring 0.98 leaves it on top regardless;
 * multiplying by 0.1 removes it while leaving the order of everything else intact.
 * "How well does this fit" and "is it appropriate to show now" are different questions
 * and must not be added together.
 */
export type ContributionKind = 'additive' | 'multiplicative' | 'boost' | 'veto'

/** One strategy's raw opinion about every candidate, before normalization. */
export interface ScoreColumn {
  readonly strategyId: StrategyId
  /** Any scale: 4_200_000 plays or 0.87. Normalization comes later, on purpose. */
  readonly raw: Float64Array
  /** Row → why. Sparse: most rows have nothing worth saying. */
  readonly reasons: ReadonlyMap<number, readonly Reason[]>
}

/**
 * What one strategy did to one candidate's score.
 *
 * Keeps `raw`, `normalized`, `weight` and `contribution` all four. That is redundant as
 * data and necessary as explanation: without `raw` you cannot say "played 143 times",
 * and without `contribution` you cannot say "this is what put it at 95".
 */
export interface ScoreContribution {
  readonly strategyId: StrategyId
  readonly kind: ContributionKind
  readonly raw: number
  readonly normalized: number
  readonly weight: number
  readonly contribution: number
  readonly reasons: readonly Reason[]
}

/**
 * Scores for the whole candidate set, with the trail that produced them.
 *
 * Explainability is structural here: there is no way to record a score without
 * recording what made it, because the board only accepts contributions.
 */
export interface ScoreBoard {
  readonly rows: number
  /** Score after combination, before modifiers. */
  base(row: number): number
  /** Score after modifiers. What ranking sorts on. */
  final(row: number): number
  contributions(row: number): readonly ScoreContribution[]
}

/**
 * Accumulates contributions, then folds them per ARCHITECTURE.md §11.2:
 *
 * ```
 * base  = Σ(weight × normalized) / Σ(weight)
 * final = clamp(base × Π multiplicative + Σ boost, 0, 1)
 * veto  ⇒ final = 0
 * ```
 *
 * Dividing by `Σ weight` is what keeps weights honest. Without it, adding a ninth
 * strategy silently rescales every score, and a tuned threshold like `score > 80 → push`
 * quietly starts meaning something else. It also makes a skipped strategy free:
 * `applicable() === false` simply leaves its weight out of both sums, and the rest
 * reweight themselves.
 */
export class ScoreBoardBuilder {
  readonly rows: number
  private readonly perRow: ScoreContribution[][]

  constructor(rows: number) {
    if (!Number.isInteger(rows) || rows < 0) {
      throw new RecoError('INVALID_CONFIG', `ScoreBoard needs a non-negative integer row count, got ${rows}.`)
    }
    this.rows = rows
    this.perRow = Array.from({ length: rows }, () => [])
  }

  add(row: number, contribution: ScoreContribution): this {
    const bucket = this.perRow[row]
    if (bucket === undefined) {
      throw new RecoError('INVALID_CONFIG', `Row ${row} is out of range for a board with ${this.rows} rows.`)
    }
    if (!Number.isFinite(contribution.contribution)) {
      // A NaN here spreads to the sum, then to the whole ranking, and shows up as
      // "recommendations are randomly ordered" three weeks later. Refuse it at the door.
      throw new RecoError(
        'PORT_FAILED',
        `Strategy "${contribution.strategyId}" produced a non-finite contribution for row ${row}.`,
      )
    }
    bucket.push(contribution)
    return this
  }

  build(): ScoreBoard {
    const bases = new Float64Array(this.rows)
    const finals = new Float64Array(this.rows)
    const perRow = this.perRow

    for (let row = 0; row < this.rows; row++) {
      const contributions = perRow[row] as ScoreContribution[]

      let weighted = 0
      let weights = 0
      let multiplier = 1
      let boost = 0
      let vetoed = false

      for (const c of contributions) {
        switch (c.kind) {
          case 'additive':
            weighted += c.contribution
            weights += c.weight
            break
          case 'multiplicative':
            multiplier *= c.contribution
            break
          case 'boost':
            boost += c.contribution
            break
          case 'veto':
            vetoed = true
            break
        }
      }

      const base = weights > 0 ? weighted / weights : 0
      bases[row] = base
      finals[row] = vetoed ? 0 : Math.min(1, Math.max(0, base * multiplier + boost))
    }

    const rows = this.rows
    const assertRow = (row: number): void => {
      if (!Number.isInteger(row) || row < 0 || row >= rows) {
        throw new RecoError('INVALID_CONFIG', `Row ${row} is out of range for a board with ${rows} rows.`)
      }
    }

    return {
      rows,
      base: (row) => {
        assertRow(row)
        return bases[row] as number
      },
      final: (row) => {
        assertRow(row)
        return finals[row] as number
      },
      contributions: (row) => {
        assertRow(row)
        return perRow[row] as ScoreContribution[]
      },
    }
  }
}

/**
 * Turns a strategy's raw column into a weighted contribution.
 *
 * `contribution = weight × normalized`, deliberately *not* divided by `Σ weight` —
 * the board does that when it folds, because only the board knows which strategies
 * actually ran.
 */
export function contributionOf(
  strategyId: StrategyId,
  kind: ContributionKind,
  raw: number,
  normalized: number,
  weight: number,
  reasons: readonly Reason[] = [],
): ScoreContribution {
  return {
    strategyId,
    kind,
    raw,
    normalized,
    weight,
    contribution: kind === 'additive' ? weight * normalized : normalized,
    reasons,
  }
}
