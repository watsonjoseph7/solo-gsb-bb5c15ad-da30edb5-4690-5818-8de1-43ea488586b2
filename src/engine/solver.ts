import solver from 'javascript-lp-solver'
import { checkFeasibility, orgAwareCapacityForPaperGroup } from './maxflow'
import { buildForcedMatrix, dedupePreAssignments, validatePreAssignments, type ForcedMatrix } from './preassign'
import type {
  AppData,
  AssignmentItem,
  AssignmentResult,
  AssignmentSuccess,
  InfeasibleReason,
  Paper,
  PreAssignment,
  Reviewer,
  ReviewerLoad
} from '../types'

/** 标签规范化：去空白、去重，大小写不敏感保留首次写法 */
function normalizeTags(raw: string[]): string[] {
  const seen = new Set<string>()
  const out: string[] = []
  for (const t of raw) {
    const v = t.trim()
    if (!v) continue
    const key = v.toLowerCase()
    if (!seen.has(key)) {
      seen.add(key)
      out.push(v)
    }
  }
  return out
}

interface Normalized {
  papers: Paper[]
  reviewers: Reviewer[]
  /** 去重后的预指派关系（失效引用不在此阶段剔除，由预检逐条报告） */
  preAssignments: PreAssignment[]
}

function normalize(data: AppData): Normalized {
  const papers: Paper[] = data.papers
    .map((p) => ({
      ...p,
      title: p.title.trim(),
      tags: normalizeTags(p.tags),
      reviewsRequired: Math.max(0, Math.floor(Number.isFinite(p.reviewsRequired) ? p.reviewsRequired : 0))
    }))
    .filter((p) => p.title.length > 0 && p.reviewsRequired > 0)

  const reviewers: Reviewer[] = data.reviewers
    .map((r) => ({
      ...r,
      name: r.name.trim(),
      // 机构：去除首尾空白后完全相同者视为同一机构；空串保留为空（仅代表本人，不与其他空值合并）
      organization: typeof r.organization === 'string' ? r.organization.trim() : '',
      tags: normalizeTags(r.tags),
      capacity: Math.max(0, Math.floor(Number.isFinite(r.capacity) ? r.capacity : 0)),
      conflictPaperIds: Array.from(new Set(r.conflictPaperIds))
    }))
    .filter((r) => r.name.length > 0)

  return { papers, reviewers, preAssignments: dedupePreAssignments(data.preAssignments ?? []) }
}

function hasConflict(paper: Paper, reviewer: Reviewer): boolean {
  return reviewer.conflictPaperIds.includes(paper.id)
}

function tagKey(t: string): string {
  return t.toLowerCase()
}

/** 稿件 i 与评审人 j 命中的共同主题标签 */
function matchedTagsOf(paper: Paper, reviewer: Reviewer): string[] {
  const rSet = new Set(reviewer.tags.map(tagKey))
  return paper.tags.filter((t) => rSet.has(tagKey(t)))
}

/**
 * 计算一份（可能未经归一化的）稿件与评审人命中的共同主题标签。
 * 复用求解器同一套标签归一化（去空白、大小写不敏感、保留稿件侧首次写法），
 * 供「分派互换」在结果层重算交换后的匹配情况，保证与生成结果口径一致。
 */
export function computeMatchedTags(paper: Paper, reviewer: Reviewer): string[] {
  return matchedTagsOf(
    { ...paper, tags: normalizeTags(paper.tags) },
    { ...reviewer, tags: normalizeTags(reviewer.tags) }
  )
}

/**
 * 硬约束评估结果。
 * 可行性、不可行原因与归一化后的输入一并返回，供分配主流程与缺席压力测试复用。
 */
export interface HardConstraintEvaluation {
  feasible: boolean
  reasons: InfeasibleReason[]
  papers: Paper[]
  reviewers: Reviewer[]
  /** eligible[i][j] = true 表示稿件 i 与评审人 j 无冲突 */
  eligible: boolean[][]
  demands: number[]
  capacities: number[]
  /** 评审人机构（归一化、去首尾空白）；空串表示无机构 */
  organizations: string[]
  totalRequired: number
  /** 归一化（去重）后的预指派关系，顺序与存储一致 */
  preAssignments: PreAssignment[]
  /** 预指派问题（逐条）；非空时整体不可行，且不生成任何部分结果 */
  preAssignmentIssues: ReturnType<typeof validatePreAssignments>
  /** 有效预指派矩阵（仅在预检通过时有意义） */
  forced: ForcedMatrix
  /** 预指派占用后，评审人 j 对“自由名额”的剩余容量 = 容量 − 被预指派数 */
  residualCapacities: number[]
  /** 预指派占用后，稿件 i 仍需自由分配的名额 = 需求 − 预指派数 */
  residualDemands: number[]
  /**
   * 每篇稿件上被预指派占住唯一名额的非空机构集合：
   * 自由分配不得再从这些机构中为该稿件选择评审人（同稿每机构至多一人）。
   */
  blockedOrgsByPaper: Set<string>[]
}

