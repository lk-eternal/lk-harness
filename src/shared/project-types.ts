import * as path from "node:path"
import { channelIdFromSessionKey, chatIdFromSessionKey, makeChatKey, parseChatKey } from "./channel-types.js"
import type { FlowHubHubTrack } from "./flow-hub-types.js"
import { GENERAL_NODE_GROUPS } from "./project-templates.js"

/** 节点 id：流程组节点 slug，或用户自定义 */
export type ProjectActionType = string
/** @deprecated 轻量化后不再使用运行态；仅兼容读存量 JSON */
export type ProjectActionStatus =
  | "running"
  | "awaiting_ack"
  | "accepted"
  | "rejected"
  | "failed"

/** 项目流程节点定义（推进按钮/命令/提示词的唯一来源；无内置/自定义之分，均可增删改） */
export interface ProjectNodeDef extends FlowHubHubTrack {
  id: string
  label: string
  /** 节点工作要求；留空且 id 命中默认模板时用代码里的模板 */
  prompt?: string
}

/**
 * 模板要不要接代码仓库：worktree=建项时可以选代码仓库（选不选都行）；plain=不接，只有一个普通文件夹。
 * 它只决定建项表单里出不出现仓库选择，项目建好后不再记这个类型：仓库和分支都是普通的项目信息。
 */
export type ProjectWorkspaceType = "worktree" | "plain"

export { WORK_BRANCH_MODES, normalizeWorkBranchMode, type WorkBranchMode } from "./work-branch-mode.js"
import type { WorkBranchMode } from "./work-branch-mode.js"

/** 模板要用户在建项时填的一项信息；值存进项目的 metadata，键就是 label（AI 读上下文时看到的也是它） */
export interface ProjectFieldDef {
  label: string
  placeholder?: string
  /** 多行输入框 */
  multiline?: boolean
  required?: boolean
}

/** 流程组 = 项目模板：建项可选；推进按钮/命令按所选组分组展示节点 */
export interface ProjectNodeGroupDef extends FlowHubHubTrack {
  id: string
  name: string
  nodes: ProjectNodeDef[]
  /** 接不接代码仓库：plain=不接，worktree=建项时可选仓库（应用内建项的表单按它走）。缺省按 worktree（存量） */
  workspace?: ProjectWorkspaceType
  /** 接了代码仓库时，克隆副本停在哪个分支的默认值；缺省=新建分支（存量行为），建项时可以改 */
  branchMode?: WorkBranchMode
  /** 一句话说明这个模板适合干什么（建项时展示） */
  description?: string
  /** 建项时要填的信息 */
  fields?: ProjectFieldDef[]
}

/** 默认流程组种子：仅在无任何持久化数据时初始化用 */
export const DEFAULT_NODE_GROUPS: ProjectNodeGroupDef[] = [
  {
    id: "develop",
    name: "开发",
    description: "软件研发：需求规划、写代码、提测、修缺陷。要接 git 代码仓库；用到飞书项目、GitLab 时再单独配置。",
    workspace: "worktree",
    nodes: [
      { id: "plan", label: "规划" },
      { id: "build", label: "实现" },
      { id: "review", label: "审查" },
      { id: "deploy", label: "部署" },
      { id: "mr", label: "MR" },
      { id: "submit-test", label: "提测" },
      { id: "analyze-bug", label: "分析缺陷" },
      { id: "fix-bug", label: "修复缺陷" },
      { id: "fill-release-doc", label: "上线文档" },
    ],
  },
  {
    id: "test",
    name: "测试",
    description: "软件测试：评审、写用例、执行测试、提缺陷、复测。用飞书项目。建项时可以选要测的代码仓库（可不选），代码停在测试分支上。",
    workspace: "worktree",
    branchMode: "test",
    nodes: [
      { id: "test-review", label: "测试评审" },
      { id: "test-cases", label: "用例编写" },
      { id: "test-deploy", label: "部署" },
      { id: "test-exec", label: "测试" },
      { id: "file-bug", label: "提缺陷" },
      { id: "retest", label: "复测" },
      { id: "release-doc", label: "上线文档" },
    ],
  },
  ...GENERAL_NODE_GROUPS,
]

