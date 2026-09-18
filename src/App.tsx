import { useEffect, useMemo, useState } from 'react'
import type { AppData, Paper, PlanSetResult, Reviewer, StressTestReport } from './types'
import { createId, loadData, saveData } from './storage'
import { solveAssignment, evaluateHardConstraints } from './engine/solver'
import {
  MAX_PLAN_COUNT,
  maxPossibleDifference,
  recomputePlanDifferences,
  singlePlanSet,
  solveAlternatives,
  validateAlternativesRequest
} from './engine/alternatives'
import { runStressTest, stressFingerprint } from './engine/stress'
import { applySwapCandidate, type SwapCandidate } from './engine/swap'
import { createSampleData } from './sampleData'
import { buildExportPayload, buildStressExportPayload, downloadJson } from './exporter'
import { PapersPanel } from './components/PapersPanel'
import { ReviewersPanel } from './components/ReviewersPanel'
import { ResultPanel } from './components/ResultPanel'
import { StressPanel } from './components/StressPanel'
import './styles.css'

type Tab = 'papers' | 'reviewers' | 'result' | 'stress'

const EMPTY: AppData = { papers: [], reviewers: [], preAssignments: [] }

export default function App() {
  const [data, setData] = useState<AppData>(() => loadData() ?? EMPTY)
  const [tab, setTab] = useState<Tab>('papers')
  // 生成结果统一以“方案集”存储：单方案（默认）就是只含 1 个方案的方案集
  const [planSet, setPlanSet] = useState<PlanSetResult | null>(null)
  const [selectedPlan, setSelectedPlan] = useState(0)
  // 备选方案选项：方案数量（1～3，默认 1 保持现有行为）与最小差异 N 的输入框文本
  const [planCount, setPlanCount] = useState(1)
  const [minDifferenceText, setMinDifferenceText] = useState('2')
  const [stale, setStale] = useState(false)
  const [solving, setSolving] = useState(false)
  const [solveMillis, setSolveMillis] = useState<number | null>(null)
  const [stressReport, setStressReport] = useState<StressTestReport | null>(null)
  const [stressRunning, setStressRunning] = useState(false)

  // 数据变化自动持久化到 localStorage；已有结果则标记为过期
  useEffect(() => {
    saveData(data)
    setStale((s) => (planSet ? true : s))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data])

  // 硬约束基线评估：与“生成分派”同源，压力测试只在当前数据可生成方案时可运行（每次录入变化即时重算）
  const baseline = useMemo(() => evaluateHardConstraints(data), [data])
  const baselineFeasible = baseline.feasible
  const baselineReasons = baseline.reasons.map((r) => r.message)

  // 压力测试过期判定：报告保存了运行时数据指纹，当前指纹不一致即立即标记过期（复用基线归一化结果）
  const currentFingerprint = useMemo(() => stressFingerprint(data, baseline), [data, baseline])
  const stressStale = stressReport !== null && stressReport.fingerprint !== currentFingerprint

  const conflictCountOf = useMemo(() => {
    const map = new Map<string, number>()
    for (const r of data.reviewers) for (const pid of r.conflictPaperIds) map.set(pid, (map.get(pid) ?? 0) + 1)
    return (paperId: string) => map.get(paperId) ?? 0
  }, [data.reviewers])

  const setPapers = (papers: Paper[]) => setData((d) => ({ ...d, papers }))
  const setReviewers = (reviewers: Reviewer[]) => setData((d) => ({ ...d, reviewers }))

  // ---- 预指派关系维护 ----
  // 关系独立存储：删除/修改稿件或评审人后，失效关系仍保留（不级联删除），
  // 由稿件编辑区显式列出并提示原因，用户可逐条移除。
  const addPreAssignment = (paperId: string, reviewerId: string) =>
    setData((d) => {
      if (d.preAssignments.some((pa) => pa.paperId === paperId && pa.reviewerId === reviewerId)) return d
      return { ...d, preAssignments: [...d.preAssignments, { id: createId('pre'), paperId, reviewerId }] }
    })
  const removePreAssignment = (id: string) =>
    setData((d) => ({ ...d, preAssignments: d.preAssignments.filter((pa) => pa.id !== id) }))

  // ---- 备选方案输入校验 ----
  // 差异 N 的理论上限：总名额 − 预指派固定名额，全部改变时对称差为其 2 倍（基线不可行时不设上界提示）
  const maxDifference = useMemo(() => maxPossibleDifference(data), [data])
  const minDifferenceValue = useMemo(() => {
    const n = Number(minDifferenceText)
    return Number.isFinite(n) ? Math.trunc(n) : NaN
  }, [minDifferenceText])
  const alternativesEnabled = planCount > 1
  const optionsError = useMemo(() => {
    if (!alternativesEnabled) return null
    if (!Number.isInteger(minDifferenceValue) || minDifferenceValue < 1) {
      return '最小差异 N 必须是不小于 1 的整数。'
    }
    if (maxDifference !== null && minDifferenceValue > maxDifference) {
      return `N 不能超过 ${maxDifference}：预指派关系固定不变，可改变的自由关系最多产生 ${maxDifference} 条对称差（每替换一条分派记 2 条）。`
    }
    return null
  }, [alternativesEnabled, minDifferenceValue, maxDifference])

  const generate = () => {
    if (alternativesEnabled && optionsError) return
    // 让“求解中”状态先渲染，再执行同步求解（大规模 ILP 可能耗时数百毫秒至数秒）
    setSolving(true)
    setTimeout(() => {
      const t0 = performance.now()
      let set: PlanSetResult
      if (planCount === 1) {
        // 默认单方案行为：沿用现有求解入口，结果包装成只含 1 个方案的方案集
        const r = solveAssignment(data)
        set = r.feasible ? singlePlanSet(r) : r
      } else {
        set = solveAlternatives(data, validateAlternativesRequest(planCount, minDifferenceValue))
      }
      setSolveMillis(Math.round(performance.now() - t0))
      setPlanSet(set)
      setSelectedPlan(0)
      setStale(false)
      setSolving(false)
      setTab('result')
    }, 30)
  }

  const runStress = () => {
    // 与生成同理：先渲染“进行中”，再逐位同步跑最大流
    setStressRunning(true)
    setTimeout(() => {
      const outcome = runStressTest(data)
      if (outcome.runnable) setStressReport(outcome.report)
      setStressRunning(false)
    }, 30)
  }

  const loadSample = () => {
    if (data.papers.length || data.reviewers.length) {
      if (!window.confirm('载入示例数据将覆盖当前录入内容，是否继续？')) return
    }
    setData(createSampleData())
    setPlanSet(null)
    setSelectedPlan(0)
    setStale(false)
    setStressReport(null)
  }

  const clearAll = () => {
    if (!window.confirm('确定清空全部稿件与评审人数据？该操作不可撤销。')) return
    setData(EMPTY)
    setPlanSet(null)
    setSelectedPlan(0)
    setStale(false)
    setStressReport(null)
  }

  const exportResult = () => {
    if (planSet?.feasible) {
      const plan = planSet.plans[selectedPlan] ?? planSet.plans[0]
      const payload = buildExportPayload(data, plan, {
        planIndex: plan.planIndex,
        requestedCount: planSet.requestedCount,
        minDifference: planSet.minDifference,
        differences: plan.differences
      })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      const suffix = planSet.plans.length > 1 ? `-plan${plan.planIndex + 1}of${planSet.plans.length}` : ''
      downloadJson(payload, `blind-review-assignment${suffix}-${stamp}.json`)
    }
  }

  // 确认一次一换一：仅在结果层改派（不改录入数据），只作用于当前选中方案。
  // 成功后该方案仍是“成功且未过期”，并被标记为已人工调整；差异统计在结果面板按当前分派即时重算。
  const applySwap = (candidate: SwapCandidate) => {
    if (!planSet?.feasible || stale) return
    const plan = planSet.plans[selectedPlan]
    if (!plan) return
    const next = applySwapCandidate(data, plan, candidate)
    if (next) {
      const updated = planSet.plans.map((p) =>
        p.planIndex === plan.planIndex ? { ...p, ...next, planIndex: p.planIndex } : p
      )
      // 人工互换后按最新分派重算全部两两差异（互换只改结果层，录入数据不变）
      const freshDiffs = recomputePlanDifferences(updated)
      setPlanSet({
        ...planSet,
        plans: updated.map((p) => ({ ...p, differences: freshDiffs[p.planIndex] }))
      })
    }
  }

  const exportStress = () => {
    if (stressReport) {
      const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
      downloadJson(buildStressExportPayload(data, stressReport), `blind-review-absence-stress-${stamp}.json`)
    }
  }

  const totalRequired = data.papers.reduce((a, p) => a + Math.max(0, p.reviewsRequired || 0), 0)
  const totalCapacity = data.reviewers.reduce((a, r) => a + Math.max(0, r.capacity || 0), 0)

  return (
    <div className="app">
      <header className="app-header">
        <div className="brand">
          <span className="brand-mark">⚖</span>
          <div>
            <h1>盲审分配台</h1>
            <p>Blind Review Desk · 浏览器本地整数规划分配，数据不出本机</p>
          </div>
        </div>
        <div className="header-actions">
          <span className="header-stat">
            稿件 {data.papers.length} · 名额 {totalRequired} · 评审人 {data.reviewers.length} · 容量 {totalCapacity}
          </span>
          <button className="btn btn-ghost" onClick={loadSample}>
            载入示例
          </button>
          <button className="btn btn-ghost danger" onClick={clearAll}>
            清空
          </button>
          <button
            className="btn btn-generate"
            onClick={generate}
            disabled={data.papers.length === 0 || solving || !!optionsError}
            title={optionsError ?? undefined}
          >
            {solving ? '⏳ 本地求解中…' : '▶ 生成分派'}
          </button>
        </div>
      </header>

      <div className="generate-options">
        <span className="generate-options-label">备选方案</span>
        <div className="plan-count-group" role="group" aria-label="生成方案数量">
          {Array.from({ length: MAX_PLAN_COUNT }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              type="button"
              className={`plan-count-btn${planCount === n ? ' active' : ''}`}
              aria-pressed={planCount === n}
              onClick={() => setPlanCount(n)}
              title={n === 1 ? '默认：生成 1 个字典序最优方案' : `生成 ${n} 个方案（首个最优，其余满足硬约束且彼此不同）`}
            >
              {n}
            </button>
          ))}
        </div>
        <span className="generate-options-hint">个方案{planCount === 1 ? '（默认单方案）' : ''}</span>
        {alternativesEnabled && (
          <label className={`min-diff-field${optionsError ? ' has-error' : ''}`}>
            <span>
              最小差异 <strong>N</strong>
            </span>
            <input
              className="input min-diff-input"
              type="number"
              min={1}
              max={maxDifference ?? undefined}
              step={2}
              value={minDifferenceText}
              onChange={(e) => setMinDifferenceText(e.target.value)}
              aria-label="与已生成方案至少不同的稿件—评审人关系条数 N"
            />
            <span className="min-diff-suffix">条关系</span>
          </label>
        )}
        {alternativesEnabled && maxDifference !== null && !optionsError && (
          <span className="generate-options-hint">可改变的自由关系最多产生 {maxDifference} 条对称差</span>
        )}
        {optionsError && <span className="generate-options-error">⚠ {optionsError}</span>}
      </div>

      <nav className="tabs">
        <button className={tab === 'papers' ? 'tab active' : 'tab'} onClick={() => setTab('papers')}>
          稿件
        </button>
        <button className={tab === 'reviewers' ? 'tab active' : 'tab'} onClick={() => setTab('reviewers')}>
          评审人 / 利益冲突
        </button>
        <button className={tab === 'result' ? 'tab active' : 'tab'} onClick={() => setTab('result')}>
          分配结果
          {stale && <span className="stale-dot" title="数据已变更，结果可能过期">●</span>}
        </button>
        <button className={tab === 'stress' ? 'tab active' : 'tab'} onClick={() => setTab('stress')}>
          缺席压力测试
          {stressStale && <span className="stale-dot" title="录入数据已变化，压力测试结果已过期">●</span>}
        </button>
        {solveMillis !== null && <span className="solve-time">本地求解耗时 {solveMillis} ms</span>}
      </nav>

      <main className="content">
        {tab === 'papers' && (
          <PapersPanel
            papers={data.papers}
            reviewers={data.reviewers}
            preAssignments={data.preAssignments}
            onChange={setPapers}
            onAddPreAssignment={addPreAssignment}
            onRemovePreAssignment={removePreAssignment}
            conflictCountOf={conflictCountOf}
          />
        )}
        {tab === 'reviewers' && <ReviewersPanel papers={data.papers} reviewers={data.reviewers} onChange={setReviewers} />}
        {tab === 'result' &&
          (solving ? (
            <section className="result-empty">
              <p>⏳ 正在浏览器本地进行整数规划求解，请稍候…</p>
            </section>
          ) : (
            <ResultPanel
              data={data}
              planSet={planSet}
              selectedPlan={selectedPlan}
              onSelectPlan={setSelectedPlan}
              stale={stale}
              onExport={exportResult}
              onApplySwap={applySwap}
            />
          ))}
        {tab === 'stress' && (
          <StressPanel
            data={data}
            baselineFeasible={baselineFeasible}
            baselineReasons={baselineReasons}
            report={stressReport}
            stale={stressStale}
            running={stressRunning}
            onRun={runStress}
            onExport={exportStress}
          />
        )}
      </main>

      <footer className="app-footer">
        所有计算均在浏览器内完成（javascript-lp-solver）；录入数据自动保存于 localStorage，可随时关闭页面。
      </footer>
    </div>
  )
}
