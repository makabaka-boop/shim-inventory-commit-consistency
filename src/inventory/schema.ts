/**
 * Structural validation for stocktake batches and their persistence envelope.
 *
 * Every candidate produced by a domain operation is re-validated here before
 * it is offered to the repository, and every record read back from storage is
 * validated here on load. The checks are deliberately strict: a single bad
 * field isolates the whole record instead of silently dropping data.
 */

import {
  DISPOSITION_LABEL,
  STATUS_ORDER,
  type BatchStatus,
  type DispositionCode,
  type Level,
  type StocktakeBatch,
  type StocktakeLine,
} from './types'

/** Specification bounds reuse the reachability tool's shim domain. */
export const SPEC_MIN = 0
export const SPEC_MAX = 200_000
export const QTY_MAX = 1_000_000
export const NAME_MAX_LENGTH = 80
export const NOTE_MAX_LENGTH = 200
export const MAX_LINES = 100_000

export interface ValidationResult {
  ok: boolean
  error?: string
}

const DISPOSITION_CODES = Object.keys(DISPOSITION_LABEL) as DispositionCode[]
const LEVELS: readonly Level[] = ['A', 'B']

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v) && Number.isInteger(v)
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

export function isBatchStatus(v: unknown): v is BatchStatus {
  return typeof v === 'string' && (STATUS_ORDER as readonly string[]).includes(v)
}

export function isDispositionCode(v: unknown): v is DispositionCode {
  return typeof v === 'string' && (DISPOSITION_CODES as readonly string[]).includes(v)
}

/**
 * Validate one persisted/migrated batch. The status-dependent cross checks
 * encode the completion-gate invariants directly on the stored shape:
 *  - counting/review/completed batches must have every line counted
 *  - review_required/completed batches must have every difference disposed
 */
export function validateBatch(data: unknown): ValidationResult {
  if (!isObject(data)) return { ok: false, error: '批次必须是对象' }

  if (typeof data.id !== 'string' || data.id.length === 0)
    return { ok: false, error: '缺少批次 id' }
  if (typeof data.name !== 'string') return { ok: false, error: '批次名称不是字符串' }
  if (data.name.trim().length === 0) return { ok: false, error: '批次名称为空' }
  if (data.name.length > NAME_MAX_LENGTH)
    return { ok: false, error: `批次名称超过 ${NAME_MAX_LENGTH} 字` }
  if (!isInt(data.createdAt) || data.createdAt <= 0)
    return { ok: false, error: 'createdAt 非法' }
  if (!isInt(data.updatedAt) || data.updatedAt < data.createdAt)
    return { ok: false, error: 'updatedAt 非法' }
  if (!isBatchStatus(data.status)) return { ok: false, error: '批次状态非法' }
  if (!Array.isArray(data.lines)) return { ok: false, error: 'lines 不是数组' }
  if (data.lines.length === 0) return { ok: false, error: '批次没有任何明细' }
  if (data.lines.length > MAX_LINES)
    return { ok: false, error: `明细超过 ${MAX_LINES} 行` }

  const seen = new Set<string>()
  for (let i = 0; i < data.lines.length; i++) {
    const raw = data.lines[i]
    const at = `第 ${i + 1} 行`
    if (!isObject(raw)) return { ok: false, error: `${at}：不是对象` }
    if (typeof raw.id !== 'string' || raw.id.length === 0)
      return { ok: false, error: `${at}：缺少明细 id` }
    if (seen.has(raw.id)) return { ok: false, error: `${at}：明细 id 重复` }
    seen.add(raw.id)
    if (typeof raw.level !== 'string' || !LEVELS.includes(raw.level as Level))
      return { ok: false, error: `${at}：级别必须是 A 或 B` }
    if (!isInt(raw.spec) || raw.spec < SPEC_MIN || raw.spec > SPEC_MAX)
      return { ok: false, error: `${at}：规格必须是 [0, ${SPEC_MAX}] 的整数` }
    if (!isInt(raw.bookQty) || raw.bookQty < 0 || raw.bookQty > QTY_MAX)
      return { ok: false, error: `${at}：账面数量必须是 [0, ${QTY_MAX}] 的整数` }

    if (raw.actualQty !== null && raw.actualQty !== undefined) {
      if (!isInt(raw.actualQty) || raw.actualQty < 0 || raw.actualQty > QTY_MAX)
        return { ok: false, error: `${at}：实点数量必须是 [0, ${QTY_MAX}] 的整数或 null` }
    }
    if (raw.disposition !== undefined) {
      if (!isDispositionCode(raw.disposition))
        return { ok: false, error: `${at}：处置结论非法` }
    }
    if (raw.dispositionNote !== undefined && typeof raw.dispositionNote !== 'string')
      return { ok: false, error: `${at}：处置备注不是字符串` }
    if (typeof raw.dispositionNote === 'string' && raw.dispositionNote.length > NOTE_MAX_LENGTH)
      return { ok: false, error: `${at}：处置备注超过 ${NOTE_MAX_LENGTH} 字` }
  }

  const status = data.status
  const lines = data.lines as unknown as StocktakeLine[]

  if (status === 'review_required' || status === 'completed') {
    const uncounted = lines.findIndex((l) => l.actualQty === null || l.actualQty === undefined)
    if (uncounted >= 0)
      return { ok: false, error: `第 ${uncounted + 1} 行尚未计数，状态不应为 ${status}` }
  }
  // review_required *means* differences are awaiting disposition, so they may
  // legitimately be unresolved there; only a completed batch must have every
  // difference disposed.
  if (status === 'completed') {
    const unresolved = lines.findIndex(
      (l) => l.actualQty !== null && l.actualQty !== l.bookQty && l.disposition === undefined,
    )
    if (unresolved >= 0)
      return { ok: false, error: `第 ${unresolved + 1} 行存在未处置差异，状态不应为 ${status}` }
  }

  return { ok: true }
}

