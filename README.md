# recoengine

Algorithmic, explainable, domain-agnostic recommendation engine for TypeScript.

**Not AI. Not an LLM.** A deterministic ranking machine: give it a user, a history and a set of
candidates, and every item in the result can tell you why it is there — as data, not as prose.

> **Status: pre-alpha. Nothing is published to npm yet.**
> The engine works end to end: retrieval → filtering → features → scoring → normalization →
> combination → modifiers → ranking → diversification → explanation. 672 tests; CI green on
> Node 20/22/24, Bun and Deno. The batteries are built too — strategies, modifiers, diversity,
> reusable features and the testing kit all ship the standard plugins (stages 5–8а). Two full
> domains — a music recommender ([`examples/music`](./examples/music)) and an e-commerce one
> ([`examples/ecommerce`](./examples/ecommerce)) — run on those same packages with **zero
> changes to the core**, which is the abstraction's acceptance test. The `v0.1.0` release is
> prepared — batteries-included `recoengine` facade, changelogs, zero lint warnings — and only
> the npm publish itself remains ([RELEASING.md](./RELEASING.md)). The public API may still
> change. Current state: [PROGRESS.md](./PROGRESS.md).

## The idea

Elasticsearch is a search engine for *anything* because it separates two concerns: the mapping knows
your domain, the scoring knows the maths, and they never touch. `recoengine` applies the same split
to recommendations.

Domain knowledge turns into numbers inside **feature extractors**. Everything downstream — scoring,
normalization, ranking, diversification, explanation — works on numbers only. A `ScoringStrategy`
physically cannot reach `item.payload.artist`: it is never handed the payload, and the compiler
enforces it.

Two consequences follow, and they are the whole point:

- **The same engine serves music, e-commerce and news.** Swap the extractors, keep everything else.
- **Errors surface at startup, not at 3am.** A strategy needing a feature nobody provides fails at
  `build()` — the way a mapping error in Elasticsearch fails at index time rather than at search time.

## Install

Not on npm yet. To try it, build from source:

```bash
git clone https://github.com/waleron07/recommendationEngine.git
cd recommendationEngine
pnpm install
pnpm verify     # lint + architecture check + build + 672 tests
```

Then import from `packages/core/src`, or run `pnpm build` and import from `packages/core/dist`.

Once stage 11 lands this section becomes `npm i recoengine` — the unscoped package will be the
batteries-included facade; `@recoengine/core` is the zero-dependency core.

## Example

A complete engine: it recommends tracks the user has not played yet, favouring the popular ones, and
explains itself. Every line is real API, and the example below is
[under test](./packages/core/src/readme-example.test.ts) — it compiles, runs, and produces the
output shown. Only `db` is yours to supply.

