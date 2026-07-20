import {
  type FeatureKey,
  featureKey,
  type Reason,
  type ScoreNormalizer,
  type StrategyId,
  strategyId,
} from '@recoengine/core'

/**
 * A feature is named by its `FeatureKey`, but callers configure strategies with plain
 * strings (`{ feature: 'affinity_artist' }`). `toKey` brands one without a cast at every
 * call site, and accepts an already-branded key unchanged.
 */
export type FeatureRef = FeatureKey | string

export const toKey = (ref: FeatureRef): FeatureKey => featureKey(ref as string)
export const toId = (id: string): StrategyId => strategyId(id)

/** What every strategy factory accepts on top of its own feature options. */
export interface StrategyOptions {
  /**
   * Overrides the strategy id. The id is also the key its weight is configured under, so
   * two strategies of the same kind (two `affinityStrategy`s) must be given distinct ids.
   */
  readonly id?: string
  /**
   * Overrides the strategy's default normalizer. A strategy ships the normalizer that
   * suits its own scale (§12); override only when you know the extractor's output differs
   * from what the strategy assumes.
   */
  readonly normalizer?: ScoreNormalizer
}

/** [0..1], NaN → 0. Guards against an extractor that let a value drift out of range. */
export const clamp01 = (x: number): number => (x > 1 ? 1 : x > 0 ? x : 0)

/**
 * Percentile of every row in [0..1]: the fraction of other rows it ranks strictly above.
 *
 * Min → 0, max → 1, ties share a value. This is what makes heavy-tailed columns — play
 * counts, co-occurrence — comparable without letting one viral outlier flatten the rest,
 * and it doubles as the `strength` a reason reports ("popular: 92nd percentile").
 *
 * O(n log n): one sort. A strategy that calls this and then also declares `rank` as its
 * normalizer sorts twice; that is why the popularity strategy blends percentiles itself
 * and normalizes with `identity` instead.
 */
export function percentiles(raw: Float64Array): Float64Array {
  const n = raw.length
  const out = new Float64Array(n)
  if (n <= 1) {
    // One row is neither popular nor unpopular relative to a field of one. 0.5 keeps a
    // single-candidate request from claiming a spurious 100th-percentile reason.
    if (n === 1) out[0] = 0.5
    return out
  }

  const order = Array.from({ length: n }, (_, i) => i).sort((a, b) => (raw[a] as number) - (raw[b] as number))

  let i = 0
  while (i < n) {
    // Walk the tie group [i, j): every equal value gets the percentile of the group's
    // lowest position, so equal inputs never receive different strengths.
    let j = i + 1
    while (j < n && (raw[order[j] as number] as number) === (raw[order[i] as number] as number)) j++
    const percentile = i / (n - 1)
    for (let k = i; k < j; k++) out[order[k] as number] = percentile
    i = j
  }
  return out
}

/**
 * Builds the sparse row → reasons map a `ScoreColumn` carries.
 *
 * Sparse on purpose: most rows have nothing worth saying, and a reason on every candidate
 * would be noise the explainer then has to filter back out.
 */
export function sparseReasons(
  fill: (add: (row: number, reason: Reason) => void) => void,
): ReadonlyMap<number, readonly Reason[]> {
  const map = new Map<number, Reason[]>()
  fill((row, reason) => {
    const bucket = map.get(row)
    if (bucket === undefined) map.set(row, [reason])
    else bucket.push(reason)
  })
  return map
}
