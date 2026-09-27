import { useMemo, useState } from 'react'
import {
  NAME_MAX_LENGTH,
  SPEC_MAX,
  QTY_MAX,
  validateBatchName,
  validateLineDrafts,
  type LineDraft,
} from '../schema'
import type { Level, StocktakeBatch } from '../types'

interface BatchFormProps {
  /** Existing draft when editing; absent when creating. */
  batch?: StocktakeBatch
  onCancel: () => void
  onSubmit: (input: { name: string; lines: LineDraft[] }) => void
  submitLabel: string
}

interface RawLine {
  level: Level
  spec: string
  bookQty: string
}

function toRawLines(lines: LineDraft[]): RawLine[] {
  return lines.map((l) => ({ level: l.level, spec: String(l.spec), bookQty: String(l.bookQty) }))
}

const EMPTY_LINE: RawLine = { level: 'A', spec: '', bookQty: '' }

/**
 * Create/edit form for a draft batch: name plus A/B level specifications with
 * book quantities. Validation runs on submit; errors are inline. Editing a
 * draft replaces its lines (counting has not started, so no data is lost).
 */
export function BatchForm({ batch, onCancel, onSubmit, submitLabel }: BatchFormProps) {
  const [name, setName] = useState(batch?.name ?? '')
  const [rows, setRows] = useState<RawLine[]>(
    batch
      ? toRawLines(batch.lines.map((l) => ({ level: l.level, spec: l.spec, bookQty: l.bookQty })))
      : [{ ...EMPTY_LINE }],
  )
  const [error, setError] = useState<string | null>(null)

  const counts = useMemo(
    () => ({
      a: rows.filter((r) => r.level === 'A').length,
      b: rows.filter((r) => r.level === 'B').length,
    }),
    [rows],
  )

  function updateRow(index: number, patch: Partial<RawLine>) {
    setRows((prev) => prev.map((r, i) => (i === index ? { ...r, ...patch } : r)))
  }

  function addRow() {
    setRows((prev) => [...prev, { ...EMPTY_LINE, level: prev.length % 2 ? 'B' : 'A' }])
  }

  function removeRow(index: number) {
    setRows((prev) => prev.filter((_, i) => i !== index))
  }

  function handleSubmit() {
    const nameResult = validateBatchName(name)
    if (!nameResult.ok) {
      setError(nameResult.error!)
      return
    }
    const drafts: LineDraft[] = []
    for (const row of rows) {
      drafts.push({
        level: row.level,
        spec: Number(row.spec),
        bookQty: Number(row.bookQty),
      })
    }
    const linesResult = validateLineDrafts(drafts)
    if (!linesResult.ok) {
      setError(linesResult.error!)
      return
    }
    onSubmit({ name: name.trim(), lines: drafts })
  }

  return (
    <div className="batch-form">
      <h3>{batch ? '编辑草稿批次' : '新建盘点批次'}</h3>
      <label className="field">
        <span>批次名称</span>
        <input
          type="text"
          value={name}
          maxLength={NAME_MAX_LENGTH}
          placeholder="例如：2026-09 光学平台 A/B 级垫片套装"
          onChange={(e) => setName(e.target.value)}
        />
      </label>

      <div className="form-lines-header">
        <span>级别</span>
        <span>规格（μm，0–{SPEC_MAX} 整数）</span>
        <span>账面数量（0–{QTY_MAX}）</span>
        <span />
      </div>
      <div className="form-lines">
        {rows.map((row, i) => (
          <div className="form-line" key={i}>
            <select value={row.level} onChange={(e) => updateRow(i, { level: e.target.value as Level })}>
              <option value="A">A 级</option>
              <option value="B">B 级</option>
            </select>
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={SPEC_MAX}
              value={row.spec}
              placeholder="规格"
              onChange={(e) => updateRow(i, { spec: e.target.value })}
            />
            <input
              type="number"
              inputMode="numeric"
              min={0}
              max={QTY_MAX}
              value={row.bookQty}
              placeholder="账面数量"
              onChange={(e) => updateRow(i, { bookQty: e.target.value })}
            />
            <button
              type="button"
              className="icon-btn"
              onClick={() => removeRow(i)}
              disabled={rows.length <= 1}
              title="删除该行"
            >
              ✕
            </button>
          </div>
        ))}
      </div>

      <div className="form-meta">
        <button type="button" onClick={addRow}>
          + 添加一行
        </button>
        <span className="muted">
          A 级 {counts.a} 行 · B 级 {counts.b} 行
        </span>
      </div>

      {error && <p className="form-error">{error}</p>}

      <div className="actions">
        <button type="button" className="primary" onClick={handleSubmit}>
          {submitLabel}
        </button>
        <button type="button" onClick={onCancel}>
          取消
        </button>
      </div>
    </div>
  )
}
