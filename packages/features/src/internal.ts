import { type FeatureDescriptor, type FeatureKey, featureKey } from '@recoengine/core'

/** A feature named by its key or a plain string (branded on the way in). */
export type FeatureRef = FeatureKey | string

export const toKey = (ref: FeatureRef): FeatureKey => featureKey(ref as string)

/**
 * A numeric feature descriptor, attributed to the port that provides it.
 *
 * `owner` must name the extractor/transform: it is what invalidates the feature cache when
 * that port changes (§6), and `build()` rejects a descriptor attributed to anyone else.
 */
export function numericFeature(
  key: FeatureKey,
  owner: string,
  description: string,
  defaultValue = 0,
): FeatureDescriptor {
  return { key, kind: 'numeric', defaultValue, description, owner, ownerVersion: '1.0.0' }
}
