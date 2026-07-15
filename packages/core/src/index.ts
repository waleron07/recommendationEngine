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
export type { Event, EventType, History, Item, User } from './domain/entities.js'
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
export {
  BuilderSealedError,
  FeatureCollisionError,
  MissingFeatureError,
  RecoError,
  type RecoErrorCode,
} from './kernel/errors.js'
