// manage_project 的 settings / repo_save / template_save / get / update 等返回给 AI 的文字：纯函数，便于单测。
// 约定：密钥只出现打码后的样子；每条结果都说清「改了什么」和「接下来 AI 该干什么」。

import type { ProjectListItem } from "./project-app-types.js"
import { repoDisplayName } from "./project-app-types.js"
import { parseChatKey } from "./channel-types.js"
import type {
  ProjectSettingsView,
  RepoProfileLike,
  RepoSavePlan,
  TemplateDetail,
  TemplateSavePlan,
} from "./project-admin-plan.js"
import { WORK_BRANCH_MODES } from "./work-branch-mode.js"

const BRANCH_LABEL: Record<string, string> = Object.fromEntries(WORK_BRANCH_MODES.map((m) => [m.value, m.label]))

const GIT_MODE_LABEL: Record<ProjectSettingsView["gitPrinciplesMode"], string> = {
  default: "默认（内置，没改过）",
  custom: "已自定义",
  off: "已关闭（项目会话里不带）",
}

export function formatSettings(v: ProjectSettingsView): string {
  const lines = [
    "项目相关设置现状（要改用 settings_set；密钥只显示打码）：",
    `📁 项目存放位置：${v.worktreeRoot ? `${v.worktreeRoot}（自定义）` : `${v.effectiveRoot || "（默认位置）"}（默认位置，没改过）`}`,
    `📚 常用代码仓库：${v.repoCount} 个（repos 查看）`,
    `📋 项目模板：${v.templateCount} 个（templates 查看）；已有项目 ${v.projectCount} 个`,
    `🧭 Git 基本原则：${GIT_MODE_LABEL[v.gitPrinciplesMode]}`,
    ...(v.gitPrinciples ? ["正文：", ...v.gitPrinciples.split("\n").map((l) => `  ${l}`)] : []),
    `🔑 GitLab Token：${v.gitlabTokenMasked}｜GitLab 地址：${v.gitlabHost || "（默认从仓库 origin 推断）"}`,
    "   （可选：只在用「共享空间」时用；不影响建项目、改代码、推分支）",
    `🤝 共享空间（可选）：地址 ${v.flowHubUrl || "（未设置）"}｜Token ${v.flowHubTokenMasked}｜署名 ${v.flowHubAuthor || "（未设置）"}`,
  ]
  return lines.join("\n")
}

/** help 末尾附的「当前状态」：让 AI 一眼看出用户还缺什么、该先帮他配什么 */
export function formatSetupChecklist(v: ProjectSettingsView): string {
  const lines = ["## 当前状态（据此判断用户还缺什么）"]
  lines.push(v.worktreeRoot
    ? `- 项目存放位置：已自定义为 ${v.worktreeRoot}`
    : `- 项目存放位置：用默认位置 ${v.effectiveRoot || "（应用数据目录下）"}。一般不用动；用户想放到别的盘 / 文件夹再改`)
  lines.push(v.repoCount > 0
    ? `- 常用代码仓库：${v.repoCount} 个，建研发 / 测试类项目时可以直接选（repos 查看）`
    : "- 常用代码仓库：还没有。用户要做研发 / 测试类项目前，先问他仓库在哪，帮他 repo_save 登记；不接仓库的项目（调研、文档、周报等）不需要")
  lines.push(`- 项目模板：${v.templateCount} 个（templates 查看）；已有项目 ${v.projectCount} 个`)
  lines.push(`- Git 基本原则：${GIT_MODE_LABEL[v.gitPrinciplesMode]}`)
  const sharing = v.gitlabTokenMasked !== "（未设置）" || v.flowHubUrl
  lines.push(sharing
    ? `- GitLab / 共享空间：已配置（GitLab Token ${v.gitlabTokenMasked}，共享空间地址 ${v.flowHubUrl || "未设置"}）`
    : "- GitLab / 共享空间：没配。可选，只有团队要共享项目模板时才需要，用户没提就不要主动让他配")
  return lines.join("\n")
}

function repoLine(p: RepoProfileLike): string {
  const extra = [p.testBranch ? `测试分支 ${p.testBranch}` : "", p.developBranch ? `开发分支 ${p.developBranch}` : ""].filter(Boolean).join("，")
  return `${repoDisplayName(p.path)}｜${p.path}｜基线分支 ${p.baseBranch}${extra ? `｜${extra}` : ""}｜${p.clone === false ? "不克隆，AI 直接用本机这份" : "建项时克隆一份副本"}`
}

export function formatRepoSaved(plan: Extract<RepoSavePlan, { ok: true }>, detectedBase?: string): string {
  const lines = [plan.created ? "✅ 已登记常用代码仓库：" : plan.changed.length ? "✅ 已更新常用代码仓库：" : "ℹ️ 这个仓库已经登记过，内容没有变化：", repoLine(plan.profile)]
  if (!plan.created && plan.changed.length) lines.push(`改动：${plan.changed.join("；")}`)
  if (plan.created && detectedBase && plan.profile.baseBranch === detectedBase) {
    lines.push(`基线分支「${detectedBase}」是自动识别的默认分支，请和用户确认是不是他要的（新分支从它切出）。`)
  }
  lines.push("建项目时 repos 里直接填这个路径即可。")
  return lines.join("\n")
}

export function formatRepoRemoved(p: RepoProfileLike): string {
  return [
    `✅ 已从常用代码仓库里移除：${repoDisplayName(p.path)}（${p.path}）`,
    "只是不再出现在常用列表里：磁盘上的仓库、已经建好的项目都不受影响，需要时可以再 repo_save 登记回来。",
  ].join("\n")
}

