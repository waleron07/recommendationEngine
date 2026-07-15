import type { CandidateSet } from '../../domain/candidate.js'
import type { FeatureSchema } from '../../domain/feature.js'
import { DenseFeatureMatrix, type FeatureMatrix } from '../../domain/matrix.js'
import { DenseProfileVector, type ProfileVector } from '../../domain/profile.js'
import type { RequestContext } from '../../ports/context.js'
import type { FeatureExtractor, UserFeatureExtractor } from '../../ports/feature-extractor.js'
import { degradeOrThrow, type PolicyContext, warn } from '../policy.js'

export interface Extracted {
  /**
   * The concrete matrix, not the `FeatureMatrix` interface.
   *
   * The pipeline owns the implementation — it allocated it — and stage 4b needs
   * `select()` to renumber rows. Ports still receive the interface, so `select` stays out
   * of the extension contract, where it would oblige every future matrix to implement a
   * row-compaction scheme it may have no use for.
   */
  readonly matrix: DenseFeatureMatrix
  readonly profile: ProfileVector
  /** Profile features nobody could compute. Strategies that need them stand down (§17.2). */
  readonly degradedProfile: ReadonlySet<string>
}

/**
 * Stage 3. The only place in the engine that knows what an artist is.
 *
 * Extractors run concurrently and each writes its own columns, so there is no shared
 * cursor to race on: the matrix is preallocated from the schema, and a writer only
 * touches keys it declared and `build()` proved nobody else declared. Concurrency is safe
 * here by construction rather than by lock.
 */
export async function extract<P, UP>(
  set: CandidateSet<P>,
  ctx: RequestContext<UP>,
  schema: FeatureSchema,
  profileSchema: FeatureSchema,
  extractors: readonly FeatureExtractor<P>[],
  userExtractors: readonly UserFeatureExtractor[],
  policy: PolicyContext,
): Promise<Extracted> {
  const matrix = new DenseFeatureMatrix(schema, set.size)
  const profile = new DenseProfileVector(profileSchema)
  const degradedProfile = new Set<string>()

  await Promise.all([
    ...extractors.map(async (extractor) => {
      try {
        await extractor.extract(set, matrix, ctx)
      } catch (error) {
        degradeOrThrow(policy, extractor, error, `extractor "${extractor.id}" failed`)
        substituteDefaults(extractor, matrix, set.size, policy)
      }
    }),
    ...userExtractors.map(async (extractor) => {
      try {
        await extractor.extract(profile, ctx)
      } catch (error) {
        degradeOrThrow(policy, extractor, error, `user extractor "${extractor.id}" failed`)
        // No defaults here: a profile feature has no per-row fallback to fill, and a
        // centroid substituted with zeros is not a degraded taste vector, it is a wrong
        // one. Strategies that require it stand down instead (§17.2).
        for (const descriptor of extractor.provides) degradedProfile.add(descriptor.key)
      }
    }),
  ])

  return { matrix, profile, degradedProfile }
}

/**
 * Where `defaultValue` finally earns its place in the descriptor.
 *
 * Declared since version 0.1 and decorative until now: it is what lets an `optional`
 * extractor degrade into something meaningful rather than into zeros. The author of the
 * feature decides what its absence means — 0 for `popularity`, 0 for `affinity`, the
 * median for `item_age_days`, because 0 there would silently declare every item brand new
 * and hand the whole catalogue to the recency strategy.
 */
function substituteDefaults<P>(
  extractor: FeatureExtractor<P>,
  matrix: FeatureMatrix,
  rows: number,
  policy: PolicyContext,
): void {
  for (const descriptor of extractor.provides) {
    const arity = descriptor.arity ?? 1
    if (arity === 1) {
      matrix.columnMut(descriptor.key).fill(descriptor.defaultValue)
    } else {
      for (let row = 0; row < rows; row++) matrix.vectorMut(descriptor.key, row).fill(descriptor.defaultValue)
    }

    // Named per feature, not per extractor: "affinity_artist is a default" is actionable,
    // "the artist extractor degraded" leaves you guessing which scores moved.
    warn(policy, {
      stage: 'extraction',
      port: extractor.id,
      code: 'schema_default',
      message: `"${descriptor.key}" fell back to its default of ${descriptor.defaultValue} for all ${rows} candidates.`,
    })
  }
}
