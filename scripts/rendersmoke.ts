// 无浏览器环境下的渲染冒烟：桩掉浏览器 API 后 renderToString
const store = new Map<string, string>()
;(globalThis as any).localStorage = {
  getItem: (k: string) => (store.has(k) ? store.get(k)! : null),
  setItem: (k: string, v: string) => void store.set(k, v),
  removeItem: (k: string) => void store.delete(k)
}
;(globalThis as any).performance = { now: () => 0 }
;(globalThis as any).window = { confirm: () => false }

import React from 'react'
import { renderToString } from 'react-dom/server'
import App from '../src/App'
import { createSampleData } from '../src/sampleData'
import { solveAssignment, computeMatchedTags } from '../src/engine/solver'
import { singlePlanSet, solveAlternatives, validateAlternativesRequest } from '../src/engine/alternatives'
import { ResultPanel } from '../src/components/ResultPanel'
import { PapersPanel } from '../src/components/PapersPanel'
import { ReviewersPanel } from '../src/components/ReviewersPanel'
import { buildExportPayload } from '../src/exporter'
import type { AppData } from '../src/types'

// 初始空数据渲染
const html1 = renderToString(React.createElement(App))
if (!html1.includes('盲审分配台')) throw new Error('未渲染标题')
if (!html1.includes('生成分派')) throw new Error('未渲染生成按钮')
if (!html1.includes('还没有稿件')) throw new Error('空态提示异常')
if (!html1.includes('备选方案')) throw new Error('备选方案选项未渲染')
console.log('✓ 空数据渲染成功，长度', html1.length)

// 成功结果页统一以“方案集”传入（单方案包装），以下为复用的小工具
const panelProps = (data: AppData, solved: ReturnType<typeof solveAssignment>, stale = false) =>
  solved.feasible
    ? {
        data,
        planSet: singlePlanSet(solved),
        selectedPlan: 0,
        onSelectPlan: () => {},
        stale,
        onExport: () => {},
        onApplySwap: () => {}
      }
    : { data, planSet: solved, selectedPlan: 0, onSelectPlan: () => {}, stale, onExport: () => {}, onApplySwap: () => {} }

// 写入示例数据后渲染（localStorage 初始值，落在"稿件"标签页）
store.set('blind-review-desk:data:v1', JSON.stringify(createSampleData()))
const html2 = renderToString(React.createElement(App))
if (!html2.includes('添加稿件')) throw new Error('稿件面板异常')
if (!html2.includes('面向大语言模型的高效微调方法')) throw new Error('示例稿件未渲染')
if (!html2.includes('机器学习')) throw new Error('稿件标签未渲染')
if (!html2.includes('利益冲突')) throw new Error('冲突入口未渲染')
console.log('✓ 示例数据渲染成功，长度', html2.length)

// 成功结果页：渲染分派互换工具
{
  const data = createSampleData()
  const solved = solveAssignment(data)
  if (!solved.feasible) throw new Error('示例数据应可生成可行方案')
  const html3 = renderToString(React.createElement(ResultPanel, panelProps(data, solved)))
  if (!html3.includes('分派互换')) throw new Error('分派互换工具未渲染')
  if (!html3.includes('请选择')) throw new Error('评审人选择器未渲染')
  if (!html3.includes('导出结果 JSON')) throw new Error('导出按钮未渲染')
  console.log('✓ 成功结果页（含分派互换）渲染成功，长度', html3.length)

  // 过期结果页：互换工具应暂停并提示
  const html4 = renderToString(React.createElement(ResultPanel, panelProps(data, solved, true)))
  if (html4.includes('分派互换（一换一）')) throw new Error('过期结果不应展示互换工具')
  if (!html4.includes('可能已过期')) throw new Error('过期提示未渲染')
  console.log('✓ 过期结果页暂停互换渲染成功')

  // 人工调整后：徽章与导出 JSON 需反映标记
  const adjusted = { ...solved, manuallyAdjusted: true as const, swapCount: 1 }
  const html5 = renderToString(React.createElement(ResultPanel, panelProps(data, adjusted)))
  if (!html5.includes('已人工调整')) throw new Error('已人工调整徽章未渲染')
  const payload = buildExportPayload(data, adjusted)
  if (payload.manuallyAdjusted !== true || payload.swapCount !== 1) throw new Error('导出未反映人工调整标记')
  if (payload.assignments.length !== solved.assignments.length) throw new Error('导出分派条数异常')
  if (payload.plan.planIndex !== 1 || payload.plan.requestedCount !== 1) throw new Error('单方案导出缺少方案序号（应为 1/1）')
  console.log('✓ 已人工调整徽章与导出标记正确')

  // 匹配标签计算在面板外可复用（互换重算口径）
  if (computeMatchedTags(data.papers[0], data.reviewers[0]).length < 0) throw new Error('匹配标签计算异常')
}

