import { describe, it, expect } from 'vitest'
import { validateBatch, validateLineDrafts, validateBatchName } from './schema'
import type { StocktakeBatch } from './types'

function batch(over: Partial<StocktakeBatch> = {}): StocktakeBatch {
  return {
    id: 'b1',
    name: '批次',
    createdAt: 1000,
    updatedAt: 1000,
    status: 'draft',
    lines: [
      { id: 'l1', level: 'A', spec: 10, bookQty: 2, actualQty: null },
      { id: 'l2', level: 'B', spec: 20, bookQty: 4, actualQty: null },
    ],
    ...over,
  }
}

describe('validateBatch — shape', () => {
  it('accepts a minimal draft', () => {
    expect(validateBatch(batch()).ok).toBe(true)
  })

  it('rejects non-objects and missing fields', () => {
    expect(validateBatch(null).ok).toBe(false)
    expect(validateBatch('x').ok).toBe(false)
    expect(validateBatch([]).ok).toBe(false)
    expect(validateBatch(batch({ id: '' })).ok).toBe(false)
    expect(validateBatch(batch({ name: ' ' })).ok).toBe(false)
    expect(validateBatch(batch({ createdAt: 0 })).ok).toBe(false)
    expect(validateBatch(batch({ updatedAt: 5 })).ok).toBe(false)
    expect(validateBatch(batch({ status: 'weird' as never })).ok).toBe(false)
  })

  it('rejects bad lines', () => {
    expect(validateBatch(batch({ lines: [] })).ok).toBe(false)
    expect(
      validateBatch(batch({ lines: [{ id: 'l', level: 'C' as never, spec: 1, bookQty: 1, actualQty: null }] })).ok,
    ).toBe(false)
    expect(
      validateBatch(batch({ lines: [{ id: 'l', level: 'A', spec: 1.5, bookQty: 1, actualQty: null }] })).ok,
    ).toBe(false)
    expect(
      validateBatch(batch({ lines: [{ id: 'l', level: 'A', spec: -1, bookQty: 1, actualQty: null }] })).ok,
    ).toBe(false)
    expect(
      validateBatch(batch({ lines: [{ id: 'l', level: 'A', spec: 200001, bookQty: 1, actualQty: null }] })).ok,
    ).toBe(false)
    expect(
      validateBatch(batch({ lines: [{ id: 'l', level: 'A', spec: 1, bookQty: -2, actualQty: null }] })).ok,
    ).toBe(false)
    expect(
      validateBatch(
        batch({ lines: [{ id: 'l', level: 'A', spec: 1, bookQty: 1, actualQty: 1.5 }] }),
      ).ok,
    ).toBe(false)
  })

  it('rejects duplicate line ids and bad dispositions', () => {
    expect(
      validateBatch(
        batch({
          lines: [
            { id: 'l', level: 'A', spec: 1, bookQty: 1, actualQty: null },
            { id: 'l', level: 'B', spec: 2, bookQty: 1, actualQty: null },
          ],
        }),
      ).ok,
    ).toBe(false)
    // Same id repeated within the same level is also a collision.
    expect(
      validateBatch(
        batch({
          lines: [
            { id: 'l', level: 'A', spec: 1, bookQty: 1, actualQty: null },
            { id: 'l', level: 'A', spec: 2, bookQty: 1, actualQty: null },
          ],
        }),
      ).ok,
    ).toBe(false)
    expect(
      validateBatch(
        batch({
          status: 'completed',
          lines: [
            {
              id: 'l',
              level: 'A',
              spec: 1,
              bookQty: 1,
              actualQty: 2,
              disposition: 'nope' as never,
            },
          ],
        }),
      ).ok,
    ).toBe(false)
  })
})