/** 存量项目没记流程组时的回落组：保持开发流程，老项目行为不变 */
export const DEFAULT_NODE_GROUP_ID = DEFAULT_NODE_GROUPS[0].id
/** 新建项目默认选的模板（不依赖 git / 飞书 / GitLab，谁都能用） */
export const DEFAULT_NEW_PROJECT_GROUP_ID = GENERAL_NODE_GROUPS[0].id

/** 常用代码仓库（设置里配的，建项时勾选）；分支都只是信息，只有「克隆副本」会让应用对仓库做 git 操作 */
export interface RepoProfile {
  path: string
  /** 基线分支：新建分支从它切出；没配专门分支时的兜底 */
  baseBranch: string
  testBranch?: string
  developBranch?: string
  /** 建项时克隆一份到项目目录（AI 在副本里改，不动你自己的仓库）；缺省=克隆。false=不克隆，只把仓库信息记进项目 */
  clone?: boolean
}

/** @deprecated 轻量化后不再写入；仅兼容读存量 JSON */
export interface ProjectAction {
  id: string
  type: ProjectActionType
  status: ProjectActionStatus
  artifactPath?: string
  feishuDocUrl?: string
  summary?: string
  mrUrl?: string
  error?: string
  startedAt: number
  completedAt?: number
}

/**
 * 项目接入的一个聊天入口。项目只有一份（目录、信息、成果共用），但可以接到多个通道和群：
 * 每个入口各有一条独立的项目会话（会话键 = 聊天键::project_<项目id>），消息只进自己那条、回复只回自己的聊天，不合并。
 */
export interface ProjectBinding {
  /** main=该通道的主聊天（应用内对话，或飞书 / 微信主用户的私聊）；group=项目专属群（群只属于这个项目） */
  kind: "main" | "group"
  channelId: string
  /** group 才有：群的聊天键 ch_xxx|oc_yyy */
  chatKey?: string
  /**
   * 这个入口上项目会话的会话键。group 可以不记（由群的聊天键推出来）；
   * main 要记（通道的主聊天键只有建项或进入那一刻才知道），没有就是还没进入过。
   */
  sessionKey?: string
}

/** 旧版（项目只有一个入口）的绑定字段：只在读旧项目文件时用来迁移成 bindings，迁完不再出现在 Project 上 */
export interface LegacyProjectBindingFields {
  sessionKey?: string
  notifyChatId?: string
  groupChatId?: string
}

