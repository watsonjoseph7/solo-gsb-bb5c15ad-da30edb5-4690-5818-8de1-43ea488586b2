import type { AppData, AssignmentPlan, PlanSetResult } from '../types'
import type { SwapCandidate } from '../engine/swap'
import { SwapTool } from './SwapTool'

interface ResultPanelProps {
  data: AppData
  planSet: PlanSetResult | null
  /** 当前选中的方案序号（从 0 开始） */
  selectedPlan: number
  onSelectPlan: (index: number) => void
  /** 当前结果是否因录入数据变化而已过期（过期时不允许互换） */
  stale: boolean
  onExport: () => void
  onApplySwap: (candidate: SwapCandidate) => void
}

const kindLabel: Record<string, string> = {
  'global-capacity': '全局容量不足',
  'paper-eligible': '单篇稿件可分配人数不足',
  'subset-bottleneck': '组合性瓶颈（局部容量不足）',
  preassignment: '预指派硬约束无法满足'
}

const issueLabel: Record<string, string> = {
  'paper-missing': '引用稿件不存在',
  'reviewer-missing': '引用评审人不存在',
  conflict: '与利益冲突冲突',
  'organization-duplicate': '预指派机构重复',
  'paper-overflow': '同篇预指派超过名额',
  'reviewer-overload': '单人预占超过容量'
}

export function ResultPanel({ data, planSet, selectedPlan, onSelectPlan, stale, onExport, onApplySwap }: ResultPanelProps) {
  if (!planSet) {
    return (
      <section className="result-empty">
        <p>点击页面顶部的「▶ 生成分派」按钮，系统将在浏览器本地完成整数规划求解。</p>
        <ul>
          <li>
            <strong>硬约束</strong>：预指派必须入选、利益冲突回避、评审人容量上限、每篇稿件所需评审人数、
            同一篇稿件对每个机构至多选择一人（空机构除外），五者必须全部满足；
          </li>
          <li>
            <strong>优化目标</strong>：先最大化主题标签匹配，再最小化评审人最大负载（负载均衡）。
          </li>
          <li>
            <strong>备选方案</strong>：顶部可选择生成 1～3 个方案并设定最小差异 N；
            首方案仍为字典序最优，其余方案满足全部硬约束且与每个已生成方案至少相差 N 条稿件—评审人关系。
          </li>
        </ul>
      </section>
    )
  }

  if (!planSet.feasible) {
    return <FailureView result={planSet} />
  }

  const plan = planSet.plans[Math.min(selectedPlan, planSet.plans.length - 1)]
  const firstPlan = planSet.plans[0]
  const multi = planSet.plans.length > 1

  return (
    <section>
      {multi && (
        <div className="plan-tabs" role="tablist" aria-label="备选方案切换">
          {planSet.plans.map((p) => {
            const vsFirst = p.differences.find((d) => d.otherPlanIndex === 0)
            return (
              <button
                key={p.planIndex}
                role="tab"
                data-plan-index={p.planIndex}
                aria-selected={plan.planIndex === p.planIndex}
                className={`plan-tab${plan.planIndex === p.planIndex ? ' active' : ''}`}
                onClick={() => onSelectPlan(p.planIndex)}
              >
                <span className="plan-tab-no">
                  {p.planIndex === 0 ? '★ ' : ''}方案 {p.planIndex + 1}
                </span>
                <span className="plan-tab-stats">
                  匹配 {p.objective.topicMatches} · 最大负载 {p.objective.maxLoad}
                  {p.planIndex > 0 && vsFirst && <em> · 与首方案差 {vsFirst.symmetricDifference} 条</em>}
                </span>
                {p.manuallyAdjusted && <span className="plan-tab-adjust" title="该方案经过分派互换人工调整">✎</span>}
              </button>
            )
          })}
        </div>
      )}

      {planSet.stopReason && (
        <div className="plan-stop-banner">
          <strong>ℹ 未凑满 {planSet.requestedCount} 个方案（已保留 {planSet.plans.length} 个）。</strong>
          <p className="plan-stop-message">{planSet.stopReason}</p>
        </div>
      )}

      <PlanView
        data={data}
        plan={plan}
        firstPlan={firstPlan}
        multi={multi}
        actualCount={planSet.plans.length}
        requestedCount={planSet.requestedCount}
        minDifference={planSet.minDifference}
        stale={stale}
        onExport={onExport}
        onApplySwap={onApplySwap}
      />
    </section>
  )
}

