// manage_project 的 templates / repos / channels / create / bind / unbind 返回给 AI 的文字：纯函数，便于单测。

import {
  PROJECT_REPOS_MAX,
  type AiProjectCreateResult,
  type ProjectBindingChoice,
  type ProjectBindingOutcome,
  type ProjectBindResult,
  type ProjectChannelOption,
  type ProjectRepoOption,
  type ProjectTemplateInfo,
  type ProjectUnbindResult,
} from "./project-app-types.js"
import type { ProjectChatMode } from "./project-types.js"
import { WORK_BRANCH_MODES } from "./work-branch-mode.js"

/** 每种接入方式是什么意思：channels 的返回、create / bind 缺少 bindings 时的提示都用这一份 */
const MODE_EXPLAIN: Record<ProjectChatMode, string> = {
  inline: "inline=接这个通道的主聊天（飞书、微信是主用户私聊，应用内是应用内对话），不建群",
  group: "group=新建飞书独立群「📦 项目名」，主用户是群主并被拉进群，之后在群里协作",
  bind: "bind=绑定一个已有的飞书群（还要给 group_chat_id：oc_ 开头，机器人要已经在群里）",
}

/** MCP 里 bindings 参数的形状（snake_case）→ 宿主认的接入点。不判断对错，由宿主的规则校验并给出带原因的报错 */
export function parseAiBindings(
  raw: readonly { channel_id?: string; mode?: string; group_chat_id?: string }[] | undefined,
): ProjectBindingChoice[] {
  return (raw ?? []).map((b) => ({
    channelId: String(b?.channel_id ?? "").trim(),
    mode: String(b?.mode ?? "").trim() as ProjectChatMode,
    ...(b?.group_chat_id?.trim() ? { groupChatId: b.group_chat_id.trim() } : {}),
  }))
}

/** channels 的返回：当前在哪个通道，能把项目接到哪些通道、各自能用什么方式 */
export function formatChannels(current: string, channels: readonly ProjectChannelOption[]): string {
  if (!channels.length) return "📭 没有可以接入项目的消息通道"
  const here = channels.find((c) => c.id === current)
  const lines = [
    here ? `你现在在「${here.name}」通道（channel_id=${here.id}）。` : "",
    channels.length === 1
      ? "项目只能接到你当前所在的这个通道（其它通道的接入要在应用内对话里操作）。"
      : "你在应用内对话里，可以把项目接到下面任何通道；一个项目可以同时接多个通道，每个通道各自一条独立会话，互不合并。",
    "create / bind 的 bindings 每一项是 {channel_id, mode, group_chat_id?}，mode 的含义：",
    ...(["inline", "group", "bind"] as const).map((m) => `- ${MODE_EXPLAIN[m]}`),
    "",
    `共 ${channels.length} 个通道：`,
  ]
  channels.forEach((c, i) => {
    const modes = c.modes.length ? c.modes.join(" / ") : "暂时都不能选"
    lines.push(`#${i + 1} ${c.name}｜channel_id=${c.id}｜${CHANNEL_TYPE_LABEL[c.type] ?? c.type}${c.current ? "｜当前所在" : ""}｜能用：${modes}`)
    if (c.note) lines.push(`   ⚠️ ${c.note}`)
  })
  lines.push("", "没有默认值：用户没说清楚项目要放到哪些通道、用哪种方式，就先问他（send_question），确认内容里写明每个通道选了什么。")
  return lines.filter((l, i) => l !== "" || i > 0).join("\n")
}

const CHANNEL_TYPE_LABEL: Record<string, string> = { feishu: "飞书", wechat: "微信", app: "应用内对话" }

const BRANCH_LABEL: Record<string, string> = Object.fromEntries(WORK_BRANCH_MODES.map((m) => [m.value, m.label]))