export interface Project {
  id: string
  name: string
  goal: string
  storyUrl?: string
  relatedDocs?: string
  productDocUrl?: string
  techDocUrl?: string
  /**
   * 项目目录：AI 工作的目录，会话从这里启动；成果放在它下面的 .lk-harness/artifacts。
   * 名字是历史遗留（早期是 git worktree），现在就是一个普通目录。
   * 仓库、分支这些都不再有专门的字段：记在 metadata 的「代码仓库」几行里（见 project-repo-info.ts）。
   */
  worktreePath: string
  /** 流程组 id；旧项目缺省视为默认组；多组时为首组 id（兼容） */
  groupId?: string
  /** 绑定的流程组 id 列表（多选）；缺省回落 groupId 或默认组 */
  groupIds?: string[]
  /**
   * 建项时从模板复制来的流程组副本（含步骤和提示词）。有它就只认它，不再随全局模板变；
   * 缺省的存量项目继续实时读全局流程组。
   */
  groupSnapshot?: ProjectNodeGroupDef[]
  /** worktreePath 是用户自己选的已有文件夹：删项目时只解绑，不删它，也不删它的上级目录 */
  externalWorkspace?: boolean
  /**
   * 归档时间；有值就是已归档。做完的项目用户自己归档（或删除），没有「进行中 / 已暂停 / 已完成」这类状态。
   * 归档的项目不再认领飞书专属群、不能再排定时任务，对话页里收进最下面的「已归档」分组；会话和成果都还在。
   */
  archivedAt?: number
  /** 可选：最近一次登记的产物路径（供下次节点注入） */
  lastArtifactPath?: string
  lastArtifactSummary?: string
  lastMrUrl?: string
  lastFeishuDocUrl?: string
  lastArtifactAt?: number
  /** @deprecated 存量字段，读取时迁移到 lastArtifact* 后不再依赖 */
  actions?: ProjectAction[]
  /**
   * 项目接入了哪些聊天入口（通道的主聊天、项目专属群）。绑了才看得到、才能进入和推进；
   * 每个入口各有一条独立的项目会话，互不合并。没有任何入口的项目只在设置页里看得到。
   * 旧版的 sessionKey / notifyChatId / groupChatId 读旧文件时迁移成这个，见 bindingsFromLegacy。
   */
  bindings?: ProjectBinding[]
  /** 项目级 KV 配置，AI 可通过 project_update 持久化（空字符串 value 表示删 key） */
  metadata?: Record<string, string>
  createdAt: number
  updatedAt: number
}

export interface ProjectSettingsSlice {
  gitlabToken: string
  gitlabHost: string
  repoRoots: string[]
  repoProfiles: RepoProfile[]
  worktreeRoot: string
}

/** /p 保留子命令：自定义节点 id 不得与之冲突 */
export const PROJECT_RESERVED_SUBCOMMANDS = [
  "help", "menu", "ls", "list", "use", "leave", "info", "new", "del", "delete", "rm", "setup", "sync", "ship",
]

export function projectSessionKey(chatKey: string, projectId: string): string {
  return `${chatKey}::project_${projectId}`
}

// ── 项目接入点（bindings）：谁看得到、谁能进、会话键是什么 ─────────────────────────

type BindingHolder = Pick<Project, "bindings">

export function projectBindings(p: BindingHolder): ProjectBinding[] {
  return Array.isArray(p.bindings) ? p.bindings : []
}

/**
 * 两个聊天键是不是同一个聊天。两边都带通道就必须完全相同：飞书的 oc_ 群号在同一租户内是通用的，
 * 两个机器人（两个通道）进了同一个群时，群号一样、通道不同，不能当成同一个入口。
 * 有一边没有通道前缀（老版本的裸 chatId）才退回比群号本身。
 */
export function sameChatKey(a: string, b: string): boolean {
  if (a === b) return true
  const pa = parseChatKey(a)
  const pb = parseChatKey(b)
  if (pa.channelId && pb.channelId) return false
  return pa.chatId === pb.chatId
}

/** 项目接入的专属群入口 */
export function projectGroupBindings(p: BindingHolder): ProjectBinding[] {
  return projectBindings(p).filter((b) => b.kind === "group" && !!b.chatKey)
}

/** 项目的主聊天入口（每个通道至多一个） */
export function projectMainBindings(p: BindingHolder): ProjectBinding[] {
  return projectBindings(p).filter((b) => b.kind === "main")
}

/** 这个聊天是不是项目的某个专属群 */
export function projectGroupChatMatches(project: BindingHolder, chatKey?: string): boolean {
  return !!projectGroupBindingFor(project, chatKey)
}

export function projectGroupBindingFor(project: BindingHolder, chatKey?: string): ProjectBinding | undefined {
  if (!chatKey) return undefined
  return projectGroupBindings(project).find((b) => sameChatKey(b.chatKey!, chatKey))
}

/** 项目接入了这个通道的哪个入口（主聊天或专属群）；没接入返回 undefined */
export function projectBoundToChannel(project: BindingHolder, channelId?: string): boolean {
  if (!channelId) return false
  return projectBindings(project).some((b) => b.channelId === channelId)
}

