import type {
  CandidateSet,
  Diversifier,
  FeatureMatrix,
  RequestContext,
  ScoreBoard,
  SimilarityProvider,
} from '@recoengine/core'

export interface MmrOptions {
  readonly id?: string
  /** The similarity metric MMR needs — cosine over a subspace, Jaccard over sets, or your own. */
  readonly similarity: SimilarityProvider
  /**
   * Relevance-vs-diversity dial. `1` = pure relevance (provably the input ranking), `0` =
   * pure diversity, default `0.7`. This is the one knob §14 exposes.
   */
  readonly lambda?: number
  /**
   * Cap on how deep MMR reorders. Greedy MMR is `O(k·n)`; applied to the whole tail it
   * would dominate a large request for no benefit past the visible page. Default 200 (§14).
   */
  readonly window?: number
}

/**
 * Maximal Marginal Relevance (§14): the default diversifier. Greedily rebuilds the list,
 * each step picking the candidate that best trades its own score against how similar it
 * already is to what has been chosen:
 *
 * ```
 * MMR(i) = λ · score(i) − (1 − λ) · max sim(i, j)
 *                                   j ∈ selected
 * ```
 *
 * At **λ = 1** the diversity term vanishes and every pick is the highest remaining score —
 * the input order, unchanged. That identity is the acceptance test of this whole stage
 * (§22) and the reason `diversify` takes and returns row indices: a diversifier that
 * reorders nothing is the identity function, provably.
 *
 * Cost is bounded by `window`: MMR runs over the top slice (default 200) and the tail
 * keeps its ranking order, because diversity past the page nobody scrolls to buys nothing.
 * The `O(k²)` similarity work inside the window checks the abort signal each step (§17.1).
 */
export function mmrDiversifier<P = unknown>(options: MmrOptions): Diversifier<P> {
  const id = options.id ?? 'mmr'
  const provider = options.similarity
  const lambda = options.lambda ?? 0.7
  const window = options.window ?? 200

  if (!(lambda >= 0 && lambda <= 1)) throw new Error(`mmr lambda must be within [0..1], got ${lambda}.`)
  if (!(window >= 1)) throw new Error(`mmr window must be at least 1, got ${window}.`)

  return {
    id,
    diversify(
      ranked: readonly number[],
      set: CandidateSet<P>,
      board: ScoreBoard,
      ctx: RequestContext,
      matrix: FeatureMatrix,
    ): readonly number[] {
      const depth = Math.min(window, ranked.length)
      // λ = 1 is the identity, and short-circuiting it is not just an optimisation: it
      // guarantees byte-for-byte the input order without depending on the arithmetic below
      // rounding exactly, which is the property §22 tests.
      if (lambda >= 1 || depth <= 1) return ranked

      const pool = ranked.slice(0, depth)
      const tail = ranked.slice(depth)
      const selected: number[] = []
      // maxSim[k] = max similarity of pool row k to anything already selected. Updated
      // incrementally, so the whole run is O(depth²) similarity calls, not O(depth³).
      const maxSim = new Float64Array(pool.length)
      const taken = new Array<boolean>(pool.length).fill(false)

      for (let step = 0; step < pool.length; step++) {
        ctx.signal.throwIfAborted()

        let bestIndex = -1
        let bestScore = Number.NEGATIVE_INFINITY
        for (let k = 0; k < pool.length; k++) {
          if (taken[k]) continue
          const relevance = board.final(pool[k] as number)
          const penalty = selected.length === 0 ? 0 : (maxSim[k] as number)
          const mmr = lambda * relevance - (1 - lambda) * penalty
          // Ties break toward the better-ranked candidate: pool is in ranking order, and
          // the strict `>` keeps the earlier one, so the result stays deterministic.
          if (mmr > bestScore) {
            bestScore = mmr
            bestIndex = k
          }
        }

        taken[bestIndex] = true
        const chosen = pool[bestIndex] as number
        selected.push(chosen)

        for (let k = 0; k < pool.length; k++) {
          if (taken[k]) continue
          const sim = provider.similarity(pool[k] as number, chosen, set, matrix)
          if (sim > (maxSim[k] as number)) maxSim[k] = sim
        }
      }

      return tail.length === 0 ? selected : [...selected, ...tail]
    },
  }
}
