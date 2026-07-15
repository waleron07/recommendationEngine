import { bench, describe } from 'vitest'
import { topK } from '../packages/core/src/math/heap.js'
import { minmax, rank, sigmoid, zscore } from '../packages/core/src/math/normalize.js'
import { Xoshiro128 } from '../packages/core/src/math/rng.js'
import { reciprocalRankScores } from '../packages/core/src/math/rrf.js'
import { cosine, dot, jaccard } from '../packages/core/src/math/similarity.js'

/**
 * The maths, measured at the sizes the engine actually runs it at.
 *
 * `limits.maxCandidates` defaults to 5000 in every example in the document, so that is
 * the number here. A benchmark at 100 rows would flatter everything and answer nothing:
 * the reason this file exists is to catch the day a "small cleanup" turns a linear scan
 * into a quadratic one, and quadratics look fine at 100.
 */

const ROWS = 5_000
const PAGE = 20
const EMBEDDING = 128

const rng = new Xoshiro128('bench')
const scores = new Float64Array(Array.from({ length: ROWS }, () => rng.next() * 1e6))
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

describe(`ranking ${ROWS} candidates down to a page of ${PAGE}`, () => {
  // The comparison behind topKRanker: the heap is O(n log k) against the sort's O(n log n),
  // and it allocates k rather than n. If these ever converge, the heap has stopped earning
  // its complexity.
  bench('topK heap', () => {
    topK(ROWS, PAGE, (row) => scores[row] as number)
  })

  bench('full sort', () => {
    const rows = Array.from({ length: ROWS }, (_, row) => row)
    rows.sort((a, b) => (scores[b] as number) - (scores[a] as number) || a - b)
    rows.slice(0, PAGE)
  })
})

describe(`normalizing a column of ${ROWS}`, () => {
  // Runs once per strategy per request. Eight strategies means eight of these.
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

describe(`similarity over a ${EMBEDDING}-dimension embedding`, () => {
  // MMR calls this O(page × pool) times, so it is the one function here whose cost is
  // multiplied by anything.
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
