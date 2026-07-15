import type { FeatureKey } from '../domain/ids.js'
import type { PostFilter } from '../ports/candidate-filter.js'
import type { FeatureExtractor, UserFeatureExtractor } from '../ports/feature-extractor.js'
import type { FeatureTransform } from '../ports/feature-transform.js'
import type { AnyScoringStrategy } from '../ports/scoring-strategy.js'
import { MissingFeatureError, RecoError } from './errors.js'

export interface FeatureGraphInput<P = unknown> {
  readonly extractors: readonly FeatureExtractor<P>[]
  readonly userExtractors: readonly UserFeatureExtractor[]
  readonly transforms: readonly FeatureTransform[]
  readonly strategies: readonly AnyScoringStrategy<P>[]
  readonly postFilters: readonly PostFilter[]
}

/** Who produces a feature. Kept for the ordering and for the error messages. */
type Producers = ReadonlyMap<FeatureKey, string>

/**
 * Validates the feature graph and orders the transforms. Runs inside `build()`, so every
 * problem below stops the application from starting.
 *
 * This is the point of the whole kernel. Elasticsearch catches a mapping error when you
 * index, not when you search; this catches a feature error when you build, not when you
 * recommend. Every JS recommender I know of does neither: a missing feature reads as
 * `undefined`, becomes `NaN` in the first arithmetic, and `NaN` propagates through the
 * weighted sum until the whole ranking collapses into insertion order. Nothing throws.
 * The tests pass. The feed is quietly garbage, and you find out from a business metric.
 *
 * @returns transforms in topological order — derived, never hand-maintained
 */
export function resolveFeatureGraph<P>(input: FeatureGraphInput<P>): readonly FeatureTransform[] {
  const itemProducers = collectProducers(input.extractors, input.transforms)
  const profileProducers = collectProducers(input.userExtractors, [])

  const sorted = sortTransforms(input.transforms, itemProducers)

  for (const strategy of input.strategies) {
    requireAll(strategy.requires, itemProducers, strategy.id, 'no extractor or transform provides it')
    requireAll(
      strategy.requiresProfile ?? [],
      profileProducers,
      strategy.id,
      'no UserFeatureExtractor provides it — profile features live in their own schema, ' +
        'so an item feature of the same name does not satisfy this',
    )
  }

  for (const filter of input.postFilters) {
    requireAll(filter.requires, itemProducers, filter.id, 'no extractor or transform provides it')
  }

  return sorted
}

function collectProducers(
  owners: readonly { readonly id: string; readonly provides: readonly { readonly key: FeatureKey }[] }[],
  transforms: readonly FeatureTransform[],
): Producers {
  const producers = new Map<FeatureKey, string>()
  // Key collisions are already refused by FeatureSchemaBuilder.register when the builder
  // registers these descriptors, so by the time we get here every key has one owner.
  for (const owner of [...owners, ...transforms]) {
    for (const descriptor of owner.provides) producers.set(descriptor.key, owner.id)
  }
  return producers
}

function requireAll(
  keys: readonly FeatureKey[],
  producers: Producers,
  requiredBy: string,
  why: string,
): void {
  for (const key of keys) {
    if (!producers.has(key)) {
      // The acceptance criterion of this whole stage: this throws at startup, not at 3am.
      throw new MissingFeatureError(key, requiredBy, why)
    }
  }
}

/**
 * Orders transforms by what they read and write, rather than by the order someone typed
 * `use()` in.
 *
 * Registration order is the wrong source of truth: `log1p(popularity)` must run after
 * whoever computes `popularity`, and expecting the author to keep a chain of six
 * transforms in the right sequence by hand is a rule that holds until the first merge
 * conflict. The dependencies are already declared in `requires`/`provides` — the order is
 * derivable, so deriving it is the only honest option.
 */
function sortTransforms(
  transforms: readonly FeatureTransform[],
  producers: Producers,
): readonly FeatureTransform[] {
  const byId = new Map<string, FeatureTransform>()
  for (const transform of transforms) byId.set(transform.id, transform)

  const sorted: FeatureTransform[] = []
  const done = new Set<string>()
  const onPath = new Set<string>()
  const path: string[] = []

  const visit = (transform: FeatureTransform): void => {
    if (done.has(transform.id)) return
    if (onPath.has(transform.id)) {
      const cycle = [...path.slice(path.indexOf(transform.id)), transform.id].join(' → ')
      throw new RecoError(
        'DEPENDENCY_CYCLE',
        `Feature transforms form a cycle: ${cycle}. Each of these waits for a feature another one ` +
          `in the loop has not produced yet, so there is no order in which they can run.`,
      )
    }

    onPath.add(transform.id)
    path.push(transform.id)
    for (const key of transform.requires) {
      const producer = producers.get(key)
      if (producer === undefined) {
        throw new MissingFeatureError(key, transform.id, 'no extractor or transform provides it')
      }
      // Extractors all run on stage 3, before every transform, so an extractor-provided
      // input imposes no ordering here — only transform-to-transform edges do.
      const upstream = byId.get(producer)
      if (upstream !== undefined) visit(upstream)
    }
    path.pop()
    onPath.delete(transform.id)

    done.add(transform.id)
    sorted.push(transform)
  }

  for (const transform of transforms) visit(transform)
  return sorted
}
