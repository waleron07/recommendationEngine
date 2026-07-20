import {
  type CandidateSet,
  cosine,
  type FeatureMatrix,
  type SimilarityProvider,
  weightedJaccard,
} from '@recoengine/core'
import { clampSimilarity, type FeatureRef, subspaceVector, toKey } from './internal.js'

export interface CosineSimilarityOptions {
  readonly id?: string
  /** Scalar features that form the subspace. Their values become the vector's dimensions. */
  readonly features?: readonly FeatureRef[]
  /** Or one embedding feature, read whole. Mutually exclusive with `features`. */
  readonly embedding?: FeatureRef
}

/**
 * Cosine similarity over a configured feature subspace — the general-purpose metric MMR
 * reaches for. Similarity is *direction*, not magnitude: two tracks with the same genre
 * mix at different play volumes still point the same way, which is what "similar" should
 * mean here. Reads the matrix, never the payload, so one instance serves any domain.
 *
 * Cosine ranges `[-1..1]`; the result is clamped to `[0..1]` because a diversifier treats
 * "opposite" and "unrelated" alike — both are simply "not the same".
 */
export function cosineSimilarity(options: CosineSimilarityOptions = {}): SimilarityProvider {
  const id = options.id ?? 'cosine'
  const embedding = options.embedding === undefined ? undefined : toKey(options.embedding)
  const keys = (options.features ?? []).map(toKey)

  if (embedding === undefined && keys.length === 0) {
    throw new Error('cosineSimilarity needs a subspace: pass "features" (scalars) or "embedding".')
  }

  return {
    id,
    similarity(a: number, b: number, _set: CandidateSet, matrix: FeatureMatrix): number {
      const va = subspaceVector(matrix, keys, embedding, a)
      const vb = subspaceVector(matrix, keys, embedding, b)
      return clampSimilarity(cosine(va, vb))
    },
  }
}

export interface WeightedJaccardSimilarityOptions {
  readonly id?: string
  /** Non-negative membership weights: how strongly each candidate belongs to each set/tag. */
  readonly features: readonly FeatureRef[]
}

/**
 * Weighted Jaccard over a set of membership features — for "how much do these two share"
 * when a candidate belongs to tags/genres to varying degrees. Each feature is one set
 * element and its value the membership weight; overlap over union, in `[0..1]`.
 *
 * The plain set case (0/1 memberships) falls out of this: weighted Jaccard on binary
 * vectors is ordinary Jaccard. A domain whose sets cannot be flattened into columns at
 * all writes its own `SimilarityProvider` — that is exactly the seam the port exists for.
 */
export function jaccardSimilarity(options: WeightedJaccardSimilarityOptions): SimilarityProvider {
  const id = options.id ?? 'jaccard'
  const keys = options.features.map(toKey)
  if (keys.length === 0) throw new Error('jaccardSimilarity needs at least one membership feature.')

  return {
    id,
    similarity(a: number, b: number, _set: CandidateSet, matrix: FeatureMatrix): number {
      const va = subspaceVector(matrix, keys, undefined, a)
      const vb = subspaceVector(matrix, keys, undefined, b)
      return clampSimilarity(weightedJaccard(va, vb))
    },
  }
}
