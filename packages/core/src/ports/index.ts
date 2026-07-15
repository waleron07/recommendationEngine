/**
 * Every extension point the engine has. This is the whole contract.
 *
 * A port is an interface and never a class: a plugin must be able to be an object
 * literal, so that nothing here depends on `instanceof` surviving a duplicated package
 * in `node_modules`.
 */

export type { Blender } from './blender.js'
export type { PostFilter, PreFilter } from './candidate-filter.js'
export type { CandidateProvider } from './candidate-provider.js'
export type {
  Criticality,
  DiagnosticsSink,
  DiagnosticWarning,
  RequestContext,
  RetrievalBudget,
} from './context.js'
export type { Diversifier, SimilarityProvider } from './diversifier.js'
export type { Explainer } from './explainer.js'
export type { FeatureExtractor, UserFeatureExtractor } from './feature-extractor.js'
export type { FeatureTransform } from './feature-transform.js'
export type { Clock, FeatureCache, Logger, Metrics, Rng } from './infra.js'
export type { StageInfo, StageMiddleware } from './middleware.js'
export type { Ranker } from './ranker.js'
export type { ScoreCombiner } from './score-combiner.js'
export type { ScoreModifier } from './score-modifier.js'
export type { NormalizedColumn, ScoreNormalizer } from './score-normalizer.js'
export {
  type AnyScoringStrategy,
  type DomainScoringStrategy,
  isDomainStrategy,
  type ScoringStrategy,
  type ScoringView,
} from './scoring-strategy.js'
export type { WeightProvider } from './weight-provider.js'
