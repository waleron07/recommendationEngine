# `examples/music`

A complete music recommender built entirely on the published `@recoengine/*` packages —
and the first half of the architecture's **acceptance test**: it serves a real domain with
**zero changes to the core** (`git status packages/core/` is empty on the commit that added
it).

## What it shows

- **Domain lives in extractors only.** `extractors.ts` is the whole of the music-specific
  code: it turns `Track` payloads (artist, genres, plays) and the listening history into
  the numeric features the standard strategies read. Nothing else knows a track from a
  toaster.
- **Everything downstream is off the shelf.** `engine.ts` wires the same `affinityStrategy`,
  `popularityStrategy`, `recencyStrategy`, `historyStrategy`, `fatigueModifier` and
  `attributeQuotaDiversifier` that any domain would use, plus the domain-neutral
  `interactionCount`/`interactionRecency` extractors from `@recoengine/features`.
- **It explains itself.** `engine.explain(itemId)` reports why a track is — or is not — in
  the feed. In the demo, "Yesterday" comes back `diversified_out`: it scored well but the
  "≤ 2 per artist" quota dropped it as the third Beatles track.

## Run it

```bash
pnpm build
pnpm --filter @recoengine/example-music demo
```

## Files

| File | What |
|---|---|
| `catalogue.ts` | The dataset: eight tracks, three artists, a listening history |
| `extractors.ts` | The only payload-reading code: popularity, age, artist/genre affinity, artist group |
| `engine.ts` | `buildMusicEngine()` — assembles the engine from the published packages |
| `demo.ts` | Prints a feed with reasons, then an `explain()` |
| `music.test.ts` | Seven end-to-end tests |

The e-commerce mirror is [`examples/ecommerce`](../ecommerce/README.md) — the same engine,
a different domain.
