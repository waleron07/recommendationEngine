import type { StrategyId } from '../domain/ids.js'
import type { RequestContext } from './context.js'

/**
 * Stage 0. Supplies weights per request: A/B arms, per-user tuning, weights learned by a
 * bandit outside the engine.
 *
 * This is the door the library deliberately leaves open. The core stays not-AI — it
 * learns nothing, it has no model — but someone who wants to train weights elsewhere can
 * feed them in here without touching a line of it. That is the difference between an
 * algorithmic library and a primitive one.
 *
 * Synchronous: this runs before retrieval on every request, and a network hop here would
 * be on the critical path of every recommendation. Fetch and cache outside; return what
 * you already know.
 */
export interface WeightProvider {
  readonly id: string
  /** Overrides `config.weights` for this request. Missing keys keep the configured value. */
  weights(ctx: RequestContext): ReadonlyMap<StrategyId, number>
}