function FailureView({ result }: { result: Extract<PlanSetResult, { feasible: false }> }) {
  const preReason = result.reasons.find((r) => r.kind === 'preassignment')
  return (
    <section>
      <div className="result-banner result-banner--fail">
        <h2>✕ 无法生成可行分配</h2>
        <p>以下硬约束无法同时满足，请按提示调整数据后重新生成（不会生成任何部分结果）：</p>
      </div>
      {preReason?.issues && preReason.issues.length > 0 && (
        <div className="reason-list">
          <div className="reason-card preassignment-reason-card">
            <span className="reason-kind">{kindLabel.preassignment}</span>
            <p className="reason-message">{preReason.message}</p>
            {(() => {
              const hasOrgIssues = preReason.issues.some((iss) => iss.organization)
              return (
                <div
                  className="preassign-issue-table"
                >
                  <div
                    className={`preassign-issue-row preassign-issue-head ${hasOrgIssues ? 'preassign-issue-row--org' : ''}`}
                  >
                    <span>稿件</span>
                    {hasOrgIssues && <span>机构</span>}
                    <span>评审人</span>
                    <span>原因</span>
                  </div>
                  {preReason.issues.map((iss) => (
                    <div
                      className={`preassign-issue-row ${hasOrgIssues ? 'preassign-issue-row--org' : ''}`}
                      key={iss.preAssignmentId}
                    >
                      <span>{iss.paperTitle ? `《${iss.paperTitle}》` : `（已删除：${iss.paperId ?? '—'}）`}</span>
                      {hasOrgIssues && (
                        <span>
                          {iss.organization ? (
                            <span className="stress-chip stress-chip--amber org-chip">🏛 {iss.organization}</span>
                          ) : (
                            <span className="muted">—</span>
                          )}
                        </span>
                      )}
                      <span>
                        {iss.reviewerName ?? `（已删除：${iss.reviewerId ?? '—'}）`}
                        {iss.organizationReviewerNames && iss.organizationReviewerNames.length > 1 && (
                          <em className="muted preassign-issue-detail">
                            同稿同机构：{iss.organizationReviewerNames.join('、')}
                          </em>
                        )}
                      </span>
                      <span>
                        <span className="stress-chip stress-chip--red">{issueLabel[iss.reason] ?? iss.reason}</span>
                        <span className="muted preassign-issue-detail">{iss.message}</span>
                      </span>
                    </div>
                  ))}
                </div>
              )
            })()}
          </div>
          {result.reasons
            .filter((r) => r.kind !== 'preassignment')
            .map((r, i) => (
              <div className="reason-card" key={i}>
                <span className="reason-kind">{kindLabel[r.kind] ?? r.kind}</span>
                <p className="reason-message">{r.message}</p>
              </div>
            ))}
        </div>
      )}
      {!preReason && (
        <div className="reason-list">
          {result.reasons.map((r, i) => (
            <div className="reason-card" key={i}>
              <span className="reason-kind">{kindLabel[r.kind] ?? r.kind}</span>
              <p className="reason-message">{r.message}</p>
            </div>
          ))}
        </div>
      )}
    </section>
  )
}