/** Unchecked cast helper used only after validateBatch has returned ok. */
export function asBatch(data: unknown): StocktakeBatch {
  // Normalize: persisted drafts may omit actualQty; represent as null.
  const b = data as StocktakeBatch
  for (const line of b.lines) {
    if (line.actualQty === undefined) line.actualQty = null
  }
  return b
}

/** Shape of a single draft line supplied by the create/edit form. */
export interface LineDraft {
  level: Level
  spec: number
  bookQty: number
}

/**
 * Validate the form's line drafts: bounds plus per-level duplicate
 * specifications (the same physical spec can't appear twice in one batch).
 */
export function validateLineDrafts(lines: LineDraft[]): ValidationResult {
  if (lines.length === 0) return { ok: false, error: '至少录入一行 A/B 级规格' }
  if (lines.length > MAX_LINES) return { ok: false, error: `明细超过 ${MAX_LINES} 行` }
  const seen = new Set<string>()
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    const at = `第 ${i + 1} 行`
    if (!LEVELS.includes(line.level)) return { ok: false, error: `${at}：级别必须是 A 或 B` }
    if (!isInt(line.spec) || line.spec < SPEC_MIN || line.spec > SPEC_MAX)
      return { ok: false, error: `${at}：规格必须是 [0, ${SPEC_MAX}] 的整数` }
    if (!isInt(line.bookQty) || line.bookQty < 0 || line.bookQty > QTY_MAX)
      return { ok: false, error: `${at}：账面数量必须是 [0, ${QTY_MAX}] 的整数` }
    const key = `${line.level}:${line.spec}`
    if (seen.has(key)) return { ok: false, error: `${at}：与前一行 ${line.level} 级规格 ${line.spec} 重复` }
    seen.add(key)
  }
  return { ok: true }
}

export function validateBatchName(name: string): ValidationResult {
  if (name.trim().length === 0) return { ok: false, error: '请填写批次名称' }
  if (name.length > NAME_MAX_LENGTH)
    return { ok: false, error: `批次名称不超过 ${NAME_MAX_LENGTH} 字` }
  return { ok: true }
}
