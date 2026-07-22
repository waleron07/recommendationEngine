import { bench, describe } from 'vitest'
import { topK } from '../packages/core/src/math/heap.js'
import { minmax, rank, sigmoid, zscore } from '../packages/core/src/math/normalize.js'
import { Xoshiro128 } from '../packages/core/src/math/rng.js'
import { reciprocalRankScores } from '../packages/core/src/math/rrf.js'
import { cosine, dot, jaccard } from '../packages/core/src/math/similarity.js'

/**
 * The maths, measured at the sizes the engine actually runs it at.
 *
 * The size-dependent functions — ranking and the normalizers — are benched at **1k, 10k
 * and 100k** candidates (§22), because a single size hides the thing this file exists to
 * catch: the day a "small cleanup" turns a linear scan into a quadratic one. A quadratic
 * looks fine at 1k and falls off a cliff at 100k, so the three points together are the
 * regression signal, not any one of them. `maxCandidates` defaults to 5000 in the examples;
 * 100k is the deliberately pessimistic upper end.
 *
 * The similarity functions are sized by the embedding dimension, not the candidate count,
 * so they are benched once at 128. `rng` is per-call and sized by nothing.
 */

const SIZES = [1_000, 10_000, 100_000] as const
const PAGE = 20
const EMBEDDING = 128

const rng = new Xoshiro128('bench')

/** One scores column per size, generated deterministically so runs are comparable. */
const columns = new Map<number, Float64Array>(
  SIZES.map((size) => [size, new Float64Array(Array.from({ length: size }, () => rng.next() * 1e6))]),
)

const vectorA = new Float64Array(Array.from({ length: EMBEDDING }, () => rng.next()))
const vectorB = new Float64Array(Array.from({ length: EMBEDDING }, () => rng.next()))
const tagsA = new Float64Array(Array.from({ length: EMBEDDING }, () => (rng.next() > 0.8 ? 1 : 0)))
const tagsB = new Float64Array(Array.from({ length: EMBEDDING }, () => (rng.next() > 0.8 ? 1 : 0)))

describe('rng', () => {
  const stream = new Xoshiro128('draw')
  bench('next', () => {
    stream.next()
  })

  bench('fork — once per request, so it is on the hot path', () => {
    stream.fork('user')
  })
})

for (const size of SIZES) {
  const scores = columns.get(size) as Float64Array

  describe(`ranking ${size.toLocaleString('en-US')} candidates down to a page of ${PAGE}`, () => {
    // The comparison behind topKRanker: the heap is O(n log k) against the sort's O(n log n),
    // and it allocates k rather than n. The gap should widen with size; if it narrows, the
    // heap has stopped earning its complexity.
    bench('topK heap', () => {
      topK(size, PAGE, (row) => scores[row] as number)
    })

    bench('full sort', () => {
      const rows = Array.from({ length: size }, (_, row) => row)
      rows.sort((a, b) => (scores[b] as number) - (scores[a] as number) || a - b)
      rows.slice(0, PAGE)
    })
  })

  describe(`normalizing a column of ${size.toLocaleString('en-US')}`, () => {
    // Runs once per strategy per request. `minmax`/`zscore`/`sigmoid` are single passes;
    // `rank` and `rrf` sort, and should scale worse — the point of measuring all five.
    bench('minmax', () => {
      minmax.normalize(scores)
    })

    bench('zscore', () => {
      zscore.normalize(scores)
    })

    bench('sigmoid', () => {
      sigmoid.normalize(scores)
    })

    bench('rank — sorts, and pays for it', () => {
      rank.normalize(scores)
    })

    bench('rrf', () => {
      reciprocalRankScores(scores)
    })
  })
}

describe(`similarity over a ${EMBEDDING}-dimension embedding`, () => {
  // MMR calls this O(page × pool) times, so it is the one function here whose cost is
  // multiplied by anything. Sized by the embedding, not the candidate count.
  bench('cosine', () => {
    cosine(vectorA, vectorB)
  })

  bench('dot', () => {
    dot(vectorA, vectorB)
  })

  bench('jaccard', () => {
    jaccard(tagsA, tagsB)
  })
})
