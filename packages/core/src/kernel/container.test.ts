import { describe, expect, it, vi } from 'vitest'
import { DefaultContainer } from './container.js'
import type { RecoError } from './errors.js'
import { token } from './token.js'

interface Clockish {
  now(): number
}

const A = token<Clockish>('A')
const B = token<string>('B')

const codeOf = (fn: () => unknown): string => {
  try {
    fn()
  } catch (error) {
    return (error as RecoError).code
  }
  throw new Error('expected a throw, got none')
}

describe('token', () => {
  it('keys on a fresh symbol, so two tokens with one description stay distinct', () => {
    const first = token<string>('Clock')
    const second = token<string>('Clock')

    const container = new DefaultContainer()
    container.bind(first).toValue('first')
    container.bind(second).toValue('second')

    expect(container.get(first)).toBe('first')
    expect(container.get(second)).toBe('second')
  })
})

describe('DefaultContainer', () => {
  it('resolves values and factories', () => {
    const container = new DefaultContainer()
    container.bind(B).toValue('bound')
    container.bind(A).toFactory(() => ({ now: () => 42 }))

    expect(container.get(B)).toBe('bound')
    expect(container.get(A).now()).toBe(42)
  })

  it('calls a factory once — a singleton is a singleton', () => {
    const factory = vi.fn(() => ({ now: () => 1 }))
    const container = new DefaultContainer()
    container.bind(A).toFactory(factory)

    expect(container.get(A)).toBe(container.get(A))
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('names the token when nothing is bound, because that error is a wiring bug', () => {
    const container = new DefaultContainer()
    expect(() => container.get(A)).toThrow(/nothing is bound to "a"/i)
    expect(codeOf(() => container.get(A))).toBe('INVALID_CONFIG')
    expect(container.tryGet(A)).toBeUndefined()
    expect(container.has(A)).toBe(false)
  })

  it('distinguishes "unbound" from "bound to undefined"', () => {
    const maybe = token<string | undefined>('Maybe')
    const container = new DefaultContainer()
    container.bind(maybe).toValue(undefined)

    // tryGet cannot tell these apart — has() and get() must.
    expect(container.has(maybe)).toBe(true)
    expect(() => container.get(maybe)).not.toThrow()
    expect(container.get(maybe)).toBeUndefined()
  })

  it('refuses a second binding for one token instead of letting one win silently', () => {
    const container = new DefaultContainer()
    container.bind(B).toValue('first')

    expect(codeOf(() => container.bind(B).toValue('second'))).toBe('SLOT_CONFLICT')
  })

  it('reports a factory cycle as a cycle rather than a stack overflow', () => {
    const container = new DefaultContainer()
    const first = token<string>('First')
    const second = token<string>('Second')

    container.bind(first).toFactory((c) => `first+${c.get(second)}`)
    container.bind(second).toFactory((c) => `second+${c.get(first)}`)

    expect(codeOf(() => container.get(first))).toBe('DEPENDENCY_CYCLE')
    expect(() => container.get(first)).toThrow(/cycle/i)
  })

  it('leaves the token resolvable after a failed resolution, rather than wedging it', () => {
    const container = new DefaultContainer()
    let fail = true
    container.bind(B).toFactory(() => {
      if (fail) throw new Error('boom')
      return 'recovered'
    })

    expect(() => container.get(B)).toThrow('boom')
    fail = false
    expect(container.get(B)).toBe('recovered')
  })
})

describe('scopes', () => {
  it('falls through to the parent, so request scope reads engine scope', () => {
    const parent = new DefaultContainer()
    parent.bind(B).toValue('engine')

    expect(parent.child().get(B)).toBe('engine')
    expect(parent.child().has(B)).toBe(true)
  })

  it('lets a child shadow the parent — that is what request scope is for', () => {
    const parent = new DefaultContainer()
    parent.bind(B).toValue('engine')

    const request = parent.child()
    request.bind(B).toValue('request')

    expect(request.get(B)).toBe('request')
    expect(parent.get(B)).toBe('engine')
  })

  it('memoizes a singleton in the container that owns it, not in the child that asked', () => {
    // The bug this guards: resolve against the child and every request quietly gets its
    // own "singleton" — a cache that never hits, and nothing looks broken.
    const factory = vi.fn(() => ({ now: () => 1 }))
    const parent = new DefaultContainer()
    parent.bind(A).toFactory(factory)

    const first = parent.child().get(A)
    const second = parent.child().get(A)

    expect(first).toBe(second)
    expect(factory).toHaveBeenCalledTimes(1)
  })

  it('resolves a parent factory against the parent, so it cannot capture request state', () => {
    const parent = new DefaultContainer()
    let seen: unknown
    parent.bind(A).toFactory((c) => {
      seen = c
      return { now: () => 1 }
    })

    parent.child().get(A)
    expect(seen).toBe(parent)
  })

  it('keeps a child binding out of the parent', () => {
    const parent = new DefaultContainer()
    const request = parent.child()
    request.bind(B).toValue('request')

    expect(parent.has(B)).toBe(false)
  })
})

describe('sealing', () => {
  it('refuses new bindings once build() sealed it, so requests cannot race on it', () => {
    const container = new DefaultContainer()
    container.seal()

    expect(codeOf(() => container.bind(B).toValue('late'))).toBe('BUILDER_SEALED')
  })

  it('still hands out children after sealing — request scope must keep working', () => {
    const container = new DefaultContainer()
    container.bind(B).toValue('engine')
    container.seal()

    const request = container.child()
    expect(() => request.bind(token<string>('PerRequest')).toValue('ok')).not.toThrow()
    expect(request.get(B)).toBe('engine')
  })
})
