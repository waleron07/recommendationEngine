import {
  exponentialDecay,
  type FeatureKey,
  type FeatureTransform,
  gaussianDecay,
  linearDecay,
} from '@recoengine/core'
import { type FeatureRef, numericFeature, toKey } from './internal.js'

export interface LogTransformOptions {
  readonly id?: string
  /** The heavy-tailed column to compress, e.g. a raw play count. */
  readonly source: FeatureRef
  /** Where to write the compressed value. */
  readonly target: FeatureRef
}

/**
 * `log1p(x) / log1p(max)` — compresses a heavy-tailed column into `[0..1]` (§12's
 * LogNormalizer, as a transform). The difference from a normalizer is *when*: this runs at
 * the engineering stage and produces a feature any strategy can read, rather than being a
 * strategy's private choice of scale. Use it when several strategies should share one
 * log-compressed view of the same raw count.
 *
 * Pure maths over the column — no payload, no clock — so it is domain-neutral by
 * construction. Negative inputs clamp to 0 (`log1p` is undefined below −1, and a negative
 * count is not a smaller count, it is a bug upstream).
 */
export function logTransform(options: LogTransformOptions): FeatureTransform {
  const id = options.id ?? 'log-transform'
  const source: FeatureKey = toKey(options.source)
  const target: FeatureKey = toKey(options.target)

  return {
    id,
    version: '1.0.0',
    requires: [source],
    provides: [numericFeature(target, id, `log-compressed ${source as string}`)],
    apply: (matrix) => {
      const input = matrix.column(source)
      const output = matrix.columnMut(target)

      let max = 0
      for (let i = 0; i < input.length; i++) {
        const x = input[i] as number
        if (x > max) max = x
      }
      // Every value 0 (or negative) → a flat column of zeros. Dividing by log1p(0) = 0
      // would be NaN, which §12 forbids; a degenerate column is legitimately all-0 here.
      const denom = max > 0 ? Math.log1p(max) : 1

      for (let i = 0; i < input.length; i++) {
        const x = input[i] as number
        output[i] = x > 0 ? Math.log1p(x) / denom : 0
      }
    },
  }
}

export interface DecayTransformOptions {
  readonly id?: string
  /** A column of ages/elapsed times, in the same unit as the shape parameter. */
  readonly source: FeatureRef
  /** Where to write the `[0..1]` decayed weight. */
  readonly target: FeatureRef
  /** Which curve. Default `exponential`. */
  readonly curve?: 'exponential' | 'linear' | 'gaussian'
  /**
   * The shape parameter, in the source's own unit: half-life for exponential, span for
   * linear (zero after it), scale for gaussian. Default 30.
   */
  readonly shape?: number
}

/**
 * Turns a column of ages into a `[0..1]` freshness weight with a chosen decay curve — the
 * general form of what `recencyStrategy` does internally, exposed as a feature so any
 * strategy (or another transform) can build on the decayed value.
 *
 * The three curves differ in their first few units (§decay): `exponential` starts dropping
 * at once, `linear` reaches zero at `span` and stops, `gaussian` holds a plateau then
 * falls. A negative age returns 1 ("not yet"), so a clock skew cannot make a future item
 * out-fresh a present one. Domain-neutral: it reads one column and writes another.
 */
export function decayTransform(options: DecayTransformOptions): FeatureTransform {
  const id = options.id ?? 'decay-transform'
  const source: FeatureKey = toKey(options.source)
  const target: FeatureKey = toKey(options.target)
  const curve = options.curve ?? 'exponential'
  const shape = options.shape ?? 30
  const decay = curve === 'linear' ? linearDecay : curve === 'gaussian' ? gaussianDecay : exponentialDecay

  return {
    id,
    version: '1.0.0',
    requires: [source],
    provides: [numericFeature(target, id, `${curve} decay of ${source as string}`)],
    apply: (matrix) => {
      const input = matrix.column(source)
      const output = matrix.columnMut(target)
      for (let i = 0; i < input.length; i++) output[i] = decay(input[i] as number, shape)
    },
  }
}
