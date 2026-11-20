// ── 应用内（桌面端 / 手机端）项目：接口里传的数据形状 ─────────────────────────

import type { ChannelType } from "./channel-types.js"
import type { ProjectChatMode, ProjectFieldDef, WorkBranchMode } from "./project-types.js"

/**
 * 项目会话键 → 项目 id；不是项目会话返回 undefined。
 * 与 project-types 的 projectIdFromSessionKey 同一条规则，单独放这里是因为那边依赖 node:path，界面（桌面/手机）不能引。
 */
export function projectIdOfSessionKey(sessionKey: string): string | undefined {
  const idx = sessionKey.indexOf("::")
  if (idx < 0) return undefined
  const suffix = sessionKey.slice(idx + 2)
  if (!suffix.startsWith("project_")) return undefined
  return suffix.slice("project_".length) || undefined
}

/** 项目名称、目标、模板字段值的长度上限（界面和主进程校验用同一个数） */
export const PROJECT_NAME_MAX = 60
export const PROJECT_TEXT_MAX = 2000

/** 建项时可选的模板（来自流程组） */
export interface ProjectTemplateInfo {
  id: string
  name: string
  description: string
  fields: ProjectFieldDef[]
  /** 快捷操作（点一下把这件事交给 AI）。只是常用请求的入口，没有先后顺序，随时可以直接用自然语言说 */
  steps: { id: string; label: string }[]
  /** 接了代码仓库：建项时可以选仓库（选不选都行）和工作分支 */
  needsRepo: boolean
  /** 工作分支的默认值（建项对话框里预填，可以改）；不接仓库的模板用不上 */
  workBranchMode: WorkBranchMode
}

/**
 * 选模板界面里的顺序（桌面、手机共用）：「通用任务」是默认，放最前；其余保持原来的顺序（设置里怎么排就怎么排）。
 */
export function sortTemplatesForPicker<T extends Pick<ProjectTemplateInfo, "id">>(list: readonly T[]): T[] {
  const rank = (t: T) => (t.id === "general" ? 0 : 1)
  return list.map((t, i) => ({ t, i })).sort((a, b) => rank(a.t) - rank(b.t) || a.i - b.i).map((x) => x.t)
}

/** 一次最多接几个仓库 */
export const PROJECT_REPOS_MAX = 6

/** 建项时选的一个代码仓库：本地 git 根目录或远程地址，加上它的基线分支（新建分支从它切出；没配专门分支时的兜底） */
export interface ProjectRepoInput {
  repoPath: string
  baseBranch: string
}

/** 记住的常用仓库（建过项目的仓库会自动记下），建项时直接勾选 */
export interface ProjectRepoOption {
  path: string
  /** 显示名：目录名或仓库名 */
  name: string
  baseBranch: string
  /** 设置里配的测试 / 开发分支（只是信息，研发流程里用；没配就没有） */
  testBranch?: string
  developBranch?: string
  /** 建项时克隆一份到项目目录；false=不克隆，只把仓库信息记进项目（在设置的「常用代码仓库」里改） */
  clone: boolean
}

/** 桌面端「添加本地仓库」的检查结果：确认是 git 仓库根目录，给出默认基线分支和分支提示 */
export type InspectRepoResult =
  | { ok: true; path: string; name: string; baseBranch: string; branches: string[] }
  | { ok: false; error: string }

/** 远程仓库地址（http(s)/ssh/git@）而非本地路径；与主进程判断同一条规则，这里不依赖 node */
export function isRemoteRepoUrl(s: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@)/i.test((s ?? "").trim())
}

/** 仓库的显示名：路径或地址的最后一段，去掉 .git */
export function repoDisplayName(repoPath: string): string {
  const norm = (repoPath ?? "").trim().replace(/\\/g, "/").replace(/\/+$/, "")
  const last = norm.split(/[/:]/).pop() ?? ""
  return last.replace(/\.git$/i, "") || norm || "仓库"
}

/** 判断是不是同一个仓库用的键：去掉首尾空白、末尾斜杠和 .git，不分大小写（Windows 路径不分大小写） */
export function repoIdentityKey(repoPath: string): string {
  return (repoPath ?? "").trim().replace(/[\\/]+$/, "").replace(/\.git$/i, "").toLowerCase()
}

/**
 * 代码仓库表单的校验（桌面、手机共用；主进程会再校验一遍，这里只为早点给提示）。
 * 没问题返回空串，有问题返回一句人话。
 */
export function repoPicksProblem(picks: readonly ProjectRepoInput[]): string {
  // 仓库是可选的：一个都不选也能建项目
  if (picks.length > PROJECT_REPOS_MAX) return `最多接 ${PROJECT_REPOS_MAX} 个仓库`
  const seen = new Set<string>()
  for (const p of picks) {
    const name = repoDisplayName(p.repoPath)
    if (!p.baseBranch.trim()) return `请填写「${name}」的基线分支`
    const key = repoIdentityKey(p.repoPath)
    if (seen.has(key)) return `「${name}」选重了`
    seen.add(key)
  }
  return ""
}

