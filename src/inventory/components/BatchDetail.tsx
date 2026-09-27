import { useEffect, useState } from 'react'
import type { InventoryStore } from '../store'
import {
  DISPOSITION_LABEL,
  STATUS_LABEL,
  type DispositionCode,
  type RuleError,
  type StocktakeBatch,
} from '../types'
import { BatchForm } from './BatchForm'

interface BatchDetailProps {
  batch: StocktakeBatch
  actions: InventoryStore
  onBack: () => void
}

const DISPOSITIONS = Object.keys(DISPOSITION_LABEL) as DispositionCode[]

function formatDelta(delta: number): string {
  return delta > 0 ? `+${delta}` : String(delta)
}

/**
 * One batch's workbench. The visible controls follow the lifecycle strictly:
 *  - draft: edit/delete, start counting
 *  - counting: enter actual qty per line; advance (gate: all counted)
 *  - review_required: disposition per difference; advance (gate: all resolved)
 *  - completed: fully read-only
 */
export function BatchDetail({ batch, actions, onBack }: BatchDetailProps) {
  const [editing, setEditing] = useState(false)
  const [ruleError, setRuleError] = useState<string | null>(null)

  // Switching batches clears transient form/error state.
  useEffect(() => {
    setEditing(false)
    setRuleError(null)
  }, [batch.id])

  function report(result: { ok: boolean; ruleError?: RuleError }) {
    setRuleError(result.ok || !result.ruleError ? null : result.ruleError.message)
  }

  if (editing && batch.status === 'draft') {
    return (
      <BatchForm
        batch={batch}
        submitLabel="保存草稿"
        onCancel={() => setEditing(false)}
        onSubmit={(input) => {
          const result = actions.updateDraft(batch.id, input)
          if (result.ok) setEditing(false)
          else if (result.ruleError) setRuleError(result.ruleError.message)
        }}
      />
    )
  }

  const counted = batch.lines.filter((l) => l.actualQty !== null).length
  const unresolved = batch.lines.filter(
    (l) => l.actualQty !== null && l.actualQty !== l.bookQty && l.disposition === undefined,
  ).length
  const readOnly = batch.status === 'completed'
  const gateBlocked =
    batch.status === 'counting'
      ? counted < batch.lines.length
      : batch.status === 'review_required'
        ? unresolved > 0
        : false

  let advanceLabel = ''
  if (batch.status === 'counting') advanceLabel = '提交复核'
  if (batch.status === 'review_required') advanceLabel = '结案'

  return (
    <div className="batch-detail">
      <div className="detail-header">
        <button type="button" onClick={onBack}>
          ← 返回批次列表
        </button>
        <h2>{batch.name}</h2>
        <span className={`status-pill status-${batch.status}`}>
          {STATUS_LABEL[batch.status]}
        </span>
      </div>

      <p className="detail-progress muted">
        共 {batch.lines.length} 行
        {batch.status !== 'draft' && ` · 已计数 ${counted}/${batch.lines.length}`}
        {(batch.status === 'review_required' || batch.status === 'completed') &&
          ` · 未处置差异 ${unresolved}`}
      </p>

      {batch.status === 'draft' && (
        <div className="actions">
          <button
            type="button"
            className="primary"
            onClick={() => report(actions.startCounting(batch.id))}
          >
            开始盘点
          </button>
          <button type="button" onClick={() => setEditing(true)}>
            编辑草稿
          </button>
          <button
            type="button"
            className="danger"
            onClick={() => {
              if (confirm(`删除草稿批次「${batch.name}」？`)) {
                report(actions.deleteBatch(batch.id))
                onBack()
              }
            }}
          >
            删除草稿
          </button>
        </div>
      )}

      <div className="lines-table">
        <div className="line-row line-row-head">
          <span>级别</span>
          <span>规格 (μm)</span>
          <span>账面数量</span>
          <span>实点数量</span>
          <span>差异</span>
          <span>处置结论</span>
        </div>
        {batch.lines.map((line) => (
          <LineRow
            key={line.id}
            line={line}
            status={batch.status}
            readOnly={readOnly}
            onCount={(qty) => report(actions.recordCount(batch.id, line.id, qty))}
            onResolve={(code, note) =>
              report(actions.resolveDifference(batch.id, line.id, code, note))
            }
          />
        ))}
      </div>

      {ruleError && <p className="form-error">{ruleError}</p>}

      {!readOnly && advanceLabel && (
        <div className="actions detail-actions">
          <button
            type="button"
            className="primary"
            disabled={gateBlocked}
            title={
              batch.status === 'counting'
                ? counted < batch.lines.length
                  ? '仍有明细未录入实点数'
                  : '无差异时直接结案，有差异时进入复核'
                : unresolved > 0
                  ? `还有 ${unresolved} 项差异未处置`
                  : '完成结案'
            }
            onClick={() => {
              const result = actions.advance(batch.id)
              report(result)
            }}
          >
            {advanceLabel}
          </button>
          {gateBlocked && batch.status === 'counting' && (
            <span className="muted">还差 {batch.lines.length - counted} 行未计数</span>
          )}
          {gateBlocked && batch.status === 'review_required' && (
            <span className="muted">还差 {unresolved} 项差异未处置</span>
          )}
        </div>
      )}

      {readOnly && (
        <p className="readonly-note">批次已结案，内容只读。盘点结论与处置记录已归档。</p>
      )}
    </div>
  )
}

