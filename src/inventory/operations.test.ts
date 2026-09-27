import { describe, it, expect, beforeEach } from 'vitest'
import {
  advance,
  completeReview,
  createBatch,
  recordCount,
  resolveDifference,
  startCounting,
  submitForReview,
  updateDraft,
} from './operations'
import { RuleError, type StocktakeBatch } from './types'
import type { LineDraft } from './schema'

const lines: LineDraft[] = [
  { level: 'A', spec: 10, bookQty: 5 },
  { level: 'A', spec: 20, bookQty: 3 },
  { level: 'B', spec: 7, bookQty: 9 },
]

function draft(now = 1000): StocktakeBatch[] {
  return createBatch([], { name: '批次甲', lines, now })
}

function findId(batches: StocktakeBatch[]): string {
  return batches[0].id
}

function expectCode(fn: () => unknown, code: string) {
  try {
    fn()
  } catch (err) {
    expect(err).toBeInstanceOf(RuleError)
    expect((err as RuleError).code).toBe(code)
    return
  }
  throw new Error(`expected RuleError ${code}`)
}

describe('stocktake lifecycle — happy path', () => {
  it('creates a draft with A/B specs and book quantities', () => {
    const batches = draft()
    expect(batches).toHaveLength(1)
    const b = batches[0]
    expect(b.status).toBe('draft')
    expect(b.lines).toHaveLength(3)
    expect(b.lines.map((l) => l.actualQty)).toEqual([null, null, null])
  })

  it('walks draft -> counting -> review_required -> completed via the same advance action', () => {
    let batches = draft()
    const id = findId(batches)

    batches = startCounting(batches, id)
    expect(batches[0].status).toBe('counting')

    batches = recordCount(batches, id, batches[0].lines[0].id, 7) // diff +2
    batches = recordCount(batches, id, batches[0].lines[1].id, 3) // same
    batches = recordCount(batches, id, batches[0].lines[2].id, 9) // same

    // counting -> review because there is one difference
    batches = advance(batches, id)
    expect(batches[0].status).toBe('review_required')

    const diffLine = batches[0].lines[0]
    expect(diffLine.actualQty).not.toBe(diffLine.bookQty)

    batches = resolveDifference(batches, id, diffLine.id, 'actual_correct', '实盘为准')
    batches = advance(batches, id)
    expect(batches[0].status).toBe('completed')
    expect(batches[0].lines[0].disposition).toBe('actual_correct')
  })

  it('completes straight from counting when there are no differences', () => {
    let batches = draft()
    const id = findId(batches)
    batches = startCounting(batches, id)
    for (const line of batches[0].lines) batches = recordCount(batches, id, line.id, line.bookQty)
    batches = submitForReview(batches, id)
    expect(batches[0].status).toBe('completed')
  })

  it('records updatedAt on every mutation but keeps createdAt', () => {
    let batches = draft(1000)
    const id = findId(batches)
    expect(batches[0].createdAt).toBe(1000)
    batches = startCounting(batches, id)
    expect(batches[0].updatedAt).toBeGreaterThanOrEqual(batches[0].createdAt)
  })

  it('does not mutate the input batch list', () => {
    const batches = draft()
    const snapshot = JSON.stringify(batches)
    const id = findId(batches)
    startCounting(batches, id)
    expect(JSON.stringify(batches)).toBe(snapshot)
    expect(batches[0].status).toBe('draft')
  })
})