/**
 * 这个聊天对应项目的哪个入口：先看是不是项目的专属群，再看项目有没有接入这个聊天所在通道的主聊天。
 * 调用方（/p、/c、应用里切会话）都只会带来主聊天或专属群，所以主聊天按通道认，不比聊天键——
 * 通道换了主用户之后，项目不会因为聊天键变了就丢。
 */
export function projectBindingForChat(project: BindingHolder, chatKey?: string): ProjectBinding | undefined {
  if (!chatKey) return undefined
  const group = projectGroupBindingFor(project, chatKey)
  if (group) return group
  const channelId = parseChatKey(chatKey).channelId
  if (!channelId) return undefined
  return projectMainBindings(project).find((b) => b.channelId === channelId)
}

/**
 * 是否允许从该 chat 进入/推进项目：这个聊天就是项目的专属群，或者项目接入了它所在通道的主聊天。
 * 没接入的通道、别的项目的专属群都不行（防串台、防串租户）。
 */
export function canEnterProjectFromChat(project: BindingHolder, chatKey?: string): boolean {
  return !!projectBindingForChat(project, chatKey)
}

/** 项目接入的通道（去重，按入口顺序） */
export function projectChannelIds(project: BindingHolder): string[] {
  const seen = new Set<string>()
  for (const b of projectBindings(project)) if (b.channelId) seen.add(b.channelId)
  return [...seen]
}

/**
 * 从这个聊天进入项目时用的会话键：专属群用群自己的（记过的优先，老会话的历史不丢），
 * 主聊天一律是「当前聊天键::project_<id>」。没接入这个聊天返回 undefined。
 */
export function projectSessionKeyFor(project: BindingHolder & { id: string }, chatKey?: string): string | undefined {
  const b = projectBindingForChat(project, chatKey)
  if (!b || !chatKey) return undefined
  if (b.kind === "group") return b.sessionKey || projectSessionKey(b.chatKey!, project.id)
  return projectSessionKey(chatKey, project.id)
}

/**
 * 项目在某个通道上已知的会话键（不需要聊天键的场景用：定时任务投递、清理会话）。
 * group 入口总能推出来；main 入口只有建项或进入过才记着，没有就返回 undefined。
 * 同一通道既有 main 又有 group 时 main 优先。
 */
export function projectSessionKeyOfChannel(project: BindingHolder & { id: string }, channelId?: string): string | undefined {
  if (!channelId) return undefined
  const here = projectBindings(project).filter((b) => b.channelId === channelId)
  const main = here.find((b) => b.kind === "main" && b.sessionKey)
  if (main) return main.sessionKey
  const group = here.find((b) => b.kind === "group" && b.chatKey)
  return group ? (group.sessionKey || projectSessionKey(group.chatKey!, project.id)) : undefined
}

/** 项目所有入口上已知的会话键：删项目、归档要把它们都收拾掉 */
export function projectSessionKeys(project: BindingHolder & { id: string }): string[] {
  const out: string[] = []
  for (const b of projectBindings(project)) {
    const sk = b.kind === "group"
      ? (b.chatKey ? (b.sessionKey || projectSessionKey(b.chatKey, project.id)) : undefined)
      : b.sessionKey
    if (sk && !out.includes(sk)) out.push(sk)
  }
  return out
}

/** 两条入口是不是同一个：主聊天按通道，专属群按聊天键 */
export function sameProjectBinding(a: ProjectBinding, b: ProjectBinding): boolean {
  if (a.kind !== b.kind || a.channelId !== b.channelId) return false
  if (a.kind === "main") return true
  return !!a.chatKey && !!b.chatKey && sameChatKey(a.chatKey, b.chatKey)
}