export function formatTemplates(list: readonly ProjectTemplateInfo[]): string {
  if (!list.length) return "📭 没有可用的项目模板（可以用 template_save 新建一个；先和用户商量清楚）"
  const lines = [`共 ${list.length} 个项目模板（create 的 template_id 填 id；看某个模板的详情或要改它，用 templates + template_id）：`]
  list.forEach((t, i) => {
    lines.push("")
    lines.push(`#${i + 1} id=${t.id}「${t.name}」${t.description ? `— ${t.description}` : ""}`)
    if (t.steps?.length) lines.push(`   快捷操作：${t.steps.map((s) => s.label).join("、")}`)
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
    return "📭 还没有常用代码仓库。create 的 repos 里可以直接填本地 git 仓库的根目录（绝对路径）或远程地址，并给出基线分支；想先登记下来以后直接选，用 repo_save。"
  }
  const lines = [
    `共 ${list.length} 个常用代码仓库。create 的 repos 里 repo_path 用下面的路径，base_branch 用它的基线分支（用户另有要求时按用户的）；也可以填没列在这里的本地 git 仓库根目录或远程地址（改或加用 repo_save，移除用 repo_remove）：`,
  ]
  list.forEach((r, i) => {
    const extra = [r.testBranch ? `测试分支 ${r.testBranch}` : "", r.developBranch ? `开发分支 ${r.developBranch}` : ""].filter(Boolean).join("，")
    lines.push(`#${i + 1} ${r.name}｜${r.path}｜基线分支 ${r.baseBranch || "（未配置，需要问用户）"}${extra ? `｜${extra}` : ""}｜${r.clone ? "建项时克隆一份副本" : "不克隆，只记录仓库信息"}`)
  })
  return lines.join("\n")
}

/** 一个接入点最后的样子，一行说清（没接成的带原因） */
export function formatBindingOutcome(o: ProjectBindingOutcome): string {
  if (!o.ok) return `⚠️「${o.channelName}」${o.warning ?? "没接成"}`
  if (o.mode === "group") {
    return `✅「${o.channelName}」新建了飞书独立群「${o.groupName ?? ""}」，用户是群主并已被拉入群，群里已发项目卡片；群里的项目只能在群里进入和推进`
  }
  if (o.mode === "bind") {
    return `✅「${o.channelName}」绑定了飞书群 ${o.groupChatId ?? ""}，已向群里发项目卡片（机器人不在群里的话发不进去，请提醒用户确认机器人已经在群里）；群里的项目只能在群里进入和推进`
  }
  if (o.channelType === "app") {
    return `✅「${o.channelName}」接入了应用内对话：用户需要时在应用里的项目列表点开项目进入`
  }
  return `✅「${o.channelName}」接了主聊天（不建群）：需要时在那里进入——应用里在项目列表点开，飞书 / 微信里发 /p use <项目 ID>`
}

export function formatCreated(r: Extract<AiProjectCreateResult, { ok: true }>): string {
  const lines = [
    `✅ 已创建项目「${r.name}」`,
    `项目 ID：${r.projectId}`,
    r.templateName ? `模板：${r.templateName}` : "",
    `项目目录：${r.dir}`,
  ]
  if (r.warning) lines.push(`⚠️ ${r.warning}`)
  lines.push("项目接入的聊天（每个通道各自一条独立会话）：")
  for (const o of r.bindings) lines.push(`- ${formatBindingOutcome(o)}`)
  lines.push("没有进入项目会话，当前对话不受影响。")
  return lines.filter(Boolean).join("\n")
}

export function formatBound(r: Extract<ProjectBindResult, { ok: true }>): string {
  const lines = [`✅ 项目「${r.name}」（${r.projectId}）的接入已更新：`]
  for (const o of r.bindings) lines.push(`- ${formatBindingOutcome(o)}`)
  if (r.warning) lines.push(`⚠️ ${r.warning}`)
  return lines.join("\n")
}

export function formatUnbound(r: Extract<ProjectUnbindResult, { ok: true }>): string {
  const lines = [`✅ 项目「${r.name}」（${r.projectId}）已取消接入：${r.removed}；那条会话已一并清理。`]
  if (r.note) lines.push(r.note)
  return lines.join("\n")
}