function PlanView({
  data,
  plan,
  firstPlan,
  multi,
  actualCount,
  requestedCount,
  minDifference,
  stale,
  onExport,
  onApplySwap
}: {
  data: AppData
  plan: AssignmentPlan
  firstPlan: AssignmentPlan
  multi: boolean
  actualCount: number
  requestedCount: number
  minDifference: number
  stale: boolean
  onExport: () => void
  onApplySwap: (candidate: SwapCandidate) => void
}) {
  const reviewerMap = new Map(data.reviewers.map((r) => [r.id, r]))
  const byPaper = new Map<string, typeof plan.assignments>()
  for (const a of plan.assignments) {
    const list = byPaper.get(a.paperId) ?? []
    list.push(a)
    byPaper.set(a.paperId, list)
  }

  const { totalRequired, totalAssigned, topicMatches, maxLoad, preassignedCount } = plan.objective
  const isFirst = plan.planIndex === 0
  const vsFirst = isFirst ? null : plan.differences.find((d) => d.otherPlanIndex === 0) ?? null
  const dMatches = topicMatches - firstPlan.objective.topicMatches
  const dMaxLoad = maxLoad - firstPlan.objective.maxLoad

  return (
    <section>
      <div className="result-banner result-banner--ok">
        <h2>
          {isFirst ? '✓ 分配完成' : `✓ 备选方案 ${plan.planIndex + 1}`}
          {multi && isFirst && <span className="plan-primary-badge" title="按现有字典序目标求出的最优方案">★ 首方案 · 最优</span>}
          {plan.manuallyAdjusted && (
            <span className="manual-badge" title={`已通过「分派互换」人工调整 ${plan.swapCount ?? 0} 次；录入数据未改动`}>
              ✎ 已人工调整
            </span>
          )}
        </h2>
        <p className="plan-banner-sub">
          {multi
            ? isFirst
              ? `本次请求 ${requestedCount} 个方案、最小差异 N=${minDifference}；首方案先最大化主题匹配、再最小化最大负载。`
              : `满足全部硬约束，与每个已生成方案至少相差 ${minDifference} 条稿件—评审人关系（对称差；每替换一条分派记 2 条）。`
            : '硬约束全部满足，并按“先主题匹配、后负载均衡”的字典序目标优化。'}
        </p>
        <div className="stat-row">
          <div className="stat">
            <strong>{totalAssigned}/{totalRequired}</strong>
            <span>分配名额</span>
          </div>
          <div className="stat">
            <strong>{topicMatches}</strong>
            <span>
              主题匹配数
              {multi && !isFirst && (
                <em className={`stat-delta ${dMatches > 0 ? 'stat-delta--up' : dMatches < 0 ? 'stat-delta--down' : ''}`}>
                  较首方案 {dMatches > 0 ? '+' : ''}
                  {dMatches}
                </em>
              )}
            </span>
          </div>
          <div className="stat">
            <strong>{maxLoad}</strong>
            <span>
              评审人最大负载
              {multi && !isFirst && (
                <em className={`stat-delta ${dMaxLoad < 0 ? 'stat-delta--up' : dMaxLoad > 0 ? 'stat-delta--down' : ''}`}>
                  较首方案 {dMaxLoad > 0 ? '+' : ''}
                  {dMaxLoad}
                </em>
              )}
            </span>
          </div>
          {multi ? (
            <div className="stat">
              <strong className={vsFirst && vsFirst.symmetricDifference > 0 ? 'stat-pre' : undefined}>
                {vsFirst ? vsFirst.symmetricDifference : '—'}
              </strong>
              <span>与首方案不同关系{vsFirst ? `（相同 ${vsFirst.common} 条）` : ''}</span>
            </div>
          ) : (
            <div className="stat">
              <strong className={preassignedCount > 0 ? 'stat-pre' : undefined}>{preassignedCount}</strong>
              <span>来自预指派</span>
            </div>
          )}
        </div>
        {multi && (
          <p className="muted plan-compare-note">
            {isFirst
              ? '★ 首方案是字典序最优方案；切换上方标签可对比各备选方案的主题匹配数、最大负载与差异条数。'
              : `本方案主题匹配数 ${formatDelta(dMatches)}、最大负载 ${formatDelta(dMaxLoad, true)}、与首方案有 ${
                  vsFirst?.symmetricDifference ?? 0
                } 条不同关系（N=${minDifference}）。`}
          {' '}预指派 {preassignedCount} 条在全部方案中相同。
          </p>
        )}
        <button className="btn btn-primary" onClick={onExport}>
          ⬇ {multi ? `导出当前方案 JSON（方案 ${plan.planIndex + 1}/${actualCount}）` : '导出结果 JSON'}
        </button>
      </div>

      {stale ? (
        <div className="stress-stale-banner">
          ⚠ 录入数据在生成本结果后已变化，当前分派<strong>可能已过期</strong>。
          为避免在过期方案上误改派，「分派互换」已暂停；请点击页面顶部「▶ 生成分派」刷新结果后再操作。
        </div>
      ) : (
        <SwapTool data={data} result={plan} onApply={onApplySwap} />
      )}

      <h3 className="subhead">逐稿分配明细</h3>
      <div className="card-list">
        {data.papers
          .filter((p) => p.reviewsRequired > 0)
          .map((p) => {
            const items = byPaper.get(p.id) ?? []
            return (
              <div className="card assignment-card" key={p.id}>
                <div className="assignment-title">
                  <span className="paper-title">{p.title || p.id}</span>
                  <span className="muted">
                    需 {p.reviewsRequired} 人 · 已分配 {items.length} 人
                  </span>
                  <div className="mini-tags">
                    {p.tags.map((t) => (
                      <span className="mini-tag mini-tag--blue" key={t}>
                        {t}
                      </span>
                    ))}
                  </div>
                </div>
                <div className="assignee-list">
                  {items.map((a) => {
                    const rv = reviewerMap.get(a.reviewerId)
                    return (
                      <div className={`assignee ${a.topicMatched ? 'is-match' : 'is-nomatch'}`} key={a.reviewerId}>
                        <span className="assignee-name">
                          {rv?.name ?? a.reviewerId}
                          {rv && (rv.organization ?? '').trim() && (
                            <em className="assignee-org" title="评审人机构（同一稿件每机构至多一人）">
                              🏛 {(rv.organization ?? '').trim()}
                            </em>
                          )}
                        </span>
                        {a.preassigned ? (
                          <span className="badge badge-preassigned" title="该分派来自稿件编辑区的预指派（硬约束）">
                            📌 预指派
                          </span>
                        ) : null}
                        {a.topicMatched ? (
                          <span className="badge badge-match">主题匹配</span>
                        ) : (
                          <span className="badge badge-nomatch">无直接匹配</span>
                        )}
                        {a.matchedTags.length > 0 && (
                          <div className="mini-tags">
                            {a.matchedTags.map((t) => (
                              <span className="mini-tag mini-tag--green" key={t}>
                                {t}
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )
                  })}
                </div>
              </div>
            )
          })}
      </div>

      <h3 className="subhead">评审人负载</h3>
      <div className="load-list">
        {plan.loads.map((l) => {
          const rv = reviewerMap.get(l.reviewerId)
          const pct = l.capacity > 0 ? Math.round((l.assigned / l.capacity) * 100) : 0
          const forcedCount = plan.assignments.filter(
            (a) => a.reviewerId === l.reviewerId && a.preassigned === true
          ).length
          return (
            <div className="load-row" key={l.reviewerId}>
              <span className="load-name" title={rv?.name}>
                {rv?.name ?? l.reviewerId}
                {rv && (rv.organization ?? '').trim() && <em className="load-org" title="评审人机构">🏛 {(rv.organization ?? '').trim()}</em>}
                {forcedCount > 0 && <em className="load-preassigned" title="其中来自预指派的名额">📌 {forcedCount}</em>}
              </span>
              <div className="load-bar">
                <div
                  className={`load-fill ${pct >= 100 ? 'full' : pct >= 70 ? 'high' : ''}`}
                  style={{ width: `${Math.min(100, pct)}%` }}
                />
              </div>
              <span className="load-num">
                {l.assigned}/{l.capacity}
              </span>
            </div>
          )
        })}
      </div>
    </section>
  )
}

/** 有正负号的差值文案（lowerIsBetter 时数值减小视为改善） */
function formatDelta(d: number, lowerIsBetter = false): string {
  const word = d === 0 ? '持平' : d > 0 ? (lowerIsBetter ? '增加' : '多') : lowerIsBetter ? '减少' : '少'
  return `${word} ${Math.abs(d)}`
}