/**
 * 残量网络可行性输入：预指派边视为已固定发送的流量，只保留“自由”边（非预指派），
 * 源→稿件容量为剩余需求，评审人→汇容量为剩余容量（容量−预占），
 * 并把预指派已占用的机构名额按稿件封禁。生成分派与压力测试共用同一口径。
 */
export function buildResidualFeasibilityInput(hc: HardConstraintEvaluation): {
  demands: number[]
  capacities: number[]
  eligible: boolean[][]
  organizations: string[]
  blockedOrgsByPaper: Set<string>[]
} {
  const residualEligible = hc.papers.map((_, i) =>
    hc.reviewers.map((_, j) => hc.eligible[i][j] && !hc.forced.forcedByPaperIndex[i].has(j))
  )
  return {
    demands: hc.residualDemands,
    capacities: hc.residualCapacities,
    eligible: residualEligible,
    organizations: hc.organizations,
    blockedOrgsByPaper: hc.blockedOrgsByPaper
  }
}

/**
 * 稿件 i 在机构去重约束下还能从自由评审人处获得的名额上界：
 * 无冲突、未被预指派占用，且其机构未被该稿件上的预指派封禁；同一非空机构只计 1 人，
 * 空机构逐人计数（互不合并）。
 * onlyPositiveCapacity 用于缺席诊断：容量已置 0（或缺席导致剩余容量 ≤ 0）者不计入可选名额。
 */
export function effectiveFreeReviewerCount(args: {
  i: number
  reviewers: Reviewer[]
  eligible: boolean[][]
  organizations: string[]
  forcedByPaper: Set<number>
  blockedOrgs: Set<string>
  /** 额外的逐评审人容量上界（缺省取评审人归一化容量）；传 0 即视为缺席，不计入可选 */
  effectiveCapacities?: number[]
}): number {
  const { i, reviewers, eligible, organizations, forcedByPaper, blockedOrgs, effectiveCapacities } = args
  const countedOrgs = new Set<string>()
  let n = 0
  for (let j = 0; j < reviewers.length; j++) {
    if (!eligible[i][j]) continue
    if (forcedByPaper.has(j)) continue
    const cap = effectiveCapacities ? effectiveCapacities[j] : reviewers[j].capacity
    if (cap <= 0) continue
    const org = organizations[j]
    if (org) {
      if (blockedOrgs.has(org) || countedOrgs.has(org)) continue
      countedOrgs.add(org)
    }
    n++
  }
  return n
}

/**
 * 仅评估硬约束（冲突 / 容量 / 人数 / 机构去重 / 预指派），不做任何目标优化、不改变输入数据。
 * 缺席压力测试把某位评审人容量改为 0 后调用本函数，即“使用既有硬约束可行性逻辑重新判定”
 * （预指派同样是硬约束：容量置 0 后，被该评审人预占的名额会立刻显现为超限）。
 */
