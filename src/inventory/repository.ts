/**
 * Versioned localStorage repository for stocktake batches.
 *
 * Concerns are split:
 *   - migrations.ts decides how old payload versions map to the current model
 *   - schema.ts decides whether a (migrated) batch is structurally sound
 *   - this module only owns the storage protocol and failure recovery
 *
 * Write protocol (no candidate may leak into React state on failure):
 *   1. STAGE  — write the candidate under a `::stage` key (committed:false
 *               marker) and read it back; mismatch/quota/throw aborts before
 *               the live record is ever touched.
 *   2. COMMIT — write the same payload with committed:true to the live key,
 *               read it back and require deep equality. Any failure triggers
 *               a best-effort rollback to the previously stored raw string.
 *   3. CLEANUP— remove the stage key.
 *
 * Only after all three steps return does the caller update React state.
 * On failure the last successfully committed version keeps being served and
 * the same operation can be retried verbatim.
 */

import { CURRENT_RECORD_VERSION, migratePayload } from './migrations'
import { asBatch, validateBatch } from './schema'
import { isObject, jsonDeepEqual } from './schema-utils'
import type {
  QuarantineEntry,
  QuarantineReason,
  StocktakeBatch,
} from './types'

export const STORAGE_PREFIX = 'shim-stocktake:'
const STAGE_SUFFIX = '::stage'

/** Minimal injectable storage seam (localStorage-shaped). */
export interface StorageLike {
  getItem(key: string): string | null
  setItem(key: string, value: string): void
  removeItem(key: string): void
  /** List owned keys; the real adapter scans localStorage. */
  keys(): string[]
}

export type CommitStage = 'stage' | 'commit' | 'cleanup' | 'delete'

export class StorageWriteError extends Error {
  readonly stage: CommitStage
  readonly cause?: unknown
  readonly quota: boolean
  constructor(stage: CommitStage, message: string, cause?: unknown) {
    super(message)
    this.name = 'StorageWriteError'
    this.stage = stage
    this.cause = cause
    this.quota = isQuotaError(cause)
  }
}

function isQuotaError(err: unknown): boolean {
  if (!err || typeof err !== 'object') return false
  const e = err as { name?: string; code?: number | string; message?: string }
  if (e.name === 'QuotaExceededError' || e.name === 'NS_ERROR_DOM_QUOTA_REACHED') return true
  if (e.code === 22 || e.code === 1014) return true
  return typeof e.message === 'string' && /quota/i.test(e.message)
}

interface Envelope {
  version: number
  committed: boolean
  savedAt: number
  batch: unknown
}

function makeEnvelope(batch: StocktakeBatch, committed: boolean, now: number): Envelope {
  return { version: CURRENT_RECORD_VERSION, committed, savedAt: now, batch }
}

export interface LoadResult {
  batches: StocktakeBatch[]
  quarantined: QuarantineEntry[]
}

export interface RepositoryOptions {
  /** Override the migration entry point (tests inject illegal migrations). */
  migrate?: typeof migratePayload
  now?: () => number
}

export class InventoryRepository {
  private readonly storage: StorageLike
  private readonly migrate: typeof migratePayload
  private readonly now: () => number

  constructor(storage: StorageLike, options: RepositoryOptions = {}) {
    this.storage = storage
    this.migrate = options.migrate ?? migratePayload
    this.now = options.now ?? (() => Date.now())
  }

  private dataKey(id: string): string {
    return `${STORAGE_PREFIX}${id}`
  }

  private stageKey(id: string): string {
    return `${STORAGE_PREFIX}${id}${STAGE_SUFFIX}`
  }

