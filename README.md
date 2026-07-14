# recoengine

Algorithmic, explainable, domain-agnostic recommendation engine for TypeScript.

**Not AI. Not an LLM.** A deterministic ranking machine: give it a user, a history and a set of
candidates, and every item in the result can tell you why it is there.

> **Status: pre-alpha.** The architecture is designed and agreed ([ARCHITECTURE.md](./ARCHITECTURE.md));
> the scaffold is in place. The engine itself is not implemented yet — see [Roadmap](#roadmap).
> Nothing is published to npm.

## The idea

Elasticsearch is a search engine for *anything* because it separates two concerns: the mapping knows
your domain, the scoring knows the maths, and they never touch. `recoengine` applies the same split
to recommendations.

Domain knowledge turns into numbers inside **feature extractors**. Everything downstream — scoring,
normalization, ranking, diversification, explanation — works on numbers only. A `ScoringStrategy`
physically cannot reach `item.payload.artist`; the compiler forbids it.

The payoff: adding movies to a library built for music means writing a candidate provider and one or
two extractors. Strategies, ranking, diversification and explanations are reused unchanged.

```
Input → Candidate Provider → Feature Extraction → Feature Engineering
      → Scoring → Normalization → Ranking → Diversification
      → Recommendation → Explanation
```

## Packages

| Package | Purpose | Deps |
|---|---|---|
| `@recoengine/core` | Pipeline, ports, scoring, explainability | **zero** |
| `@recoengine/features` | Domain-neutral extractors and transforms | core |
| `@recoengine/strategies` | Domain-neutral scoring strategies | core |
| `@recoengine/modifiers` | Fatigue, novelty, boosts | core |
| `@recoengine/diversity` | MMR, quotas, similarity | core |
| `@recoengine/testing` | Fixtures, golden runner, port contracts | core |
| `recoengine` | Batteries-included meta package | all of the above |

`@recoengine/core` has zero runtime dependencies and no Node API, so it runs on Node, Bun, Deno and
in the browser. Both claims are enforced in CI, not just promised here: `tsconfig` sets `types: []`
(so `process` and `Buffer` do not exist), and `scripts/check-arch.mjs` rejects `node:*` imports and
any dependency pointing the wrong way.

## Design highlights

- **Explainability by construction.** Contributions accumulate through the pipeline; you cannot
  compute a score without leaving a trail. `engine.explain(itemId)` also answers the harder
  question — why an item is *missing* from the results.
- **Errors at `build()`, not at 3am.** A strategy requiring a feature nobody provides fails at
  startup, not with a silent `NaN` in production.
- **Fail-closed filters.** Age gates, licensing and GDPR rules are structurally unable to fail open.
- **Deterministic.** No `Math.random()`, no `Date.now()` — `Rng` and `Clock` are injected, so
  exploration is reproducible and testable.

## Development

```bash
pnpm install
pnpm ci        # lint + architecture guard + build + test
```

| Command | Does |
|---|---|
| `pnpm build` | `tsc --build` across the workspace |
| `pnpm test` | Vitest |
| `pnpm lint` | Biome (`pnpm lint:fix` to apply) |
| `pnpm check:arch` | Zero-dep core, leftward deps, no Node API in core |
| `pnpm docs` | Typedoc |

Requires Node 20+ and pnpm 10+. ESM only, no CommonJS build.

## Roadmap

Stage 0 (scaffold) is done. Stages follow [ARCHITECTURE.md §22](./ARCHITECTURE.md#22-план-реализации):

| Stage | Content | Status |
|---|---|---|
| 0 | Workspace, TS, Biome, Vitest, Typedoc, CI, architecture guard | done |
| 1 | Domain: ids, `FeatureMatrix`, `ProfileVector`, `ScoreBoard`, `HistoryIndex` | next |
| 2 | Kernel: container, builder/registry, plugins, config, schema freeze | |
| 3 | Pipeline: stages, middleware, cancellation, error policy | |
| 4 | Maths: normalizers, similarity, MMR, RRF, decay, heap, RNG | |
| 5–8 | Strategies, modifiers, diversity, explainability | |
| 9 | Music example | |
| 10 | E-commerce example — the acceptance test for domain independence | |
| 11 | Docs, benchmarks, `v0.1.0` | |

Stage 10 is not a demo. If a second domain requires touching `core`, the abstraction leaked and gets
fixed before release.

## License

MIT
