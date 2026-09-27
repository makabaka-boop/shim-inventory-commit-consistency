import { describe, it, expect } from 'vitest'
import {
  CURRENT_RECORD_VERSION,
  MIGRATIONS,
  migratePayload,
  MigrationError,
} from './migrations'
import { validateBatch } from './schema'

describe('migration rules', () => {
  it('current-version payload passes through', () => {
    const batch = {
      id: 'x',
      name: 'n',
      createdAt: 1,
      updatedAt: 1,
      status: 'draft',
      lines: [{ id: 'l', level: 'A', spec: 1, bookQty: 1, actualQty: null }],
    }
    expect(migratePayload(CURRENT_RECORD_VERSION, batch)).toBe(batch)
  })

  it('migrates a complete v1 record ("done") to completed with dispositions', () => {
    const v1 = {
      id: 'old-1',
      title: '旧批次',
      createdAt: 12345,
      status: 'done',
      entries: [
        { grade: 'A', size: 10, ledger: 5, counted: 7 },
        { grade: 'B', size: 20, ledger: 3, counted: 3 },
      ],
    }
    const migrated = migratePayload(1, v1) as any
    expect(migrated.name).toBe('旧批次')
    expect(migrated.status).toBe('completed')
    expect(migrated.lines[0].spec).toBe(10)
    expect(migrated.lines[0].bookQty).toBe(5)
    expect(migrated.lines[0].actualQty).toBe(7)
    expect(migrated.lines[0].disposition).toBe('actual_correct')
    expect(migrated.lines[1].disposition).toBeUndefined()
    // The migrated record must itself satisfy the current strict schema.
    expect(validateBatch(migrated).ok).toBe(true)
  })

  it('migrates a partial v1 count to counting, preserving progress', () => {
    const v1 = {
      id: 'old-2',
      title: '盘到一半',
      entries: [
        { grade: 'A', size: 1, ledger: 2, counted: 2 },
        { grade: 'B', size: 2, ledger: 4 },
      ],
    }
    const migrated = migratePayload(1, v1) as any
    expect(migrated.status).toBe('counting')
    expect(migrated.lines[0].actualQty).toBe(2)
    expect(migrated.lines[1].actualQty).toBeNull()
    expect(validateBatch(migrated).ok).toBe(true)
  })

  it('migrates fully counted v1 with differences to review_required', () => {
    const v1 = {
      id: 'old-3',
      title: '待复核',
      entries: [
        { grade: 'A', size: 1, ledger: 2, counted: 9 },
        { grade: 'B', size: 2, ledger: 4, counted: 4 },
      ],
    }
    const migrated = migratePayload(1, v1) as any
    expect(migrated.status).toBe('review_required')
    // Differences must remain un-disposed so the user reviews them.
    expect(migrated.lines[0].disposition).toBeUndefined()
    // review_required legitimately holds unresolved differences pending
    // disposition; the record itself is structurally sound.
    expect(validateBatch(migrated).ok).toBe(true)
  })

  it('rejects malformed v1 records', () => {
    expect(() => migratePayload(1, null)).toThrow(MigrationError)
    expect(() => migratePayload(1, { id: '', title: 't', entries: [] })).toThrow(MigrationError)
    expect(() =>
      migratePayload(1, { id: 'i', title: 't', entries: [{ grade: 'C', size: 1, ledger: 1 }] }),
    ).toThrow(MigrationError)
    expect(() =>
      migratePayload(1, { id: 'i', title: 't', entries: [{ grade: 'A', size: 1.5, ledger: 1 }] }),
    ).toThrow(MigrationError)
    expect(() =>
      migratePayload(1, { id: 'i', title: 't', entries: [{ grade: 'A', size: 1, ledger: -1 }] }),
    ).toThrow(MigrationError)
    expect(() =>
      migratePayload(1, {
        id: 'i',
        title: 't',
        entries: [{ grade: 'A', size: 1, ledger: 1, counted: -2 }],
      }),
    ).toThrow(MigrationError)
  })

  it('refuses illegal/unknown migrations', () => {
    expect(() => migratePayload(0, {})).toThrow(MigrationError)
    expect(() => migratePayload(CURRENT_RECORD_VERSION + 1, {})).toThrow(MigrationError)
  })

  it('ships the full migration chain starting at v1', () => {
    expect(MIGRATIONS[1]).toBeTypeOf('function')
  })
})
