/**
 * `@recoengine/features` — reusable, domain-neutral extractors and transforms.
 *
 * The standard strategies (`@recoengine/strategies`) read features with fixed names —
 * `interaction_count`, `interaction_recency`, and so on. Someone has to produce those, and
 * for the ones that come from the *interaction history* rather than from `Item.payload`,
 * that producer is domain-neutral: counting events keyed by `ItemId` and decaying their
 * recency is the same arithmetic whether the items are tracks or products. This package
 * ships those producers, so a host gets history-based scoring without writing domain code.
 *
 * - **Extractors** read `ctx.history` and `ctx.now` — never the payload — which is exactly
 *   what keeps them reusable across domains.
 * - **Transforms** are pure maths over columns (`log1p` compression, decay curves), domain-
 *   neutral by construction.
 *
 * Features that genuinely need the payload — an item's own age, its category, a
 * precomputed co-occurrence score — stay in the host's domain extractors, because only the
 * host knows where in the payload they live. This package is the part that doesn't.
 *
 * @packageDocumentation
 */

export {
  type InteractionCountOptions,
  type InteractionRecencyOptions,
  interactionCountExtractor,
  interactionRecencyExtractor,
} from './interaction.js'
export type { FeatureRef } from './internal.js'
export {
  type DecayTransformOptions,
  decayTransform,
  type LogTransformOptions,
  logTransform,
} from './transforms.js'
