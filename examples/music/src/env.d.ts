/**
 * The sliver of the Node runtime the demo uses, declared locally.
 *
 * The example builds with `types: []` and `lib: ["ES2022"]` — the same isomorphic setup as
 * the packages — so `console` and `process` are not in scope. Rather than pull in
 * `@types/node` (and with it a thousand APIs the demo does not touch), it declares the two
 * globals it actually uses. Ambient and file-local; not emitted.
 */

declare const console: {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
}

declare const process: {
  exitCode?: number
}