export interface ProjectCreateInput {
  name: string
  goal?: string
  templateId: string
  /** 模板字段的值，键是字段名 */
  fields?: Record<string, string>
  /** 用已有文件夹当项目目录（只有桌面端能选）；不给就由应用在工作目录下新建。接代码仓库的模板不用它 */
  folder?: string
  /** 接代码仓库的模板可选：要接哪些仓库、各自的基线分支。克隆还是只记信息，由仓库自己的「克隆副本」设置决定 */
  repos?: ProjectRepoInput[]
  /** 克隆副本停在哪个分支；不给就用模板上的默认值 */
  workBranch?: WorkBranchMode
  /** 工作分支是「新建分支」时的分支名；不填按「feature/日期-项目名」生成 */
  featureBranch?: string
  /** 项目链接（需求、任务单、参考资料等入口） */
  storyUrl?: string
  /** 相关文档（链接或说明） */
  relatedDocs?: string
  /**
   * 项目接入哪些消息通道、用什么方式（可以多个）。不给 = 只接当前所在的应用内通道的主聊天（inline）。
   * 每个入口各有一条独立的项目会话，互不合并；没接入的通道看不到这个项目。
   */
  bindings?: ProjectBindingChoice[]
}

/**
 * 建项时选的一个接入点。inline=该通道的主聊天（应用内对话 / 主用户私聊，不建群）；
 * group=新建飞书独立群并把主用户拉进去；bind=绑定一个已有的飞书群（机器人要已经在群里）。
 */
export interface ProjectBindingChoice {
  channelId: string
  mode: ProjectChatMode
  /** bind 才有：飞书群的 chat_id（oc_…） */
  groupChatId?: string
}

/** 建项时能选的一个消息通道，以及在它上面能用哪几种接入方式 */
export interface ProjectChannelOption {
  id: string
  name: string
  type: ChannelType
  /** 你现在就在这个通道里 */
  current: boolean
  /** 在这个通道上能用的接入方式；空 = 暂时不能选，原因看 note */
  modes: ProjectChatMode[]
  /** 能用的方式受限、或暂时不能选的原因（没绑主用户、没记到飞书身份等） */
  note?: string
}

export interface ProjectCreateResult {
  ok: boolean
  error?: string
  /** 项目已经建好，但后续有件事没做成（比如进入会话失败）；界面照常切到项目并提示这句 */
  warning?: string
  projectId?: string
  /** 项目会话键：界面据此切到这个会话 */
  sessionKey?: string
}

/** 一个接入点最后实际的样子（建群 / 绑群没成功时，原因在 warning） */
export interface ProjectBindingOutcome {
  channelId: string
  channelName: string
  /** 通道类型：应用内对话里没有「建群」这回事，告诉 AI 的结果文案不同 */
  channelType: ChannelType
  /** 接成了没有（没成功的原因在 warning） */
  ok: boolean
  /** 要求的方式：inline=主聊天，group=新建的独立群，bind=绑定的已有群 */
  mode: ProjectChatMode
  /** group：群名 */
  groupName?: string
  /** group / bind：群的原始 chat_id */
  groupChatId?: string
  /** 这个接入点没按要求做成时的原因 */
  warning?: string
}

/** AI 建项（管理 MCP 的 manage_project create）的结果：建好就返回，不进入项目会话 */
export type AiProjectCreateResult =
  | {
      ok: true
      projectId: string
      name: string
      dir: string
      templateName: string
      /** 项目实际接入的聊天，逐个通道列出 */
      bindings: ProjectBindingOutcome[]
      /** 项目建好了，但有件事没做成（比如建群失败）；AI 必须如实告诉用户 */
      warning?: string
    }
  | { ok: false; error: string }

/** manage_project channels：调用者当前所在的通道，和他能把项目接到哪些通道 */
export type AiProjectChannelsResult =
  | { ok: true; current: string; channels: ProjectChannelOption[] }
  | { ok: false; error: string }

/** 给已有项目补接入（manage_project bind / 设置页项目详情）的结果 */
export type ProjectBindResult =
  | {
      ok: true
      projectId: string
      name: string
      /** 这次要求的每个接入点各自的结果（已经接着的会写在 warning 里，不重复接） */
      bindings: ProjectBindingOutcome[]
      warning?: string
    }
  | { ok: false; error: string }

/** 取消项目在某个通道上的接入（manage_project unbind / 设置页项目详情）的结果 */
export type ProjectUnbindResult =
  | { ok: true; projectId: string; name: string; removed: string; note?: string }
  | { ok: false; error: string }

/** 项目步骤条里的一项 */
export interface ProjectStepInfo {
  id: string
  label: string
  /** 所属模板名（多模板项目才有意义） */
  group: string
}

