/**
 * The exact platform surface `@recoengine/core` requires. Nothing else exists here.
 *
 * `lib: ["ES2022"]` and `types: []` (§23.4) mean the core compiles against no DOM and no
 * Node typings, which is what makes "this package uses no environment API" a build error
 * rather than a promise in the README. `AbortSignal` is the one casualty of that: it is a
 * genuine cross-platform standard — Node 20+, Deno, Bun, every browser — but TypeScript
 * ships its declaration inside `lib.dom.d.ts`, bundled with `window`, `document` and
 * `fetch`.
 *
 * Pulling in the DOM lib to get one type would hand the core `localStorage` and `fetch`
 * as well, and the guard would be gone: the first accidental `fetch()` in an extractor
 * would compile. Declaring the surface we actually depend on keeps the guard intact and
 * states the platform contract explicitly — this, and only this, is what a host runtime
 * must provide.
 *
 * Ambient and file-local: it is not emitted into `dist`, so a consumer resolves
 * `AbortSignal` from their own lib as usual.
 */

interface AbortSignal {
  readonly aborted: boolean
  readonly reason: unknown
  /** The contract of §17.1 rule 3: long CPU loops call this every ~1024 iterations. */
  throwIfAborted(): void
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

declare var AbortSignal: {
  prototype: AbortSignal
  abort(reason?: unknown): AbortSignal
  /** `limits.timeoutMs` becomes this. */
  timeout(milliseconds: number): AbortSignal
  /** How the caller's signal and the engine's timeout become the one signal in `ctx`. */
  any(signals: readonly AbortSignal[]): AbortSignal
}

interface AbortController {
  readonly signal: AbortSignal
  abort(reason?: unknown): void
}

declare var AbortController: {
  prototype: AbortController
  new (): AbortController
}
