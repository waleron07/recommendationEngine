# Releasing

The version bump for `0.1.0` is already applied (via `changeset version`): every
publishable package sits at `0.1.0` with a generated `CHANGELOG.md`, and the facade
(`recoengine`) re-exports the full plugin set. What remains is the one step that cannot be
done without npm credentials — the actual publish.

## What is already done

- All seven publishable packages at `0.1.0`; the two `examples/*` are `private` and never publish.
- `CHANGELOG.md` per package, generated from the changeset.
- `recoengine` facade re-exports core + strategies + modifiers + diversity + features.
- `pnpm verify` green: 0 lint warnings, architecture check passing, 672 tests.

## Prerequisites (one-time)

npm 2FA on this org is set to `auth-and-writes`, so a classic token will not publish from
CI. Use **one** of:

- **Trusted Publishing (OIDC)** — configure the packages on npmjs.com to trust this repo's
  GitHub Actions workflow. No token in CI; npm verifies the workflow's OIDC identity. This
  is the recommended path.
- **Granular access token** — create one scoped to the `recoengine` org with publish
  rights, store it as the `NPM_TOKEN` secret, and have the workflow write it to `.npmrc`.

The `recoengine` org exists; `waleron` is the owner (`npm org ls recoengine`).

## Publishing

From a clean `main` with the version bump committed:

```bash
pnpm install
pnpm release        # runs `pnpm verify`, then `changeset publish`
```

`changeset publish` publishes only packages whose version is not yet on npm, and replaces
each `workspace:*` internal dependency with the concrete `0.1.0` range at pack time.

To publish by hand instead:

```bash
pnpm verify
pnpm -r --filter='./packages/*' publish --access public --no-git-checks
```

## After publishing

- Tag the release: `git tag v0.1.0 && git push --tags`.
- Update `README.md`'s **Install** section from "build from source" to `npm i recoengine`.
- The next change starts a new changeset (`pnpm changeset`), and the cycle repeats.

## Known limitations shipped in 0.1.0

Listed in the changeset and in [PROGRESS.md](./PROGRESS.md) §5 — none block use, but they
belong in the release notes: no `softmax` normalizer; `container.child()` request-scope
unused; a product combiner is not expressible through the board's re-fold; `cosine`
underflows below ~1.5e-162 (unreachable for real data).
