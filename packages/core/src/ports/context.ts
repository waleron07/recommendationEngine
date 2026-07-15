import type { User } from '../domain/entities.js'
import type { HistoryIndex } from '../domain/history.js'
import type { Timestamp } from '../domain/ids.js'
import type { ResolvedConfig } from '../kernel/config.js'
import type { Logger, Rng } from './infra.js'

/**
 * How the engine behaves when this extension throws. Default: `'required'` — fail loudly.
 *
 * The default is deliberate. An extractor whose features silently became zeros is the
 * invisible catastrophe: every score shifts, nothing looks broken, and the regression is
 * found three weeks later in a business metric. Degradation must be someone's decision,
 * not the path of least resistance.
 */
export interface Criticality {
  readonly criticality?: 'required' | 'optional'
}

/**
 * Pushed *into* the provider, not applied after it.
 *
 * Trimming a million rows after `SELECT` protects the response and not the database: the
 * query already ran, the memory was already allocated. That is a DOS masked, not
 * prevented. A provider is obliged to translate `maxItems` into its source's LIMIT; the
 * engine trims on top only as a second line of defence, with a warning.
 */
export interface RetrievalBudget {
  readonly maxItems: number
  readonly deadline: Timestamp
}

/** Structured warning. Diagnostics are part of the response, not a line in a log file. */
export interface DiagnosticWarning {
  readonly stage: string
  readonly port: string
  readonly code: 'port_failed' | 'not_applicable' | 'degraded' | 'quota_unfilled' | 'schema_default'
  readonly message: string
  readonly cause?: unknown
}

/**
 * Where ports write warnings. Not `console`: a library that prints to stdout has made a
 * decision that belongs to the host application.
 */
export interface DiagnosticsSink {
  warn(warning: DiagnosticWarning): void
}

/**
 * Everything one request carries. Frozen at stage 0 and passed to every port.
 *
 * `signal` is not optional. The engine always constructs one — from the caller's signal
 * and `limits.timeoutMs` — so a port author can never say "no signal was given". A port
 * doing I/O is obliged to pass it down; a port with a long CPU loop is obliged to call
 * `throwIfAborted()` roughly every 1024 iterations. Single-threaded JS cannot be
 * interrupted from outside: cooperation is the only mechanism there is.
 */
export interface RequestContext<UP = unknown> {
  readonly user: User<UP>
  readonly history: HistoryIndex
  readonly now: Timestamp
  readonly limit: number
  readonly offset: number
  readonly explain: 'none' | 'reasons' | 'full'
  /**
   * Deliberately untyped bag: time of day, device, weather, mood.
   *
   * The one concession in the contract. Context is irreducibly domain-specific, and any
   * type the core picked would be wrong for someone. Domains narrow it by declaration
   * merging on their side.
   */
  readonly signals: ReadonlyMap<string, unknown>
  readonly config: ResolvedConfig
  readonly rng: Rng
  readonly logger: Logger
  readonly diagnostics: DiagnosticsSink
  readonly signal: AbortSignal
}