export function evaluateHardConstraints(rawData: AppData): HardConstraintEvaluation {
  const { papers, reviewers, preAssignments } = normalize(rawData)
  const P = papers.length
  const R = reviewers.length

  // ---- 冲突矩阵 ----
  const eligible: boolean[][] = papers.map((p) => reviewers.map((r) => !hasConflict(p, r)))
  const demands = papers.map((p) => p.reviewsRequired)
  const capacities = reviewers.map((r) => r.capacity)
  const organizations = reviewers.map((r) => r.organization)
  const totalRequired = demands.reduce((a, b) => a + b, 0)

  // ---- 预指派预检（最高优先级）：引用缺失 / 利益冲突 / 机构重复 / 同篇超额 / 单人超容量 ----
  const preAssignmentIssues = validatePreAssignments(papers, reviewers, preAssignments)
  const forced = buildForcedMatrix(papers, reviewers, preAssignments, eligible)
  const residualCapacities = reviewers.map((r, j) => {
    const reserved = papers.reduce((n, _, i) => n + (forced.forcedByPaperIndex[i].has(j) ? 1 : 0), 0)
    return r.capacity - reserved
  })
  const residualDemands = demands.map((d, i) => d - forced.forcedByPaperIndex[i].size)
  // 机构去重：预指派已确定占住该稿件上其机构的唯一名额，自由分配不得再选同机构者
  const blockedOrgsByPaper: Set<string>[] = papers.map((_, i) => {
    const s = new Set<string>()
    for (const j of forced.forcedByPaperIndex[i]) {
      if (organizations[j]) s.add(organizations[j])
    }
    return s
  })

  const emptyEval = (reasons: InfeasibleReason[]): HardConstraintEvaluation => ({
    feasible: false,
    reasons,
    papers,
    reviewers,
    preAssignments,
    eligible,
    demands,
    capacities,
    organizations,
    totalRequired,
    preAssignmentIssues,
    forced,
    residualCapacities,
    residualDemands,
    blockedOrgsByPaper
  })

  // 残量网络输入（自由边 + 机构封禁），预检诊断与正式可行性判定共用同一口径
  const residualInput = buildResidualFeasibilityInput(emptyEval([]))

  if (preAssignmentIssues.length > 0) {
    return emptyEval([
      {
        kind: 'preassignment',
        message:
          `预指派关系存在 ${preAssignmentIssues.length} 条无法满足的问题。预指派是生成分派时必须满足的硬约束，` +
          `任一问题存在时都不会生成部分结果；请逐条移除或修正后重新生成。`,
        issues: preAssignmentIssues
      }
    ])
  }

  const reasons: InfeasibleReason[] = []

  // ---- 退化情形 ----
  if (P === 0) {
    return emptyEval([
      { kind: 'paper-eligible', message: '没有需要分配的有效稿件（请至少录入一篇需要评审的稿件）。' }
    ])
  }
  if (R === 0) {
    reasons.push({
      kind: 'global-capacity',
      message: `尚未录入任何评审人，${papers.reduce((a, p) => a + p.reviewsRequired, 0)} 个评审名额无人承担。`
    })
    return emptyEval(reasons)
  }

  // ---- 原因 1（最具体）：单篇稿件可分配评审人数不足 ----
  // 预指派占用的评审人已确定占住该篇名额，单篇只需再找到 需求−预指派数 位不同评审人；
  // 机构去重同时生效：被预指派封禁的机构、以及彼此同机构的自由评审人只按 1 个名额计。
  const perPaperFailures: InfeasibleReason[] = []
  for (let i = 0; i < P; i++) {
    const reserved = forced.forcedByPaperIndex[i]
    const avail = effectiveFreeReviewerCount({
      i,
      reviewers,
      eligible,
      organizations,
      forcedByPaper: reserved,
      blockedOrgs: blockedOrgsByPaper[i]
    })
    const need = residualDemands[i]
    if (avail < need) {
      const forcedNames = [...reserved].map((j) => reviewers[j].name)
      const blockedNames = [...blockedOrgsByPaper[i]]
        .map((org) => `「${org}」`)
        .join('、')
      perPaperFailures.push({
        kind: 'paper-eligible',
        paperIds: [papers[i].id],
        message:
          `《${papers[i].title}》需要 ${demands[i]} 位评审人` +
          (reserved.size > 0
            ? `（其中 ${reserved.size} 位已由预指派确定：${forcedNames.join('、')}），还需 ${need} 位`
            : '') +
          `，但在无利益冲突且满足“每篇稿件同一机构至多一人”的评审人中仅能再选出 ${Math.max(0, avail)} 位（缺口 ${need - Math.max(0, avail)}）。` +
          (blockedNames ? `其中机构 ${blockedNames} 的名额已被预指派占用。` : '')
      })
    }
  }

  // ---- 全局容量：预指派已提前占住各评审人名额，自由名额总量不得少于剩余总需求 ----
  const totalResidualCapacity = residualCapacities.reduce((a, b) => a + b, 0)
  const totalResidualDemand = residualDemands.reduce((a, b) => a + b, 0)
  if (totalResidualCapacity < totalResidualDemand) {
    const totalForced = forced.forcedKeys.size
    reasons.push({
      kind: 'global-capacity',
      reviewerIds: reviewers.map((r) => r.id),
      message:
        totalForced > 0
          ? `全部稿件共需 ${totalRequired} 个名额，其中 ${totalForced} 个已由预指派提前占住；剩余 ${totalResidualDemand} 个自由名额，而评审人的剩余容量合计仅 ${totalResidualCapacity}（缺口 ${totalResidualDemand - totalResidualCapacity}）。请增加评审人、提高容量或减少预指派。`
          : `全部稿件共需 ${totalRequired} 个评审名额，而 ${R} 位评审人的容量合计仅 ${capacities.reduce((a, b) => a + b, 0)}（缺口 ${totalRequired - capacities.reduce((a, b) => a + b, 0)}）。请增加评审人或提高容量。`
    })
  }

  // ---- 最大流可行性检验（残量视角）----
  // 预指派边视为已固定发送的流量：网络中只保留“自由”边（非预指派），
  // 源→稿件容量为剩余需求，评审人→汇容量为剩余容量（容量−预占），
  // 并在“论文→机构”层封禁已被预指派占住的机构名额（同一稿件每机构至多一人）。
  const feas = checkFeasibility(residualInput)

  if (!feas.feasible && reasons.length === 0 && perPaperFailures.length === 0) {
    // 组合性瓶颈（广义 Hall 条件违反）：
    // 取残量网源侧可达稿件集合 Z，令 Y 为与 Z 中任一稿件有自由边、且仍有自由容量的全部评审人。
    // 机构去重同时计入：Y 对 Z 的可承担名额上界用同构“稿件→机构→评审人”网络精确实测
    //（不能逐人 min 求和，否则会高估同机构名额）。
    const Zidx = feas.sourceReachablePapers
    const Zset = Zidx.map((i) => papers[i])
    const Yidx: number[] = []
    for (let j = 0; j < R; j++) {
      if (residualCapacities[j] <= 0) continue
      if (Zidx.some((i) => residualInput.eligible[i][j])) Yidx.push(j)
    }
    const Yset = Yidx.map((j) => reviewers[j])
    const demandZ = Zidx.reduce((a, i) => a + residualDemands[i], 0)
    // 精确上界：仅以 Z 中稿件为左部、机构层容量 1 的子网络最大流
    const capY = orgAwareCapacityForPaperGroup(residualInput, Zidx)
    const totalForced = forced.forcedKeys.size
    const orgNote = organizations.some((o) => o)
      ? '同一稿件对每个机构至多选择一人（空机构除外），机构集中也会形成名额瓶颈；'
      : ''
    reasons.push({
      kind: 'subset-bottleneck',
      paperIds: Zset.map((p) => p.id),
      reviewerIds: Yset.map((r) => r.id),
      deficit: demandZ - capY,
      message:
        `存在一组 ${Zset.length} 篇稿件，其可选评审人范围相互重叠、形成容量瓶颈：扣除预指派后它们共需 ${demandZ} 个自由名额，` +
        `而 ${Yset.length} 位无冲突且仍有剩余容量的评审人对这组稿件至多能承担 ${capY} 个自由名额（缺口 ${demandZ - capY}，已计入每位评审人对同一篇稿件至多评一次、` +
        `以及同一稿件对每个机构至多一人）。\n` +
        orgNote +
        `瓶颈稿件：${Zset.map((p) => `《${p.title}》`).join('、')}；\n` +
        `可选评审人：${Yset.length ? Yset.map((r) => r.name).join('、') : '（无，全部存在利益冲突、机构名额被预指派占满或容量已被预指派占满）'}。\n` +
        (totalForced > 0 ? `预指派已提前占住 ${totalForced} 个名额；` : '') +
        `建议：为这些稿件补充评审人、解除部分冲突、提高相关评审人容量，或调整预指派。`
    })
  }

  return {
    feasible: feas.feasible,
    reasons: feas.feasible ? [] : [...perPaperFailures, ...reasons],
    papers,
    reviewers,
    preAssignments,
    eligible,
    demands,
    capacities,
    organizations,
    totalRequired,
    preAssignmentIssues,
    forced,
    residualCapacities,
    residualDemands,
    blockedOrgsByPaper
  }
}

