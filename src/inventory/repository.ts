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
 *               read it back (transient flaky reads are retried) and require
 *               deep equality. Any failure triggers a VERIFIED rollback.
 *   3. CLEANUP— remove the stage key.
 *
 * Ambiguous-commit handling (the important invariant):
 *   When the live write landed but its read-back cannot prove the candidate
 *   is what storage holds, the push is reported as failed. We then attempt a
 *   verified rollback to the previous raw bytes.
 *     - rollback verified      → evidence swept, plain failure; the last good
 *                                version remains authoritative.
 *     - rollback unverifiable  → the stage is rewritten with `indoubt:true`
 *                                (carrying the previous bytes) and KEPT. The
 *                                failed push can never silently become truth:
 *                                on the next load that live record is isolated
 *                                (ambiguous_commit) until a human explicitly
 *                                adopts or reverts it.
 *
 * Only after a fully verified commit does the caller update React state.
 */

import { CURRENT_RECORD_VERSION, migratePayload } from './migrations'
import { asBatch, validateBatch } from './schema'
import { isObject, jsonDeepEqual } from './schema-utils'
import type {
  AmbiguousResolution,
  BatchStatus,
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

export type CommitStage = 'stage' | 'commit' | 'cleanup' | 'delete' | 'resolve'

export class StorageWriteError extends Error {
  readonly stage: CommitStage
  readonly cause?: unknown
  readonly quota: boolean
  /**
   * True when the commit result is ambiguous: the live write may have landed,
   * and storage could not be proven restored. The affected batch is frozen
   * in-memory and isolated on the next load until explicitly resolved.
   */
  readonly indoubt: boolean
  constructor(
    stage: CommitStage,
    message: string,
    cause?: unknown,
    options: { indoubt?: boolean } = {},
  ) {
    super(message)
    this.name = 'StorageWriteError'
    this.stage = stage
    this.cause = cause
    this.quota = isQuotaError(cause)
    this.indoubt = options.indoubt === true
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

interface StageEnvelope extends Envelope {
  /** Marks evidence of a push whose commit result could not be verified. */
  indoubt?: boolean
  /**
   * Exact previous live-record raw string (JSON-encoded), captured before the
   * live key was touched. Enables byte-exact recovery across a refresh. Null
   * when there was no prior record (the push was a create).
   */
  previousRaw?: string | null
}

function makeEnvelope(batch: StocktakeBatch, committed: boolean, now: number): Envelope {
  return { version: CURRENT_RECORD_VERSION, committed, savedAt: now, batch }
}

/** Number of read attempts used to tolerate a single transient read glitch. */
const VERIFY_READ_ATTEMPTS = 3

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

  private isStageKey(key: string): boolean {
    return key.startsWith(STORAGE_PREFIX) && key.endsWith(STAGE_SUFFIX)
  }

  private idFromDataKey(key: string): string {
    return key.slice(STORAGE_PREFIX.length)
  }

  private idFromStageKey(key: string): string {
    return key.slice(STORAGE_PREFIX.length, -STAGE_SUFFIX.length)
  }

  /**
   * Load every owned record. Corrupt / incompatible / uncommitted records are
   * isolated into `quarantined` while valid batches remain usable.
   *
   * A leftover stage key is evidence of an interrupted write. Normally
   * (crash before commit) it is swept. When marked `indoubt` it means the
   * previous tab could not verify its commit/rollback, so the paired live
   * record is reconciled against the stored evidence rather than trusted.
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

    // Gather records first so each live key can be judged alongside its stage.
    const liveRawByKey = new Map<string, string>()
    const stageByKey = new Map<string, StageEnvelope>()
    const malformedStageKeys = new Set<string>()

    for (const key of keys) {
      if (!key.startsWith(STORAGE_PREFIX)) continue
      let raw: string | null
      try {
        raw = this.storage.getItem(key)
      } catch {
        quarantined.push(this.entry(key, 'bad_envelope', '读取记录失败'))
        continue
      }
      if (raw === null) continue

      if (this.isStageKey(key)) {
        const parsed = this.readJson(key)
        // Only a well-formed stage envelope is usable as recovery evidence.
        if (this.isStageShape(parsed)) stageByKey.set(key, parsed)
        else malformedStageKeys.add(key)
        continue
      }
      liveRawByKey.set(key, raw)
    }

    // ---- Reconcile each stage against its paired live record ----
    const consumedLiveKeys = new Set<string>()
    for (const [stageKey, stage] of stageByKey) {
      const id = this.idFromStageKey(stageKey)
      const liveKey = this.dataKey(id)
      const liveRaw = liveRawByKey.has(liveKey) ? (liveRawByKey.get(liveKey) as string) : null

      if (!stage.indoubt) {
        // Crash before/during commit: the live record was never touched.
        this.safeRemove(stageKey)
        continue
      }

      const candidateEnv = {
        version: stage.version,
        committed: true,
        savedAt: stage.savedAt,
        batch: stage.batch,
      }
      const prevRaw = typeof stage.previousRaw === 'string' ? stage.previousRaw : null

      if (liveRaw === null) {
        // The new version is absent. Recover the last good version if we can
        // prove the restore; otherwise isolate so nothing is silently lost.
        if (prevRaw === null) {
          this.safeRemove(stageKey) // a failed create: nothing to recover
          continue
        }
        if (this.restoreAndVerify(liveKey, prevRaw)) {
          this.safeRemove(stageKey)
          liveRawByKey.set(liveKey, prevRaw) // validated by the normal pass below
        } else {
          consumedLiveKeys.add(liveKey)
          quarantined.push(
            this.ambiguousEntry(liveKey, stage, '提交结果存疑：正式记录丢失且恢复上一版本失败'),
          )
        }
        continue
      }

      if (prevRaw !== null && liveRaw === prevRaw) {
        // Durable proof the rollback restored the previous version: the push
        // genuinely did not take effect. Clear the evidence and load it.
        this.safeRemove(stageKey)
        continue
      }

      if (this.rawMatchesEnvelope(liveRaw, candidateEnv)) {
        // The live record holds the unconfirmed candidate, or something we
        // cannot distinguish from it. It never becomes truth automatically:
        // a human must explicitly adopt or revert it.
        consumedLiveKeys.add(liveKey)
        quarantined.push(
          this.ambiguousEntry(
            liveKey,
            stage,
            '提交结果存疑：存储中的批次与未确认的提交一致，需人工确认采用还是回退',
          ),
        )
        continue
      }

      // Live holds neither the previous version nor the candidate.
      consumedLiveKeys.add(liveKey)
      quarantined.push(
        this.ambiguousEntry(liveKey, stage, '提交结果存疑：正式记录既非上一版本也非本次候选，已冻结'),
      )
    }

    // Stages that cannot be parsed are not evidence; sweep them but do not
    // let a broken stage hide an otherwise-valid live record.
    for (const stageKey of malformedStageKeys) {
      this.safeRemove(stageKey)
    }

    // ---- Validate every remaining live record one by one ----
    for (const [key, raw] of liveRawByKey) {
      if (consumedLiveKeys.has(key)) continue
      this.validateLive(key, raw, quarantined, batches)
    }

    batches.sort((p, q) => p.createdAt - q.createdAt)
    return { batches, quarantined }
  }

  private validateLive(
    key: string,
    raw: string,
    quarantined: QuarantineEntry[],
    batches: StocktakeBatch[],
  ): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      quarantined.push(this.entry(key, 'unparseable', 'JSON 解析失败'))
      return
    }
    if (!isObject(parsed) || typeof parsed.version !== 'number') {
      quarantined.push(this.entry(key, 'bad_envelope', '缺少版本字段或信封不是对象'))
      return
    }
    const env = parsed as Partial<Envelope>
    if (
      typeof env.committed !== 'boolean' ||
      typeof env.savedAt !== 'number' ||
      !isObject(env.batch)
    ) {
      quarantined.push(this.entry(key, 'bad_envelope', 'committed/savedAt/batch 字段缺失或类型错误'))
      return
    }
    const version = (parsed as { version: unknown }).version
    if (!Number.isInteger(version) || (version as number) < 1) {
      quarantined.push(this.entry(key, 'bad_envelope', `版本号非法: ${String(version)}`))
      return
    }
    const recordVersion = version as number
    if (env.committed !== true) {
      quarantined.push(this.entry(key, 'uncommitted_record', '记录缺少提交标记（上次写入未完成）'))
      return
    }
    if (recordVersion > CURRENT_RECORD_VERSION) {
      quarantined.push(
        this.entry(key, 'unsupported_version', `记录版本 ${recordVersion} 高于当前版本 ${CURRENT_RECORD_VERSION}`),
      )
      return
    }

    let batch: unknown
    try {
      batch = this.migrate(recordVersion, env.batch)
    } catch (err) {
      quarantined.push(
        this.entry(key, 'invalid_migration', err instanceof Error ? err.message : String(err)),
      )
      return
    }
    const validation = validateBatch(batch)
    if (!validation.ok) {
      quarantined.push(this.entry(key, 'invalid_batch', validation.error ?? '结构校验失败'))
      return
    }
    batches.push(asBatch(batch))
  }

  /**
   * Persist a candidate batch through stage → verified commit → cleanup.
   * Returns the batch exactly as read back from storage. Throws
   * StorageWriteError on quota exhaustion, writer exceptions or read-back
   * inconsistency. A failure is either a clean failure (last good version
   * intact and verified) or an explicitly flagged ambiguous failure (the
   * batch is frozen and isolated on reload) — never a silent leak.
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
    const stageEnvelope: StageEnvelope = {
      ...makeEnvelope(batch, false, this.now()),
      indoubt: false,
      previousRaw,
    }
    const stagedText = JSON.stringify(stageEnvelope)
    try {
      this.storage.setItem(stageKey, stagedText)
    } catch (err) {
      this.safeRemove(stageKey)
      throw new StorageWriteError('stage', '暂存区写入失败（可能容量不足），正式记录未改动', err)
    }
    const stagedBack = this.readJson(stageKey)
    if (stagedBack === undefined || !this.stageMatches(stagedBack, stageEnvelope)) {
      this.safeRemove(stageKey)
      throw new StorageWriteError('stage', '暂存区写入后回读不一致，已放弃本次写入')
    }

    // ---- Step 2: commit to the live key + verified read-back ----
    const liveEnvelope = makeEnvelope(batch, true, this.now())
    const liveText = JSON.stringify(liveEnvelope)
    try {
      this.storage.setItem(key, liveText)
    } catch (err) {
      // setItem is atomic per spec, but we still verify the previous bytes.
      if (this.restoreAndVerify(key, previousRaw)) {
        this.safeRemove(stageKey)
        throw new StorageWriteError(
          'commit',
          '正式记录写入失败（可能容量不足），已保留上一版本',
          err,
        )
      }
      this.markAmbiguous(stageKey, stageEnvelope)
      throw new StorageWriteError(
        'commit',
        '正式记录写入失败，且无法确认上一版本是否完好；该批次已冻结，需在恢复提示中处理',
        err,
        { indoubt: true },
      )
    }

    const liveBack = this.readJsonRepeatedly(key, VERIFY_READ_ATTEMPTS)
    if (
      liveBack !== undefined &&
      this.envelopeMatches(liveBack, liveEnvelope)
    ) {
      // ---- Step 3: fully verified commit. Cleanup is best effort; a
      // leftover non-indoubt stage is swept harmlessly on next load. ----
      this.safeRemove(stageKey)
      return asBatch((liveBack as Envelope).batch)
    }

    // Commit landed (or may have) but cannot be verified as the candidate.
    // Attempt a verified rollback to the previous raw bytes.
    if (this.restoreAndVerify(key, previousRaw)) {
      this.safeRemove(stageKey)
      throw new StorageWriteError(
        'commit',
        '正式记录写入后回读不一致，已回滚到上一版本',
      )
    }

    // Ambiguous: keep durable evidence so the unconfirmed push can never be
    // silently adopted on reload; the batch is isolated until resolved.
    this.markAmbiguous(stageKey, stageEnvelope)
    throw new StorageWriteError(
      'commit',
      '正式记录写入后无法确认，且回滚未经验证；该批次已冻结，请在恢复提示中选择采用新版本或回退到上一版本',
      undefined,
      { indoubt: true },
    )
  }

  /**
   * Explicitly resolve an isolated ambiguous commit.
   *  - 'adopt'  : promote the staged candidate to a verified committed record
   *  - 'revert' : restore the previous raw bytes (or remove the record when
   *               the ambiguous push was a create)
   * The evidence stage key is removed only after the chosen state verifies.
   * Returns the adopted batch (adopt) or null (revert).
   */
  resolveAmbiguous(entry: QuarantineEntry, decision: 'adopt' | 'revert'): StocktakeBatch | null {
    if (entry.reason !== 'ambiguous_commit' || !entry.resolution) {
      throw new StorageWriteError('resolve', '该隔离记录不支持人工裁决')
    }
    const id = entry.resolution.batchId
    const key = this.dataKey(id)
    const stageKey = this.stageKey(id)

    const stage = this.readJson(stageKey)
    if (!this.isStageShape(stage) || !stage.indoubt) {
      // Evidence gone (e.g. cleared elsewhere); refuse to guess.
      throw new StorageWriteError('resolve', '该批次的恢复证据已不存在，无法裁决')
    }

    if (decision === 'adopt') {
      const candidate = makeEnvelope(asBatch(this.migrate(stage.version, stage.batch)), true, this.now())
      const text = JSON.stringify(candidate)
      try {
        this.storage.setItem(key, text)
      } catch (err) {
        throw new StorageWriteError('resolve', '采用新版本写入失败（可能容量不足）', err)
      }
      const back = this.readJsonRepeatedly(key, VERIFY_READ_ATTEMPTS)
      if (back === undefined || !this.envelopeMatches(back, candidate)) {
        throw new StorageWriteError('resolve', '采用新版本后回读不一致，仍保持冻结')
      }
      this.safeRemove(stageKey)
      return asBatch((back as Envelope).batch)
    }

    // revert
    const prevRaw = typeof stage.previousRaw === 'string' ? stage.previousRaw : null
    if (!this.restoreAndVerify(key, prevRaw)) {
      throw new StorageWriteError('resolve', '回退到上一版本失败，仍保持冻结')
    }
    this.safeRemove(stageKey)
    return null
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

  /**
   * Best-effort deletion of isolated records. Ambiguous entries have a paired
   * evidence stage key that must be removed together. Returns removed count.
   */
  purgeQuarantine(entries: readonly QuarantineEntry[]): number {
    let removed = 0
    for (const entry of entries) {
      const keys = [entry.storageKey]
      if (entry.reason === 'ambiguous_commit' && entry.resolution) {
        keys.push(this.stageKey(entry.resolution.batchId))
      }
      for (const key of keys) {
        if (this.safeRemove(key)) removed += 1
      }
    }
    return removed
  }

  /**
   * Restore a key to previousRaw and verify the stored bytes match exactly.
   * previousRaw === null means the record should not exist. Returns false if
   * the restored state cannot be proven (store unhealthy / bytes differ).
   */
  private restoreAndVerify(key: string, previousRaw: string | null): boolean {
    try {
      if (previousRaw === null) this.storage.removeItem(key)
      else this.storage.setItem(key, previousRaw)
    } catch {
      return false
    }
    let current: string | null
    try {
      current = this.storage.getItem(key)
    } catch {
      return false
    }
    if (previousRaw === null) return current === null
    return current === previousRaw
  }

  /** Rewrite the stage as durable evidence of an unverifiable push. */
  private markAmbiguous(stageKey: string, stage: StageEnvelope): void {
    const evidence: StageEnvelope = { ...stage, indoubt: true }
    try {
      this.storage.setItem(stageKey, JSON.stringify(evidence))
    } catch {
      // Evidence could not be persisted; the caller still flags the batch
      // in-memory for this session. A future load sees an ordinary stage and
      // sweeps it — acceptable last resort on a store that rejects all writes.
    }
  }

  private rawMatchesEnvelope(raw: string, expected: Envelope): boolean {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return false
    }
    return this.envelopeMatches(parsed, expected)
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

  /** Read with a few attempts so a single transient read glitch doesn't turn
   * a durable commit into an ambiguous failure. */
  private readJsonRepeatedly(key: string, attempts: number): unknown | undefined {
    let last: unknown | undefined
    for (let i = 0; i < attempts; i++) {
      last = this.readJson(key)
      if (last !== undefined) return last
    }
    return last
  }

  private envelopeMatches(actual: unknown, expected: Envelope): boolean {
    if (!isObject(actual)) return false
    if (actual.version !== expected.version || actual.committed !== expected.committed) return false
    return jsonDeepEqual(actual.batch, expected.batch)
  }

  private stageMatches(actual: unknown, expected: StageEnvelope): boolean {
    if (!this.isStageShape(actual)) return false
    if (actual.version !== expected.version || actual.committed !== expected.committed) return false
    if (!jsonDeepEqual(actual.batch, expected.batch)) return false
    // previousRaw must round-trip exactly; a missing/null must match too.
    return actual.previousRaw === expected.previousRaw
  }

  private isStageShape(value: unknown): value is StageEnvelope {
    if (!isObject(value)) return false
    return (
      typeof value.version === 'number' &&
      typeof value.committed === 'boolean' &&
      typeof value.savedAt === 'number' &&
      isObject(value.batch) &&
      (value.indoubt === undefined || typeof value.indoubt === 'boolean') &&
      (value.previousRaw === undefined ||
        value.previousRaw === null ||
        typeof value.previousRaw === 'string')
    )
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

  private ambiguousEntry(
    liveKey: string,
    stage: StageEnvelope,
    detail: string,
  ): QuarantineEntry {
    const resolution: AmbiguousResolution = {
      kind: 'ambiguous_commit',
      batchId: this.idFromDataKey(liveKey),
      candidateStatus: this.statusOf(stage.batch),
      previousStatus: this.statusOfPrevious(stage.previousRaw),
    }
    return { storageKey: liveKey, reason: 'ambiguous_commit', detail, resolution }
  }

  private statusOf(batch: unknown): BatchStatus | null {
    if (isObject(batch) && typeof batch.status === 'string') {
      return batch.status as BatchStatus
    }
    return null
  }

  private statusOfPrevious(previousRaw: string | null | undefined): BatchStatus | null {
    if (typeof previousRaw !== 'string') return null
    try {
      const env = JSON.parse(previousRaw) as { batch?: unknown }
      return this.statusOf(env.batch)
    } catch {
      return null
    }
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
