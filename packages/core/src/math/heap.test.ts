import { describe, expect, it } from 'vitest'
import { topK } from './heap.js'
import { Xoshiro128 } from './rng.js'

/** The obvious, slow answer. The heap must agree with it, always. */
const bySorting = (scores: readonly number[], k: number): number[] =>
  scores
    .map((_, row) => row)
    .sort((a, b) => (scores[b] as number) - (scores[a] as number) || a - b)
    .slice(0, Math.max(0, k))

const heapOf = (scores: readonly number[], k: number): number[] =>
  topK(scores.length, k, (row) => scores[row] as number)

describe('topK agrees with a full sort', () => {
  it.each([
    ['ascending', [1, 2, 3, 4, 5]],
    ['descending', [5, 4, 3, 2, 1]],
    ['unordered', [3, 1, 4, 1, 5, 9, 2, 6]],
    ['all equal', [1, 1, 1, 1]],
    ['negative', [-5, -1, -3]],
    ['mixed signs', [-1, 0, 1, -2, 2]],
    ['single', [42]],
  ])('on %s input', (_label, scores) => {
    for (let k = 0; k <= scores.length + 1; k++) {
      expect(heapOf(scores, k)).toEqual(bySorting(scores, k))
    }
  })

  it('on a thousand random draws, for every k that matters', () => {
    // The property that matters: whatever the data, the heap and the sort pick the same
    // rows in the same order. A heap that is merely "close" is a ranking bug.
    const rng = new Xoshiro128('heap')
    const scores = Array.from({ length: 1_000 }, () => rng.next())

    for (const k of [1, 2, 10, 20, 100, 999, 1_000]) {
      expect(heapOf(scores, k)).toEqual(bySorting(scores, k))
    }
  })

  it('on data with many ties, where the tie-break does the work', () => {
    // Scores quantised into ten buckets, so most rows tie. Determinism has to survive it.
    const rng = new Xoshiro128('ties')
    const scores = Array.from({ length: 500 }, () => Math.floor(rng.next() * 10))

    expect(heapOf(scores, 25)).toEqual(bySorting(scores, 25))
  })
})

describe('determinism', () => {
  it('breaks ties on the row index, not on the heap internals', () => {
    // Two candidates with equal scores must come back in the same order on every request,
    // or a golden test is measuring how the heap happened to shuffle.
    expect(heapOf([1, 1, 1, 1, 1], 3)).toEqual([0, 1, 2])
  })

  it('gives the same answer twice', () => {
    const rng = new Xoshiro128('repeat')
    const scores = Array.from({ length: 200 }, () => rng.next())
    expect(heapOf(scores, 20)).toEqual(heapOf(scores, 20))
  })

  it('honours a custom tie-break, lower first', () => {
    // Equal scores, tie-break reversed: the last row now wins.
    const scores = [1, 1, 1]
    expect(
      topK(
        3,
        2,
        () => scores[0] as number,
        (row) => -row,
      ),
    ).toEqual([2, 1])
  })
})

describe('bounds', () => {
  it.each([
    ['k of zero', 0],
    ['negative k', -1],
  ])('returns nothing for %s', (_label, k) => {
    expect(heapOf([3, 1, 2], k)).toEqual([])
  })

  it('returns nothing for an empty board', () => {
    expect(heapOf([], 10)).toEqual([])
  })

  it('caps k at the number of rows', () => {
    expect(heapOf([3, 1, 2], 100)).toEqual([0, 2, 1])
  })

  it('keeps only k, however many rows there are', () => {
    const rng = new Xoshiro128('cap')
    const scores = Array.from({ length: 5_000 }, () => rng.next())
    expect(heapOf(scores, 20)).toHaveLength(20)
  })
})

describe('the ordering it returns', () => {
  it('is best first', () => {
    const rng = new Xoshiro128('order')
    const scores = Array.from({ length: 300 }, () => rng.next())
    const best = heapOf(scores, 30)

    for (let i = 1; i < best.length; i++) {
      expect(scores[best[i - 1] as number] as number).toBeGreaterThanOrEqual(
        scores[best[i] as number] as number,
      )
    }
  })

  it('returns each row once', () => {
    const rng = new Xoshiro128('distinct')
    const scores = Array.from({ length: 300 }, () => rng.next())
    const best = heapOf(scores, 50)

    expect(new Set(best).size).toBe(best.length)
  })

  it('never returns a row that is not a candidate', () => {
    const best = heapOf([3, 1, 2], 2)
    for (const row of best) {
      expect(row).toBeGreaterThanOrEqual(0)
      expect(row).toBeLessThan(3)
    }
  })
})
