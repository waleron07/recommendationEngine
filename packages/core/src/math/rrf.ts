/**
 * Reciprocal Rank Fusion: combine rankings by position, ignoring the scores entirely.
 *
 * The answer to a problem normalization only half solves. A cosine of 0.83 and a BM25 of
 * 14.2 both normalize into [0..1], and the numbers are *still* not comparable — min-max
 * only tells you where each sat within its own column, not what either is worth against
 * the other. RRF sidesteps the question: it reads only "you were third", which means the
 * same thing in every column there is.
 *
 * The cost is stated plainly: the margins vanish. A candidate that won its column by a
 * mile and one that scraped in first score identically. When the scores within a column
 * are meaningful, a weighted sum keeps information RRF throws away — so this is for
 * fusing rankers you cannot calibrate against each other, not a better default.
 */

/**
 * The standard constant from the original paper (Cormack, Clarke & Buettcher, 2009).
 *
 * It sets how sharply the top of a list beats the rest: 1/(60+1) against 1/(60+2) is a
 * 1.6% edge for first over second, where k=1 would make it 33%. Sixty is deliberately
 * flat — it says "being in the top ten of several lists beats topping one", which is the
 * whole reason to fuse rankings rather than trust one.
 */
export const RRF_K = 60

/**
 * Scores by position: `1 / (k + rank)`, rank being 1-based.
 *
 * Ties share a rank rather than being split by row order — otherwise the fused result
 * would encode retrieval order as preference, exactly as it would in `rank` normalization.
 *
 * @param scores raw column; higher is better
 * @param k      flattening constant; larger favours consensus over any single first place
 */
export function reciprocalRankScores(scores: Float64Array, k: number = RRF_K): Float64Array {
  if (!Number.isFinite(k) || k <= 0) {
    throw new RangeError(`RRF k must be a positive finite number, got ${k}.`)
  }

  const out = new Float64Array(scores.length)
  if (scores.length === 0) return out

  const order = Array.from({ length: scores.length }, (_, i) => i).sort(
    (a, b) => (scores[b] as number) - (scores[a] as number),
  )

  let position = 0
  while (position < order.length) {
    // Every row with this score shares the position the block starts at.
    let end = position
    while (end + 1 < order.length && scores[order[end + 1] as number] === scores[order[position] as number]) {
      end += 1
    }

    const shared = 1 / (k + position + 1)
    for (let i = position; i <= end; i++) out[order[i] as number] = shared
    position = end + 1
  }

  return out
}

/**
 * Rescales RRF output onto [0..1], which is what a normalizer must return.
 *
 * The raw values live in a narrow band near 1/k — with k=60 they run from 0.0164 down to
 * almost nothing — and while that band ranks correctly, it would contribute almost nothing
 * to a weighted sum against a column that uses the whole interval. Dividing by the best
 * possible value maps first place to 1 and keeps every ratio intact.
 */
export function reciprocalRankNormalized(scores: Float64Array, k: number = RRF_K): Float64Array {
  const raw = reciprocalRankScores(scores, k)
  const best = 1 / (k + 1)
  const out = new Float64Array(raw.length)
  for (let i = 0; i < raw.length; i++) out[i] = (raw[i] as number) / best
  return out
}
