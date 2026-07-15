/**
 * Vector similarity. The maths under `SimilarityProvider`, and under any strategy that
 * compares an item to a taste centroid.
 *
 * Every function here reads two `Float64Array`s of the same length and returns a number.
 * They know nothing about candidates, features or the schema — which is what lets the same
 * cosine serve a music domain and a shop.
 */

/** Rejects a length mismatch rather than silently comparing a prefix. */
function assertSameLength(a: Float64Array, b: Float64Array): void {
  if (a.length !== b.length) {
    // Comparing the first n dimensions of a 128-vector against a 64-vector produces a
    // number, and that number means nothing. Better to stop than to return it.
    throw new RangeError(`Vectors must be the same length to compare: got ${a.length} and ${b.length}.`)
  }
}

/** Σ aᵢbᵢ. Unbounded, and the building block of the rest. */
export function dot(a: Float64Array, b: Float64Array): number {
  assertSameLength(a, b)
  let sum = 0
  for (let i = 0; i < a.length; i++) sum += (a[i] as number) * (b[i] as number)
  return sum
}

/** Euclidean length. */
export function norm(vector: Float64Array): number {
  let sum = 0
  for (const value of vector) sum += value * value
  return Math.sqrt(sum)
}

/**
 * Cosine of the angle between two vectors: how aligned they are, ignoring magnitude.
 *
 * The right measure for embeddings, because length there is usually an artefact — a track
 * with a longer description does not have a stronger genre. Direction is the signal.
 *
 * **Range is [-1, 1], not [0, 1].** A `SimilarityProvider` promises [0..1], so it must map
 * this itself, and the map is a real decision rather than a formality: `(1 + c) / 2` treats
 * "opposite" as maximally dissimilar and keeps the whole scale, while `max(0, c)` treats
 * everything below orthogonal as simply unrelated. For the non-negative vectors most
 * feature pipelines produce (counts, TF-IDF, one-hot) the cosine is already in [0, 1] and
 * the question does not arise — which is why it is left here rather than decided here.
 *
 * A zero vector returns 0, not NaN. It has no direction, so it is aligned with nothing —
 * and a NaN escaping into a score column poisons every comparison downstream, which is the
 * failure this whole codebase keeps guarding against.
 */
export function cosine(a: Float64Array, b: Float64Array): number {
  assertSameLength(a, b)

  let product = 0
  let squaredA = 0
  let squaredB = 0
  for (let i = 0; i < a.length; i++) {
    const left = a[i] as number
    const right = b[i] as number
    product += left * right
    squaredA += left * left
    squaredB += right * right
  }

  if (squaredA === 0 || squaredB === 0) return 0

  const value = product / Math.sqrt(squaredA * squaredB)
  // Floating point can push an exact 1 to 1.0000000000000002, and a caller that trusts the
  // documented range would be right to be surprised.
  return Math.min(1, Math.max(-1, value))
}

/**
 * Jaccard over sets, encoded as vectors: |A ∩ B| / |A ∪ B|.
 *
 * Anything non-zero counts as membership, so it reads a one-hot genre vector the obvious
 * way. Magnitudes are ignored entirely — this asks "which of these tags do they share",
 * not "how strongly".
 *
 * Two empty sets return 1: they are identical, and identical is what similarity 1 means.
 * The alternative — 0 for "nothing in common" — reports two things that are the same as
 * maximally different, which is worse than the edge case it avoids.
 */
export function jaccard(a: Float64Array, b: Float64Array): number {
  assertSameLength(a, b)

  let intersection = 0
  let union = 0
  for (let i = 0; i < a.length; i++) {
    const inA = (a[i] as number) !== 0
    const inB = (b[i] as number) !== 0
    if (inA && inB) intersection += 1
    if (inA || inB) union += 1
  }

  return union === 0 ? 1 : intersection / union
}

/**
 * Weighted Jaccard: Σ min(aᵢ, bᵢ) / Σ max(aᵢ, bᵢ).
 *
 * The same question asked of counts rather than of membership — "you played this genre 40
 * times and I played it 38" is near-identical, where plain Jaccard would only see that
 * both of us played it at all.
 *
 * Negative components are refused rather than accepted: with them the denominator can go
 * to zero or turn negative, and the result stops being a similarity in any sense. A
 * signed vector is a job for `cosine`.
 */
export function weightedJaccard(a: Float64Array, b: Float64Array): number {
  assertSameLength(a, b)

  let minimums = 0
  let maximums = 0
  for (let i = 0; i < a.length; i++) {
    const left = a[i] as number
    const right = b[i] as number
    if (left < 0 || right < 0) {
      throw new RangeError(
        `weightedJaccard needs non-negative components; got ${Math.min(left, right)}. Use cosine for signed vectors.`,
      )
    }
    minimums += Math.min(left, right)
    maximums += Math.max(left, right)
  }

  return maximums === 0 ? 1 : minimums / maximums
}
