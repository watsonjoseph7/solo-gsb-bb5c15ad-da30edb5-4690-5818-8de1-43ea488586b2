import type { AppData, AssignmentSuccess, StressTestReport } from './types'

export interface ExportPayload {
  exportedAt: string
  /** 结果是否经过「分派互换」人工调整（未调整时缺省为 false） */
  manuallyAdjusted: boolean
  /** 累计执行的一换一互换次数 */
  swapCount: number
  summary: AssignmentSuccess['objective']
  assignments: Array<{
    paperId: string
    paperTitle: string
    reviewerId: string
    reviewerName: string
    /** 评审人机构（去首尾空白；空串表示无机构） */
    reviewerOrganization: string
    topicMatched: boolean
    matchedTags: string[]
    /** 是否来自预指派硬约束（非预指派缺省为 false） */
    preassigned: boolean
  }>
  reviewerLoads: Array<{
    reviewerId: string
    reviewerName: string
    /** 评审人机构（去首尾空白；空串表示无机构） */
    reviewerOrganization: string
    assigned: number
    capacity: number
    utilization: number
  }>
}

export function buildExportPayload(data: AppData, result: AssignmentSuccess): ExportPayload {
  const paperMap = new Map(data.papers.map((p) => [p.id, p]))
  const reviewerMap = new Map(data.reviewers.map((r) => [r.id, r]))
  return {
    exportedAt: new Date().toISOString(),
    manuallyAdjusted: result.manuallyAdjusted === true,
    swapCount: result.swapCount ?? 0,
    summary: result.objective,
    assignments: result.assignments.map((a) => ({
      paperId: a.paperId,
      paperTitle: paperMap.get(a.paperId)?.title ?? a.paperId,
      reviewerId: a.reviewerId,
      reviewerName: reviewerMap.get(a.reviewerId)?.name ?? a.reviewerId,
      reviewerOrganization: (reviewerMap.get(a.reviewerId)?.organization ?? '').trim(),
      topicMatched: a.topicMatched,
      matchedTags: a.matchedTags,
      preassigned: a.preassigned === true
    })),
    reviewerLoads: result.loads.map((l) => ({
      reviewerId: l.reviewerId,
      reviewerName: reviewerMap.get(l.reviewerId)?.name ?? l.reviewerId,
      reviewerOrganization: (reviewerMap.get(l.reviewerId)?.organization ?? '').trim(),
      assigned: l.assigned,
      capacity: l.capacity,
      utilization: l.capacity > 0 ? Number((l.assigned / l.capacity).toFixed(3)) : 0
    }))
  }
}

/* ------------------------- 缺席压力测试报告导出 ------------------------- */

export interface StressExportPayload {
  exportedAt: string
  kind: 'reviewer-absence-stress-test'
  summary: {
    testedReviewerCount: number
    totalRequired: number
    totalCapacity: number
    feasibleCount: number
    infeasibleCount: number
  }
  scenarios: Array<{
    reviewerId: string
    reviewerName: string
    capacity: number
    feasible: boolean
    message: string
    deficit?: number
    globalDeficit?: number
    remainingCapacity?: number
    affectedPapers?: Array<{
      paperId: string
      paperTitle: string
      required: number
      available: number
      shortfall: number
    }>
    bottleneckReviewers?: Array<{
      reviewerId: string
      reviewerName: string
      /** 评审人机构（去首尾空白；空串表示无机构） */
      reviewerOrganization: string
      capacity: number
      eligiblePaperCount: number
      capacityForGroup: number
    }>
  }>
}

export function buildStressExportPayload(data: AppData, report: StressTestReport): StressExportPayload {
  const paperMap = new Map(data.papers.map((p) => [p.id, p]))
  const reviewerMap = new Map(data.reviewers.map((r) => [r.id, r]))
  return {
    exportedAt: new Date().toISOString(),
    kind: 'reviewer-absence-stress-test',
    summary: {
      testedReviewerCount: report.testedReviewerCount,
      totalRequired: report.totalRequired,
      totalCapacity: report.totalCapacity,
      feasibleCount: report.feasibleCount,
      infeasibleCount: report.infeasibleCount
    },
    scenarios: report.scenarios.map((s) => ({
      reviewerId: s.reviewerId,
      reviewerName: reviewerMap.get(s.reviewerId)?.name ?? s.reviewerId,
      capacity: s.capacity,
      feasible: s.feasible,
      message: s.message,
      deficit: s.deficit,
      globalDeficit: s.globalDeficit,
      remainingCapacity: s.remainingCapacity,
      affectedPapers: s.affectedPapers?.map((p) => ({
        paperId: p.paperId,
        paperTitle: paperMap.get(p.paperId)?.title ?? p.paperId,
        required: p.required,
        available: p.available,
        shortfall: p.shortfall
      })),
      bottleneckReviewers: s.bottleneckReviewers?.map((b) => ({
        reviewerId: b.reviewerId,
        reviewerName: reviewerMap.get(b.reviewerId)?.name ?? b.reviewerId,
        reviewerOrganization: (reviewerMap.get(b.reviewerId)?.organization ?? '').trim(),
        capacity: b.capacity,
        eligiblePaperCount: b.eligiblePaperCount,
        capacityForGroup: b.capacityForGroup
      }))
    }))
  }
}

export function downloadJson(payload: unknown, filename?: string): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  a.href = url
  a.download = filename ?? `blind-review-assignment-${stamp}.json`
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}