/**
 * 核心入口：执行盲审分配。
 *
 * 硬约束（全部必须满足，否则不可行）:
 *  1. 预指派：显式指定的（稿件，评审人）对必须出现在分派中；
 *  2. 利益冲突：声明冲突的稿件-评审人对绝不分配；
 *  3. 容量：每位评审人承担稿件数不超过 capacity（含被预指派预占的名额）；
 *  4. 人数：每篇稿件恰好得到 reviewsRequired 位互不相同的评审人；
 *  5. 机构去重：同一篇稿件至多选择每个机构（去首尾空白后相同的非空机构名）一人；
 *     机构为空的评审人不受此限，且空值之间互不合并（仅代表本人）。
 *
 * 优化目标（硬约束满足后）:
 *  第一优先 最大化稿件主题标签与评审人擅长标签的匹配数；
 *  第二优先 最小化评审人最大负载（负载均衡）。
 */
export function solveAssignment(rawData: AppData): AssignmentResult {
  // ---- 硬约束可行性（与缺席压力测试共用同一套判定逻辑；预指派问题在此逐条报告） ----
  const hc = evaluateHardConstraints(rawData)
  if (!hc.feasible) {
    return { feasible: false, reasons: hc.reasons }
  }

  // ---- 硬约束可行：用整数规划做目标优化（预指派关系作为强制变量；单方案模式不会返回 null） ----
  return (
    optimize(hc.papers, hc.reviewers, hc.eligible, hc.organizations, hc.demands, hc.totalRequired, hc.forced) ??
    greedyFallback(hc.papers, hc.reviewers, hc.eligible, hc.organizations, hc.demands, hc.totalRequired, hc.forced)
  )
}