  /**
   * Load every owned record. Corrupt / incompatible / uncommitted records are
   * isolated into `quarantined` while valid batches remain usable. Leftover
   * stage keys from a crashed tab are swept best-effort.
   */
  load(): LoadResult {
    const quarantined: QuarantineEntry[] = []
    const batches: StocktakeBatch[] = []
    let keys: string[]
    try {
      keys = this.storage.keys()
    } catch {
      // Storage completely unreadable: nothing valid to offer.
      return { batches, quarantined }
    }

    for (const key of keys) {
      if (!key.startsWith(STORAGE_PREFIX)) continue
      if (key.endsWith(STAGE_SUFFIX)) {
        // Staging area of an interrupted write; never authoritative.
        this.safeRemove(key)
        continue
      }

      let raw: string | null
      try {
        raw = this.storage.getItem(key)
      } catch {
        quarantined.push(this.entry(key, 'bad_envelope', '读取记录失败'))
        continue
      }
      if (raw === null) continue

      let parsed: unknown
      try {
        parsed = JSON.parse(raw)
      } catch {
        quarantined.push(this.entry(key, 'unparseable', 'JSON 解析失败'))
        continue
      }
      if (!isObject(parsed) || typeof parsed.version !== 'number') {
        quarantined.push(this.entry(key, 'bad_envelope', '缺少版本字段或信封不是对象'))
        continue
      }
      const env = parsed as Partial<Envelope>
      if (
        typeof env.committed !== 'boolean' ||
        typeof env.savedAt !== 'number' ||
        !isObject(env.batch)
      ) {
        quarantined.push(this.entry(key, 'bad_envelope', 'committed/savedAt/batch 字段缺失或类型错误'))
        continue
      }
      const version = (parsed as { version: unknown }).version
      if (!Number.isInteger(version) || (version as number) < 1) {
        quarantined.push(this.entry(key, 'bad_envelope', `版本号非法: ${String(version)}`))
        continue
      }
      const recordVersion = version as number
      if (env.committed !== true) {
        quarantined.push(this.entry(key, 'uncommitted_record', '记录缺少提交标记（上次写入未完成）'))
        continue
      }
      if (recordVersion > CURRENT_RECORD_VERSION) {
        quarantined.push(
          this.entry(key, 'unsupported_version', `记录版本 ${recordVersion} 高于当前版本 ${CURRENT_RECORD_VERSION}`),
        )
        continue
      }

      let batch: unknown
      try {
        batch = this.migrate(recordVersion, env.batch)
      } catch (err) {
        quarantined.push(
          this.entry(key, 'invalid_migration', err instanceof Error ? err.message : String(err)),
        )
        continue
      }
      const validation = validateBatch(batch)
      if (!validation.ok) {
        quarantined.push(this.entry(key, 'invalid_batch', validation.error ?? '结构校验失败'))
        continue
      }
      batches.push(asBatch(batch))
    }

    batches.sort((p, q) => p.createdAt - q.createdAt)
    return { batches, quarantined }
  }

  /**
   * Persist a candidate batch through stage → verified commit → cleanup.
   * Returns the batch exactly as read back from storage. Throws
   * StorageWriteError on quota exhaustion, writer exceptions or read-back
   * inconsistency; the previously committed record is preserved/restored.
   */
  commit(batch: StocktakeBatch): StocktakeBatch {
    const key = this.dataKey(batch.id)
    const stageKey = this.stageKey(batch.id)

    let previousRaw: string | null = null
    try {
      previousRaw = this.storage.getItem(key)
    } catch {
      previousRaw = null
    }

    // ---- Step 1: stage write + read-back verification ----
    const stageEnvelope = makeEnvelope(batch, false, this.now())
    const stagedText = JSON.stringify(stageEnvelope)
    try {
      this.storage.setItem(stageKey, stagedText)
    } catch (err) {
      this.safeRemove(stageKey)
      throw new StorageWriteError('stage', '暂存区写入失败（可能容量不足），正式记录未改动', err)
    }
    const stagedBack = this.readJson(stageKey)
    if (stagedBack === undefined || !this.envelopeMatches(stagedBack, stageEnvelope)) {
      this.safeRemove(stageKey)
      throw new StorageWriteError('stage', '暂存区写入后回读不一致，已放弃本次写入')
    }

    // ---- Step 2: commit to the live key + read-back verification ----
    const liveEnvelope = makeEnvelope(batch, true, this.now())
    const liveText = JSON.stringify(liveEnvelope)
    try {
      this.storage.setItem(key, liveText)
    } catch (err) {
      // setItem is atomic per spec; old record should still be intact.
      this.rollback(key, previousRaw)
      this.safeRemove(stageKey)
      throw new StorageWriteError('commit', '正式记录写入失败（可能容量不足），已保留上一版本', err)
    }
    const liveBack = this.readJson(key)
    if (liveBack === undefined || !this.envelopeMatches(liveBack, liveEnvelope)) {
      this.rollback(key, previousRaw)
      this.safeRemove(stageKey)
      throw new StorageWriteError('commit', '正式记录写入后回读不一致，已回滚到上一版本')
    }

    // ---- Step 3: cleanup (best effort; the live commit is already
    // durable — a leftover stage key is swept harmlessly on next load) ----
    this.safeRemove(stageKey)

    return asBatch((liveBack as Envelope).batch)
  }

