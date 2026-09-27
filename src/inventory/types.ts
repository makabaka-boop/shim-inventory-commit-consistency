/**
 * Domain model for the physical shim-kit stocktake (实物垫片套装盘点).
 *
 * A stocktake batch carries A/B level shim specifications with their book
 * quantities; counters enter actual (counted) quantities line by line, then
 * each book-vs-actual difference must be resolved with a disposition before
 * the same advance action closes the batch.
 */

export type BatchStatus = 'draft' | 'counting' | 'review_required' | 'completed'

/** Ordered lifecycle; advance only moves one step forward. */
export const STATUS_ORDER: readonly BatchStatus[] = [
  'draft',
  'counting',
  'review_required',
  'completed',
]

export const STATUS_LABEL: Record<BatchStatus, string> = {
  draft: '已建草稿',
  counting: '盘点中',
  review_required: '待差异复核',
  completed: '已完成',
}

export type Level = 'A' | 'B'

export type DispositionCode =
  | 'book_correct'
  | 'actual_correct'
  | 'write_off'
  | 'recheck'

export const DISPOSITION_LABEL: Record<DispositionCode, string> = {
  book_correct: '以账面为准（盘盈/盘亏不成立）',
  actual_correct: '以实点为准（调账）',
  write_off: '报损/报溢核销',
  recheck: '安排复盘',
}

export interface StocktakeLine {
  /** Stable id within the batch. */
  id: string
  level: Level
  /** Discrete shim specification in μm, integer [0, 200_000]. */
  spec: number
  /** Book (ledger) quantity, integer >= 0. */
  bookQty: number
  /** Actual counted quantity; null means not counted yet. */
  actualQty: number | null
  /**
   * Disposition for a line whose counted value differs from the book value.
   * Undefined while there is no difference or while it is unresolved.
   */
  disposition?: DispositionCode
  /** Free-text note attached to the disposition (optional). */
  dispositionNote?: string
}

export interface StocktakeBatch {
  id: string
  name: string
  createdAt: number
  updatedAt: number
  status: BatchStatus
  lines: StocktakeLine[]
}

/** Why a stored record was isolated on load. Stable codes used by UI/tests. */
export type QuarantineReason =
  | 'unparseable'
  | 'bad_envelope'
  | 'unsupported_version'
  | 'invalid_migration'
  | 'invalid_batch'
  | 'uncommitted_record'

export interface QuarantineEntry {
  storageKey: string
  reason: QuarantineReason
  detail: string
}

export const QUARANTINE_REASON_LABEL: Record<QuarantineReason, string> = {
  unparseable: '记录不是合法 JSON',
  bad_envelope: '存储信封结构损坏',
  unsupported_version: '存储版本不兼容（高于当前版本）',
  invalid_migration: '版本迁移失败',
  invalid_batch: '批次结构校验未通过',
  uncommitted_record: '上次写入未完成（缺少提交标记）',
}

/** Why a domain transition was rejected. */
export type RuleErrorCode =
  | 'BATCH_NOT_FOUND'
  | 'INVALID_STATUS'
  | 'EMPTY_LINES'
  | 'NOT_ALL_COUNTED'
  | 'UNRESOLVED_DIFFERENCES'
  | 'INVALID_NAME'
  | 'INVALID_LINE'

export class RuleError extends Error {
  readonly code: RuleErrorCode
  constructor(code: RuleErrorCode, message: string) {
    super(message)
    this.name = 'RuleError'
    this.code = code
  }
}
