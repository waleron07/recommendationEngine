import { type FeatureKey, type FeatureMatrix, featureKey } from '@recoengine/core'

/** A feature named by its key or a plain string (branded on the way in). */
export type FeatureRef = FeatureKey | string

export const toKey = (ref: FeatureRef): FeatureKey => featureKey(ref as string)

/**
 * The feature-subspace vector for one candidate row: the values of `keys` in order, or a
 * single embedding column read whole. This is what turns "how similar are these two
 * candidates" into arithmetic over a `Float64Array` — the maths in `math/similarity.ts`
 * takes it from there.
 *
 * A fresh array per call, never a live view of the matrix: similarity is read-only and a
 * subarray view would alias the matrix's storage.
 */
export function subspaceVector(
  matrix: FeatureMatrix,
  keys: readonly FeatureKey[],
  embedding: FeatureKey | undefined,
  row: number,
): Float64Array {
  if (embedding !== undefined) return Float64Array.from(matrix.vector(embedding, row))
  const out = new Float64Array(keys.length)
  for (let i = 0; i < keys.length; i++) out[i] = matrix.get(keys[i] as FeatureKey, row)
  return out
}

/** [0..1], NaN → 0. Cosine ranges [-1..1]; opposite vectors read as "not similar". */
export const clampSimilarity = (x: number): number => (x > 1 ? 1 : x > 0 ? x : 0)
