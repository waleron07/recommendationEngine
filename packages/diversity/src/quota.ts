import type { CandidateSet, Diversifier, FeatureMatrix, RequestContext, ScoreBoard } from '@recoengine/core'
import { type FeatureRef, toKey } from './internal.js'

export interface AttributeQuotaOptions {
  readonly id?: string
  /**
   * A categorical feature — its column holds a hash of the group (artist, brand, genre),
   * so equal values mean the same group. The extractor that owns the domain decides what
   * the group is; this diversifier only counts equalities.
   */
  readonly feature: FeatureRef
  /** At most this many candidates per group in the output. */
  readonly max: number
}

/**
 * "At most 3 tracks by one artist." Walks the ranked list in order and skips any candidate
 * whose group already has `max` picks, keeping everything else where it stood (§14).
 *
 * Grouping is equality on a **categorical** column — the extractor hashed `artistId` into
 * a number, so the diversifier needs no domain knowledge, only `===`. Skipped candidates
 * are dropped from the output, not reordered: a quota is a ceiling, and the ranker already
 * decided who deserves the slots under it. `max ≤ 0` would empty the feed, so it is refused
 * at construction rather than discovered at request time.
 */
export function attributeQuotaDiversifier<P = unknown>(options: AttributeQuotaOptions): Diversifier<P> {
  const id = options.id ?? 'attribute-quota'
  const key = toKey(options.feature)
  const max = options.max
  if (!Number.isFinite(max) || max < 1) {
    throw new Error(`attributeQuota "max" must be at least 1, got ${max}; a quota of 0 would empty the feed.`)
  }

  return {
    id,
    diversify(
      ranked: readonly number[],
      _set: CandidateSet<P>,
      _board: ScoreBoard,
      ctx: RequestContext,
      matrix: FeatureMatrix,
    ): readonly number[] {
      const counts = new Map<number, number>()
      const kept: number[] = []

      for (let i = 0; i < ranked.length; i++) {
        if ((i & 1023) === 0) ctx.signal.throwIfAborted()
        const row = ranked[i] as number
        const group = matrix.get(key, row)
        const seen = counts.get(group) ?? 0
        if (seen >= max) continue
        counts.set(group, seen + 1)
        kept.push(row)
      }

      return kept
    },
  }
}
