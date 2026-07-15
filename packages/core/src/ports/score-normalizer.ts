import type { StrategyId } from '../domain/ids.js'
import type { Reason } from '../domain/reason.js'

/**
 * Stage 6. Maps a raw column onto [0..1].
 *
 * Without this step weights are meaningless: to balance 4,200,000 plays against 0.87 you
 * would write `popularityWeight: 0.0000001`, and one popular item joining the catalogue
 * would silently rescale everyone's recommendations. The strategy must not know how it
 * is normalized, and the config must stay readable by a human — those two requirements
 * are the same requirement.
 */
export interface ScoreNormalizer {
  readonly id: string
  /** Same length, same order. Output in [0..1]. */
  normalize(raw: Float64Array): Float64Array
}

/** One normalized column: the combiner's input. */
export interface NormalizedColumn {
  readonly strategyId: StrategyId
  readonly normalized: Float64Array
  /** Kept alongside `normalized` for explanation: "played 143 times" needs the 143. */
  readonly raw: Float64Array
  readonly weight: number
  readonly reasons: ReadonlyMap<number, readonly Reason[]>
}
