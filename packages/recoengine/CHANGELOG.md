# recoengine

## 0.1.0

### Minor Changes

- Initial public release (0.1.0).

  Algorithmic, explainable, domain-agnostic recommendation engine. The core is a
  deterministic 16-stage pipeline (retrieval → filtering → features → scoring →
  normalization → combination → modifiers → ranking → diversification → blending →
  explanation) with a zero-dependency, isomorphic core and a structural plugin system.

  Ships the standard plugin set: nine scoring strategies, three modifiers (fatigue,
  novelty, boost), diversification (MMR, attribute quotas, cosine/Jaccard similarity,
  bucket blender), reusable domain-neutral feature extractors and transforms, and a
  port-contract testing kit. `engine.explain(itemId)` reports why an item is — or is
  not — in the feed. Two worked examples (music, e-commerce) demonstrate a second domain
  served with zero changes to the core.

  Known limitations: `container.child()` request-scope is declared but unused;
  `FeatureCache`/`retrievalScore` declared but not yet wired; a product combiner is not
  expressible through the board's re-fold; `cosine` underflows below ~1.5e-162 (unreachable
  for real data).

### Patch Changes

- Updated dependencies
  - @recoengine/core@0.1.0
  - @recoengine/strategies@0.1.0
  - @recoengine/modifiers@0.1.0
  - @recoengine/diversity@0.1.0
  - @recoengine/features@0.1.0