/**
 * 给项目加一个入口（就地改 project.bindings，调用方负责保存）：已经有同一个入口就更新它（补上记录的会话键），没有就追加。
 * 返回项目上这个入口的引用。
 */
export function addProjectBinding(project: { bindings?: ProjectBinding[] }, binding: ProjectBinding): ProjectBinding {
  const list = project.bindings ?? (project.bindings = [])
  const same = list.find((b) => sameProjectBinding(b, binding))
  if (same) {
    if (binding.sessionKey) same.sessionKey = binding.sessionKey
    if (binding.chatKey && !same.chatKey) same.chatKey = binding.chatKey
    return same
  }
  list.push({ ...binding })
  return list[list.length - 1]
}

/** 去掉项目的一个入口（就地改）；没有这个入口返回 undefined，有就返回被去掉的那个 */
export function removeProjectBinding(project: { bindings?: ProjectBinding[] }, match: ProjectBinding): ProjectBinding | undefined {
  const list = project.bindings ?? []
  const idx = list.findIndex((b) => sameProjectBinding(b, match))
  if (idx < 0) return undefined
  const [removed] = list.splice(idx, 1)
  return removed
}

/**
 * 旧版项目文件的绑定字段 → bindings（「存量只绑它现在所在的通道」）：
 * - 有 groupChatId：只有这个专属群（旧语义里独立群项目私聊进不去）；
 * - 否则按 sessionKey（没有就按 notifyChatId）所在的通道，绑那个通道的主聊天；
 * - 老版本飞书会话键没有通道前缀，认不出通道，就一个入口也不给：它只在设置页里看得到，要用再去绑定。
 *   例外是旧的裸群号：群里的消息路由靠它认群，所以群入口照样留着（通道记空）。
 */
export function bindingsFromLegacy(projectId: string, legacy: LegacyProjectBindingFields): ProjectBinding[] {
  const group = (legacy.groupChatId ?? "").trim()
  const sessionKey = (legacy.sessionKey ?? "").trim()
  const notify = (legacy.notifyChatId ?? "").trim()
  if (group) {
    const parsed = parseChatKey(group)
    const channelId = parsed.channelId
      ?? (sessionKey ? parseChatKey(chatIdFromSessionKey(sessionKey)).channelId : undefined)
      ?? (notify ? parseChatKey(notify).channelId : undefined)
      ?? ""
    const chatKey = parsed.channelId || !channelId ? group : makeChatKey(channelId, parsed.chatId)
    const own = sessionKey && sameChatKey(chatIdFromSessionKey(sessionKey), chatKey) ? sessionKey : ""
    return [{ kind: "group", channelId, chatKey, sessionKey: own || projectSessionKey(chatKey, projectId) }]
  }
  const ref = sessionKey || notify
  const channelId = ref ? channelIdFromSessionKey(ref) : undefined
  if (!channelId) return []
  return [{ kind: "main", channelId, ...(sessionKey ? { sessionKey } : {}) }]
}

/**
 * 写盘时顺手带上旧版字段（只写文件，不进 Project 类型）：万一回退到旧版本，项目还能认到它的会话和专属群。
 * 有专属群取专属群，否则取第一个主聊天入口。读文件时只认 bindings，这几个字段会被丢掉。
 */
export function legacyMirrorOf(project: BindingHolder & { id: string }): LegacyProjectBindingFields {
  const group = projectGroupBindings(project)[0]
  if (group?.chatKey) {
    return {
      groupChatId: group.chatKey,
      notifyChatId: group.chatKey,
      sessionKey: group.sessionKey || projectSessionKey(group.chatKey, project.id),
    }
  }
  const main = projectMainBindings(project).find((b) => b.sessionKey)
  if (!main?.sessionKey) return {}
  return { sessionKey: main.sessionKey, notifyChatId: chatIdFromSessionKey(main.sessionKey) }
}

const FEISHU_GROUP_CHAT_ID = /^oc_[a-z0-9]+$/i

