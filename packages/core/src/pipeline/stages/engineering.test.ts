import { describe, expect, it } from 'vitest'
import { type FeatureDescriptor, FeatureSchemaBuilder } from '../../domain/feature.js'
import { featureKey } from '../../domain/ids.js'
import { DenseFeatureMatrix } from '../../domain/matrix.js'
import type { RecoError } from '../../kernel/errors.js'
import type { RequestContext } from '../../ports/context.js'
import type { FeatureTransform } from '../../ports/feature-transform.js'
import type { PolicyContext } from '../policy.js'
import { DiagnosticsCollector } from '../stage.js'
import { engineer } from './engineering.js'

const descriptor = (key: string): FeatureDescriptor => ({
  key: featureKey(key),
  kind: 'numeric',
  defaultValue: 0,
  description: key,
  owner: 'x',
  ownerVersion: '1',
})

const matrixOf = (...keys: string[]) => {
  const builder = new FeatureSchemaBuilder()
  for (const key of keys) builder.register(descriptor(key))
  return new DenseFeatureMatrix(builder.freeze(), 2)
}

const ctxWith = (signal = new AbortController().signal): RequestContext => ({ signal }) as RequestContext

const policyWith = (): PolicyContext => ({
  stage: 'engineering',
  errorPolicy: 'strict',
  diagnostics: new DiagnosticsCollector(),
  metrics: undefined,
})

const doubling = (id: string, from: string, to: string): FeatureTransform => ({
  id,
  version: '1',
  requires: [featureKey(from)],
  provides: [descriptor(to)],
  apply: (matrix) => {
    const source = matrix.column(featureKey(from))
    const target = matrix.columnMut(featureKey(to))
    for (let i = 0; i < source.length; i++) target[i] = (source[i] as number) * 2
  },
})

const failure = (fn: () => unknown): RecoError => {
  try {
    fn()
  } catch (error) {
    return error as RecoError
  }
  throw new Error('expected a throw, got none')
}

describe('engineering', () => {
  it('runs the chain in the order build() sorted it into', () => {
    // Sequential on purpose: `scale` reads what `log1p` wrote, and running them
    // concurrently would throw away the ordering the graph validation exists to establish.
    const matrix = matrixOf('raw', 'once', 'twice')
    matrix.columnMut(featureKey('raw')).set([1, 2])

    engineer(matrix, ctxWith(), [doubling('a', 'raw', 'once'), doubling('b', 'once', 'twice')], policyWith())

    expect([...matrix.column(featureKey('once'))]).toEqual([2, 4])
    expect([...matrix.column(featureKey('twice'))]).toEqual([4, 8])
  })

  it('does nothing when there are no transforms', () => {
    expect(() => engineer(matrixOf('raw'), ctxWith(), [], policyWith())).not.toThrow()
  })

  it('fails the request when a transform throws — the chain downstream is broken', () => {
    // There is no honest default for "the logarithm of a number we never computed", which
    // is why this port has no criticality to consult.
    const broken: FeatureTransform = {
      id: 'log1p',
      version: '1',
      requires: [],
      provides: [],
      apply: () => {
        throw new Error('maths went wrong')
      },
    }

    const error = failure(() => engineer(matrixOf('raw'), ctxWith(), [broken], policyWith()))
    expect(error.code).toBe('PORT_FAILED')
    expect(error.message).toMatch(/cannot degrade/i)
    expect(error.cause).toBeInstanceOf(Error)
  })

  it('checks the signal between transforms, not only at the stage boundary', () => {
    // A chain of six over 5000 rows is exactly the CPU-bound stretch where an abort would
    // otherwise sit and wait for the whole stage.
    const controller = new AbortController()
    const ran: string[] = []
    const record = (id: string, then?: () => void): FeatureTransform => ({
      id,
      version: '1',
      requires: [],
      provides: [],
      apply: () => {
        ran.push(id)
        then?.()
      },
    })

    expect(() =>
      engineer(
        matrixOf('raw'),
        ctxWith(controller.signal),
        [record('first', () => controller.abort()), record('second')],
        policyWith(),
      ),
    ).toThrow()
    expect(ran).toEqual(['first'])
  })

  it('lets an abort thrown inside a transform through as an abort', () => {
    const cooperative: FeatureTransform = {
      id: 'ppr',
      version: '1',
      requires: [],
      provides: [],
      apply: () => {
        throw Object.assign(new Error('aborted'), { name: 'AbortError' })
      },
    }

    // Not dressed up as PORT_FAILED: a cancelled request is not a broken transform.
    expect(() => engineer(matrixOf('raw'), ctxWith(), [cooperative], policyWith())).toThrow('aborted')
  })
})
