# `examples/ecommerce`

A product recommender on the same engine that ranks music — the second half of the
architecture's **acceptance test**. Line up `engine.ts` against
[`examples/music`](../music/README.md): the imports from `@recoengine/*` are byte-for-byte
identical, and only the domain extractors and one prefilter differ. Two unrelated domains,
one engine, **zero changes to the core**.

## What differs from music (and why that's the point)

- **Intent-weighted affinity.** A purchase says far more than a glance, so the brand and
  category affinity extractors weight events (`purchase` 5 ≫ `add_to_cart` 3 ≫ `view` 1).
  That nuance lives entirely inside the domain extractor — the strategy reading the column
  never learns of it.
- **"Already purchased" prefilter.** E-commerce should not re-recommend the fridge you just
  bought, so a fail-closed `PreFilter` drops purchased items. Music did the opposite
  (repeat listening is good). Same port, opposite policy — decided by the domain, not the
  core.

## Run it

```bash
pnpm build
pnpm --filter @recoengine/example-ecommerce demo
```

## Files

| File | What |
|---|---|
| `catalogue.ts` | Eight products, three brands/categories; `view`/`add_to_cart`/`purchase` events |
| `extractors.ts` | The only payload-reading code: popularity, age, intent-weighted brand/category affinity, brand group |
| `engine.ts` | `buildShopEngine()` — the same strategies as music, plus the "not purchased" prefilter |
| `demo.ts` | Prints a feed, then explains why the purchased item is absent |
| `ecommerce.test.ts` | Seven end-to-end tests |
