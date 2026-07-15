/**
 * Stable, machine-readable error codes.
 *
 * Every code below is raised at `build()` time rather than per request, with two
 * exceptions (`REQUEST_LIMIT_EXCEEDED`, `PORT_FAILED`) that are inherently
 * request-scoped. That split is the point: a misconfigured engine must refuse to
 * start, not to degrade quietly at 3am.
 */
export type RecoErrorCode =
  /** A strategy requires a feature no extractor provides. Raised by `build()`. */
  | 'MISSING_FEATURE'
  /** Two extractors declare the same feature key. Raised by `build()`. */
  | 'FEATURE_COLLISION'
  /** `use()` or `register()` called after `build()` sealed the builder. */
  | 'BUILDER_SEALED'
  /** A cycle in plugin `dependsOn` or in feature transform ordering. */
  | 'DEPENDENCY_CYCLE'
  /** Config failed schema validation, or a mandatory limit was omitted. */
  | 'INVALID_CONFIG'
  /** Two plugins claim the same single-slot port without `override: true`. */
  | 'SLOT_CONFLICT'
  /** `request.limit` exceeds `limits.maxLimit`. */
  | 'REQUEST_LIMIT_EXCEEDED'
  /** A port threw and the active error policy escalated it. */
  | 'PORT_FAILED'

/**
 * Base class for every error the engine raises on purpose.
 *
 * Carries a stable `code` so callers can branch without string-matching messages,
 * and preserves the underlying failure in `cause` rather than swallowing it.
 */
export class RecoError extends Error {
  readonly code: RecoErrorCode

  constructor(code: RecoErrorCode, message: string, options?: { cause?: unknown }) {
    super(message, options)
    this.name = 'RecoError'
    this.code = code
  }
}

/** Raised by `build()` when a strategy requires a feature nobody provides. */
export class MissingFeatureError extends RecoError {
  constructor(featureKey: string, requiredBy: string, why = 'no extractor provides it') {
    super(
      'MISSING_FEATURE',
      `Feature "${featureKey}" is required by "${requiredBy}" but ${why}. ` +
        `Register an extractor that declares it, or remove "${requiredBy}".`,
    )
    this.name = 'MissingFeatureError'
  }
}

/** Raised by `build()` when two extractors declare the same feature key. */
export class FeatureCollisionError extends RecoError {
  constructor(featureKey: string, existingOwner: string, newOwner: string) {
    super(
      'FEATURE_COLLISION',
      `Feature "${featureKey}" is declared by both "${existingOwner}" and "${newOwner}". ` +
        `Two extractors writing one key means one silently wins; rename one of them.`,
    )
    this.name = 'FeatureCollisionError'
  }
}

/** Raised when the builder is mutated after `build()` froze it. */
export class BuilderSealedError extends RecoError {
  constructor(operation: string) {
    super(
      'BUILDER_SEALED',
      `Cannot call "${operation}" after build(). The registry and feature schema are frozen, ` +
        `so the feature matrix always matches schema.version. Create a new builder instead.`,
    )
    this.name = 'BuilderSealedError'
  }
}