/**
 * 在已通过硬约束评估的输入上，按给定多样性约束做字典序优化。
 * 供“备选方案”模块复用：首方案传空约束（与 {@link solveAssignment} 完全一致），
 * 后续方案对每个已生成方案传一条“对称差 ≥ N”约束。
 * 返回 null 表示不存在满足全部多样性约束的可行方案。
 */
export function optimizeWithDiversity(hc: HardConstraintEvaluation, diversity: DiversityConstraint[]): AssignmentSuccess | null {
  return optimize(
    hc.papers,
    hc.reviewers,
    hc.eligible,
    hc.organizations,
    hc.demands,
    hc.totalRequired,
    hc.forced,
    diversity
  )
}

/** 方案的“稿件—评审人”关系集合（元素为 `i_j` 变量名，与多样性约束使用的键一致） */
export function edgeSetOfSuccess(hc: HardConstraintEvaluation, result: AssignmentSuccess): Set<string> {
  const paperIndex = new Map(hc.papers.map((p, i) => [p.id, i]))
  const reviewerIndex = new Map(hc.reviewers.map((r, j) => [r.id, j]))
  const edges = new Set<string>()
  for (const a of result.assignments) {
    const i = paperIndex.get(a.paperId)
    const j = reviewerIndex.get(a.reviewerId)
    if (i !== undefined && j !== undefined) edges.add(`${i}_${j}`)
  }
  return edges
}

/* ------------------------------ 整数规划优化 ------------------------------ */

/**
 * 备选方案多样性约束：针对某个已生成方案，当前解与其不同的“稿件—评审人”关系
 * （分派边）至少 minDifference 条。
 * 以对称差实现：令 priorEdges 为对照方案取 1 的变量名集合，
 * 约束 Σ_{e∈priorEdges} (1−x_e) + Σ_{e∉priorEdges} x_e ≥ N
 * （展开后即 |Prior\\Current| + |Current\\Prior| ≥ N，为对称差）。
 * 预指派边在所有方案中恒为 1，不出现在约束中（它们对差异贡献恒为 0）。
 */
export interface DiversityConstraint {
  priorEdges: Set<string>
  minDifference: number
}

interface PhaseSolution {
  feasible: boolean
  /** 最优主题匹配数 */
  matches: number
  /** 求解器原始结果，用于读取变量取值 */
  raw: Record<string, number>
}

/**
 * 阶段模型：在“每位评审人负载 ≤ capLimit（缺省取自身容量）”下最大化主题匹配数。
 *
 * 约束矩阵是带容量二部图（b-匹配 / 运输问题）的节点-关联阵，全幺模：
 * LP 松弛的顶点解天然为整数，javascript-lp-solver 无需真正分支即可快速求得 0/1 最优解。
 * 机构去重以“每（稿件,非空机构）Σ x ≤ 1”的行约束加入（机构成员节点-关联阵依旧全幺模）；
 * 空机构不生成此类约束，因此空值仅代表本人。
 */
