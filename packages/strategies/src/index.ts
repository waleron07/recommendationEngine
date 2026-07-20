/**
 * `@recoengine/strategies` — the nine standard, domain-neutral scoring strategies of
 * ARCHITECTURE.md §11.3.
 *
 * Each is a factory returning a `ScoringStrategy`: it reads one or more feature columns a
 * domain extractor produced, folds them into a single raw column plus its reasons, and
 * declares the normalizer that suits its own scale. None of them looks inside `Item`, and
 * none imports anything from the core beyond its public ports and maths — the dependency
 * rule `core ← strategies` holds not just in `check-arch` but in what these files can say.
 *
 * The lot are functions, not classes, matching the core's own functional exports
 * (`weightedSum`, `sortRanker`) and the structural plugin system, which recognises a
 * strategy by its `score` method and never by `instanceof`. ARCHITECTURE.md §11.3 wrote
 * them as `new AffinityStrategy(...)`; that was reconciled to `affinityStrategy(...)`
 * when this package was built (see PROGRESS §5).
 *
 * @packageDocumentation
 */

export { type AffinityStrategyOptions, affinityStrategy } from './affinity.js'
export { type ContextStrategyOptions, contextStrategy } from './context.js'
export { type CoOccurrenceStrategyOptions, coOccurrenceStrategy } from './cooccurrence.js'
export { type DiscoveryStrategyOptions, discoveryStrategy } from './discovery.js'
export { type HistoryStrategyOptions, historyStrategy } from './history.js'
export type { FeatureRef, StrategyOptions } from './internal.js'
export { type NoveltyStrategyOptions, noveltyStrategy } from './novelty.js'
export { type PopularityStrategyOptions, popularityStrategy } from './popularity.js'
export { type RecencyStrategyOptions, recencyStrategy } from './recency.js'
export { type SimilarityStrategyOptions, similarityStrategy } from './similarity.js'