/** 项目信息面板要展示的内容 */
export interface ProjectView {
  id: string
  name: string
  goal: string
  /** 已归档：会话列表里收进最下面的「已归档」分组 */
  archived: boolean
  /** 项目信息里记了代码仓库（删除确认框要多说一句代码副本的去向）；叫 isCode 是沿用老名字 */
  isCode: boolean
  templateNames: string[]
  steps: ProjectStepInfo[]
  /** 项目信息（metadata）逐条展示 */
  info: { key: string; value: string }[]
  storyUrl?: string
  relatedDocs?: string
  /** 项目目录（用户可见的那个） */
  dir: string
  /** 目录是用户自己选的文件夹 */
  externalDir: boolean
  /** 最近一次登记的成果 */
  artifact?: { path: string; name: string; summary?: string; at?: number; exists: boolean }
  /**
   * 项目接入了当前这个通道：只有接入了的通道才能看到项目、推进项目；
   * 没接入的通道里（比如设置页里看别的通道的项目）步骤、删除都只读。
   */
  ownedHere: boolean
}

/**
 * 设置页「项目」里一个项目的完整资料（项目列表和详情用）。
 * fields / actions 取自项目实际在用的模板，详情页据此决定要展示哪些字段，不再写死。
 */
export interface ProjectListItem {
  id: string
  name: string
  goal: string
  storyUrl?: string
  relatedDocs?: string
  productDocUrl?: string
  techDocUrl?: string
  /** 已归档 */
  archived: boolean
  /** 项目实际在用的模板（没记模板的老项目已回落到默认模板） */
  groupId?: string
  groupIds: string[]
  groupNames: string[]
  /** 模板要用户填的信息（多模板合并，同名只留一个） */
  fields: ProjectFieldDef[]
  /** 项目里的快捷操作 */
  actions: { id: string; label: string }[]
  externalWorkspace: boolean
  /** 项目信息里记了代码仓库；叫 isCode 是沿用老名字 */
  isCode: boolean
  /** 项目目录（用户看得到的那个） */
  dir: string
  worktreePath?: string
  /** 项目信息（含「代码仓库」几行）；仓库、分支都在这里，改它就是改项目信息 */
  metadata: Record<string, string>
  /** 项目接入的聊天入口（通道的主聊天、专属群）；一个都没有的项目只在设置页里看得到 */
  bindings: ProjectBindingItem[]
}

/** 项目接入的一个聊天入口，设置页展示用（通道名由界面按 channelId 查） */
export interface ProjectBindingItem {
  kind: "main" | "group"
  channelId: string
  /** group 才有：群的聊天键（ch_xxx|oc_yyy） */
  chatKey?: string
}

/**
 * 删项目确认框里「哪些东西会被怎么处理」那一句（桌面、手机共用）。
 * recycleBin 手机端传「电脑的回收站」。记了代码仓库的项目要特别说清：克隆的代码副本里没提交/没推送的改动会跟着进回收站，
 * 而用户自己的仓库和远程分支不受影响。
 */
export function projectDeleteNote(view: Pick<ProjectView, "externalDir" | "dir" | "isCode">, recycleBin = "回收站"): string {
  if (view.externalDir) return `你选的文件夹「${view.dir}」不会被删除，里面 AI 生成的 .lk-harness 成果文件夹会留着。`
  if (view.isCode) return `项目文件夹（含里面克隆的代码副本，以及还没提交或推送的改动）会移到${recycleBin}；你自己的仓库和远程分支不受影响。`
  return `项目文件夹（含 AI 生成的全部成果）会移到${recycleBin}。`
}

/** 项目没接入当前通道时，这里动不了它的删除 / 归档，这句话告诉用户去哪做 */
export function projectNotOwnedHint(action: "删除" | "归档"): string {
  return `这个项目没有接入当前通道，${action}可以在设置的项目管理里做`
}

/** 对话页项目栏、会话列表、手机端删项目时确认框里的正文（三处同一句话，不各写一份） */
export function projectDeleteConfirmText(view: Pick<ProjectView, "name" | "externalDir" | "dir" | "isCode">, recycleBin = "回收站"): string {
  return `确定删除项目「${view.name}」吗？\n会停止它的 AI 会话、清除聊天记录。${projectDeleteNote(view, recycleBin)}\n做完了想留着成果的话，可以归档，不用删除。`
}

/**
 * 给旧版手机 App（1.4.0 及以前）补上它认得的 status。
 * 旧 App 在项目信息里按 view.status !== "active" 决定要不要挂「已完成 / 已暂停」标签；三态去掉之后电脑端不再有这个字段，
 * 旧 App 会给每个项目都挂上「已暂停」。已归档的当「已完成」、其余当「进行中」；新版 App 不读它。
 */
export function withLegacyProjectStatus(view: ProjectView): ProjectView & { status: "active" | "done" } {
  return { ...view, status: view.archived ? "done" : "active" }
}

export interface ProjectActionResult {
  ok: boolean
  error?: string
}
