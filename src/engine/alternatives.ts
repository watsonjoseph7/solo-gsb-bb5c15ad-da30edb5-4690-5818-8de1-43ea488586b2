/**
 * 备选方案（多方案）生成。
 *
 * 在现有“生成分派”的硬约束与字典序目标之上增加一个“多样性”维度：
 *  - 方案 0（首方案）与单方案模式完全一致：先最大化主题匹配数，再最小化最大负载；
 *  - 后续每个方案仍必须满足全部硬约束（预指派 / 利益冲突 / 容量 / 人数 / 机构去重），
 *    并与已生成的**每个**方案至少有 N 条不同的稿件—评审人关系；
 *  - 差异以两个方案分派边集合的**对称差**计：|A\\B| + |B\\A|（恒为偶数，
 *    因此 N 为奇数时实际门槛是不小于 N 的最小偶数）。预指派边在所有方案中恒相同，
 *    差异只能来自自由名额；
 *  - 多样性作为 ILP 行约束加入，后续方案在该约束下仍按“先匹配、后均衡”求字典序最优；
 *  - 无法凑满请求数量时保留已找到方案，并在 stopReason 说明停止原因。
 */
import {
  edgeSetOfSuccess,
  evaluateHardConstraints,
  optimizeWithDiversity,
  type DiversityConstraint
} from './solver'
import type {
  AppData,
  AssignmentFailure,
  AssignmentPlan,
  AssignmentSuccess,
  PlanDifference,
  PlanSetResult,
  PlanSetSuccess
} from '../types'

/** 用户一次“生成分派”请求的方案数量范围（1 为默认单方案行为） */
export const MIN_PLAN_COUNT = 1
export const MAX_PLAN_COUNT = 3

/** 校验后的生成请求 */
export interface AlternativesRequest {
  /** 期望方案数量（1～3） */
  count: number
  /** 最小差异 N（方案间对称差下界；count=1 时缺省为 0） */
  minDifference: number
}

/**
 * 校验用户输入的方案数量与差异 N。
 * count 非法时抛错（界面侧也会拦截，这里是引擎侧的权威校验）；
 * 返回归一化后的请求（count=1 时 N 归零）。
 */
export function validateAlternativesRequest(countRaw: number, minDifferenceRaw: number): AlternativesRequest {
  const count = Math.floor(Number(countRaw))
  if (!Number.isFinite(count) || count < MIN_PLAN_COUNT || count > MAX_PLAN_COUNT) {
    throw new Error(`方案数量必须是 ${MIN_PLAN_COUNT}～${MAX_PLAN_COUNT} 之间的整数。`)
  }
  if (count === 1) return { count, minDifference: 0 }
  const n = Math.floor(Number(minDifferenceRaw))
  if (!Number.isFinite(n) || n < 1) {
    throw new Error('备选方案的最小差异 N 必须是不小于 1 的整数。')
  }
  return { count, minDifference: n }
}

/**
 * 当前数据下差异 N 的理论上限：可改变的只有自由名额（预指派边恒定），
 * 对称差最大为 2 ×（总名额 − 预指派条数）。供界面即时校验输入。
 * 数据未通过硬约束评估时返回 null。
 */
export function maxPossibleDifference(data: AppData): number | null {
  const hc = evaluateHardConstraints(data)
  if (!hc.feasible) return null
  const freeSlots = hc.totalRequired - hc.forced.forcedKeys.size
  return 2 * Math.max(0, freeSlots)
}

/** 两方案分派边集合的对称差与交集大小 */
export function differenceBetween(a: Set<string>, b: Set<string>): { symmetricDifference: number; common: number } {
  let common = 0
  for (const e of a) if (b.has(e)) common++
  return { symmetricDifference: a.size + b.size - 2 * common, common }
}

/** 为一组方案补齐两两差异统计（每个方案都列出对其余所有方案的差异，顺序按方案序号） */
export function buildPlanDifferences(edgeSets: Set<string>[]): PlanDifference[][] {
  return edgeSets.map((edges, i) => {
    const diffs: PlanDifference[] = []
    edgeSets.forEach((other, j) => {
      if (i === j) return
      const { symmetricDifference, common } = differenceBetween(edges, other)
      diffs.push({ otherPlanIndex: j, symmetricDifference, common })
    })
    return diffs
  })
}

/** 依据当前（可能已被人工互换调整过的）方案列表重算两两差异统计；差异全部以最新分派为准 */
export function recomputePlanDifferences(plans: AssignmentPlan[]): PlanDifference[][] {
  const keyOf = (p: AssignmentPlan) => new Set(p.assignments.map((a) => `${a.paperId}|${a.reviewerId}`))
  const sets = plans.map(keyOf)
  return sets.map((edges, i) => {
    const diffs: PlanDifference[] = []
    sets.forEach((other, j) => {
      if (i === j) return
      const { symmetricDifference, common } = differenceBetween(edges, other)
      diffs.push({ otherPlanIndex: j, symmetricDifference, common })
    })
    return diffs
  })
}

