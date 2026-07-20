/**
 * `@recoengine/diversity` — stage-10 diversification and stage-11 blending (§14–§15).
 *
 * Ranking alone gives a correct but samey feed: twenty tracks by one artist, formally
 * perfect and practically useless. These reorder the ranked list toward variety —
 * `mmrDiversifier` trades relevance against similarity, `attributeQuotaDiversifier` caps
 * per-group counts — and `bucketBlender` mixes in exploration by slot quota. Similarity is
 * a separate port (`cosineSimilarity`, `jaccardSimilarity`) because "how alike are these
 * two" is domain-shaped while MMR is not; keeping them apart is what lets one MMR serve
 * music and e-commerce.
 *
 * Each is a factory returning the matching core port, matching the functional style of the
 * other packages. None reads `Item.payload` — diversity works off the feature matrix and
 * the board, so the dependency rule `core ← diversity` holds in what these files can say.
 *
 * @packageDocumentation
 */

export { type Bucket, type BucketBlenderOptions, bucketBlender } from './blender.js'
export type { FeatureRef } from './internal.js'
export { type MmrOptions, mmrDiversifier } from './mmr.js'
export { type AttributeQuotaOptions, attributeQuotaDiversifier } from './quota.js'
export {
  type CosineSimilarityOptions,
  cosineSimilarity,
  jaccardSimilarity,
  type WeightedJaccardSimilarityOptions,
} from './similarity.js'
