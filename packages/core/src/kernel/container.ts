import { RecoError } from './errors.js'
import type { Token } from './token.js'

/** What `bind()` returns: pick a value or a factory, exactly once. */
export interface Binding<T> {
  toValue(value: T): void
  toFactory(factory: (container: Container) => T): void
}

/**
 * Minimal DI. No decorators, no `reflect-metadata`, no autowiring.
 *
 * Roughly 150 lines instead of `inversify`, because both alternatives drag
 * `reflect-metadata` and legacy decorators along, and that breaks two promises at once:
 * zero dependencies and clean ESM. Injection is through constructors, explicitly, and
 * this container exists only for the handful of things that are genuinely ambient —
 * clock, rng, logger, metrics, cache.
 */
export interface Container {
  bind<T>(token: Token<T>): Binding<T>
  /** Throws if unbound. Use when the absence is a wiring bug. */
  get<T>(token: Token<T>): T
  /** `undefined` if unbound. Use when the absence is a legitimate state. */
  tryGet<T>(token: Token<T>): T | undefined
  has(token: Token<unknown>): boolean
  /** A request-scoped child. Reads fall through to the parent; writes stay local. */
  child(): Container
}

interface Entry {
  factory: (container: Container) => unknown
  value?: unknown
  resolved: boolean
}

/**
 * Two scopes, and only two: singleton (the engine's own container) and request
 * (`child()` per `recommend()`).
 *
 * A singleton stays a singleton even when resolved through a child: the entry is
 * memoized in the container that *owns* the binding, and the factory receives that
 * owner. Resolving it against the child instead would quietly give every request its own
 * "singleton" — the kind of bug that only shows up as a cache that never hits.
 */
export class DefaultContainer implements Container {
  private readonly entries = new Map<symbol, Entry>()
  private readonly parent: DefaultContainer | undefined
  /** Guards against `A → B → A` factories, which would otherwise blow the stack. */
  private readonly resolving = new Set<symbol>()
  private sealed = false

  constructor(parent?: DefaultContainer) {
    this.parent = parent
  }

  bind<T>(token: Token<T>): Binding<T> {
    if (this.sealed) {
      throw new RecoError(
        'BUILDER_SEALED',
        `Cannot bind "${token.description}" after build(). The container is frozen so that ` +
          `concurrent requests cannot race on it. Bind before build(), or bind on a child().`,
      )
    }
    if (this.entries.has(token.key)) {
      // Not a silent overwrite: two plugins binding one token means one of them loses,
      // and the loser finds out at 3am. Shadowing in a child() is a different thing and
      // stays legal — that is what request scope is.
      throw new RecoError(
        'SLOT_CONFLICT',
        `Token "${token.description}" is already bound in this container. Two bindings for one ` +
          `token means one silently wins. Rebind on a child() if you meant to override per request.`,
      )
    }

    const set = (factory: (container: Container) => unknown): void => {
      this.entries.set(token.key, { factory, resolved: false })
    }
    return {
      toValue: (value) => set(() => value),
      toFactory: (factory) => set(factory as (container: Container) => unknown),
    }
  }

  get<T>(token: Token<T>): T {
    // Deliberately not `tryGet() ?? throw`: that would conflate "unbound" with "bound to
    // undefined", and report a legitimately-undefined value as a wiring error.
    const owner = this.ownerOf(token.key)
    if (owner === undefined) {
      throw new RecoError(
        'INVALID_CONFIG',
        `Nothing is bound to "${token.description}". Bind it before build() with .provide().`,
      )
    }
    return owner.resolve(token) as T
  }

  tryGet<T>(token: Token<T>): T | undefined {
    const owner = this.ownerOf(token.key)
    if (owner === undefined) return undefined
    return owner.resolve(token) as T
  }

  has(token: Token<unknown>): boolean {
    return this.ownerOf(token.key) !== undefined
  }

  child(): Container {
    return new DefaultContainer(this)
  }

  /** Called by `build()`. Freezes writes; `child()` still works, which is the point. */
  seal(): void {
    this.sealed = true
  }

  private ownerOf(key: symbol): DefaultContainer | undefined {
    let current: DefaultContainer | undefined = this
    while (current !== undefined) {
      if (current.entries.has(key)) return current
      current = current.parent
    }
    return undefined
  }

  private resolve<T>(token: Token<T>): unknown {
    const entry = this.entries.get(token.key) as Entry
    if (entry.resolved) return entry.value

    if (this.resolving.has(token.key)) {
      throw new RecoError(
        'DEPENDENCY_CYCLE',
        `Cycle while resolving "${token.description}": its factory asks for itself, directly or ` +
          `through another token. Break the cycle, or bind one side with toValue().`,
      )
    }

    this.resolving.add(token.key)
    try {
      // `this`, not the child that asked: memoization belongs to the owner, or the
      // singleton silently becomes per-request.
      entry.value = entry.factory(this)
      entry.resolved = true
      return entry.value
    } finally {
      this.resolving.delete(token.key)
    }
  }
}
