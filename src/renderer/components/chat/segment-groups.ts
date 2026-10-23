import type { AppChatSegment, AppChatTool } from "../../../shared/app-chat-types"

/** 参与折叠的分段：思考和工具调用 */
export type ProcessSegment = Extract<AppChatSegment, { type: "thinking" | "tools" }>

export type SegmentBlock =
  | { kind: "single"; index: number; seg: AppChatSegment }
  /** 连续的多个思考/工具分段；segs[j] 对应原数组下标 start + j */
  | { kind: "group"; start: number; segs: ProcessSegment[] }

/** 连续的思考/工具分段至少这么多才折成一组；单个分段保持原样 */
const MIN_GROUP_SIZE = 2

function isProcess(seg: AppChatSegment): seg is ProcessSegment {
  return seg.type === "thinking" || seg.type === "tools"
}

/** 把连续的思考/工具分段归成一组，其余分段（回复、任务清单）保持原位 */
export function groupSegments(segments: AppChatSegment[]): SegmentBlock[] {
  const blocks: SegmentBlock[] = []
  let i = 0
  while (i < segments.length) {
    const seg = segments[i]
    if (!isProcess(seg)) {
      blocks.push({ kind: "single", index: i, seg })
      i++
      continue
    }
    const run: ProcessSegment[] = []
    for (let j = i; j < segments.length; j++) {
      const s = segments[j]
      if (!isProcess(s)) break
      run.push(s)
    }
    if (run.length >= MIN_GROUP_SIZE) {
      blocks.push({ kind: "group", start: i, segs: run })
    } else {
      run.forEach((s, j) => blocks.push({ kind: "single", index: i + j, seg: s }))
    }
    i += run.length
  }
  return blocks
}

export interface GroupSummary {
  thinkings: number
  toolCalls: number
  failed: number
  /** 组内最后一次工具调用：折叠时展示的"最后一条具体的操作" */
  lastTool?: AppChatTool
  /** 组内最后一段思考的耗时；组里没有任何工具调用时用它兜底 */
  lastThinkingMs?: number
  /** 组内最后一个分段是思考（回合进行中意味着"正在思考"） */
  endsWithThinking: boolean
}

export function summarizeGroup(segs: ProcessSegment[]): GroupSummary {
  const summary: GroupSummary = { thinkings: 0, toolCalls: 0, failed: 0, endsWithThinking: false }
  for (const seg of segs) {
    if (seg.type === "thinking") {
      summary.thinkings++
      summary.lastThinkingMs = seg.ms
      continue
    }
    for (const tool of seg.tools) {
      summary.toolCalls++
      if (tool.status === "error") summary.failed++
      summary.lastTool = tool
    }
  }
  summary.endsWithThinking = segs.length > 0 && segs[segs.length - 1].type === "thinking"
  return summary
}
