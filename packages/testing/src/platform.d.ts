/**
 * The platform surface `@recoengine/testing` needs, mirrored from `@recoengine/core`.
 *
 * Same reasoning as core's own `platform.d.ts` (§23.4): `lib: ["ES2022"]` and `types: []`
 * keep the DOM and Node typings out, so `AbortSignal`/`AbortController` — a genuine
 * cross-platform standard that TypeScript ships only inside `lib.dom.d.ts` — have to be
 * declared explicitly. The contract kit builds aborted signals to test cancellation
 * (§17.1), and this is the one platform type it depends on. Ambient and file-local; not
 * emitted to `dist`.
 */

interface AbortSignal {
  readonly aborted: boolean
  readonly reason: unknown
  throwIfAborted(): void
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void
  removeEventListener(type: 'abort', listener: () => void): void
}

declare var AbortSignal: {
  prototype: AbortSignal
  abort(reason?: unknown): AbortSignal
  timeout(milliseconds: number): AbortSignal
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
