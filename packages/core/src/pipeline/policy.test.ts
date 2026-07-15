import { describe, expect, it, vi } from 'vitest'
import type { RecoError } from '../kernel/errors.js'
import type { Metrics } from '../ports/infra.js'
import {
  degradeOrThrow,
  FilterErrorBudget,
  isAbort,
  type PolicyContext,
  rethrowIfAborted,
  warn,
} from './policy.js'
import { DiagnosticsCollector } from './stage.js'

const abortError = () => Object.assign(new Error('aborted'), { name: 'AbortError' })

const policyWith = (errorPolicy: 'strict' | 'degrade', metrics?: Metrics): PolicyContext => ({
  stage: 'extraction',
  errorPolicy,
  diagnostics: new DiagnosticsCollector(),
  metrics,
})

const failure = (fn: () => unknown): RecoError => {
  try {
    fn()
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected a throw, got none')
}

describe('cancellation is not a port failure', () => {
  it('recognises an abort by name, not by instanceof', () => {
    // throwIfAborted() throws a DOMException, which does not exist as a type in an
    // isomorphic core, and a host may substitute its own reason object anyway.
    expect(isAbort(abortError())).toBe(true)
    expect(isAbort(Object.assign(new Error('slow'), { name: 'TimeoutError' }))).toBe(true)
    expect(isAbort(new Error('connection refused'))).toBe(false)
    expect(isAbort(undefined)).toBe(false)
  })

  it('rethrows an abort untouched and lets a real failure pass', () => {
    expect(() => rethrowIfAborted(abortError())).toThrow('aborted')
    expect(() => rethrowIfAborted(new Error('boom'))).not.toThrow()
  })

  it('never degrades an abort into a warning, whatever the policy', () => {
    const policy = policyWith('degrade')
    const port = { id: 'artist', criticality: 'optional' as const }

    expect(() => degradeOrThrow(policy, port, abortError(), 'extractor failed')).toThrow('aborted')
    expect(policy.diagnostics.collected).toEqual([])
  })
})

describe('the error matrix (§17.2)', () => {
  it('fails the request for a required port, whatever the policy', () => {
    for (const errorPolicy of ['strict', 'degrade'] as const) {
      const policy = policyWith(errorPolicy)
      const error = failure(() =>
        degradeOrThrow(policy, { id: 'artist' }, new Error('db down'), 'extractor failed'),
      )

      expect(error.code).toBe('PORT_FAILED')
      expect(error.message).toContain('extraction')
      expect(error.cause).toBeInstanceOf(Error)
    }
  })

  it('treats a port that said nothing as required — loud is the default', () => {
    // An extractor whose features silently became zeros is the invisible catastrophe.
    expect(() =>
      degradeOrThrow(policyWith('degrade'), { id: 'artist' }, new Error('boom'), 'failed'),
    ).toThrow()
  })

  it('still fails an optional port under strict, which is what dev and CI want', () => {
    const port = { id: 'artist', criticality: 'optional' as const }
    expect(() => degradeOrThrow(policyWith('strict'), port, new Error('boom'), 'failed')).toThrow()
  })

  it('degrades an optional port under degrade, and says so out loud', () => {
    const policy = policyWith('degrade')
    const port = { id: 'artist', criticality: 'optional' as const }

    expect(degradeOrThrow(policy, port, new Error('boom'), 'extractor failed')).toBe(true)
    expect(policy.diagnostics.collected).toEqual([
      {
        stage: 'extraction',
        port: 'artist',
        code: 'degraded',
        message: 'extractor failed',
        cause: expect.any(Error),
      },
    ])
  })

  it('counts every degradation, because degrading without a metric is a silent regression', () => {
    const metrics: Metrics = { count: vi.fn(), timing: vi.fn() }
    const policy = policyWith('degrade', metrics)

    degradeOrThrow(policy, { id: 'artist', criticality: 'optional' }, new Error('boom'), 'failed')
    expect(metrics.count).toHaveBeenCalledWith('reco.degraded')
  })

  it('works without a metrics port bound', () => {
    const policy = policyWith('degrade')
    expect(() =>
      warn(policy, { stage: 'scoring', port: 'x', code: 'not_applicable', message: 'cold start' }),
    ).not.toThrow()
  })
})

describe('filter error budget', () => {
  const budgetOf = (total: number, budget: number, policy = policyWith('degrade')) => ({
    policy,
    budget: new FilterErrorBudget(policy, total, budget),
  })

  it('drops the candidate rather than the request — the invariant holds either way', () => {
    const { budget, policy } = budgetOf(100, 0.05)

    expect(budget.refuse('licence', 'track-1', new Error('service down'))).toBe(false)
    expect(policy.diagnostics.collected[0]).toMatchObject({ code: 'port_failed', port: 'licence' })
  })

  it('fails the request once failures pass the budget, because that is a broken dependency', () => {
    // The trap of fail-closed: a dead licence service empties the feed, and an empty feed
    // reports itself as HTTP 200. Safe, and lying about why.
    const { budget } = budgetOf(100, 0.05)

    for (let i = 0; i < 5; i++) budget.refuse('licence', `track-${i}`, new Error('down'))
    const error = failure(() => budget.refuse('licence', 'track-5', new Error('down')))

    expect(error.code).toBe('PORT_FAILED')
    expect(error.message).toMatch(/broken dependency/i)
  })

  it('tolerates the odd failure without touching the request', () => {
    const { budget } = budgetOf(100, 0.05)
    expect(() => budget.refuse('licence', 'track-1', new Error('flaky'))).not.toThrow()
  })

  it('lets an abort through instead of counting it against the budget', () => {
    const { budget } = budgetOf(100, 0.05)
    expect(() => budget.refuse('licence', 'track-1', abortError())).toThrow('aborted')
  })

  it('never divides by zero on an empty candidate set', () => {
    const { budget } = budgetOf(0, 0.05)
    expect(() => budget.refuse('licence', 'track-1', new Error('boom'))).not.toThrow()
  })

  it('fails on the first failure when the budget is zero', () => {
    const { budget } = budgetOf(10, 0)
    expect(failure(() => budget.refuse('licence', 'track-1', new Error('boom'))).code).toBe('PORT_FAILED')
  })
})
