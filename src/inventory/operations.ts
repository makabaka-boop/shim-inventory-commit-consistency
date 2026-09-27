/**
 * Pure stocktake domain operations.
 *
 * Every operation takes the current batch list and returns a *new* candidate
 * batch list (immutable updates) without touching storage or React state.
 * Candidates are re-validated against the schema by callers before
 * persistence. Transitions are one-way through the lifecycle:
 *
 *   draft ──startCounting──▶ counting ──submitForReview──▶ review_required
 *        ──resolveDifferences (still review_required)──▶ ... ──advance──▶ completed
 *
 * The same advance action drives counting -> review and review -> completed;
 * the gate differs (all counted vs. every difference disposed).
 */

import {
  validateBatch,
  validateBatchName,
  validateLineDrafts,
  type LineDraft,
} from './schema'
import {
  RuleError,
  STATUS_ORDER,
  type BatchStatus,
  type DispositionCode,
  type StocktakeBatch,
  type StocktakeLine,
} from './types'

function genId(): string {
  if (typeof crypto !== 'undefined' && 'randomUUID' in crypto) {
    return crypto.randomUUID()
  }
  return `id-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function cloneBatches(batches: readonly StocktakeBatch[]): StocktakeBatch[] {
  return batches.map((b) => ({ ...b, lines: b.lines.map((l) => ({ ...l })) }))
}

function findIndex(batches: readonly StocktakeBatch[], id: string): number {
  const i = batches.findIndex((b) => b.id === id)
  if (i < 0) throw new RuleError('BATCH_NOT_FOUND', `批次 ${id} 不存在`)
  return i
}

/** Final structural gate: a candidate must itself be a valid stored shape. */
function assertBatch(batch: StocktakeBatch): void {
  const result = validateBatch(batch)
  if (!result.ok) throw new RuleError('INVALID_LINE', result.error ?? '候选批次校验失败')
}

function mutate(
  batches: readonly StocktakeBatch[],
  id: string,
  fn: (batch: StocktakeBatch) => void,
): StocktakeBatch[] {
  const next = cloneBatches(batches)
  const index = findIndex(next, id)
  fn(next[index])
  next[index].updatedAt = Date.now()
  assertBatch(next[index])
  return next
}

function assertStatus(batch: StocktakeBatch, expected: BatchStatus): void {
  if (batch.status !== expected)
    throw new RuleError(
      'INVALID_STATUS',
      `当前状态为 ${batch.status}，该操作仅允许在 ${expected} 状态执行`,
    )
}

export interface CreateBatchInput {
  name: string
  lines: LineDraft[]
  now?: number
}

/** Create a draft batch. Nothing is persisted here — pure candidate. */
export function createBatch(
  batches: readonly StocktakeBatch[],
  input: CreateBatchInput,
): StocktakeBatch[] {
  const nameResult = validateBatchName(input.name)
  if (!nameResult.ok) throw new RuleError('INVALID_NAME', nameResult.error!)
  const linesResult = validateLineDrafts(input.lines)
  if (!linesResult.ok) throw new RuleError('INVALID_LINE', linesResult.error!)

  const now = input.now ?? Date.now()
  const batch: StocktakeBatch = {
    id: genId(),
    name: input.name.trim(),
    createdAt: now,
    updatedAt: now,
    status: 'draft',
    lines: input.lines.map((line) => ({
      id: genId(),
      level: line.level,
      spec: line.spec,
      bookQty: line.bookQty,
      actualQty: null,
    })),
  }
  assertBatch(batch)
  return [...batches, batch]
}

/** Drafts may still be edited (name + spec/book lines); counted data resets. */
export function updateDraft(
  batches: readonly StocktakeBatch[],
  id: string,
  input: CreateBatchInput,
): StocktakeBatch[] {
  const nameResult = validateBatchName(input.name)
  if (!nameResult.ok) throw new RuleError('INVALID_NAME', nameResult.error!)
  const linesResult = validateLineDrafts(input.lines)
  if (!linesResult.ok) throw new RuleError('INVALID_LINE', linesResult.error!)

  return mutate(batches, id, (batch) => {
    assertStatus(batch, 'draft')
    batch.name = input.name.trim()
    batch.lines = input.lines.map((line) => ({
      id: genId(),
      level: line.level,
      spec: line.spec,
      bookQty: line.bookQty,
      actualQty: null,
    }))
  })
}

export function deleteBatch(
  batches: readonly StocktakeBatch[],
  id: string,
): StocktakeBatch[] {
  const index = findIndex(batches, id)
  const next = batches.slice()
  next.splice(index, 1)
  return next
}

/** draft -> counting. Draft must still have at least one line. */
export function startCounting(
  batches: readonly StocktakeBatch[],
  id: string,
): StocktakeBatch[] {
  return mutate(batches, id, (batch) => {
    assertStatus(batch, 'draft')
    if (batch.lines.length === 0)
      throw new RuleError('EMPTY_LINES', '批次没有任何明细，无法开始盘点')
    batch.status = 'counting'
  })
}

/** Enter/overwrite the actual counted quantity of one line (counting only). */
export function recordCount(
  batches: readonly StocktakeBatch[],
  id: string,
  lineId: string,
  actualQty: number,
): StocktakeBatch[] {
  if (!Number.isInteger(actualQty) || actualQty < 0)
    throw new RuleError('INVALID_LINE', '实点数量必须是非负整数')
  return mutate(batches, id, (batch) => {
    assertStatus(batch, 'counting')
    const line = batch.lines.find((l) => l.id === lineId)
    if (!line) throw new RuleError('BATCH_NOT_FOUND', '明细不存在')
    line.actualQty = actualQty
    // A re-count changes whether the old disposition still applies.
    line.disposition = undefined
    line.dispositionNote = undefined
  })
}

function allCounted(batch: StocktakeBatch): boolean {
  return batch.lines.every((l) => l.actualQty !== null)
}

export function unresolvedDifferences(batch: StocktakeBatch): StocktakeLine[] {
  return batch.lines.filter((l) => l.actualQty !== null && l.actualQty !== l.bookQty && l.disposition === undefined)
}

/**
 * counting -> review_required. Gate: every line has an actual quantity.
 * If no differences exist, the batch advances straight to completed instead,
 * because there is nothing to review.
 */
export function submitForReview(
  batches: readonly StocktakeBatch[],
  id: string,
): StocktakeBatch[] {
  return mutate(batches, id, (batch) => {
    assertStatus(batch, 'counting')
    if (!allCounted(batch))
      throw new RuleError('NOT_ALL_COUNTED', '仍有明细未录入实点数，不能提交复核')
    batch.status = unresolvedDifferences(batch).length > 0 ? 'review_required' : 'completed'
  })
}

/** Resolve one difference while review is pending. */
export function resolveDifference(
  batches: readonly StocktakeBatch[],
  id: string,
  lineId: string,
  disposition: DispositionCode,
  note?: string,
): StocktakeBatch[] {
  return mutate(batches, id, (batch) => {
    assertStatus(batch, 'review_required')
    const line = batch.lines.find((l) => l.id === lineId)
    if (!line) throw new RuleError('BATCH_NOT_FOUND', '明细不存在')
    if (line.actualQty === null || line.actualQty === line.bookQty)
      throw new RuleError('INVALID_LINE', '该行没有待处置差异')
    line.disposition = disposition
    line.dispositionNote = note?.trim() ? note.trim() : undefined
  })
}

/**
 * review_required -> completed. Gate: every difference has a disposition.
 * This is the same advance action used at the counting stage; the caller
 * dispatches based on the current status.
 */
export function completeReview(
  batches: readonly StocktakeBatch[],
  id: string,
): StocktakeBatch[] {
  return mutate(batches, id, (batch) => {
    assertStatus(batch, 'review_required')
    const unresolved = unresolvedDifferences(batch)
    if (unresolved.length > 0)
      throw new RuleError(
        'UNRESOLVED_DIFFERENCES',
        `仍有 ${unresolved.length} 项差异未填写处置结论，不能结案`,
      )
    batch.status = 'completed'
  })
}

/** One unified advance button; rejects in draft/completed. */
export function advance(
  batches: readonly StocktakeBatch[],
  id: string,
): StocktakeBatch[] {
  const batch = batches.find((b) => b.id === id)
  if (!batch) throw new RuleError('BATCH_NOT_FOUND', `批次 ${id} 不存在`)
  if (batch.status === 'counting') return submitForReview(batches, id)
  if (batch.status === 'review_required') return completeReview(batches, id)
  throw new RuleError(
    'INVALID_STATUS',
    batch.status === 'completed'
      ? '批次已完成，只读'
      : `状态 ${batch.status} 不能直接推进`,
  )
}

export function nextStatus(status: BatchStatus): BatchStatus | null {
  const i = STATUS_ORDER.indexOf(status)
  return i >= 0 && i < STATUS_ORDER.length - 1 ? STATUS_ORDER[i + 1] : null
}
