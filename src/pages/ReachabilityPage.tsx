import { useEffect, useRef, useState } from 'react'
import type { SolveRequest, SolveResponse } from '../solver.worker'
import { VirtualResults } from '../components/VirtualResults'

export type Status =
  | { kind: 'idle' }
  | { kind: 'running' }
  | { kind: 'invalid' }
  | {
      kind: 'ok'
      reachableCount: number
      distinctA: number
      distinctB: number
      elapsedMs: number
    }
  | { kind: 'error'; message: string }

export const SAMPLE_INPUT = JSON.stringify(
  {
    a: [0, 3, 50, 200000],
    b: [0, 1, 9, 100, 200000],
    targets: [0, 1, 3, 4, 53, 300, 200000, 400000, 0],
  },
  null,
  2,
)

/**
 * Pure handler for a SolveResponse. Extracted so the paste/INVALID_INPUT
 * contract is regression-testable without a DOM worker: an invalid response
 * must clear any previous answers.
 */
export function applyResponse(
  res: SolveResponse,
  requestId: number,
): { targets: number[]; reachable: boolean[]; status: Status } | null {
  if (res.id !== requestId) return null // discard stale responses
  if (res.kind === 'ok') {
    let count = 0
    for (let i = 0; i < res.reachable.length; i++) if (res.reachable[i]) count++
    return {
      targets: res.targets,
      reachable: res.reachable,
      status: {
        kind: 'ok',
        reachableCount: count,
        distinctA: res.distinctA,
        distinctB: res.distinctB,
        elapsedMs: res.elapsedMs,
      },
    }
  }
  if (res.kind === 'invalid') {
    // Contract: INVALID_INPUT clears any previous answers.
    return { targets: [], reachable: [], status: { kind: 'invalid' } }
  }
  return { targets: [], reachable: [], status: { kind: 'error', message: res.message } }
}

/**
 * The original reachability tool, unchanged in behavior. Its state is local
 * to this component; mounting it alongside the stocktake page means switching
 * tabs preserves the last JSON/results and never touches inventory data.
 */
export function ReachabilityPage() {
  const [text, setText] = useState('')
  const [status, setStatus] = useState<Status>({ kind: 'idle' })
  const [targets, setTargets] = useState<number[]>([])
  const [reachable, setReachable] = useState<boolean[]>([])
  const workerRef = useRef<Worker | null>(null)
  const requestIdRef = useRef(0)

  useEffect(() => {
    const worker = new Worker(new URL('../solver.worker.ts', import.meta.url), {
      type: 'module',
    })
    workerRef.current = worker

    worker.onmessage = (event: MessageEvent<SolveResponse>) => {
      const next = applyResponse(event.data, requestIdRef.current)
      if (!next) return
      setTargets(next.targets)
      setReachable(next.reachable)
      setStatus(next.status)
    }

    return () => worker.terminate()
  }, [])

  function computeWith(value: string) {
    const worker = workerRef.current
    if (!worker) return
    const id = ++requestIdRef.current
    setStatus({ kind: 'running' })
    // Drop any previous answers up front so stale results never linger
    // while the new (potentially invalid) request is handled.
    setTargets([])
    setReachable([])
    const request: SolveRequest = { id, text: value }
    worker.postMessage(request)
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const pasted = event.clipboardData.getData('text')
    if (!pasted) return
    // Commit pasted text, then compute on the next frame.
    requestAnimationFrame(() => computeWith(pasted))
  }

  return (
    <div className="page">
      <header className="page-header">
        <h1>垫片补偿可达性校验</h1>
        <p className="subtitle">
          两级离散微米垫片：判断每个目标值能否由 A、B 级各取一片相加得到
        </p>
      </header>

      <main className="layout">
        <section className="panel input-panel">
          <h2>输入 JSON</h2>
          <p className="hint">
            根对象<strong>仅含</strong> <code>a</code>、<code>b</code>、
            <code>targets</code> 三个字段。
            a/b：1–100000 个取值 [0, 200000] 的整数；targets：1–100000
            个取值 [0, 400000] 的整数。重复垫片值视为同一规格；
            目标保留原始顺序及重复项，每项只输出 reachable 布尔结论。
          </p>
          <textarea
            className="json-input"
            spellCheck={false}
            placeholder='{"a":[0,3],"b":[1,2],"targets":[1,3,4]}'
            value={text}
            onChange={(e) => setText(e.target.value)}
            onPaste={handlePaste}
          />
          <div className="actions">
            <button
              type="button"
              className="primary"
              onClick={() => computeWith(text)}
              disabled={status.kind === 'running'}
            >
              {status.kind === 'running' ? '计算中…' : '计算可达性'}
            </button>
            <button
              type="button"
              onClick={() => setText(SAMPLE_INPUT)}
              disabled={status.kind === 'running'}
            >
              填入示例
            </button>
            <button
              type="button"
              onClick={() => {
                setText('')
                setTargets([])
                setReachable([])
                setStatus({ kind: 'idle' })
              }}
              disabled={status.kind === 'running'}
            >
              清空
            </button>
          </div>

          <div className="status-area" aria-live="polite">
            {status.kind === 'idle' && <p className="status idle">等待输入。</p>}
            {status.kind === 'running' && (
              <p className="status running">正在精确求解…</p>
            )}
            {status.kind === 'invalid' && (
              <p className="status invalid">INVALID_INPUT</p>
            )}
            {status.kind === 'error' && (
              <p className="status invalid">计算失败：{status.message}</p>
            )}
            {status.kind === 'ok' && (
              <div className="status ok">
                <p>
                  共 {targets.length} 个目标，{status.reachableCount} 个可达，
                  {targets.length - status.reachableCount} 个不可达
                </p>
                <p className="meta">
                  A 级去重后 {status.distinctA} 种规格 · B 级去重后{' '}
                  {status.distinctB} 种规格 · 求解耗时 {status.elapsedMs.toFixed(1)}{' '}
                  ms
                </p>
              </div>
            )}
          </div>
        </section>

        <section className="panel results-panel">
          <h2>结果（按目标原序，含重复项）</h2>
          {targets.length === 0 ? (
            <div className="empty-results">
              {status.kind === 'invalid' || status.kind === 'error'
                ? 'INVALID_INPUT'
                : '结果将在此按原序列出 target 与 reachable 结论。'}
            </div>
          ) : (
            <div className="results-container">
              <div className="result-row header-row">
                <span className="cell-index">序号</span>
                <span className="cell-target">target</span>
                <span className="cell-verdict">reachable</span>
              </div>
              <VirtualResults targets={targets} reachable={reachable} />
            </div>
          )}
        </section>
      </main>

      <footer className="page-footer">
        精确求解：两侧编码为 BigInt 位集，按目标移位并按位与判定，不枚举全部数对。
      </footer>
    </div>
  )
}
