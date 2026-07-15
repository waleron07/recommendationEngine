import type { ScoreBoard } from '../domain/score.js'
import type { RequestContext } from './context.js'

/**
 * Stage 11. Exploration/exploitation: slot quotas, ε-greedy, 70/20/10.
 *
 * After diversification, not before: exploration and diversity would otherwise compete
 * for the same slots, and whichever ran last would win silently. Randomness comes from
 * `ctx.rng`, which is seeded — an exploration bucket that cannot be replayed cannot be
 * debugged, and an A/B test over it measures noise.
 */
export interface Blender {
  readonly id: string
  blend(ranked: readonly number[], board: ScoreBoard, ctx: RequestContext): readonly number[]
}
