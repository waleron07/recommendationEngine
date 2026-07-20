import type { Blender, RequestContext, ScoreBoard } from '@recoengine/core'

export interface Bucket {
  readonly id: string
  /** Fraction of the output slots this bucket claims. Shares are normalised, need not sum to 1. */
  readonly share: number
  /**
   * Which candidates belong to this bucket, by row. A candidate is placed in the first
   * bucket whose predicate accepts it, so order the buckets from most to least specific.
   * The predicate reads the board and context — the blender has no feature matrix (§11),
   * so bucket membership is a function of score and request, not of raw features.
   */
  readonly accepts: (row: number, board: ScoreBoard, ctx: RequestContext) => boolean
}

export interface BucketBlenderOptions {
  readonly id?: string
  /** The slot distribution, e.g. 70% familiar / 20% adjacent / 10% novel (§15 Discovery). */
  readonly buckets: readonly Bucket[]
}

/**
 * Slot-quota exploration (§15 Discovery). A quota is *not* a score: a weight nudges order
 * but cannot promise "exactly one novelty in the top ten", because the tenth-best novel
 * item may still lose to the eleventh-best familiar one. This lays the ranked list into
 * buckets by predicate and then fills the output slot by slot against each bucket's share.
 *
 * Determinism comes from `ctx.rng` (seeded from user + day, §15), so the feed is stable
 * within a day and replayable in a test — `Math.random()` would give neither. Within a
 * bucket, candidates keep their ranking order; only the interleaving across buckets is
 * quota-driven.
 *
 * Underfill is honest: if a bucket runs dry before its share is met, its leftover slots go
 * to whatever ranks next across the other buckets, and a `quota_unfilled` warning lands in
 * diagnostics — a silent underfill would read as "there was nothing better", which is a
 * different and untrue claim.
 */
export function bucketBlender(options: BucketBlenderOptions): Blender {
  const id = options.id ?? 'bucket'
  const buckets = options.buckets
  if (buckets.length === 0) throw new Error('bucketBlender needs at least one bucket.')
  const totalShare = buckets.reduce((sum, b) => sum + b.share, 0)
  if (!(totalShare > 0)) throw new Error('bucketBlender shares must sum to a positive number.')

  return {
    id,
    blend(ranked: readonly number[], board: ScoreBoard, ctx: RequestContext): readonly number[] {
      if (ranked.length === 0) return ranked

      // Partition into buckets, each keeping ranking order. A row lands in the first
      // bucket that accepts it; a row no bucket claims keeps its place in a spillover pool
      // so nothing is dropped by exploration.
      const lanes: number[][] = buckets.map(() => [])
      const spillover: number[] = []
      for (const row of ranked) {
        let placed = false
        for (let b = 0; b < buckets.length; b++) {
          if ((buckets[b] as Bucket).accepts(row, board, ctx)) {
            ;(lanes[b] as number[]).push(row)
            placed = true
            break
          }
        }
        if (!placed) spillover.push(row)
      }

      // Target slot counts per bucket, proportional to share, summing to ranked.length.
      // Largest-remainder rounding, so the totals are exact rather than off by drift.
      const target = largestRemainder(
        buckets.map((b) => (b.share / totalShare) * ranked.length),
        ranked.length,
      )

      const cursor = new Array<number>(buckets.length).fill(0)
      const out: number[] = []
      const filled = new Array<number>(buckets.length).fill(0)
      let underfilled = false

      // One pass over slots. At each slot pick the bucket furthest below its target that
      // still has candidates; ties resolved by rng so a run does not always favour bucket 0.
      for (let slot = 0; slot < ranked.length; slot++) {
        let pick = -1
        let bestDeficit = Number.NEGATIVE_INFINITY
        for (let b = 0; b < buckets.length; b++) {
          if ((cursor[b] as number) >= (lanes[b] as number[]).length) continue
          const deficit = (target[b] as number) - (filled[b] as number)
          if (deficit > bestDeficit || (deficit === bestDeficit && pick !== -1 && ctx.rng.next() < 0.5)) {
            bestDeficit = deficit
            pick = b
          }
        }

        if (pick === -1) break // Every bucket empty; the rest is spillover.
        if (bestDeficit <= 0) underfilled = true // Chosen bucket was already at quota — someone else ran dry.

        const lane = lanes[pick] as number[]
        out.push(lane[cursor[pick] as number] as number)
        cursor[pick] = (cursor[pick] as number) + 1
        filled[pick] = (filled[pick] as number) + 1
      }

      // Anything a bucket could not supply, plus rows no bucket claimed, appended in
      // ranking order. The output is still a permutation of the input.
      const emitted = new Set(out)
      for (const row of ranked) if (!emitted.has(row)) out.push(row)

      if (underfilled && spillover.length !== ranked.length) {
        ctx.diagnostics.warn({
          stage: 'blending',
          port: id,
          code: 'quota_unfilled',
          message: `a bucket ran dry before its share was met; leftover slots went to the remaining candidates.`,
        })
      }

      return out
    },
  }
}

/**
 * Rounds fractional targets to integers that sum to `total` exactly: floor everyone, then
 * hand the remaining slots to the largest fractional parts. Without it, per-bucket rounding
 * drifts and the slot counts no longer add up to the list length.
 */
function largestRemainder(fractional: readonly number[], total: number): number[] {
  const floored = fractional.map((x) => Math.floor(x))
  let used = floored.reduce((sum, x) => sum + x, 0)
  const remainders = fractional
    .map((x, i) => ({ i, frac: x - Math.floor(x) }))
    .sort((a, b) => b.frac - a.frac)

  for (const { i } of remainders) {
    if (used >= total) break
    floored[i] = (floored[i] as number) + 1
    used++
  }
  return floored
}
