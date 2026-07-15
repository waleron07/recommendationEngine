import type { Clock, FeatureCache, Logger, Metrics, Rng } from '../ports/infra.js'

/**
 * A typed key into the container.
 *
 * `T` appears only in the phantom field, which exists at compile time and never at
 * runtime. Without it `Token<Clock>` and `Token<Rng>` would be the same structural type
 * — both `{ key, description }` — and `container.get(CLOCK)` would happily hand back the
 * Rng with the compiler's blessing. The function type is what pins the variance: a bare
 * `readonly __type?: T` would still let `Token<Clock>` flow into `Token<unknown>`.
 */
export interface Token<T> {
  readonly key: symbol
  readonly description: string
  /** Phantom. Never assigned, never read, never present. Do not touch. */
  readonly __type?: (value: T) => T
}

/**
 * Mints a token. The symbol is fresh every call, so two tokens with the same description
 * are still two different tokens — identity is the symbol, not the string.
 */
export function token<T>(description: string): Token<T> {
  return { key: Symbol(description), description }
}

/**
 * The infrastructure the engine binds for itself. Everything else is the host's.
 *
 * They are tokens rather than constructor parameters because they are needed deep inside
 * the pipeline, and threading a `Clock` through sixteen stages to reach one modifier is
 * how a codebase acquires a `god object` parameter.
 */
export const CLOCK: Token<Clock> = token<Clock>('Clock')
export const RNG: Token<Rng> = token<Rng>('Rng')
export const LOGGER: Token<Logger> = token<Logger>('Logger')
export const METRICS: Token<Metrics> = token<Metrics>('Metrics')
export const CACHE: Token<FeatureCache> = token<FeatureCache>('FeatureCache')
