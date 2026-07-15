import { describe, expect, it } from 'vitest'
import { Xoshiro128 } from './rng.js'
import { RRF_K, reciprocalRankNormalized, reciprocalRankScores } from './rrf.js'

const rrf = (scores: number[], k?: number) => [...reciprocalRankScores(new Float64Array(scores), k)]
const normalized = (scores: number[], k?: number) => [
  ...reciprocalRankNormalized(new Float64Array(scores), k),
]

describe('reciprocalRankScores', () => {
  it('scores by position, not by value', () => {
    // The whole point: a cosine of 0.83 and a BM25 of 14.2 are not comparable, but
    // "you were third" means the same thing in every column there is.
    expect(rrf([10, 20, 30])).toEqual([1 / 63, 1 / 62, 1 / 61])
  })

  it('gives the same answer whatever the scale', () => {
    expect(rrf([1, 2, 3])).toEqual(rrf([0.001, 0.002, 4_200_000]))
  })

  it('throws the margins away, which is the cost it charges', () => {
    // A candidate that won its column by a mile and one that scraped in first score the
    // same. When the values within a column mean something, a weighted sum keeps what
    // this discards.
    expect(rrf([100, 1, 0])).toEqual(rrf([2, 1, 0]))
  })

  it('shares a rank between ties rather than splitting them by row order', () => {
    // Otherwise the fused result would encode retrieval order as preference.
    expect(rrf([5, 5, 1])).toEqual([1 / 61, 1 / 61, 1 / 63])
  })

  it('gives every tied row the same score when everything ties', () => {
    expect(rrf([7, 7, 7])).toEqual([1 / 61, 1 / 61, 1 / 61])
  })

  it('handles an empty column', () => {
    expect(rrf([])).toEqual([])
  })

  it('is deterministic', () => {
    const rng = new Xoshiro128('rrf')
    const scores = Array.from({ length: 200 }, () => rng.next())
    expect(rrf(scores)).toEqual(rrf(scores))
  })

  it('keeps the order of the column it fused', () => {
    const rng = new Xoshiro128('order')
    const scores = Array.from({ length: 100 }, () => rng.next())
    const fused = rrf(scores)

    const byScore = scores.map((_, i) => i).sort((a, b) => (scores[b] as number) - (scores[a] as number))
    for (let i = 1; i < byScore.length; i++) {
      expect(fused[byScore[i] as number] as number).toBeLessThanOrEqual(
        fused[byScore[i - 1] as number] as number,
      )
    }
  })
})

describe('the k constant', () => {
  it('defaults to the value from the paper', () => {
    expect(RRF_K).toBe(60)
    expect(rrf([1, 0])).toEqual(rrf([1, 0], 60))
  })

  it('is flat by design: first beats second by under two percent', () => {
    // Which is the whole reason to fuse rankings — being in the top ten of several lists
    // should beat topping exactly one.
    const [first, second] = rrf([2, 1])
    expect((first as number) / (second as number)).toBeCloseTo(62 / 61, 5)
  })

  it('gets sharp as k falls', () => {
    const [first, second] = rrf([2, 1], 1)
    expect((first as number) / (second as number)).toBeCloseTo(1.5, 5)
  })

  it.each([0, -1, Number.NaN, Number.POSITIVE_INFINITY])('refuses k of %s', (k) => {
    expect(() => rrf([1], k)).toThrow(RangeError)
  })
})

describe('reciprocalRankNormalized', () => {
  it('puts first place at 1', () => {
    // Raw RRF lives in a narrow band near 1/k, and a column that never leaves 0.016 would
    // contribute almost nothing against one that uses the whole interval.
    expect(normalized([1, 2, 3])[2]).toBe(1)
  })

  it('stays inside [0..1], as a normalized column must', () => {
    const rng = new Xoshiro128('normalized')
    const scores = Array.from({ length: 500 }, () => rng.next() * 1e6)

    for (const value of normalized(scores)) {
      expect(value).toBeGreaterThan(0)
      expect(value).toBeLessThanOrEqual(1)
    }
  })

  it('keeps every ratio the raw scores had', () => {
    const raw = rrf([3, 2, 1])
    const scaled = normalized([3, 2, 1])

    expect((scaled[0] as number) / (scaled[1] as number)).toBeCloseTo(
      (raw[0] as number) / (raw[1] as number),
      10,
    )
  })

  it('gives every row 1 when everything ties', () => {
    expect(normalized([7, 7, 7])).toEqual([1, 1, 1])
  })

  it('handles an empty column', () => {
    expect(normalized([])).toEqual([])
  })
})