interface LineRowProps {
  line: StocktakeBatch['lines'][number]
  status: StocktakeBatch['status']
  readOnly: boolean
  onCount: (qty: number) => void
  onResolve: (code: DispositionCode, note?: string) => void
}

function LineRow({ line, status, readOnly, onCount, onResolve }: LineRowProps) {
  const [countText, setCountText] = useState(
    line.actualQty === null ? '' : String(line.actualQty),
  )
  const [rowError, setRowError] = useState<string | null>(null)
  const [note, setNote] = useState(line.dispositionNote ?? '')

  useEffect(() => {
    setCountText(line.actualQty === null ? '' : String(line.actualQty))
  }, [line.actualQty])
  useEffect(() => setNote(line.dispositionNote ?? ''), [line.dispositionNote])

  const counted = line.actualQty !== null
  const isDiff = counted && line.actualQty !== line.bookQty
  const canCount = status === 'counting' && !readOnly
  const canResolve = status === 'review_required' && isDiff && !readOnly

  function commitCount() {
    if (!canCount) return
    const value = Number(countText)
    if (!Number.isInteger(value) || value < 0) {
      setRowError('请输入非负整数')
      return
    }
    setRowError(null)
    onCount(value)
  }

  return (
    <div className={`line-row ${isDiff ? 'has-diff' : ''} ${counted ? 'is-counted' : ''}`}>
      <span className="line-level">{line.level}</span>
      <span className="line-spec">{line.spec}</span>
      <span className="line-book">{line.bookQty}</span>
      <span className="line-actual">
        {canCount ? (
          <input
            type="number"
            inputMode="numeric"
            min={0}
            value={countText}
            aria-label={`${line.level} 级 ${line.spec} μm 实点数量`}
            onChange={(e) => setCountText(e.target.value)}
            onBlur={commitCount}
            onKeyDown={(e) => {
              if (e.key === 'Enter') (e.target as HTMLInputElement).blur()
            }}
          />
        ) : (
          line.actualQty === null ? <span className="muted">— 未计数 —</span> : line.actualQty
        )}
        {rowError && <span className="row-error">{rowError}</span>}
      </span>
      <span className={`line-diff ${isDiff ? 'bad' : counted ? 'ok' : ''}`}>
        {!counted
          ? '—'
          : line.actualQty === line.bookQty
            ? '0'
            : formatDelta(line.actualQty! - line.bookQty)}
      </span>
      <span className="line-disposition">
        {!isDiff ? (
          <span className="muted">—</span>
        ) : canResolve ? (
          <span className="disposition-edit">
            <select
              value={line.disposition ?? ''}
              aria-label={`${line.level} 级 ${line.spec} μm 差异处置`}
              onChange={(e) => onResolve(e.target.value as DispositionCode, note || undefined)}
            >
              <option value="" disabled>
                选择处置结论…
              </option>
              {DISPOSITIONS.map((code) => (
                <option key={code} value={code}>
                  {DISPOSITION_LABEL[code]}
                </option>
              ))}
            </select>
            <input
              type="text"
              placeholder="备注（可选）"
              value={note}
              maxLength={200}
              onChange={(e) => setNote(e.target.value)}
              onBlur={() => line.disposition && onResolve(line.disposition, note || undefined)}
            />
          </span>
        ) : (
          <span className={line.disposition ? 'resolved' : 'unresolved'}>
            {line.disposition ? DISPOSITION_LABEL[line.disposition] : '待处置'}
            {line.dispositionNote ? `（${line.dispositionNote}）` : ''}
          </span>
        )}
      </span>
    </div>
  )
}
