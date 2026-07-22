/**
 * `recoengine` — batteries-included entry point.
 *
 * Re-exports the core plus the full standard plugin set: the nine strategies, the three
 * modifiers, the diversifiers and blender, and the reusable feature extractors. `npm i
 * recoengine` gives you everything; `import { createEngine, popularityStrategy } from
 * 'recoengine'` just works.
 *
 * If you want the zero-dependency core and hand-picked plugins instead, depend on
 * `@recoengine/core` and add only the packages you use — the tree stays smaller and every
 * dependency is one you chose.
 *
 * The re-exports are explicit rather than `export *` so a name that two packages happen to
 * share (only `FeatureRef` today) is surfaced once, deliberately, rather than silently
 * dropped by an ambiguous star.
 *
 * @packageDocumentation
 */

export * from '@recoengine/core'
// Diversification and blending (§14–§15).
export {
  type AttributeQuotaOptions,
  attributeQuotaDiversifier,
  type Bucket,
  type BucketBlenderOptions,
  bucketBlender,
  type CosineSimilarityOptions,
  cosineSimilarity,
  jaccardSimilarity,
  type MmrOptions,
  mmrDiversifier,
  type WeightedJaccardSimilarityOptions,
} from '@recoengine/diversity'
// Reusable, domain-neutral feature producers (§11.3.1).
export {
  type DecayTransformOptions,
  decayTransform,
  type InteractionCountOptions,
  type InteractionRecencyOptions,
  interactionCountExtractor,
  interactionRecencyExtractor,
  type LogTransformOptions,
  logTransform,
} from '@recoengine/features'
// Modifiers (§15).
export {
  type BoostModifierOptions,
  boostModifier,
  type FatigueModifierOptions,
  fatigueModifier,
  type NoveltyModifierOptions,
  noveltyModifier,
  saturationOf,
} from '@recoengine/modifiers'
// Strategies (§11.3). `FeatureRef` is re-exported once here for the whole facade — the
// diversity and features packages export the same type, and one is enough.
export {
  type AffinityStrategyOptions,
  affinityStrategy,
  type ContextStrategyOptions,
  type CoOccurrenceStrategyOptions,
  contextStrategy,
  coOccurrenceStrategy,
  type DiscoveryStrategyOptions,
  discoveryStrategy,
  type FeatureRef,
  type HistoryStrategyOptions,
  historyStrategy,
  type NoveltyStrategyOptions,
  noveltyStrategy,
  type PopularityStrategyOptions,
  popularityStrategy,
  type RecencyStrategyOptions,
  recencyStrategy,
  type SimilarityStrategyOptions,
  type StrategyOptions,
  similarityStrategy,
} from '@recoengine/strategies'