  /** Remove a batch record (and any stage residue). */
  remove(id: string): void {
    const key = this.dataKey(id)
    const stageKey = this.stageKey(id)
    try {
      this.storage.removeItem(key)
      this.storage.removeItem(stageKey)
    } catch (err) {
      throw new StorageWriteError('delete', '删除记录失败', err)
    }
    let remaining: string | null
    try {
      remaining = this.storage.getItem(key)
    } catch {
      remaining = null
    }
    if (remaining !== null) {
      throw new StorageWriteError('delete', '删除后回读仍存在该记录')
    }
  }

  /** Best-effort deletion of isolated records; returns number actually removed. */
  purgeQuarantine(entries: readonly QuarantineEntry[]): number {
    let removed = 0
    for (const entry of entries) {
      if (this.safeRemove(entry.storageKey)) removed += 1
    }
    return removed
  }

  private rollback(key: string, previousRaw: string | null): void {
    try {
      if (previousRaw === null) this.storage.removeItem(key)
      else this.storage.setItem(key, previousRaw)
    } catch {
      // Rollback itself failed; the underlying store is unhealthy. We never
      // surface untrusted data as current state — callers keep their last
      // known-good in-memory version regardless.
    }
  }

  private readJson(key: string): unknown | undefined {
    let raw: string | null
    try {
      raw = this.storage.getItem(key)
    } catch {
      return undefined
    }
    if (raw === null) return undefined
    try {
      return JSON.parse(raw)
    } catch {
      return undefined
    }
  }

  private envelopeMatches(actual: unknown, expected: Envelope): boolean {
    if (!isObject(actual)) return false
    if (actual.version !== expected.version || actual.committed !== expected.committed) return false
    return jsonDeepEqual(actual.batch, expected.batch)
  }

  private safeRemove(key: string): boolean {
    try {
      this.storage.removeItem(key)
      return true
    } catch {
      return false
    }
  }

  private entry(key: string, reason: QuarantineReason, detail: string): QuarantineEntry {
    return { storageKey: key, reason, detail }
  }
}

/** Default adapter over window.localStorage. */
export class LocalStorageAdapter implements StorageLike {
  private get store(): Storage {
    if (typeof localStorage === 'undefined') {
      throw new Error('当前环境不支持 localStorage')
    }
    return localStorage
  }

  getItem(key: string): string | null {
    return this.store.getItem(key)
  }

  setItem(key: string, value: string): void {
    this.store.setItem(key, value)
  }

  removeItem(key: string): void {
    this.store.removeItem(key)
  }

  keys(): string[] {
    const out: string[] = []
    const store = this.store
    for (let i = 0; i < store.length; i++) {
      const key = store.key(i)
      if (key !== null) out.push(key)
    }
    return out
  }
}