/** 建项「绑定已有群」：解析 oc_… 或 ch_…|oc_… 为 chatKey */
export function parseExistingGroupChatBinding(
  input: string,
  channelId: string,
): { chatKey: string; rawChatId: string } | { error: string } {
  const raw = (input || "").trim()
  if (!raw) return { error: "请填写群 chat_id（oc_…）" }
  if (!channelId) return { error: "无法解析飞书通道（请从飞书私聊建项）" }

  let chatKey: string
  let rawChatId: string
  if (raw.includes("|")) {
    const parsed = parseChatKey(raw)
    rawChatId = parsed.chatId
    if (!FEISHU_GROUP_CHAT_ID.test(rawChatId)) {
      return { error: "群 chat_id 须以 oc_ 开头，示例：oc_aa2192cfececee92d57dccd0b59980fd" }
    }
    // 带别的通道前缀的群号不认：项目的专属群必须是它所在通道的群，不然别的通道的群里的人就能驱动这个项目
    if (parsed.channelId && parsed.channelId !== channelId) {
      return { error: "这个群属于别的消息通道，不能绑到当前通道上（项目只能绑自己所在通道的群）" }
    }
    chatKey = parsed.channelId ? raw : makeChatKey(channelId, rawChatId)
  } else {
    if (!FEISHU_GROUP_CHAT_ID.test(raw)) {
      return { error: "群 chat_id 格式无效，示例：oc_aa2192cfececee92d57dccd0b59980fd" }
    }
    rawChatId = raw
    chatKey = makeChatKey(channelId, rawChatId)
  }
  return { chatKey, rawChatId }
}

export type ProjectChatMode = "group" | "inline" | "bind"

export function normalizeProjectChatMode(raw?: string): ProjectChatMode {
  if (raw === "inline") return "inline"
  if (raw === "bind") return "bind"
  return "group"
}

/** 远程仓库地址（http(s)/ssh/git@…）而非本地路径 */
export function isRemoteRepoRef(repoPath: string): boolean {
  return /^(https?:\/\/|ssh:\/\/|git@)/i.test((repoPath || "").trim())
}

export function projectIdFromSessionKey(sessionKey: string): string | undefined {
  const idx = sessionKey.indexOf("::")
  if (idx < 0) return undefined
  const suffix = sessionKey.slice(idx + 2)
  if (!suffix.startsWith("project_")) return undefined
  return suffix.slice("project_".length) || undefined
}


export const REPO_PAIR_SEP = "||"

/** path||base||test||develop（后两段可空） */
export function encodeRepoPair(
  repoPath: string,
  baseBranch: string,
  testBranch?: string,
  developBranch?: string,
): string {
  return [
    repoPath.replace(/\\/g, "/"),
    baseBranch || "main",
    testBranch || "",
    developBranch || "",
  ].join(REPO_PAIR_SEP)
}

export function decodeRepoPair(value: string): {
  path: string
  baseBranch: string
  testBranch?: string
  developBranch?: string
} {
  const parts = (value || "").trim().split(REPO_PAIR_SEP)
  const rawPath = (parts[0] || "").trim()
  // 远程地址原样保留（斜杠回填会毁掉 URL）；本地路径按当前系统还原分隔符：
  // Windows 把 / 还原成 \，macOS / Linux 的 /Users/… 要原样保留（之前一律换成 \，mac 上的路径整个被毁掉，飞书建项目报「不是可用的仓库」）
  const pathPart = !rawPath || isRemoteRepoRef(rawPath) ? rawPath : path.normalize(rawPath)
  if (parts.length < 2) return { path: pathPart, baseBranch: "main" }
  const baseBranch = (parts[1] || "").trim() || "main"
  const testBranch = (parts[2] || "").trim() || undefined
  const developBranch = (parts[3] || "").trim() || undefined
  return { path: pathPart, baseBranch, testBranch, developBranch }
}

const REPO_PAIR_OPT_PREFIX = "b64:"

