/**
 * `@recoengine/core` — algorithmic, explainable, domain-agnostic recommendation engine.
 *
 * Not AI. Not an LLM. A deterministic ranking machine: given a user, a history and
 * a set of candidates, it produces a ranked list where every item can say why it is
 * there.
 *
 * @packageDocumentation
 */

export type { Brand } from './domain/brand.js'
export { type Candidate, type CandidateSet, CandidateSetBuilder } from './domain/candidate.js'
export type { Event, EventType, History, Item, User } from './domain/entities.js'
export type { Explanation, ScoreTrace } from './domain/explanation.js'
export {
  type FeatureDescriptor,
  type FeatureKind,
  type FeatureSchema,
  FeatureSchemaBuilder,
  type FeatureSchemaVersion,
  type MutableFeatureSchema,
} from './domain/feature.js'
export { type HistoryIndex, MapHistoryIndex } from './domain/history.js'
export {
  type EventId,
  eventId,
  type FeatureKey,
  featureKey,
  type ItemId,
  itemId,
  type PluginName,
  pluginName,
  type StrategyId,
  strategyId,
  type Timestamp,
  timestamp,
  type UserId,
  userId,
} from './domain/ids.js'
export { DenseFeatureMatrix, type FeatureMatrix } from './domain/matrix.js'
export { DenseProfileVector, type MutableProfileVector, type ProfileVector } from './domain/profile.js'
export type { Reason } from './domain/reason.js'
export type {
  Diagnostics,
  DiagnosticWarning,
  Recommendation,
  RecommendationResult,
  StageTiming,
} from './domain/recommendation.js'
export {
  type ContributionKind,
  contributionOf,
  type MutableScoreBoard,
  type ScoreBoard,
  ScoreBoardBuilder,
  type ScoreColumn,
  type ScoreContribution,
} from './domain/score.js'
export { createEngine, type EngineBlueprint, EngineBuilder } from './kernel/builder.js'
export {
  type ConfigIssue,
  ConfigResolver,
  type ConfigSchema,
  type DeepPartial,
  type EngineConfig,
  type ErrorPolicy,
  type ResolvedConfig,
} from './kernel/config.js'
export { type Binding, type Container, DefaultContainer } from './kernel/container.js'
export {
  BuilderSealedError,
  FeatureCollisionError,
  MissingFeatureError,
  RecoError,
  type RecoErrorCode,
} from './kernel/errors.js'
export { asPlugin, isPlugin, type Plugin, type Usable } from './kernel/plugin.js'
export type { Registry, ResolvedRegistry, SlotOptions } from './kernel/registry.js'
export { CACHE, CLOCK, LOGGER, METRICS, RNG, type Token, token } from './kernel/token.js'
export { FilterErrorBudget, isAbort } from './pipeline/policy.js'
export { deadlineOf, type RecommendationRequest, resolveRequest } from './pipeline/request.js'
export { DiagnosticsCollector, STAGES, type StageId, stageInfo } from './pipeline/stage.js'
export * from './ports/index.js'
