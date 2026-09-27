/**
 * Versioned migration rules for persisted stocktake records.
 *
 * Migration rules live here, separate from the storage repository: the
 * repository only knows how to read/write an envelope, while this module
 * knows how older payload versions map to the current domain shape.
 *
 * Adding a future version means bumping CURRENT_RECORD_VERSION and appending a
 * migration to MIGRATIONS — never editing an already-shipped migration.
 */

import { isObject } from './schema-utils'
import type { BatchStatus, StocktakeBatch, StocktakeLine } from './types'

export const CURRENT_RECORD_VERSION = 2

export type MigrateFn = (payload: unknown) => unknown

export class MigrationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'MigrationError'
  }
}

/**
 * v1 -> v2
 *
 * v1 was the provisional single-customer shape:
 *   { id, title, createdAt?, status?: 'open'|'done',
 *     entries: [{ grade: 'A'|'B', size, ledger, counted? }] }
 *
 * v2 is the stocktake domain model: named batch with explicit statuses and
 * per-line disposition fields. Partial counting survives the migration; the
 * status is inferred from how far the v1 record got.
 */
function migrateV1ToV2(raw: unknown): unknown {
  if (!isObject(raw)) throw new MigrationError('v1 记录不是对象')
  const { id, title, entries, createdAt, status: oldStatus } = raw

  if (typeof id !== 'string' || id.length === 0)
    throw new MigrationError('v1 记录缺少 id')
  if (typeof title !== 'string' || title.length === 0)
    throw new MigrationError('v1 记录缺少 title')
  if (!Array.isArray(entries) || entries.length === 0)
    throw new MigrationError('v1 记录 entries 缺失或为空')

  // v1 did not guarantee timestamps; synthesize a valid positive epoch so the
  // migrated record satisfies the current strict schema.
  const created =
    typeof createdAt === 'number' && Number.isFinite(createdAt) && createdAt > 0
      ? Math.trunc(createdAt)
      : 1

  const lines: StocktakeLine[] = entries.map((entry, i) => {
    if (!isObject(entry)) throw new MigrationError(`v1 第 ${i + 1} 项不是对象`)
    const grade = entry.grade
    if (grade !== 'A' && grade !== 'B')
      throw new MigrationError(`v1 第 ${i + 1} 项 grade 非法`)
    const size = entry.size
    const ledger = entry.ledger
    if (typeof size !== 'number' || !Number.isInteger(size))
      throw new MigrationError(`v1 第 ${i + 1} 项 size 非法`)
    if (typeof ledger !== 'number' || !Number.isInteger(ledger) || ledger < 0)
      throw new MigrationError(`v1 第 ${i + 1} 项 ledger 非法`)
    const hasCounted = entry.counted !== undefined && entry.counted !== null
    if (hasCounted && (typeof entry.counted !== 'number' || !Number.isInteger(entry.counted) || entry.counted < 0))
      throw new MigrationError(`v1 第 ${i + 1} 项 counted 非法`)
    return {
      id: `v1-${i + 1}`,
      level: grade as 'A' | 'B',
      spec: size,
      bookQty: ledger,
      actualQty: hasCounted ? (entry.counted as number) : null,
    }
  })

  let status: BatchStatus
  if (oldStatus === 'done') {
    // v1 "done" implied a finished count; differences were auto-accepted.
    for (const line of lines) {
      if (line.actualQty === null) line.actualQty = line.bookQty
      if (line.actualQty !== line.bookQty) line.disposition = 'actual_correct'
    }
    status = 'completed'
  } else if (lines.every((l) => l.actualQty !== null)) {
    const anyDiff = lines.some((l) => l.actualQty !== l.bookQty)
    status = anyDiff ? 'review_required' : 'counting'
  } else {
    status = 'counting'
  }

  const batch: unknown = {
    id,
    name: title,
    createdAt: created,
    updatedAt: created,
    status,
    lines,
  }
  return batch
}

/** Indexed by source version; MIGRATIONS[1] upgrades 1 -> 2. */
export const MIGRATIONS: Record<number, MigrateFn> = {
  1: migrateV1ToV2,
}

/**
 * Bring an envelope payload up to CURRENT_RECORD_VERSION.
 * Throws MigrationError on a malformed older record or an unknown migration
 * chain. A payload already at the current version passes through untouched.
 */
export function migratePayload(fromVersion: number, payload: unknown): StocktakeBatch {
  let version = fromVersion
  let current = payload
  if (!Number.isInteger(version) || version < 1)
    throw new MigrationError(`非法存储版本号: ${String(fromVersion)}`)
  if (version > CURRENT_RECORD_VERSION)
    throw new MigrationError(`存储版本 ${version} 高于当前版本 ${CURRENT_RECORD_VERSION}`)
  while (version < CURRENT_RECORD_VERSION) {
    const fn = MIGRATIONS[version]
    if (!fn) throw new MigrationError(`缺少 v${version} 的迁移规则`)
    current = fn(current)
    version += 1
  }
  return current as StocktakeBatch
}