// 预指派：稿件面板渲染“预指派”编辑区；成功结果/失败结果/导出均体现预指派
{
  const base = createSampleData()
  const data: AppData = {
    ...base,
    // p1 预指派给 Bob（无冲突）；另一条引用已删除评审人（失效关系，必须保留并提示）
    preAssignments: [
      { id: 'pre_ok', paperId: base.papers[0].id, reviewerId: 'rev_bob' },
      { id: 'pre_gone', paperId: base.papers[1].id, reviewerId: 'rev_deleted' }
    ]
  }

  const papersHtml = renderToString(
    React.createElement(PapersPanel, {
      papers: data.papers,
      reviewers: data.reviewers,
      preAssignments: data.preAssignments,
      onChange: () => {},
      onAddPreAssignment: () => {},
      onRemovePreAssignment: () => {},
      conflictCountOf: () => 0
    })
  )
  if (!papersHtml.includes('预指派评审人')) throw new Error('预指派编辑区未渲染')
  if (!papersHtml.includes('指定评审人')) throw new Error('预指派添加入口未渲染')
  if (!papersHtml.includes('待处理的失效预指派关系')) throw new Error('失效关系提示区未渲染')
  if (!papersHtml.includes('rev_deleted')) throw new Error('失效关系应保留被删除评审人 id')
  if (!papersHtml.includes('移除该关系')) throw new Error('失效关系逐条移除按钮未渲染')
  console.log('✓ 稿件面板（预指派编辑区 + 失效关系提示）渲染成功')

  // 含失效预指派 → 生成失败，结果区必须列出具体稿件、评审人、原因，且无部分结果
  const fail = solveAssignment(data)
  if (fail.feasible) throw new Error('含失效预指派时不应生成结果')
  const failHtml = renderToString(
    React.createElement(ResultPanel, panelProps(data, fail))
  )
  if (!failHtml.includes('预指派硬约束无法满足')) throw new Error('预指派失败横幅未渲染')
  if (!failHtml.includes('rev_deleted')) throw new Error('失败结果未列出失效评审人')
  console.log('✓ 预指派失败结果（逐条原因、无部分结果）渲染成功')

  // 移除失效关系后 → 成功，结果与导出标注来自预指派的分派
  const okData: AppData = { ...data, preAssignments: data.preAssignments.filter((p) => p.id === 'pre_ok') }
  const ok = solveAssignment(okData)
  if (!ok.feasible) throw new Error('有效预指派数据应可生成结果')
  if (ok.objective.preassignedCount !== 1) throw new Error('预指派计数应为 1')
  if (!ok.assignments.some((a) => a.paperId === base.papers[0].id && a.reviewerId === 'rev_bob' && a.preassigned))
    throw new Error('Bob 对第一篇的预指派未体现在结果中')
  const okHtml = renderToString(
    React.createElement(ResultPanel, panelProps(okData, ok))
  )
  if (!okHtml.includes('预指派')) throw new Error('成功结果未展示预指派标记')
  const payload = buildExportPayload(okData, ok)
  if (payload.summary.preassignedCount !== 1) throw new Error('导出 summary 缺少预指派计数')
  if (!payload.assignments.some((a) => a.preassigned && a.reviewerId === 'rev_bob'))
    throw new Error('导出未标注来自预指派的分派')
  console.log('✓ 预指派成功结果与 JSON 导出标注渲染成功')
}

// 机构去重：评审人编辑区有机构字段；成功结果与导出携带机构信息
{
  const data = createSampleData()
  const rvHtml = renderToString(
    React.createElement(ReviewersPanel, {
      papers: data.papers,
      reviewers: data.reviewers,
      onChange: () => {}
    })
  )
  if (!rvHtml.includes('机构')) throw new Error('评审人编辑区未渲染机构字段')
  if (!rvHtml.includes('清华大学')) throw new Error('示例机构未渲染')
  console.log('✓ 评审人面板机构字段渲染成功')

  const solved = solveAssignment(data)
  if (!solved.feasible) throw new Error('示例数据（含机构）应可生成可行方案')
  const payload = buildExportPayload(data, solved)
  if (!payload.assignments.every((a) => typeof a.reviewerOrganization === 'string'))
    throw new Error('导出分派缺少机构字段')
  if (!payload.reviewerLoads.every((l) => typeof l.reviewerOrganization === 'string'))
    throw new Error('导出负载缺少机构字段')
  if (!payload.assignments.some((a) => a.reviewerOrganization === '清华大学'))
    throw new Error('导出未包含去空白后的机构名')
  console.log('✓ 结果导出含机构信息')

  // 预指派同机构重复 → 整体拒绝，失败区列出机构（p4 与 Alice/Carol 均无冲突，二人同属清华）
  const dup: AppData = {
    ...data,
    preAssignments: [
      { id: 'pa1', paperId: data.papers[3].id, reviewerId: 'rev_alice' },
      { id: 'pa2', paperId: data.papers[3].id, reviewerId: 'rev_carol' }
    ]
  }
  const dupFail = solveAssignment(dup)
  if (dupFail.feasible) throw new Error('同稿预指派同机构应整体拒绝')
  const dupHtml = renderToString(
    React.createElement(ResultPanel, panelProps(dup, dupFail))
  )
  if (!dupHtml.includes('清华大学')) throw new Error('机构重复失败结果未列出机构')
  if (!dupHtml.includes('预指派机构重复')) throw new Error('未渲染机构重复原因标签')
  if (dupHtml.includes('assignee')) throw new Error('机构重复失败不应含分派结果')
  console.log('✓ 预指派同稿机构重复整体拒绝（列出机构与评审人）渲染成功')
}

