import type { ScoreNormalizer } from '../ports/score-normalizer.js'

/**
 * The normalizers of §12. Each maps a column onto [0..1], because that is what makes a
 * weight a preference rather than a unit conversion.
 *
 * They differ in what they keep. Min-max keeps distances and trusts the extremes; z-score
 * keeps distances and is nearly linear about the mean; rank keeps only the order and is
 * the only one immune to an outlier. That is the whole choice, and it belongs to whoever
 * knows the shape of the column — the strategy, or the operator, never the engine.
 *
 * **The [0..1] guarantee holds for finite input.** Feed a column an Infinity or a NaN and
 * these produce NaN rather than a number in range; stage 6 then refuses the column and
 * fails the request. That is deliberate — a strategy that emitted a NaN has a bug, and
 * inventing a plausible number for it would hide the bug rather than the NaN. The one
 * place where a wrong answer could have passed stage 6 silently is guarded in `zscore`.
 */

/**
 * Linear onto [0..1] between the smallest and the largest value.
 *
 * The default because it is the one whose behaviour you can predict from the data. Its
 * weakness is equally predictable: one outlier at 4,200,000 compresses everything else
 * into a hair above zero, so a single viral track can flatten a whole column's influence.
 * When that is the shape of your data, `zscore` or `rank` is the honest answer.
 *
 * A flat column returns zeros. Every answer there is a lie of some kind — there is no
 * spread to speak of — and zero at least contributes nothing to the sum, where 0.5 would
 * hand the column real influence on the strength of no information at all.
 */
export const minmax: ScoreNormalizer = {
  id: 'minmax',
  normalize: (raw) => {
    const out = new Float64Array(raw.length)
    if (raw.length === 0) return out

    let min = Number.POSITIVE_INFINITY
    let max = Number.NEGATIVE_INFINITY
    for (const value of raw) {
      if (value < min) min = value
      if (value > max) max = value
    }

    const span = max - min
    if (span === 0) return out
    for (let i = 0; i < raw.length; i++) out[i] = ((raw[i] as number) - min) / span
    return out
  },
}

/**
 * Standardize, then squash through a logistic.
 *
 * The squash is not decoration: a raw z-score is unbounded, and stage 6 refuses anything
 * outside [0..1] — rightly, since the weights assume it. The logistic maps the whole real
 * line into the interval and leaves the middle nearly linear, so differences within a
 * sigma or two of the mean survive as real differences.
 *
 * **It is not a defence against outliers, and it is worth being exact about why.** The
 * tempting story — "min-max is ruined by one extreme value, so standardize instead" — is
 * false: the outlier is *in the sample*, so it inflates σ, and everything else collapses
 * toward the mean. On `[1, 2, 3, 4_200_000]` it separates the first three by about 2.5e-7,
 * which is worse than min-max manages. There is a test that says so.
 *
 * What it is actually for: a roughly symmetric column where you want the middle spread out
 * and the tails compressed, rather than the linear stretch min-max gives. For genuine
 * immunity to outliers the answer is `rank`, which throws the magnitudes away — and that
 * is the real trade, not this one.
 *
 * A column with no variance returns 0.5 — everything is equally average, which is the one
 * case where the neutral answer is also the true one.
 */
export const zscore: ScoreNormalizer = {
  id: 'zscore',
  normalize: (raw) => {
    const out = new Float64Array(raw.length)
    if (raw.length === 0) return out

    let sum = 0
    for (const value of raw) sum += value
    const mean = sum / raw.length

    let variance = 0
    for (const value of raw) variance += (value - mean) ** 2
    variance /= raw.length

    if (variance === 0) return out.fill(0.5)

    if (!Number.isFinite(variance)) {
      // The one failure in this file that would otherwise be *silent*, which is why it is
      // the one that throws. Past ~1e154 the squared deviations overflow, `variance` is
      // Infinity, every z becomes ±0 and every candidate scores 0.5 — a column with real
      // spread flattened into "everything is average". Stage 6 would wave it through
      // (0.5 is finite and within [0..1]) and the ranking would quietly lose a strategy.
      throw new RangeError(
        `zscore overflowed: this column's spread exceeds what f64 can square (values near ` +
          `${Math.max(Math.abs(mean), 1)}). Use rank, which ignores magnitudes, or scale the column.`,
      )
    }

    const deviation = Math.sqrt(variance)
    for (let i = 0; i < raw.length; i++) out[i] = logistic(((raw[i] as number) - mean) / deviation)
    return out
  },
}

