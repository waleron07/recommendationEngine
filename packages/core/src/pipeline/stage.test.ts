import { describe, expect, it, vi } from 'vitest'
import { timestamp } from '../domain/ids.js'
import type { RequestContext } from '../ports/context.js'
import type { Clock } from '../ports/infra.js'
import type { StageMiddleware } from '../ports/middleware.js'
import { DiagnosticsCollector, runStage, STAGES, stageInfo } from './stage.js'

/** Advances by one millisecond per read, so a timing is deterministic rather than 0. */
const tickingClock = (): Clock => {
  let ticks = 0
  return {
    now: () => {
      ticks += 1
      return timestamp(ticks)
    },
  }
}

const ctxWith = (signal: AbortSignal): RequestContext => ({ signal }) as RequestContext

const run = <T>(overrides: {
  signal?: AbortSignal
  middleware?: readonly StageMiddleware[]
  run: () => Promise<T>
  sizeOf?: (value: T) => number
  diagnostics?: DiagnosticsCollector
}) => {
  const diagnostics = overrides.diagnostics ?? new DiagnosticsCollector()
  return {
    diagnostics,
    promise: runStage({
      id: 'retrieval',
      ctx: ctxWith(overrides.signal ?? new AbortController().signal),
      middleware: overrides.middleware ?? [],
      diagnostics,
      clock: tickingClock(),
      inputSize: 0,
      sizeOf: overrides.sizeOf ?? (() => 0),
      run: overrides.run,
    }),
  }
}

describe('the stage sequence', () => {
  it('numbers the stages in pipeline order', () => {
    expect(stageInfo('resolve').index).toBe(0)
    expect(stageInfo('retrieval').index).toBe(1)
    expect(stageInfo('assemble').index).toBe(STAGES.length - 1)
  })

  it('puts filtering either side of feature work, as §3 argues', () => {
    const order = (id: (typeof STAGES)[number]) => stageInfo(id).index

    expect(order('prefilter')).toBeLessThan(order('extraction'))
    expect(order('postfilter')).toBeGreaterThan(order('engineering'))
    expect(order('postfilter')).toBeLessThan(order('scoring'))
    expect(order('normalization')).toBeGreaterThan(order('scoring'))
    expect(order('modifiers')).toBeGreaterThan(order('combination'))
    expect(order('diversification')).toBeGreaterThan(order('ranking'))
    expect(order('blending')).toBeGreaterThan(order('diversification'))
  })
})

describe('cancellation (§17.1 rule 1)', () => {
  it('refuses to start a stage on an already-aborted signal', async () => {
    const work = vi.fn(async () => 'done')
    const controller = new AbortController()
    controller.abort()

    // The free guarantee: a port that never read the cancellation contract still cannot
    // delay an abort by more than one stage, because the engine checks every boundary.
    await expect(run({ signal: controller.signal, run: work }).promise).rejects.toThrow()
    expect(work).not.toHaveBeenCalled()
  })

  it('propagates the abort rather than degrading it', async () => {
    const controller = new AbortController()
    controller.abort()

    // A cancelled request must not come back as half a feed dressed up as a real one.
    const { promise, diagnostics } = run({ signal: controller.signal, run: async () => 'done' })
    await expect(promise).rejects.toMatchObject({ name: 'AbortError' })
    expect(diagnostics.collected).toEqual([])
  })

  it('runs the stage when the signal is live', async () => {
    await expect(run({ run: async () => 'done' }).promise).resolves.toBe('done')
  })
})

describe('timings', () => {
  it('records what the stage cost and what passed through it', async () => {
    const { promise, diagnostics } = run({
      run: async () => ['a', 'b', 'c'],
      sizeOf: (value) => value.length,
    })
    await promise

    expect(diagnostics.stages).toEqual([{ id: 'retrieval', ms: expect.any(Number), in: 0, out: 3 }])
    expect(diagnostics.stages[0]?.ms).toBeGreaterThan(0)
  })

  it('times a stage that threw, because when it failed is half the incident', async () => {
    // "Failed after 190ms of a 200ms budget" and "failed in 2ms" are different bugs.
    const { promise, diagnostics } = run({
      run: async () => {
        throw new Error('provider exploded')
      },
    })

    await expect(promise).rejects.toThrow('provider exploded')
    expect(diagnostics.stages).toHaveLength(1)
    expect(diagnostics.stages[0]?.out).toBe(0)
  })
})

describe('middleware', () => {
  const tracer = (id: string, log: string[]): StageMiddleware => ({
    id,
    intercept: async (_stage, _ctx, next) => {
      log.push(`${id}:in`)
      const result = await next()
      log.push(`${id}:out`)
      return result
    },
  })

  it('wraps the stage outermost-first, so the first registered sees everything', async () => {
    const log: string[] = []
    await run({
      middleware: [tracer('outer', log), tracer('inner', log)],
      run: async () => {
        log.push('stage')
        return 'done'
      },
    }).promise

    expect(log).toEqual(['outer:in', 'inner:in', 'stage', 'inner:out', 'outer:out'])
  })

  it('tells the middleware which stage it is wrapping', async () => {
    const seen: unknown[] = []
    await run({
      middleware: [{ id: 'spy', intercept: async (stage, _ctx, next) => (seen.push(stage), next()) }],
      run: async () => 'done',
    }).promise

    expect(seen).toEqual([{ id: 'retrieval', index: 1 }])
  })

  it('lets middleware replace the result — that is what a cache hit is', async () => {
    const work = vi.fn(async () => 'fresh')
    const result = await run({
      middleware: [{ id: 'cache', intercept: async () => 'cached' }],
      run: work,
    }).promise

    expect(result).toBe('cached')
    expect(work).not.toHaveBeenCalled()
  })

  it('passes a middleware failure through instead of swallowing it', async () => {
    await expect(
      run({
        middleware: [
          {
            id: 'broken',
            intercept: async () => {
              throw new Error('tracer exploded')
            },
          },
        ],
        run: async () => 'done',
      }).promise,
    ).rejects.toThrow('tracer exploded')
  })
})

describe('DiagnosticsCollector', () => {
  it('keeps warnings in the order they happened', () => {
    const collector = new DiagnosticsCollector()
    collector.warn({ stage: 'retrieval', port: 'library', code: 'degraded', message: 'first' })
    collector.warn({ stage: 'scoring', port: 'artist', code: 'not_applicable', message: 'second' })

    expect(collector.collected.map((w) => w.message)).toEqual(['first', 'second'])
  })
})
