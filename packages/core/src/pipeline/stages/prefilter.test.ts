import { describe, expect, it } from 'vitest'
import { CandidateSetBuilder } from '../../domain/candidate.js'
import type { Item } from '../../domain/entities.js'
import { itemId } from '../../domain/ids.js'
import { ConfigResolver } from '../../kernel/config.js'
import type { RecoError } from '../../kernel/errors.js'
import type { PreFilter } from '../../ports/candidate-filter.js'
import type { RequestContext } from '../../ports/context.js'
import type { PolicyContext } from '../policy.js'
import { DiagnosticsCollector } from '../stage.js'
import { prefilter } from './prefilter.js'

const config = (filterErrorBudget = 0.05) =>
  new ConfigResolver().resolve(
    { limits: { maxCandidates: 5_000, maxLimit: 100, timeoutMs: 200 }, filterErrorBudget },
    [],
  )

const ctxWith = (filterErrorBudget = 0.05): RequestContext =>
  ({ config: config(filterErrorBudget) }) as RequestContext

const policyWith = (): PolicyContext => ({
  stage: 'prefilter',
  errorPolicy: 'strict',
  diagnostics: new DiagnosticsCollector(),
  metrics: undefined,
})

const track = (id: string): Item => ({ id: itemId(id), type: 'track', payload: {} })

const candidates = (...ids: string[]): CandidateSetBuilder => {
  const builder = new CandidateSetBuilder()
  builder.add('library', ids.map(track))
  return builder
}

const approving = (id: string, verdict: (itemId: string) => boolean): PreFilter => ({
  id,
  failClosed: true,
  approve: (candidate) => verdict(candidate.item.id),
})

const exploding = (id: string, on: (itemId: string) => boolean): PreFilter => ({
  id,
  failClosed: true,
  approve: (candidate) => {
    if (on(candidate.item.id)) throw new Error(`${id} could not decide`)
    return true
  },
})

const idsOf = (builder: CandidateSetBuilder): string[] => builder.build().candidates.map((c) => c.item.id)

/** Big enough that one failure stays inside a 5% budget. Ratios need a denominator. */
const manyCandidates = () => candidates(...Array.from({ length: 100 }, (_, i) => `t${i}`))

describe('approval', () => {
  it('keeps only what every filter approved', () => {
    const kept = prefilter(
      candidates('a', 'b', 'c'),
      [approving('region', (id) => id !== 'b'), approving('age', (id) => id !== 'c')],
      ctxWith(),
      policyWith(),
    )

    expect(idsOf(kept)).toEqual(['a'])
  })

  it('passes everything through when nothing filters', () => {
    expect(idsOf(prefilter(candidates('a', 'b'), [], ctxWith(), policyWith()))).toEqual(['a', 'b'])
  })

  it('handles an empty candidate set', () => {
    expect(prefilter(candidates(), [approving('region', () => true)], ctxWith(), policyWith()).size).toBe(0)
  })

  it('renumbers the survivors, so no stale row survives the filtering', () => {
    // A row index that outlives filtering is how one candidate's features end up on
    // another candidate's score.
    const kept = prefilter(
      candidates('a', 'b', 'c'),
      [approving('r', (id) => id === 'c')],
      ctxWith(),
      policyWith(),
    )
    const set = kept.build()

    expect(set.size).toBe(1)
    expect(set.at(0).item.id).toBe('c')
    expect(set.indexOf(itemId('c'))).toBe(0)
  })

  it('keeps every source of a surviving candidate', () => {
    // Two providers found it, so there are two reasons to show it — both belong in the
    // explanation, and rebuilding the set by hand would have dropped one.
    const builder = new CandidateSetBuilder()
    builder.add('history', [track('shared')])
    builder.add('cohort', [track('shared')])

    const kept = prefilter(builder, [approving('region', () => true)], ctxWith(), policyWith())
    expect([...kept.build().at(0).sources]).toEqual(['history', 'cohort'])
  })
})

describe('fail-closed is enforced, not trusted (§6)', () => {
  it('treats a throw as refusal — an exception is not a third outcome', () => {
    const kept = prefilter(
      manyCandidates(),
      [exploding('licence', (id) => id === 't0')],
      ctxWith(),
      policyWith(),
    )

    expect(kept.size).toBe(99)
    expect(idsOf(kept)).not.toContain('t0')
  })

  it('drops the candidate rather than the request, so one bad track is not a dead feed', () => {
    const policy = policyWith()
    prefilter(manyCandidates(), [exploding('licence', (id) => id === 't0')], ctxWith(), policy)

    expect(policy.diagnostics.collected[0]).toMatchObject({ port: 'licence', code: 'port_failed' })
    expect(policy.diagnostics.collected[0]?.message).toMatch(/dropped, unapproved/)
  })

  it('calls one failure in a tiny set systematic, because 1 of 2 is half the feed', () => {
    // The budget is a ratio and small sets have no room in it. That is the honest reading:
    // if half the candidates could not be decided, the dependency is broken, not flaky.
    expect(() =>
      prefilter(candidates('a', 'b'), [exploding('licence', (id) => id === 'a')], ctxWith(), policyWith()),
    ).toThrow(/broken dependency/i)
  })

  it('fails the request once a filter throws past the budget — that is a broken dependency', () => {
    // The trap fail-open does not have: a dead licence service empties the feed, and the
    // empty feed reports itself as HTTP 200.
    let error: RecoError | undefined
    try {
      prefilter(
        candidates('a', 'b', 'c', 'd'),
        [exploding('licence', () => true)],
        ctxWith(0.05),
        policyWith(),
      )
    } catch (thrown) {
      error = thrown as RecoError
    }

    expect(error?.code).toBe('PORT_FAILED')
    expect(error?.message).toMatch(/broken dependency/i)
  })

  it('tolerates the odd failure inside the budget', () => {
    // 3 of 100 is under the 5% budget: flaky, not broken.
    const flaky = ['t0', 't1', 't2']
    const kept = prefilter(
      manyCandidates(),
      [exploding('licence', (id) => flaky.includes(id))],
      ctxWith(0.05),
      policyWith(),
    )

    expect(kept.size).toBe(97)
  })

  it('stops asking the remaining filters once one has refused', () => {
    const asked: string[] = []
    const record = (id: string, verdict: boolean): PreFilter => ({
      id,
      failClosed: true,
      approve: () => {
        asked.push(id)
        return verdict
      },
    })

    prefilter(candidates('a'), [record('first', false), record('second', true)], ctxWith(), policyWith())
    expect(asked).toEqual(['first'])
  })
})
