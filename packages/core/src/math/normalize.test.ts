import { describe, expect, it } from 'vitest'
import type { ScoreNormalizer } from '../ports/score-normalizer.js'
import {
  identity,
  minmax,
  NORMALIZERS,
  rank,
  sigmoid,
  sigmoidScaled,
  softmax,
  softmaxScaled,
  zscore,
} from './normalize.js'
import { Xoshiro128 } from './rng.js'

const run = (normalizer: ScoreNormalizer, raw: number[]): number[] => [
  ...normalizer.normalize(new Float64Array(raw)),
]

/** `identity` is excluded: it promises to pass a column through, not to fix it. */
const SQUASHING = NORMALIZERS.filter((n) => n.id !== 'none')

describe('every normalizer lands in [0..1]', () => {
  // The property the whole scale rests on. Stage 6 refuses anything else, and rightly:
  // one value outside the interval and a weight stops being a preference.
  const columns: [string, number[]][] = [
    ['plays', [0, 1, 143, 4_200_000]],
    ['negatives', [-5, -1, 0, 1, 5]],
    ['one outlier', [1, 1, 1, 1, 4_200_000]],
    ['flat', [7, 7, 7]],
    ['flat zeros', [0, 0, 0]],
    ['two', [1, 2]],
    ['single', [42]],
    ['tiny spread', [1, 1.000_000_1]],
    ['huge spread', [-1e12, 1e12]],
  ]

  for (const normalizer of SQUASHING) {
    it.each(columns)(`${normalizer.id} on %s`, (_label, raw) => {
      const out = run(normalizer, raw)

      expect(out).toHaveLength(raw.length)
      for (const value of out) {
        expect(Number.isFinite(value)).toBe(true)
        expect(value).toBeGreaterThanOrEqual(0)
        expect(value).toBeLessThanOrEqual(1)
      }
    })
  }

  it.each(
    SQUASHING.map((n) => [n.id, n] as const),
  )('%s holds on a thousand random draws', (_id, normalizer) => {
    const rng = new Xoshiro128('normalize')
    const raw = Array.from({ length: 1_000 }, () => (rng.next() - 0.5) * 1e6)

    for (const value of run(normalizer, raw)) {
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it.each(SQUASHING.map((n) => [n.id, n] as const))('%s handles an empty column', (_id, normalizer) => {
    expect(run(normalizer, [])).toEqual([])
  })
})

describe('every normalizer keeps the order it was given', () => {
  // Normalization changes the scale, never the ranking. A normalizer that reorders is not
  // normalizing, it is scoring — and it would silently overrule every strategy.
  it.each(SQUASHING.map((n) => [n.id, n] as const))('%s is monotonic', (_id, normalizer) => {
    const rng = new Xoshiro128('monotonic')
    const raw = Array.from({ length: 200 }, () => rng.next() * 1_000)
    const out = run(normalizer, raw)

    const byRaw = raw.map((_, i) => i).sort((a, b) => (raw[a] as number) - (raw[b] as number))
    for (let i = 1; i < byRaw.length; i++) {
      expect(out[byRaw[i] as number] as number).toBeGreaterThanOrEqual(out[byRaw[i - 1] as number] as number)
    }
  })
})

describe('minmax', () => {
  it('stretches the column across the whole interval', () => {
    expect(run(minmax, [0, 5, 10])).toEqual([0, 0.5, 1])
  })

  it('returns zeros for a flat column, because there is no spread to speak of', () => {
    // 0.5 would hand the column real influence over the ranking on no information at all.
    expect(run(minmax, [7, 7, 7])).toEqual([0, 0, 0])
  })

  it('shows its weakness plainly: one outlier flattens everyone else', () => {
    // This is why zscore and rank exist. Documented by a test rather than a paragraph.
    const out = run(minmax, [1, 2, 3, 4_200_000])
    expect(out[0]).toBeCloseTo(0, 5)
    expect(out[2]).toBeCloseTo(0, 5)
    expect(out[3]).toBe(1)
  })
})

describe('zscore', () => {
  it('puts the mean at the middle of the interval', () => {
    const out = run(zscore, [1, 2, 3, 4, 5])
    expect(out[2]).toBeCloseTo(0.5, 10)
  })

  it('returns 0.5 for a flat column — everything is equally average, and that is true', () => {
    expect(run(zscore, [7, 7, 7])).toEqual([0.5, 0.5, 0.5])
  })

  it('is flattened by an extreme outlier too — it is not a defence against them', () => {
    // Written after this test refuted the comment above it. The tempting story is that
    // standardizing rescues you from the outlier that ruins min-max; it does not, because
    // the outlier is in the sample and inflates σ, so the rest collapses onto the mean.
    // Here it separates the first three by ~2.5e-7, worse than min-max manages.
    const out = run(zscore, [1, 2, 3, 4_200_000])
    const spread = (out[2] as number) - (out[0] as number)

    expect(spread).toBeGreaterThan(0)
    expect(spread).toBeLessThan(1e-6)
    // rank is the one that actually survives it, which is why it exists.
    expect(run(rank, [1, 2, 3, 4_200_000])).toEqual([0, 1 / 3, 2 / 3, 1])
  })

  it('spreads a roughly symmetric column, which is what it is for', () => {
    const out = run(zscore, [1, 2, 3, 4, 5])
    expect((out[4] as number) - (out[0] as number)).toBeGreaterThan(0.5)
  })
})

describe('rank', () => {
  it('spaces the column evenly, whatever the magnitudes', () => {
    expect(run(rank, [1, 2, 4_200_000])).toEqual([0, 0.5, 1])
  })

  it('gives tied values the same score', () => {
    // Without this, two identical values would be split by row index, and the column would
    // quietly encode retrieval order as preference.
    expect(run(rank, [5, 5, 9])).toEqual([0.25, 0.25, 1])
  })

  it('gives one candidate the middle, having nothing to compare it to', () => {
    expect(run(rank, [42])).toEqual([0.5])
  })

  it('makes every column look the same, which is the trade it offers', () => {
    expect(run(rank, [1, 2, 3])).toEqual(run(rank, [10, 4_200_000, 4_200_001]))
  })
})

describe('sigmoid', () => {
  it('maps zero to the middle', () => {
    expect(run(sigmoid, [0])).toEqual([0.5])
  })

  it('is absolute: the same raw value scores the same in any column', () => {
    // The only normalizer whose output is comparable across requests — which is what a
    // fixed threshold needs, and what the relative ones cannot offer.
    expect(run(sigmoid, [2, 0])[0]).toBe(run(sigmoid, [2, 100])[0])
  })

  it('saturates rather than overflowing', () => {
    const out = run(sigmoid, [-1e6, 1e6])
    expect(out[0]).toBe(0)
    expect(out[1]).toBe(1)
  })

  it('takes a scale, and a larger one is gentler', () => {
    const gentle = run(sigmoidScaled(10), [5])[0] as number
    const sharp = run(sigmoid, [5])[0] as number

    expect(gentle).toBeLessThan(sharp)
    expect(gentle).toBeGreaterThan(0.5)
  })

  it('names itself by its scale, so two of them are two normalizers', () => {
    expect(sigmoidScaled(10).id).toBe('sigmoid:10')
    expect(sigmoidScaled(1).id).toBe('sigmoid')
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses the scale %s', (scale) => {
    expect(() => sigmoidScaled(scale)).toThrow(RangeError)
  })
})

describe('softmax', () => {
  it('produces a distribution — the outputs sum to 1', () => {
    const out = run(softmax, [1, 2, 3])
    expect(out.reduce((a, b) => a + b, 0)).toBeCloseTo(1, 10)
  })

  it('maps a flat column to a uniform 1/n', () => {
    expect(run(softmax, [7, 7, 7])).toEqual([1 / 3, 1 / 3, 1 / 3])
  })

  it('rewards the top exponentially — the leader takes more than a linear share', () => {
    // Against minmax's linear 0 / 0.5 / 1, softmax pushes mass toward the largest value.
    const out = run(softmax, [0, 1, 2])
    expect(out[2] as number).toBeGreaterThan(0.6)
    expect(out[0] as number).toBeLessThan(0.12)
  })

  it('does not overflow on large logits — the max-shift keeps exp finite', () => {
    const out = run(softmax, [1000, 1001])
    expect(Number.isFinite(out[0] as number)).toBe(true)
    expect((out[0] as number) + (out[1] as number)).toBeCloseTo(1, 10)
    expect(out[1] as number).toBeGreaterThan(out[0] as number)
  })

  it('takes a temperature: higher flattens toward uniform, lower sharpens', () => {
    const sharp = run(softmaxScaled(0.5), [0, 1])[1] as number
    const flat = run(softmaxScaled(5), [0, 1])[1] as number
    expect(sharp).toBeGreaterThan(flat) // low τ concentrates mass on the leader
    expect(flat).toBeGreaterThan(0.5)
    expect(flat).toBeLessThan(0.6) // high τ is nearly uniform
  })

  it('names itself by its temperature', () => {
    expect(softmaxScaled(2).id).toBe('softmax:2')
    expect(softmaxScaled(1).id).toBe('softmax')
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses the temperature %s', (t) => {
    expect(() => softmaxScaled(t)).toThrow(RangeError)
  })
})

describe('identity', () => {
  it('passes the column through for a strategy that already normalized', () => {
    expect(run(identity, [0, 0.5, 1])).toEqual([0, 0.5, 1])
  })

  it('does not fix a column that lied — stage 6 catches that, which is the point', () => {
    // `none` is a claim the engine verifies, not a way to opt out of the claim.
    expect(run(identity, [42])).toEqual([42])
  })
})

describe('the registry', () => {
  it('offers every normalizer §12 names', () => {
    expect(NORMALIZERS.map((n) => n.id).sort()).toEqual([
      'minmax',
      'none',
      'rank',
      'sigmoid',
      'softmax',
      'zscore',
    ])
  })
})