describe('validateBatch — state invariants', () => {
  it('allows counting batches with still-uncounted lines (work in progress)', () => {
    expect(validateBatch(batch({ status: 'counting' })).ok).toBe(true)
    expect(
      validateBatch(
        batch({
          status: 'counting',
          lines: [
            { id: 'l1', level: 'A', spec: 10, bookQty: 2, actualQty: 2 },
            { id: 'l2', level: 'B', spec: 20, bookQty: 4, actualQty: null },
          ],
        }),
      ).ok,
    ).toBe(true)
  })

  it('requires all lines counted in review_required/completed', () => {
    expect(
      validateBatch(
        batch({
          status: 'review_required',
          lines: [
            { id: 'l1', level: 'A', spec: 10, bookQty: 2, actualQty: 2 },
            { id: 'l2', level: 'B', spec: 20, bookQty: 4, actualQty: null },
          ],
        }),
      ).ok,
    ).toBe(false)
    expect(
      validateBatch(
        batch({
          status: 'completed',
          lines: [
            { id: 'l1', level: 'A', spec: 10, bookQty: 2, actualQty: 2 },
            { id: 'l2', level: 'B', spec: 20, bookQty: 4, actualQty: null },
          ],
        }),
      ).ok,
    ).toBe(false)
    expect(
      validateBatch(
        batch({
          status: 'completed',
          lines: [
            { id: 'l1', level: 'A', spec: 10, bookQty: 2, actualQty: 2 },
            { id: 'l2', level: 'B', spec: 20, bookQty: 4, actualQty: 4 },
          ],
        }),
      ).ok,
    ).toBe(true)
  })

  it('requires differences disposed only in completed; review allows pending ones', () => {
    const unresolved = batch({
      status: 'review_required',
      lines: [
        { id: 'l1', level: 'A', spec: 10, bookQty: 2, actualQty: 3 },
        { id: 'l2', level: 'B', spec: 20, bookQty: 4, actualQty: 4 },
      ],
    })
    // Pending disposition is exactly what review_required is for.
    expect(validateBatch(unresolved).ok).toBe(true)

    const resolved = batch({
      status: 'completed',
      lines: [
        { id: 'l1', level: 'A', spec: 10, bookQty: 2, actualQty: 3, disposition: 'write_off' },
        { id: 'l2', level: 'B', spec: 20, bookQty: 4, actualQty: 4 },
      ],
    })
    expect(validateBatch(resolved).ok).toBe(true)

    // completed with an unresolved diff is corrupt
    const badCompleted = batch({
      status: 'completed',
      lines: [
        { id: 'l1', level: 'A', spec: 10, bookQty: 2, actualQty: 1 },
        { id: 'l2', level: 'B', spec: 20, bookQty: 4, actualQty: 4 },
      ],
    })
    expect(validateBatch(badCompleted).ok).toBe(false)
  })

  it('counting batches may have differences as long as all are counted', () => {
    const b = batch({
      status: 'counting',
      lines: [
        { id: 'l1', level: 'A', spec: 10, bookQty: 2, actualQty: 99 },
        { id: 'l2', level: 'B', spec: 20, bookQty: 4, actualQty: 0 },
      ],
    })
    expect(validateBatch(b).ok).toBe(true)
  })
})

describe('form drafts', () => {
  it('validates bounds and per-level duplicate specs', () => {
    expect(validateLineDrafts([]).ok).toBe(false)
    expect(validateLineDrafts([{ level: 'A', spec: 1, bookQty: 0 }]).ok).toBe(true)
    expect(
      validateLineDrafts([
        { level: 'A', spec: 1, bookQty: 1 },
        { level: 'B', spec: 1, bookQty: 1 },
      ]).ok,
    ).toBe(true)
    expect(
      validateLineDrafts([
        { level: 'A', spec: 1, bookQty: 1 },
        { level: 'A', spec: 1, bookQty: 2 },
      ]).ok,
    ).toBe(false)
    expect(validateLineDrafts([{ level: 'A', spec: 200001, bookQty: 1 }]).ok).toBe(false)
  })

  it('validates names', () => {
    expect(validateBatchName('').ok).toBe(false)
    expect(validateBatchName('   ').ok).toBe(false)
    expect(validateBatchName('x'.repeat(81)).ok).toBe(false)
    expect(validateBatchName('正常批次').ok).toBe(true)
  })
})
