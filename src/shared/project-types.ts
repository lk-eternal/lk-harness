import * as path from "node:path"
import { makeChatKey, parseChatKey } from "./channel-types.js"
import type { FlowHubHubTrack } from "./flow-hub-types.js"

export type ProjectStatus = "active" | "paused" | "done"
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

/** 项目工作区类型：worktree=代码开发（主仓+隔离 worktree+分支借还）；plain=纯会话目录（测试/文档协作，无 git） */
export type ProjectWorkspaceType = "worktree" | "plain"

/** 流程组：建项可多选；推进按钮/命令按所选组分组展示节点 */
export interface ProjectNodeGroupDef extends FlowHubHubTrack {
  id: string
  name: string
  nodes: ProjectNodeDef[]
  /** 存量字段；建项已统一走开发流程（worktree），不再按组切换表单 */
  workspace?: ProjectWorkspaceType
}

/** 默认流程组种子：仅在无任何持久化数据时初始化用 */
export const DEFAULT_NODE_GROUPS: ProjectNodeGroupDef[] = [
  {
    id: "develop",
    name: "开发",
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
    workspace: "plain",
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
]

export const DEFAULT_NODE_GROUP_ID = DEFAULT_NODE_GROUPS[0].id

export interface RepoProfile {
  path: string
  /** 生产基线：只作切 feature 起点，禁止默认 ship 目标 */
  baseBranch: string
  testBranch?: string
  developBranch?: string
}

export interface ProjectRepo {
  repoPath: string
  baseBranch: string
  testBranch?: string
  developBranch?: string
  worktreePath: string
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
  repoPath: string
  baseBranch: string
  featureBranch: string
  worktreePath: string
  /** multi-repo worktrees */
  repos?: ProjectRepo[]
  /** 流程组 id；旧项目缺省视为默认组；多组时为首组 id（兼容） */
  groupId?: string
  /** 绑定的流程组 id 列表（多选）；缺省回落 groupId 或默认组 */
  groupIds?: string[]
  /** 工作区类型；新建默认 worktree，缺省按 worktree 兼容存量 */
  workspaceType?: ProjectWorkspaceType
  status: ProjectStatus
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

/** 项目全部 worktree 路径（多仓项目逐仓，单仓项目兜底主路径） */
export function projectWorktrees(p: Project): string[] {
  const list = p.repos?.length ? p.repos.map((r) => r.worktreePath) : [p.worktreePath]
  return list.filter(Boolean)
}

/** 项目全部仓库引用（repoPath/worktreePath/baseBranch），供 worktree 懒修复等 git 操作 */
export function projectRepoRefs(p: Project): { repoPath: string; worktreePath: string; baseBranch: string }[] {
  const list = p.repos?.length
    ? p.repos.map((r) => ({ repoPath: r.repoPath, worktreePath: r.worktreePath, baseBranch: r.baseBranch }))
    : [{ repoPath: p.repoPath, worktreePath: p.worktreePath, baseBranch: p.baseBranch }]
  return list.filter((r) => r.repoPath && r.worktreePath)
}

/** 纯会话型项目（无 git 仓，跳过 worktree/分支借还等全部 git 行为） */
export function isPlainProject(p: Project): boolean {
  return p.workspaceType === "plain"
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

/** 项目根目录：单仓为 worktree 父层 root/slug；多仓取各 worktree 公共父目录 */
export function projectRootDir(p: Project): string {
  const wts = projectWorktrees(p).filter(Boolean)
  if (!wts.length) return (p.worktreePath || "").trim()
  if (wts.length === 1) return path.dirname(wts[0])
  const parts = wts.map((wt) => path.normalize(wt).split(path.sep))
  const minLen = Math.min(...parts.map((p) => p.length))
  const common: string[] = []
  for (let i = 0; i < minLen; i++) {
    const seg = parts[0][i]
    if (parts.every((p) => p[i] === seg)) common.push(seg)
    else break
  }
  if (common.length >= 2) return common.join(path.sep)
  return path.dirname(wts[0])
}

export function repoShortName(repoPath: string): string {
  const norm = repoPath.replace(/\\/g, "/").replace(/\/+$/, "")
  const base = norm.split("/").pop() || "repo"
  return base.replace(/[^a-zA-Z0-9._\u4e00-\u9fa5-]+/g, "-").slice(0, 40) || "repo"
}