function runPhase(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  organizations: string[],
  demands: number[],
  totalRequired: number,
  capLimit: number | null,
  forced: ForcedMatrix,
  diversity: DiversityConstraint[] = []
): PhaseSolution {
  const P = papers.length
  const R = reviewers.length

  const model: {
    optimize: string
    opType: 'max'
    constraints: Record<string, Record<string, number>>
    variables: Record<string, Record<string, number>>
    binaries: Record<string, 1>
  } = {
    optimize: 'objective',
    opType: 'max',
    constraints: {},
    variables: {},
    binaries: {}
  }

  papers.forEach((_, i) => {
    model.constraints[`paper_${i}`] = { equal: demands[i] }
  })
  reviewers.forEach((r, j) => {
    model.constraints[`reviewer_${j}`] = { max: capLimit === null ? r.capacity : Math.min(r.capacity, capLimit) }
  })
  // 预指派硬约束：对应二元变量必须取 1（与冲突/容量/人数共同求解，不是事后补丁）
  for (const key of forced.forcedKeys) {
    model.constraints[`pre_${key}`] = { equal: 1 }
  }
  // 机构去重硬约束：每个（稿件 i，非空机构 o）一行，Σ_j∈org(o) x[i][j] ≤ 1。
  // 空机构不生成行（空值仅代表本人，互不合并）；机构名按去首尾空白后的精确值分组（区分大小写）。
  const distinctOrgs: string[] = []
  const hasOrg = new Set<string>()
  for (let j = 0; j < R; j++) {
    const org = organizations[j]
    if (org && !hasOrg.has(org)) {
      hasOrg.add(org)
      distinctOrgs.push(org)
    }
  }
  for (let i = 0; i < P; i++) {
    for (const org of distinctOrgs) {
      model.constraints[`org_${i}_${org}`] = { max: 1 }
    }
  }

  // 备选方案多样性：每条对照方案一行“对称差 ≥ N”。
  // 该行只包含自由边变量（预指派边恒为 1、差异恒为 0，无需入模）。
  // 系数矩阵先在 diversityRows[k] 中按变量名组装，创建变量时再挂到模型上。
  const diversityRows: Array<{ row: Record<string, number>; rhs: number }> = diversity.map((dc) => {
    const row: Record<string, number> = {}
    let inEdges = 0
    for (let i = 0; i < P; i++) {
      for (let j = 0; j < R; j++) {
        if (!eligible[i][j]) continue
        if (forced.forcedKeys.has(`${i}_${j}`)) continue
        const varName = `x_${i}_${j}`
        // priorEdges 的键为不含 `x_` 前缀的 `i_j`（与 edgeSetOfSuccess 输出一致）
        if (dc.priorEdges.has(`${i}_${j}`)) {
          row[varName] = -1 // 对照方案有、当前方案去掉：1 − x
          inEdges++
        } else {
          row[varName] = 1 // 对照方案没有、当前方案新增：x
        }
      }
    }
    // 常数项 Σ_{e∈prior} 1 移到右端：min − 常数；左端最小可取 −inEdges，RHS 不得低于它
    return { row, rhs: Math.max(-inEdges, dc.minDifference - inEdges) }
  })
  diversity.forEach((_, k) => {
    model.constraints[`div_${k}`] = { min: diversityRows[k].rhs }
  })

  for (let i = 0; i < P; i++) {
    for (let j = 0; j < R; j++) {
      if (!eligible[i][j]) continue // 冲突对不生成变量 —— 硬约束：利益冲突
      const varName = `x_${i}_${j}`
      const matched = matchedTagsOf(papers[i], reviewers[j]).length > 0
      model.binaries[varName] = 1
      model.variables[varName] = {
        [`paper_${i}`]: 1,
        [`reviewer_${j}`]: 1,
        objective: matched ? 1 : 0
      }
      if (forced.forcedKeys.has(`${i}_${j}`)) {
        model.variables[varName][`pre_${i}_${j}`] = 1
      }
      if (organizations[j]) {
        model.variables[varName][`org_${i}_${organizations[j]}`] = 1
      }
      for (let k = 0; k < diversityRows.length; k++) {
        const c = diversityRows[k].row[varName]
        if (c !== undefined) model.variables[varName][`div_${k}`] = c
      }
    }
  }

  const res = solver.Solve(model as never) as Record<string, number | boolean>

  // 以实际取到 1 的变量数为准判定可行性（兼容求解器对 infeasible 返回 -0 的行为）
  let chosen = 0
  for (const v of Object.keys(model.variables)) {
    if (Math.round((res[v] as number) ?? 0) === 1) chosen++
  }
  const feasible = chosen === totalRequired && res.feasible !== false
  return { feasible, matches: feasible ? Math.round((res.result as number) ?? 0) : 0, raw: res as unknown as Record<string, number> }
}