function promptPreview(text: string, max = 160): string {
  const one = text.replace(/\s+/g, " ").trim()
  return one.length <= max ? one : `${one.slice(0, max)}…（共 ${text.trim().length} 字）`
}

/** 模板详情；给了 actionId 就把这个快捷操作的完整提示词（自定义的，没有就是内置默认的）展开 */
export function formatTemplateDetail(d: TemplateDetail, actionId?: string): string {
  const lines = [
    `模板 id=${d.id}「${d.name}」${d.description ? `— ${d.description}` : ""}`,
    d.needsRepo ? `代码仓库：接（建项时可选；默认工作分支：${BRANCH_LABEL[d.workBranch] ?? d.workBranch}）` : "代码仓库：不接",
  ]
  if (d.fields.length) {
    lines.push(`建项时要填的信息：${d.fields.map((f) => `${f.label}（${f.required ? "必填" : "可选"}${f.multiline ? "，多行" : ""}${f.placeholder ? `，例：${f.placeholder}` : ""}）`).join("、")}`)
  } else {
    lines.push("建项时要填的信息：无")
  }
  if (d.usedByProjects > 0) lines.push(`有 ${d.usedByProjects} 个项目在用这个模板：改模板会立刻影响它们，也不能删这个模板。`)

  if (actionId) {
    const a = d.actions.find((x) => x.id === actionId)
    if (!a) return [...lines, `❌ 这个模板里没有 id 为「${actionId}」的快捷操作（有：${d.actions.map((x) => x.id).join("、")}）`].join("\n")
    lines.push("", `快捷操作 id=${a.id}「${a.label}」的提示词（${a.customPrompt ? "自定义" : a.defaultPrompt ? "内置默认，没自定义过" : "没写，运行时用「完成 XX 工作」"}）：`)
    lines.push(a.customPrompt ?? a.defaultPrompt ?? `完成 ${a.label} 工作`)
    return lines.join("\n")
  }

  lines.push(`快捷操作（${d.actions.length} 个；改提示词先用 action_id 看全文）：`)
  for (const a of d.actions) {
    const tag = a.customPrompt ? `自定义：${promptPreview(a.customPrompt)}` : a.defaultPrompt ? `内置默认提示词（${a.defaultPrompt.length} 字）` : "没写提示词"
    lines.push(`- id=${a.id}「${a.label}」｜${tag}`)
  }
  return lines.join("\n")
}

export function formatTemplateSaved(plan: Extract<TemplateSavePlan, { ok: true }>): string {
  const g = plan.group
  const lines = [
    `✅ 已${plan.created ? "新建" : "更新"}项目模板 id=${g.id}「${g.name}」`,
    `${(g.workspace ?? "worktree") === "worktree" ? "接代码仓库" : "不接代码仓库"}｜快捷操作 ${g.nodes.length} 个：${g.nodes.map((n) => `${n.label}(${n.id})`).join("、")}`,
  ]
  if (plan.addedActions.length && !plan.created) lines.push(`新增操作：${plan.addedActions.join("、")}`)
  if (plan.removedActions.length) lines.push(`删掉的操作：${plan.removedActions.join("、")}`)
  if (plan.created) lines.push("之后建项目时 template_id 填它的 id 就能选到。")
  else lines.push("改动立即对所有在用这个模板的项目生效。")
  return lines.join("\n")
}

/** 项目接入了哪些聊天入口；channelName 把通道 id 换成人看得懂的名字 */
export function formatBindingsLine(bindings: ProjectListItem["bindings"], channelName: (channelId: string) => string = (id) => id): string {
  if (!bindings.length) return "接入的消息通道：无（没有任何聊天能看到它，只有设置页里能管；要用先 bind 接到某个通道）"
  const parts = bindings.map((b) => {
    const name = channelName(b.channelId)
    if (b.kind === "group") return `「${name}」的专属群 ${b.chatKey ? parseChatKey(b.chatKey).chatId : ""}`.trim()
    return `「${name}」的主聊天`
  })
  return `接入的消息通道（各自一条独立会话，互不通消息）：${parts.join("；")}`
}

export function formatProjectDetail(p: ProjectListItem, channelName?: (channelId: string) => string): string {
  const lines = [
    `项目「${p.name}」id=${p.id}${p.archived ? "（已归档）" : ""}`,
    `目标：${p.goal || "（未填）"}`,
    `模板：${p.groupNames.join("、") || "（无）"}｜项目目录：${p.dir}${p.externalWorkspace ? "（用户自己选的文件夹）" : ""}`,
  ]
  if (p.storyUrl) lines.push(`项目链接：${p.storyUrl}`)
  if (p.relatedDocs) lines.push(`相关文档：${p.relatedDocs}`)
  if (p.productDocUrl) lines.push(`产品文档：${p.productDocUrl}`)
  if (p.techDocUrl) lines.push(`技术文档：${p.techDocUrl}`)
  lines.push(formatBindingsLine(p.bindings, channelName))
  const info = Object.entries(p.metadata ?? {})
  lines.push(info.length ? "项目信息：" : "项目信息：无")
  for (const [k, v] of info) lines.push(`  - ${k}：${v}`)
  lines.push(`快捷操作：${p.actions.map((a) => a.label).join("、") || "无"}`)
  return lines.join("\n")
}