/** 把单方案成功结果包装成只有一个方案的方案集（保持默认单方案行为与导出兼容） */
export function singlePlanSet(result: AssignmentSuccess): PlanSetSuccess {
  return { feasible: true, requestedCount: 1, minDifference: 0, plans: [{ ...result, planIndex: 0, differences: [] }] }
}

/**
 * 备选方案生成主入口。
 *
 * 硬约束不可行时直接返回 {@link AssignmentFailure}（与单方案模式同样的逐条诊断，
 * 不产生任何部分结果）；可行时依次求出 count 个方案，凑不满则保留已找到方案并附停止原因。
 */
export function solveAlternatives(rawData: AppData, request: AlternativesRequest): PlanSetResult {
  const { count, minDifference } = request
  const hc = evaluateHardConstraints(rawData)
  if (!hc.feasible) {
    const failure: AssignmentFailure = { feasible: false, reasons: hc.reasons }
    return failure
  }

  const freeSlots = hc.totalRequired - hc.forced.forcedKeys.size
  const maxDiff = 2 * Math.max(0, freeSlots)

  // 首方案：与现有单方案流程完全相同的字典序最优
  const first = optimizeWithDiversity(hc, [])
  if (!first) {
    // 理论上最大流已保证可行；求解器异常时无法给出任何方案
    const failure: AssignmentFailure = {
      feasible: false,
      reasons: [{ kind: 'global-capacity', message: '整数规划求解器未能在当前数据上求出可行方案，请重试或调整录入数据。' }]
    }
    return failure
  }

  const results: AssignmentSuccess[] = [first]
  const edgeSets: Set<string>[] = [edgeSetOfSuccess(hc, first)]

  // 数量门槛之外的结构性不可行：自由名额为 0（全部名额被预指派占住）时所有方案必然相同
  if (count > 1) {
    if (freeSlots <= 0) {
      return finishWith(results, edgeSets, count, minDifference, [
        `全部 ${hc.totalRequired} 个名额都由预指派硬约束固定，没有可调整的自由名额，任何可行方案都完全相同，无法生成与首方案不同的备选方案。`
      ])
    }
    if (minDifference > maxDiff) {
      return finishWith(results, edgeSets, count, minDifference, [
        `最小差异 N=${minDifference} 超过可达到的上限 ${maxDiff}：全部 ${hc.totalRequired} 个名额中有 ${hc.forced.forcedKeys.size} 个被预指派固定，最多只有 ${freeSlots} 条自由关系可改变（对称差最大为 2×${freeSlots}=${maxDiff}）。请调小 N 后重试。`
      ])
    }
  }

  const stopNotes: string[] = []

  // 后续方案：对“已生成的每个方案”各加一条对称差 ≥ N 的 ILP 行约束
  for (let k = 1; k < count; k++) {
    const diversity: DiversityConstraint[] = edgeSets.map((priorEdges) => ({ priorEdges: new Set(priorEdges), minDifference }))
    const candidate = optimizeWithDiversity(hc, diversity)

    if (!candidate) {
      // 不存在同时满足全部硬约束与全部差异门槛的方案
      const which = k === 1 ? '第 2 个方案' : `第 ${k + 1} 个方案`
      stopNotes.push(
        `未能生成${which}：在满足全部硬约束的前提下，不存在与已生成的 ${k} 个方案都至少相差 ${minDifference} 条稿件—评审人关系的方案。` +
          `已保留找到的 ${k} 个方案（差异以对称差计，每替换一条分派记 2 条不同关系；N 为奇数时按不小于 N 的最小偶数生效）。`
      )
      break
    }

    // 求解器层面的防御性复核：候选与每个已生成方案的差异确实达到门槛
    const candidateEdges = edgeSetOfSuccess(hc, candidate)
    const violated = edgeSets.findIndex((prior) => differenceBetween(candidateEdges, prior).symmetricDifference < minDifference)
    if (violated >= 0) {
      stopNotes.push(
        `求解器返回的第 ${k + 1} 个方案未通过差异复核（与方案 ${violated + 1} 的差异不足 ${minDifference} 条），已停止生成并保留此前 ${k} 个方案。`
      )
      break
    }

    results.push(candidate)
    edgeSets.push(candidateEdges)
  }

  return finishWith(results, edgeSets, count, minDifference, stopNotes)
}

function finishWith(
  results: AssignmentSuccess[],
  edgeSets: Set<string>[],
  requestedCount: number,
  minDifference: number,
  stopNotes: string[]
): PlanSetSuccess {
  const diffs = buildPlanDifferences(edgeSets)
  const plans: AssignmentPlan[] = results.map((r, i) => ({ ...r, planIndex: i, differences: diffs[i] }))
  const success: PlanSetSuccess = {
    feasible: true,
    requestedCount,
    minDifference,
    plans
  }
  if (plans.length < requestedCount && stopNotes.length > 0) {
    success.stopReason = stopNotes.join('\n')
  }
  return success
}