/** 飞书 multi_select option value 会吞 `||`，表单选项用 base64 包装 */
export function encodeRepoPairOption(
  repoPath: string,
  baseBranch: string,
  testBranch?: string,
  developBranch?: string,
): string {
  const raw = encodeRepoPair(repoPath, baseBranch, testBranch, developBranch)
  return REPO_PAIR_OPT_PREFIX + Buffer.from(raw, "utf8").toString("base64url")
}

export function decodeRepoPairOption(value: string): ReturnType<typeof decodeRepoPair> {
  const t = (value || "").trim()
  if (t.startsWith(REPO_PAIR_OPT_PREFIX)) {
    try {
      const raw = Buffer.from(t.slice(REPO_PAIR_OPT_PREFIX.length), "base64url").toString("utf8")
      return decodeRepoPair(raw)
    } catch { /* fall through */ }
  }
  return decodeRepoPair(t)
}

/** 表单标量字段（input/select） */
export function formFieldStr(v: unknown): string {
  if (Array.isArray(v)) return String(v[0] ?? "").trim()
  return String(v ?? "").trim()
}

/** 飞书 multi_select：保留数组；字符串按逗号拆（含 String([]) 后的 "a,b"） */
export function coerceFormMultiSelect(v: unknown): string[] {
  if (v == null) return []
  if (Array.isArray(v)) return v.flatMap((x) => coerceFormMultiSelect(x))
  const s = String(v).trim()
  if (!s) return []
  if (s.startsWith("[") && s.endsWith("]")) {
    try {
      const parsed = JSON.parse(s)
      if (Array.isArray(parsed)) return coerceFormMultiSelect(parsed)
    } catch { /* ignore */ }
  }
  return s.split(",").map((x) => x.trim()).filter(Boolean)
}

/** 飞书 multi_select 有时把多个 encodeRepoPair 逗号拼成一条；按完整四段 pair 拆回 */
const REPO_PAIR_GLUE_RE = /,(?=https?:\/\/|ssh:\/\/|git@|[A-Za-z]:[/\\])/i

export function splitRepoPairValues(raw: unknown): string[] {
  const out: string[] = []
  const pushOne = (v: string) => {
    const t = v.trim()
    if (!t) return
    if (REPO_PAIR_GLUE_RE.test(t)) {
      for (const part of t.split(REPO_PAIR_GLUE_RE)) {
        const p = part.trim()
        if (p) out.push(p)
      }
      return
    }
    const segs = t.split(REPO_PAIR_SEP)
    if (segs.length > 4 && segs.length % 4 === 0) {
      for (let i = 0; i < segs.length; i += 4) {
        out.push(segs.slice(i, i + 4).join(REPO_PAIR_SEP))
      }
      return
    }
    out.push(t)
  }
  if (Array.isArray(raw)) {
    for (const v of raw) pushOne(String(v))
  } else if (raw != null && String(raw).trim()) {
    pushOne(String(raw))
  }
  return out
}

/**
 * 项目根目录（删项目时整个移走的那个）：应用自己建的项目都是 root/<名字>/ 下面放工作目录，所以取工作目录的上一层——
 * 工作目录要么是 root/<名字>/workspace，要么是里面唯一那个克隆副本 root/<名字>/<仓库名>。
 */
export function projectRootDir(p: Pick<Project, "worktreePath" | "externalWorkspace">): string {
  const wt = (p.worktreePath || "").trim()
  // 用户自己选的文件夹就是项目目录本身：别按约定取上一层，上一层是用户的别的东西
  if (p.externalWorkspace || !wt) return wt
  return path.dirname(wt)
}

export function repoShortName(repoPath: string): string {
  const norm = repoPath.replace(/\\/g, "/").replace(/\/+$/, "")
  const base = norm.split("/").pop() || "repo"
  return base.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]+/g, "-").slice(0, 40) || "repo"
}