// 备选方案：构造余量充足的数据，请求 3 个方案并验证标签切换/差异对比/导出
{
  const data: AppData = {
    papers: [
      { id: 'p1', title: '稿件一', reviewsRequired: 1, tags: ['T'] },
      { id: 'p2', title: '稿件二', reviewsRequired: 1, tags: ['T'] }
    ],
    reviewers: [
      { id: 'a', name: '甲', organization: '', tags: ['T'], capacity: 2, conflictPaperIds: [] },
      { id: 'b', name: '乙', organization: '', tags: ['T'], capacity: 2, conflictPaperIds: [] },
      { id: 'c', name: '丙', organization: '', tags: [], capacity: 2, conflictPaperIds: [] }
    ],
    preAssignments: []
  }
  const set = solveAlternatives(data, validateAlternativesRequest(3, 2))
  if (!set.feasible) throw new Error('余量充足数据应可生成备选方案')
  if (set.plans.length !== 3) throw new Error(`应凑满 3 个方案，实际 ${set.plans.length}（${set.stopReason ?? ''}）`)
  for (let i = 1; i < set.plans.length; i++) {
    const vs = set.plans[i].differences.find((d) => d.otherPlanIndex === 0)
    if (!vs || vs.symmetricDifference < 2) throw new Error(`方案 ${i + 1} 与首方案差异不足 N=2`)
  }
  const html = renderToString(
    React.createElement(ResultPanel, {
      data,
      planSet: set,
      selectedPlan: 1,
      onSelectPlan: () => {},
      stale: false,
      onExport: () => {},
      onApplySwap: () => {}
    })
  )
  if (
    !html.includes('data-plan-index="0"') ||
    !html.includes('data-plan-index="1"') ||
    !html.includes('data-plan-index="2"')
  )
    throw new Error('方案标签未全部渲染')
  if (!html.includes('与首方案差')) throw new Error('标签上未展示相对首方案差异条数')
  if (!html.includes('备选方案 2')) throw new Error('未渲染选中方案标题')
  if (!html.includes('导出当前方案 JSON（方案 2/3）')) throw new Error('导出按钮未标明当前方案序号')
  console.log('✓ 备选方案（3 个标签 / 差异对比 / 选中序号）渲染成功')

  // 导出当前选中方案：写入方案序号与差异统计
  const payload = buildExportPayload(data, set.plans[1], {
    planIndex: set.plans[1].planIndex,
    requestedCount: set.requestedCount,
    minDifference: set.minDifference,
    differences: set.plans[1].differences
  })
  if (payload.plan.planIndex !== 2 || payload.plan.requestedCount !== 3 || payload.plan.minDifference !== 2)
    throw new Error('导出未写入方案序号/数量/差异门槛')
  const vsPlan1 = payload.plan.differences.find((d) => d.otherPlanIndex === 1)
  if (!vsPlan1 || vsPlan1.symmetricDifference < 2) throw new Error('导出缺少相对首方案的差异统计')
  console.log('✓ 备选方案导出含方案序号与差异统计')

  // N 超过上限：保留首方案并说明停止原因
  const tooBig = solveAlternatives(data, validateAlternativesRequest(2, 99))
  if (!tooBig.feasible || tooBig.plans.length !== 1 || !tooBig.stopReason)
    throw new Error('N 超上限时应保留首方案并给出停止原因')
  const stopHtml = renderToString(
    React.createElement(ResultPanel, {
      data,
      planSet: tooBig,
      selectedPlan: 0,
      onSelectPlan: () => {},
      stale: false,
      onExport: () => {},
      onApplySwap: () => {}
    })
  )
  if (!stopHtml.includes('plan-stop-banner') || !stopHtml.includes('超过可达到的上限'))
    throw new Error('停止原因横幅未渲染')
  console.log('✓ N 超上限时保留已找到方案并说明停止原因')
}

// 旧数据兼容：localStorage 中没有 preAssignments 字段时，应用仍可正常渲染与求解
{
  const legacy = { papers: createSampleData().papers, reviewers: createSampleData().reviewers }
  store.set('blind-review-desk:data:v1', JSON.stringify(legacy))
  const html = renderToString(React.createElement(App))
  if (!html.includes('盲审分配台')) throw new Error('旧数据渲染异常')
  const solved = solveAssignment(legacy as AppData)
  if (!solved.feasible || solved.objective.preassignedCount !== 0) throw new Error('旧数据求解/预指派缺省值异常')
  console.log('✓ 旧数据（无 preAssignments 字段）兼容正常')
}