/**
 * Position in the order, not distance in the value.
 *
 * Throws the magnitudes away on purpose, and that is the point: it is immune to every
 * shape of column. Plays of 1, 2 and 4,200,000 become 0, 0.5 and 1 — the viral track is
 * still first and no longer erases the difference between the other two. The cost is
 * stated plainly: after this, "twice as popular" is not a thing the score can say.
 *
 * Ties share the average of the positions they span, so equal inputs get equal outputs —
 * without it, two identical values would be ordered by row index and the column would
 * quietly encode retrieval order as preference.
 */
export const rank: ScoreNormalizer = {
  id: 'rank',
  normalize: (raw) => {
    const out = new Float64Array(raw.length)
    if (raw.length <= 1) return raw.length === 1 ? out.fill(0.5) : out

    const order = Array.from({ length: raw.length }, (_, i) => i).sort(
      (a, b) => (raw[a] as number) - (raw[b] as number),
    )

    const last = raw.length - 1
    let i = 0
    while (i < order.length) {
      // Everything equal to this value shares one position: the average of the block.
      let j = i
      while (j + 1 < order.length && raw[order[j + 1] as number] === raw[order[i] as number]) j += 1

      const shared = (i + j) / 2 / last
      for (let k = i; k <= j; k++) out[order[k] as number] = shared
      i = j + 1
    }

    return out
  },
}

/**
 * Logistic of the raw value, for columns already centred on zero.
 *
 * For a strategy whose output is a signed affinity (-2 dislikes, +2 likes) rather than a
 * magnitude. Unlike the others it is *absolute*: it does not look at the rest of the
 * column, so the same raw value always maps to the same score. That makes it the only one
 * whose output is comparable across requests — which is what a fixed threshold needs.
 *
 * @param scale divides the input first. Larger is gentler: `sigmoidScaled(10)` keeps
 *              ±10 inside the near-linear middle instead of saturating at ±5.
 */
export function sigmoidScaled(scale = 1): ScoreNormalizer {
  if (!Number.isFinite(scale) || scale <= 0) {
    throw new RangeError(`sigmoid scale must be a positive finite number, got ${scale}.`)
  }
  return {
    id: scale === 1 ? 'sigmoid' : `sigmoid:${scale}`,
    normalize: (raw) => {
      const out = new Float64Array(raw.length)
      for (let i = 0; i < raw.length; i++) out[i] = logistic((raw[i] as number) / scale)
      return out
    },
  }
}

export const sigmoid: ScoreNormalizer = sigmoidScaled(1)

/**
 * Pass the column through untouched.
 *
 * For a strategy that already returns [0..1] and knows it — a decayed recency, a cosine
 * similarity. Not an escape from normalization: stage 6 still checks the output, so a
 * column that lied about its range fails there rather than skewing the sum. `none` is a
 * claim the engine verifies, not a way to opt out of the claim.
 */
export const identity: ScoreNormalizer = {
  id: 'none',
  normalize: (raw) => raw,
}

/** Every built-in, by id. What `normalization.default` and `perStrategy` resolve against. */
export const NORMALIZERS: readonly ScoreNormalizer[] = [minmax, zscore, rank, sigmoid, identity]

function logistic(value: number): number {
  return 1 / (1 + Math.exp(-value))
}
