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
export {
  BuilderSealedError,
  FeatureCollisionError,
  MissingFeatureError,
  RecoError,
  type RecoErrorCode,
} from './kernel/errors.js'