```ts
import {
  createEngine, featureKey, itemId, rank, strategyId, userId,
  type CandidateProvider, type FeatureExtractor, type PreFilter, type ScoringStrategy,
} from '@recoengine/core'

interface Track {
  readonly title: string
  readonly plays: number
}

const POPULARITY = featureKey('popularity')

// 1. WHERE CANDIDATES COME FROM — the only place allowed to touch your database.
//    The budget is pushed in rather than applied afterwards: trimming a million rows after
//    SELECT protects the response and not the database. Translate it into your LIMIT.
const library: CandidateProvider<Track> = {
  id: 'library',
  version: '1.0.0',
  provide: async (_ctx, budget) => {
    const rows = await db.tracks.findMany({ take: budget.maxItems })
    return rows.map((row) => ({
      id: itemId(row.id),
      type: 'track',
      payload: { title: row.title, plays: row.plays },
    }))
  },
}

// 2. HARD RULES, decided from the payload alone, before anything expensive.
//    Fail-closed by contract: approve() is synchronous and total, and a throw counts as "no".
const notPlayedYet: PreFilter<Track> = {
  id: 'not-played-yet',
  failClosed: true,
  approve: (candidate, ctx) => !ctx.history.hasSeen(candidate.item.id),
}

// 3. DOMAIN KNOWLEDGE → NUMBERS. The only component that knows what a track is.
//    Batched over the whole set on purpose: one query, not five thousand.
const popularity: FeatureExtractor<Track> = {
  id: 'popularity-extractor',
  version: '1.0.0',
  provides: [
    {
      key: POPULARITY,
      kind: 'numeric',
      // What absence means, decided by whoever owns the feature. Not decoration: this is
      // what an `optional` extractor degrades to when it fails.
      defaultValue: 0,
      description: 'lifetime play count',
      owner: 'popularity-extractor',
      ownerVersion: '1.0.0',
    },
  ],
  extract: async (set, out) => {
    const column = out.columnMut(POPULARITY)
    for (let row = 0; row < set.size; row++) column[row] = set.at(row).item.payload.plays
  },
}

// 4. THE MATHS. Knows nothing about tracks — it reads a column of numbers.
//    `requires` is checked at build(): get the key wrong and the application will not start.
const popular: ScoringStrategy = {
  id: strategyId('popularity'),
  requires: [POPULARITY],
  // The strategy knows its own scale. One viral track at 4,200,000 plays would flatten
  // min-max, so it asks for `rank`, which discards magnitudes and keeps the order.
  normalizer: rank,
  score: (view) => ({
    strategyId: strategyId('popularity'),
    raw: view.items.column(POPULARITY),
    reasons: new Map(),
  }),
}

const engine = createEngine<Track>()
  .use(library)
  .use(notPlayedYet)
  .use(popularity)
  .use(popular)
  .configure({
    // Mandatory, without defaults. Omit them and build() throws INVALID_CONFIG: there is no
    // honest default for "how much of my database may one request touch".
    limits: { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 },
    weights: { popularity: 1.0 },
  })
  .build() // ← throws here if a feature is missing or the config does not hold together

const result = await engine.recommend({
  user: { id: userId('u1'), payload: {} },
  history: { userId: userId('u1'), events: [] },
  limit: 10,
  explain: 'reasons',
})

for (const { rank: position, item, score, explanation } of result.recommendations) {
  console.log(`${position}. ${item.payload.title} — ${score.toFixed(1)}`)
  for (const c of explanation.contributions) {
    console.log(`     ${c.strategyId}: raw ${c.raw} → ${c.contribution.toFixed(3)}`)
  }
}

// Diagnostics are part of the answer, not a log line — so an empty feed explains itself.
console.log(result.diagnostics)
// { totalMs: 2, retrieved: 3, filtered: 0, stages: [...16 timings], warnings: [] }
```

Against the three tracks in the test, that prints:

```
1. The Hit — 100.0
     popularity: raw 4200000 → 1.000
2. Middling — 50.0
     popularity: raw 900 → 0.500
3. Quiet One — 0.0
     popularity: raw 12 → 0.000
```

Note the middle row. `rank` is why it says 50 and not 0.02: under min-max one viral track at
4,200,000 plays would squash 900 and 12 into the same hair above zero, and the column would stop
distinguishing anything at all. That is the choice `normalizer` exists to give the strategy.

### What that example buys you

**Add a strategy, and the weights still mean what they said.** Every column is normalized to
`[0..1]` and the total is divided by `Σ weights`, so `artist: 0.9` against `popularity: 0.3` reads
as "artist matters three times more" — and stays true when a ninth strategy joins.

**Cold start costs nothing.** Give a strategy `applicable: (ctx) => ctx.history.size >= 20` and a new
user simply gets the strategies that can speak to them, with the rest of the weight redistributed.
No `if (isNewUser)` anywhere in the core.

**Nothing degrades quietly.** A failing extractor fails the request by default. Mark it
`criticality: 'optional'` and it degrades to the feature's declared `defaultValue` — with a
structured warning in `diagnostics` and a `reco.degraded` metric, because degradation nobody
measures is a slow quality regression.

**It is reproducible.** The RNG is seeded (xoshiro128\*\*), so the same user gets the same feed
twice: a bug report can be replayed, and an A/B test measures the variant rather than the scheduler.

