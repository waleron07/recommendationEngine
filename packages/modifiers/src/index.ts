/**
 * `@recoengine/modifiers` — the standard stage-8 score modifiers of §15.
 *
 * A modifier corrects a finished score — "is it appropriate to show this now" — where a
 * strategy answers "how well does this fit". The split is load-bearing: fatigue and
 * novelty *multiply* (a subtractive penalty leaves a 0.98 track on top), boosts *add*.
 * Each is a factory returning a `ScoreModifier`, matching the functional style of core
 * and `@recoengine/strategies`.
 *
 * The modifier port hands `apply` only the `CandidateSet` and the `RequestContext` — no
 * feature matrix, no profile — so these read `ctx.history` and `ctx.now` and nothing
 * else. That is why fatigue and novelty are computed from the history's own item
 * distribution rather than from a profile feature.
 *
 * @packageDocumentation
 */

export { type BoostModifierOptions, boostModifier } from './boost.js'
export { type FatigueModifierOptions, fatigueModifier } from './fatigue.js'
export { saturationOf } from './internal.js'
export { type NoveltyModifierOptions, noveltyModifier } from './novelty.js'