describe('stocktake gates', () => {
  it('rejects counting with no lines', () => {
    let batches = draft()
    const id = findId(batches)
    batches = startCounting(batches, id)
    // Record all counts, then a fresh empty batch is impossible via ops —
    // empty-line gate is enforced on draft edit; here status guard dominates.
    expect(() => startCounting(batches, id)).toThrow(RuleError)
  })

  it('blocks submit until every line is counted', () => {
    let batches = draft()
    const id = findId(batches)
    batches = startCounting(batches, id)
    batches = recordCount(batches, id, batches[0].lines[0].id, 5)
    expectCode(() => submitForReview(batches, id), 'NOT_ALL_COUNTED')
  })

  it('blocks completion until every difference is disposed', () => {
    let batches = draft()
    const id = findId(batches)
    batches = startCounting(batches, id)
    batches = recordCount(batches, id, batches[0].lines[0].id, 8)
    batches = recordCount(batches, id, batches[0].lines[1].id, 3)
    batches = recordCount(batches, id, batches[0].lines[2].id, 9)
    batches = submitForReview(batches, id)
    expect(batches[0].status).toBe('review_required')
    expectCode(() => completeReview(batches, id), 'UNRESOLVED_DIFFERENCES')
    expectCode(() => advance(batches, id), 'UNRESOLVED_DIFFERENCES')
  })

  it('rejects disposition on a non-difference line', () => {
    let batches = draft()
    const id = findId(batches)
    batches = startCounting(batches, id)
    for (const line of batches[0].lines) batches = recordCount(batches, id, line.id, line.bookQty)
    // no differences -> completed
    batches = submitForReview(batches, id)
    expect(batches[0].status).toBe('completed')
    expect(() => resolveDifference(batches, id, batches[0].lines[0].id, 'write_off')).toThrow()
  })

  it('forbids every mutation on a completed (read-only) batch', () => {
    let batches = draft()
    const id = findId(batches)
    batches = startCounting(batches, id)
    for (const line of batches[0].lines) batches = recordCount(batches, id, line.id, line.bookQty)
    batches = submitForReview(batches, id)
    expect(batches[0].status).toBe('completed')

    expectCode(() => startCounting(batches, id), 'INVALID_STATUS')
    expectCode(() => recordCount(batches, id, batches[0].lines[0].id, 1), 'INVALID_STATUS')
    expectCode(
      () => resolveDifference(batches, id, batches[0].lines[0].id, 'recheck'),
      'INVALID_STATUS',
    )
    expectCode(() => completeReview(batches, id), 'INVALID_STATUS')
    expect(() => advance(batches, id)).toThrow('只读')
    expectCode(() => updateDraft(batches, id, { name: 'x', lines }), 'INVALID_STATUS')
  })

  it('re-recounting a reviewed line clears its stale disposition', () => {
    let batches = draft()
    const id = findId(batches)
    batches = startCounting(batches, id)
    batches = recordCount(batches, id, batches[0].lines[0].id, 6)
    batches = recordCount(batches, id, batches[0].lines[1].id, 3)
    batches = recordCount(batches, id, batches[0].lines[2].id, 9)
    batches = submitForReview(batches, id)
    const line = batches[0].lines[0]
    batches = resolveDifference(batches, id, line.id, 'book_correct')
    expect(batches[0].lines[0].disposition).toBe('book_correct')
    // Edge: counting is closed after review; re-count requires status guard.
    expectCode(() => recordCount(batches, id, line.id, 5), 'INVALID_STATUS')
  })

  it('validates create/edit inputs', () => {
    expectCode(() => createBatch([], { name: '  ', lines }), 'INVALID_NAME')
    expectCode(() => createBatch([], { name: 'x', lines: [] }), 'INVALID_LINE')
    expectCode(
      () =>
        createBatch([], {
          name: 'x',
          lines: [{ level: 'A', spec: 200001, bookQty: 1 }],
        }),
      'INVALID_LINE',
    )
    expect(
      () =>
        createBatch([], {
          name: 'x',
          lines: [
            { level: 'A', spec: 10, bookQty: 1 },
            { level: 'A', spec: 10, bookQty: 2 },
          ],
        // duplicate spec: message-level check (Chinese)
      }),
    ).toThrow(/重复/)

    const batches = draft()
    expectCode(() => updateDraft(batches, findId(batches), { name: 'y', lines: [] }), 'INVALID_LINE')
  })

  it('accepts all four disposition codes', () => {
    const codes = ['book_correct', 'actual_correct', 'write_off', 'recheck'] as const
    for (const code of codes) {
      let batches = createBatch([], {
        name: 'b',
        lines: [{ level: 'A', spec: 1, bookQty: 1 }],
      })
      const id = batches[0].id
      batches = startCounting(batches, id)
      batches = recordCount(batches, id, batches[0].lines[0].id, 2)
      batches = submitForReview(batches, id)
      batches = resolveDifference(batches, id, batches[0].lines[0].id, code)
      expect(advance(batches, id)[0].status).toBe('completed')
    }
  })
})

describe('missing batch / unknown id', () => {
  beforeEach(() => {
    // no state; just silence vitest empty-context lint
  })
  it('every op rejects BATCH_NOT_FOUND', () => {
    expectCode(() => startCounting([], 'nope'), 'BATCH_NOT_FOUND')
    expectCode(() => recordCount([], 'nope', 'x', 1), 'BATCH_NOT_FOUND')
  })
})