## Packages

| Package | What | Deps | Status |
|---|---|---|---|
| `@recoengine/core` | Domain, ports, kernel, pipeline, maths | **zero** | works |
| `recoengine` | Unscoped facade for a quick start | core | re-exports core |
| `@recoengine/strategies` | History, affinity, popularity, recency, … | core | built (stage 5) |
| `@recoengine/modifiers` | Fatigue, novelty, boost | core | built (stage 6) |
| `@recoengine/testing` | Fixtures and port contracts | core | built (stage 6а) |
| `@recoengine/diversity` | MMR, quotas, similarity providers, blender | core | built (stage 7) |
| `@recoengine/features` | Reusable extractors and transforms | core | built (stage 8а) |

## Design highlights

- **Isomorphic, and the compiler proves it.** `core` imports no environment API at all: `lib` without
  DOM and `types: []` mean `process`, `Buffer` and `window` do not exist inside it. Not a promise in
  a README — a build error. CI runs Node 20/22/24, Bun and Deno.
- **`score()` is synchronous, forever.** Not an optimization but a guard on the I/O → extraction →
  maths split. An `async score()` is a door, and "just fetch one value from Redis" walks through it.
- **Explainability is structural.** The board cannot hold a score without holding what produced it,
  so `Σ contributions = score` is true by construction rather than by discipline.
- **Filters are fail-closed by contract**, not by configuration: no `criticality`, a synchronous and
  total `approve()`, and an exception counts as refusal. What is not explicitly approved is not shown.
- **The pipeline is fixed; the ports are the extension.** A pipeline anyone can splice into is one
  nobody can reason about — "when does my filter run" becomes "it depends who else is installed".

Full reasoning: [ARCHITECTURE.md](./ARCHITECTURE.md).

## Development

```bash
pnpm verify     # lint + check:arch + build + test — what CI runs
pnpm test       # 672 tests
pnpm bench      # benchmarks: they measure, they do not assert
pnpm docs       # typedoc
```

`pnpm verify`, not `pnpm ci` — `ci` is reserved by pnpm and would exit 0 without running anything.

The architecture guard (`scripts/check-arch.mjs`) is not a formality: it fails the build if `core`
gains a dependency, imports `node:*`, or if a package depends rightwards. All four rules were
verified by breaking them on purpose.

## Roadmap

Stages follow [ARCHITECTURE.md §22](./ARCHITECTURE.md#22-план-реализации); current state and open
debts live in [PROGRESS.md](./PROGRESS.md).

| Stage | Content | Status |
|---|---|---|
| 0 | Workspace, TS, Biome, Vitest, Typedoc, CI, architecture guard | done |
| 1 | Domain: ids, `FeatureMatrix`, `ProfileVector`, `ScoreBoard`, `HistoryIndex` | done |
| 2 | Kernel: container, builder/registry, plugins, config, feature-graph validation | done |
| 3 | Pipeline: 16 stages, middleware, cancellation, error policy | done |
| 4 | Maths: normalizers, similarity, RRF, decay, heap, seeded RNG | done |
| 5 | `@recoengine/strategies` — nine strategies | done |
| 6 | `@recoengine/modifiers` — fatigue, novelty, boost | done |
| 6а | `@recoengine/testing` — fixtures and port contracts | done |
| 7 | `@recoengine/diversity` — MMR, quotas, similarity, blender | done |
| 8 | Explainability — trace, rounded scale, `engine.explain()` | done |
| 8а | `@recoengine/features` — reusable extractors and transforms | done |
| 9 | Music example (`examples/music`) — zero core changes | done |
| 10 | E-commerce example (`examples/ecommerce`) — domain-independence acceptance test | done |
| 11 | `v0.1.0` — batteries-included facade, changelogs, zero warnings | ready; publish pending |

Stage 10 is not a demo. If a second domain requires touching `core`, the abstraction leaked and gets
fixed before release.

## License

MIT