function parseSolution(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  raw: Record<string, number>,
  forced: ForcedMatrix
): AssignmentItem[] {
  const P = papers.length
  const R = reviewers.length
  const assignments: AssignmentItem[] = []
  for (let i = 0; i < P; i++) {
    for (let j = 0; j < R; j++) {
      if (!eligible[i][j]) continue
      if (Math.round(raw[`x_${i}_${j}`] ?? 0) !== 1) continue
      const matched = matchedTagsOf(papers[i], reviewers[j])
      const isForced = forced.forcedKeys.has(`${i}_${j}`)
      assignments.push({
        paperId: papers[i].id,
        reviewerId: reviewers[j].id,
        topicMatched: matched.length > 0,
        matchedTags: matched,
        preassigned: isForced || undefined
      })
    }
  }
  return assignments.sort((a, b) => a.paperId.localeCompare(b.paperId) || a.reviewerId.localeCompare(b.reviewerId))
}

function buildSuccess(
  reviewers: Reviewer[],
  assignments: AssignmentItem[],
  totalRequired: number
): AssignmentSuccess {
  const counts = new Map<string, number>()
  for (const a of assignments) counts.set(a.reviewerId, (counts.get(a.reviewerId) ?? 0) + 1)
  const loads: ReviewerLoad[] = reviewers.map((r) => ({
    reviewerId: r.id,
    assigned: counts.get(r.id) ?? 0,
    capacity: r.capacity
  }))

  return {
    feasible: true,
    assignments: [...assignments].sort((a, b) => a.paperId.localeCompare(b.paperId) || a.reviewerId.localeCompare(b.reviewerId)),
    loads,
    objective: {
      topicMatches: assignments.filter((a) => a.topicMatched).length,
      maxLoad: Math.max(0, ...loads.map((l) => l.assigned)),
      totalAssigned: assignments.length,
      totalRequired,
      preassignedCount: assignments.filter((a) => a.preassigned === true).length
    }
  }
}

/**
 * 字典序两阶段优化。
 *
 * diversity 为空（默认单方案模式）时：阶段一异常退回贪心可行解，行为与历史版本完全一致。
 * diversity 非空（备选方案模式）时：在全部多样性约束下仍按“先匹配、后均衡”求最优；
 * 若多样性约束已让模型不可行（不存在满足差异门槛的方案），返回 null，由上层据此停止生成
 * （不退回贪心——贪心解无法保证差异门槛，返回它会破坏备选方案的核心承诺）。
 */
function optimize(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  organizations: string[],
  demands: number[],
  totalRequired: number,
  forced: ForcedMatrix,
  diversity: DiversityConstraint[] = []
): AssignmentSuccess | null {
  const R = reviewers.length
  const isDiverse = diversity.length > 0

  // 阶段一：真实容量下最大化主题匹配数（预指派变量固定为 1），得到最优匹配数 M*
  const phase1 = runPhase(papers, reviewers, eligible, organizations, demands, totalRequired, null, forced, diversity)

  // 理论上最大流已保证“无多样性约束时”可行；备选模式下不可行即不存在满足门槛的方案
  if (!phase1.feasible) {
    return isDiverse ? null : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced)
  }
  const bestMatches = phase1.matches
  let bestRaw = phase1.raw

  // 阶段二：在不损失任何主题匹配（匹配数仍为 M*）的前提下，二分最小化最大负载 L。
  // 上界直接取阶段一解的最大负载，下界取总名额按人均摊的向上取整。
  const phase1Items = parseSolution(papers, reviewers, eligible, phase1.raw, forced)
  const phase1Counts = new Map<string, number>()
  for (const a of phase1Items) phase1Counts.set(a.reviewerId, (phase1Counts.get(a.reviewerId) ?? 0) + 1)
  const upperL = Math.max(1, ...reviewers.map((r) => phase1Counts.get(r.id) ?? 0))
  let lo = Math.max(1, Math.ceil(totalRequired / R))
  let hi = upperL

  while (lo < hi) {
    const mid = (lo + hi) >> 1
    const r = runPhase(papers, reviewers, eligible, organizations, demands, totalRequired, mid, forced, diversity)
    if (r.feasible && r.matches === bestMatches) {
      hi = mid
      bestRaw = r.raw
    } else {
      lo = mid + 1
    }
  }

  const assignments = parseSolution(papers, reviewers, eligible, bestRaw, forced)
  if (assignments.length !== totalRequired) {
    return isDiverse ? null : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced)
  }
  // 防御性校验：求解结果必须完整包含全部预指派
  for (const key of forced.forcedKeys) {
    const [i, j] = key.split('_').map(Number)
    if (!assignments.some((a) => a.paperId === papers[i].id && a.reviewerId === reviewers[j].id)) {
      return isDiverse ? null : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced)
    }
  }
  // 防御性校验：同一篇稿件不得出现同一机构两人（机构去重硬约束，空机构除外）
  if (hasDuplicateOrganization(papers, reviewers, assignments)) {
    return isDiverse ? null : greedyFallback(papers, reviewers, eligible, organizations, demands, totalRequired, forced)
  }
  return buildSuccess(reviewers, assignments, totalRequired)
}

