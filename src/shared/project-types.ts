import * as path from "node:path"
import { makeChatKey, parseChatKey } from "./channel-types.js"
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
  sessionKey?: string
  notifyChatId?: string
  /** 独立群模式：项目专属群 chatKey（ch_xxx|oc_yyy）；命中该群的消息强制路由到本项目 */
  groupChatId?: string
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

/** 当前 chat 是否命中项目的独立群（两边 chatKey / 裸 chatId 皆可） */
export function projectGroupChatMatches(project: Pick<Project, "groupChatId">, chatKey?: string): boolean {
  if (!project.groupChatId || !chatKey) return false
  const raw = parseChatKey(chatKey).chatId
  return project.groupChatId === chatKey || parseChatKey(project.groupChatId).chatId === raw
}

/**
 * 是否允许从该 chat 进入/推进项目：
 * - 无独立群：任意会话可进
 * - 有独立群：仅专属群内可进（私聊禁止，防串台）
 */
export function canEnterProjectFromChat(project: Pick<Project, "groupChatId">, chatKey?: string): boolean {
  if (!project.groupChatId) return true
  return projectGroupChatMatches(project, chatKey)
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
  // 远程地址原样保留（斜杠回填会毁掉 URL）；本地路径回填 Windows 分隔符
  const pathPart = isRemoteRepoRef(rawPath) ? rawPath : rawPath.replace(/\//g, "\\")
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
