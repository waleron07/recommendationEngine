/**
 * The sliver of the Node runtime the demo uses, declared locally — same reasoning as
 * `examples/music/src/env.d.ts`. The example builds with `types: []` and `lib: ["ES2022"]`,
 * so `console` and `process` are not in scope; rather than pull in `@types/node`, it
 * declares the two globals it touches. Ambient and file-local; not emitted.
 */

declare const console: {
  log(...args: unknown[]): void
  error(...args: unknown[]): void
}

declare const process: {
  exitCode?: number
}