/** 结果层机构去重复核：同一稿件出现两个去空白后相同的非空机构评审人即视为违规 */
function hasDuplicateOrganization(papers: Paper[], reviewers: Reviewer[], assignments: AssignmentItem[]): boolean {
  const orgOf = new Map(reviewers.map((r) => [r.id, r.organization]))
  const byPaper = new Map<string, Set<string>>()
  for (const a of assignments) {
    const org = (orgOf.get(a.reviewerId) ?? '').trim()
    if (!org) continue
    const set = byPaper.get(a.paperId) ?? new Set<string>()
    if (set.has(org)) return true
    set.add(org)
    byPaper.set(a.paperId, set)
  }
  void papers
  return false
}

/** 求解器异常时的兜底：先放入全部预指派，再按主题匹配优先、当前负载最低贪心选取（最大流已保证存在可行解） */
function greedyFallback(
  papers: Paper[],
  reviewers: Reviewer[],
  eligible: boolean[][],
  organizations: string[],
  demands: number[],
  totalRequired: number,
  forced: ForcedMatrix
): AssignmentSuccess {
  const assigned = new Map<string, number>(reviewers.map((r) => [r.id, 0]))
  const assignments: AssignmentItem[] = []
  const placed = new Set<string>()
  // 每篇稿件已占住的非空机构（预指派先行占位，自由选取不得再选同机构者）
  const usedOrgsByPaper = papers.map(() => new Set<string>())

  // 预指派先无条件占位（预检已保证其不冲突、不超额、无同稿重复机构）
  for (let i = 0; i < papers.length; i++) {
    for (const j of forced.forcedByPaperIndex[i]) {
      const matched = matchedTagsOf(papers[i], reviewers[j])
      assignments.push({
        paperId: papers[i].id,
        reviewerId: reviewers[j].id,
        topicMatched: matched.length > 0,
        matchedTags: matched,
        preassigned: true
      })
      assigned.set(reviewers[j].id, (assigned.get(reviewers[j].id) ?? 0) + 1)
      placed.add(`${i}_${j}`)
      if (organizations[j]) usedOrgsByPaper[i].add(organizations[j])
    }
  }

  const ordered = [...papers].sort((a, b) => b.reviewsRequired - a.reviewsRequired)
  for (const paper of ordered) {
    const i = papers.indexOf(paper)
    const need = demands[i] - forced.forcedByPaperIndex[i].size
    const choices = reviewers
      .map((r, j) => ({ r, j, matched: matchedTagsOf(paper, r) }))
      // 机构去重：与该稿件已占位（含预指派）评审人同机构者跳过；空机构不限制
      .filter(({ j }) => eligible[i][j] && !placed.has(`${i}_${j}`) && !(organizations[j] && usedOrgsByPaper[i].has(organizations[j])))
      .sort((a, b) => {
        if ((a.matched.length > 0 ? 1 : 0) !== (b.matched.length > 0 ? 1 : 0)) return b.matched.length - a.matched.length
        return (assigned.get(a.r.id) ?? 0) - (assigned.get(b.r.id) ?? 0)
      })
    for (let k = 0; k < need; k++) {
      const pick = choices[k]
      if (!pick) break
      assigned.set(pick.r.id, (assigned.get(pick.r.id) ?? 0) + 1)
      placed.add(`${i}_${pick.j}`)
      if (organizations[pick.j]) usedOrgsByPaper[i].add(organizations[pick.j])
      assignments.push({
        paperId: paper.id,
        reviewerId: pick.r.id,
        topicMatched: pick.matched.length > 0,
        matchedTags: pick.matched
      })
    }
  }

  return buildSuccess(reviewers, assignments, totalRequired)
}
