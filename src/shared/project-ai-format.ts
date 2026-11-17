// manage_project 的 templates / repos / create 返回给 AI 的文字：纯函数，便于单测。

import { PROJECT_REPOS_MAX, type AiChatChoice, type AiProjectCreateResult, type ProjectRepoOption, type ProjectTemplateInfo } from "./project-app-types.js"
import { WORK_BRANCH_MODES } from "./work-branch-mode.js"

/** create 没给 chat_mode（或给错）时带回给 AI 的话：让它拿不准就去问用户，不要替用户选 */
export const AI_CHAT_MODE_HINT = [
  "create 必须指定 chat_mode，没有默认值。用户没说清楚就先问他（send_question），不要替他选：",
  "- group：建飞书独立群「📦 项目名」，用户是群主并被拉入群，之后在群里协作（只有飞书私聊能用）",
  "- bind：绑定一个已有的飞书群，还要给 existing_group_chat_id（oc_ 开头，机器人要已经在群里）（只有飞书私聊能用）",
  "- inline：不建群，项目绑在当前聊天上（应用内对话、微信只能选这个）",
].join("\n")

/** manage_project create 的 chat_mode / existing_group_chat_id → 校验后的选择。必填：不给就报错，不猜默认值 */
export function parseAiChatChoice(
  mode: unknown,
  existingGroupChatId: unknown,
): { ok: true; choice: AiChatChoice } | { ok: false; error: string } {
  const m = typeof mode === "string" ? mode.trim() : ""
  if (!m) return { ok: false, error: AI_CHAT_MODE_HINT }
  if (m === "inline" || m === "group") return { ok: true, choice: { mode: m } }
  if (m === "bind") {
    const id = typeof existingGroupChatId === "string" ? existingGroupChatId.trim() : ""
    if (!id) return { ok: false, error: "chat_mode=bind 还需要 existing_group_chat_id（要绑定的飞书群 chat_id，oc_ 开头）；不知道群号就问用户" }
    return { ok: true, choice: { mode: "bind", existingGroupChatId: id } }
  }
  return { ok: false, error: `chat_mode 只能是 group / bind / inline，收到「${m}」。\n${AI_CHAT_MODE_HINT}` }
}

const BRANCH_LABEL: Record<string, string> = Object.fromEntries(WORK_BRANCH_MODES.map((m) => [m.value, m.label]))

export function formatTemplates(list: readonly ProjectTemplateInfo[]): string {
  if (!list.length) return "📭 没有可用的项目模板（请用户先到设置里建一个）"
  const lines = [`共 ${list.length} 个项目模板（create 的 template_id 填 id）：`]
  list.forEach((t, i) => {
    lines.push("")
    lines.push(`#${i + 1} id=${t.id}「${t.name}」${t.description ? `— ${t.description}` : ""}`)
    if (t.fields.length) {
      const fields = t.fields.map((f) => {
        const hint = f.placeholder?.trim()
        return `${f.label}（${f.required ? "必填" : "可选"}${hint ? `，例：${hint}` : ""}）`
      })
      lines.push(`   要填的信息（create 的 fields，键用括号前的名字）：${fields.join("、")}`)
    } else {
      lines.push("   要填的信息：无")
    }
    lines.push(
      t.needsRepo
        ? `   代码仓库：可以接（可选，最多 ${PROJECT_REPOS_MAX} 个），默认工作分支：${BRANCH_LABEL[t.workBranchMode] ?? t.workBranchMode}`
        : "   代码仓库：不接（可以用 folder 指定一个已有文件夹，不指定就在应用的项目目录下新建）",
    )
  })
  return lines.join("\n")
}

export function formatRepos(list: readonly ProjectRepoOption[]): string {
  if (!list.length) {
    return "📭 还没有常用代码仓库。create 的 repos 里可以直接填本地 git 仓库的根目录（绝对路径）或远程地址，并给出基线分支。"
  }
  const lines = [
    `共 ${list.length} 个常用代码仓库。create 的 repos 里 repo_path 用下面的路径，base_branch 用它的基线分支（用户另有要求时按用户的）；也可以填没列在这里的本地 git 仓库根目录或远程地址：`,
  ]
  list.forEach((r, i) => {
    lines.push(`#${i + 1} ${r.name}｜${r.path}｜基线分支 ${r.baseBranch || "（未配置，需要问用户）"}｜${r.clone ? "建项时克隆一份副本" : "不克隆，只记录仓库信息"}`)
  })
  return lines.join("\n")
}

export function formatCreated(r: Extract<AiProjectCreateResult, { ok: true }>): string {
  const lines = [
    `✅ 已创建项目「${r.name}」`,
    `项目 ID：${r.projectId}`,
    r.templateName ? `模板：${r.templateName}` : "",
    `项目目录：${r.dir}`,
  ]
  if (r.warning) lines.push(`⚠️ ${r.warning}`)
  if (r.chatMode === "group") {
    lines.push(
      `已建飞书独立群「${r.groupName ?? ""}」，用户是群主并已被拉入群，已向群里发出项目卡片。`,
      "没有进入项目会话，当前对话不受影响。群绑定的项目只能在群里进入和推进（私聊里 /p use 会被拒）：请告诉用户到这个群里协作。",
    )
  } else if (r.chatMode === "bind") {
    lines.push(
      `已绑定飞书群 ${r.groupChatId ?? ""}，已向群里发出项目卡片（机器人不在群里的话发不进去）。请提醒用户确认机器人已经在群里，否则群里收发不了消息。`,
      "没有进入项目会话，当前对话不受影响。群绑定的项目只能在群里进入和推进（私聊里 /p use 会被拒）：请告诉用户到这个群里协作。",
    )
  } else {
    lines.push("没有建群：项目绑在当前聊天上，没有进入项目会话，当前对话不受影响。请把项目 ID 告诉用户，他需要时自己进入：应用里在项目列表点开，飞书/微信里发 /p use <项目 ID>。")
  }
  return lines.filter(Boolean).join("\n")
}
