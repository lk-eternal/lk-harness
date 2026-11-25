/**
 * 宿主提示词里的「身份」和「能力」两块。
 *
 * 能力只写「有哪些组、什么时候用」，参数和用法在各 MCP 工具自己的说明里，只写那一份。
 * 哪些组出现，和工具的挂载共用同一组判定（harness-mcp-store 的 shouldMount*），挂了的会话一定被告知，没挂的不会被误导。
 */

import { shouldMountMemoryMcp, shouldMountScheduleMcp, type HarnessMcpEndpoint } from "./harness-mcp-store.js"
import { TASK_RESULT_TOOL } from "./task-delivery.js"

export interface CapabilityScope {
  endpoint: HarnessMcpEndpoint
  includeAdmin: boolean
  includeProject: boolean
  sessionKey?: string
}

export const IDENTITY_BLOCK = ["# 身份", "你是运行在 LK Harness 应用下的 AI 助手。"].join("\n")

const INTRO = "LK Harness 通过 MCP 提供下面几组工具。参数和用法以工具自带说明为准，第一次用某个工具前先看说明，不要凭印象猜参数。"

function group(title: string, body: string): string {
  return `## ${title}\n\n${body}`
}

/** 基础组：访客只有提问（发图片、发文件能把本机任意文件发出去，访客碰不得）；独立任务多一个交结果的工具 */
function baseGroup(endpoint: HarnessMcpEndpoint): string {
  const lines = ["- send_question：需要用户做选择时，发点选题。"]
  if (endpoint !== "visitor") {
    lines.push(
      "- send_image、send_file：把本机图片、文件发给用户。",
      "- render_branch_diff：生成分支对比页，再用 send_file 发给用户。",
    )
  }
  if (endpoint === "task") lines.push(`- ${TASK_RESULT_TOOL}：提交这次定时任务的结果，用法见「定时任务」一节。`)
  return group("基础（lk-harness）", lines.join("\n"))
}

export function buildCapabilityBlock(scope: CapabilityScope): string {
  const schedule = shouldMountScheduleMcp(scope)
  const groups = [baseGroup(scope.endpoint)]
  if (scope.includeAdmin) {
    groups.push(group(
      "应用自管理（lk-harness-admin）",
      `管理 LK Harness 自身：Agent、MCP、规则、Skill、全局定时任务、项目、工作目录。${schedule ? "给当前会话自己定时不用它，用 lk-harness-schedule。" : ""}`,
    ))
  }
  if (scope.includeProject) {
    groups.push(group("项目（lk-harness-project）", "查询、更新当前项目的资料和产物，按节点取完整提示词。"))
  }
  if (schedule) {
    groups.push(group("AI 自排程（lk-harness-schedule）", "给当前会话自己排定时任务：等 CI、定期检查、隔天复查。"))
  }
  if (shouldMountMemoryMcp(scope)) {
    groups.push(group(
      "会话记忆（lk-harness-memory）",
      "记录和读取当前会话的记忆。对话只保留最近约 15 轮，更早的内容会在会话滚动时丢掉，需要长期保留的结论、约束、没做完的事用记忆。"
        + "新起的会话首轮会在 `[本轮投递]` 的 `memory`（key → 内容）里带上你之前记的内容；它和用户最新说的冲突，以用户为准。",
    ))
  }
  return ["# 能力", INTRO, ...groups].join("\n\n")
}
