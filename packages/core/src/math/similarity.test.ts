import { describe, expect, it } from 'vitest'
import { Xoshiro128 } from './rng.js'
import { cosine, dot, jaccard, norm, weightedJaccard } from './similarity.js'

const v = (...values: number[]) => new Float64Array(values)

const randomVector = (rng: Xoshiro128, length: number, signed = true) =>
  new Float64Array(Array.from({ length }, () => (signed ? rng.next() - 0.5 : rng.next()) * 10))

describe('dot', () => {
  it('sums the products', () => {
    expect(dot(v(1, 2, 3), v(4, 5, 6))).toBe(32)
  })

  it('is zero for orthogonal vectors', () => {
    expect(dot(v(1, 0), v(0, 1))).toBe(0)
  })

  it('is zero on empty vectors', () => {
    expect(dot(v(), v())).toBe(0)
  })
})

describe('norm', () => {
  it('measures euclidean length', () => {
    expect(norm(v(3, 4))).toBe(5)
  })

  it('is zero for the zero vector', () => {
    expect(norm(v(0, 0))).toBe(0)
  })
})

describe('cosine', () => {
  it('is 1 for the same direction, whatever the magnitude', () => {
    // The property embeddings need: a longer description is not a stronger genre.
    expect(cosine(v(1, 1), v(5, 5))).toBe(1)
  })

  it('is 0 for orthogonal and -1 for opposite', () => {
    expect(cosine(v(1, 0), v(0, 1))).toBe(0)
    expect(cosine(v(1, 1), v(-1, -1))).toBe(-1)
  })

  it('returns 0 rather than NaN for a zero vector', () => {
    // A NaN escaping into a score column poisons every comparison downstream. A vector
    // with no direction is aligned with nothing, and 0 says exactly that.
    expect(cosine(v(0, 0), v(1, 1))).toBe(0)
    expect(cosine(v(0, 0), v(0, 0))).toBe(0)
  })

  it('stays inside [-1, 1] on a thousand random pairs', () => {
    // Floating point can push an exact 1 to 1.0000000000000002, and a caller trusting the
    // documented range would be right to be surprised.
    const rng = new Xoshiro128('cosine')
    for (let i = 0; i < 1_000; i++) {
      const value = cosine(randomVector(rng, 16), randomVector(rng, 16))
      expect(value).toBeGreaterThanOrEqual(-1)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('is exactly 1 for a vector against itself, however awkward', () => {
    const rng = new Xoshiro128('self')
    for (let i = 0; i < 100; i++) {
      const vector = randomVector(rng, 32)
      expect(cosine(vector, vector)).toBe(1)
    }
  })

  it('is symmetric', () => {
    const rng = new Xoshiro128('symmetry')
    for (let i = 0; i < 100; i++) {
      const a = randomVector(rng, 8)
      const b = randomVector(rng, 8)
      expect(cosine(a, b)).toBe(cosine(b, a))
    }
  })

  it('lands in [0, 1] for the non-negative vectors most pipelines produce', () => {
    // Counts, TF-IDF, one-hot: the mapping question the doc leaves to the provider does
    // not even arise for these.
    const rng = new Xoshiro128('non-negative')
    for (let i = 0; i < 200; i++) {
      const value = cosine(randomVector(rng, 8, false), randomVector(rng, 8, false))
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })
})

describe('jaccard', () => {
  it('divides the shared tags by the tags between them', () => {
    expect(jaccard(v(1, 1, 0, 0), v(1, 0, 1, 0))).toBe(1 / 3)
  })

  it('is 1 for identical sets and 0 for disjoint ones', () => {
    expect(jaccard(v(1, 1, 0), v(1, 1, 0))).toBe(1)
    expect(jaccard(v(1, 0), v(0, 1))).toBe(0)
  })

  it('reads any non-zero value as membership, ignoring magnitude', () => {
    expect(jaccard(v(5, 0), v(0.001, 0))).toBe(1)
  })

  it('calls two empty sets identical, which is what they are', () => {
    // 0 would report two things that are the same as maximally different — worse than the
    // edge case it avoids.
    expect(jaccard(v(0, 0), v(0, 0))).toBe(1)
  })

  it('is symmetric', () => {
    expect(jaccard(v(1, 1, 0), v(1, 0, 0))).toBe(jaccard(v(1, 0, 0), v(1, 1, 0)))
  })
})

describe('weightedJaccard', () => {
  it('compares counts rather than membership', () => {
    // "You played this genre 40 times, I played it 38" is near-identical; plain jaccard
    // would only see that we both played it at all.
    expect(weightedJaccard(v(40, 0), v(38, 0))).toBeCloseTo(38 / 40, 10)
    expect(jaccard(v(40, 0), v(38, 0))).toBe(1)
  })

  it('is 1 for identical vectors', () => {
    expect(weightedJaccard(v(3, 7), v(3, 7))).toBe(1)
  })

  it('calls two zero vectors identical', () => {
    expect(weightedJaccard(v(0, 0), v(0, 0))).toBe(1)
  })

  it('stays in [0, 1] on random non-negative pairs', () => {
    const rng = new Xoshiro128('weighted')
    for (let i = 0; i < 500; i++) {
      const value = weightedJaccard(randomVector(rng, 8, false), randomVector(rng, 8, false))
      expect(value).toBeGreaterThanOrEqual(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('refuses negative components instead of returning nonsense', () => {
    // With them the denominator can hit zero or turn negative, and the result stops being
    // a similarity in any sense. A signed vector is a job for cosine.
    expect(() => weightedJaccard(v(-1, 2), v(1, 2))).toThrow(RangeError)
  })
})

describe('length mismatch', () => {
  it.each([
    ['dot', () => dot(v(1, 2), v(1))],
    ['cosine', () => cosine(v(1, 2), v(1))],
    ['jaccard', () => jaccard(v(1, 2), v(1))],
    ['weightedJaccard', () => weightedJaccard(v(1, 2), v(1))],
  ])('%s refuses to compare a prefix', (_label, call) => {
    // Comparing the first 64 dimensions of a 128-vector produces a number, and that number
    // means nothing. Better to stop than to return it.
    expect(call).toThrow(RangeError)
  })
})
