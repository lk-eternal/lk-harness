// ── 应用内建项目 / 推进步骤 / 项目信息（桌面端 IPC 与手机端网关共用） ─────────────
// 项目归属：在应用里建的项目绑在「应用内对话」通道上，会话键 = <应用通道>|app_main::project_<id>。
// 不动飞书私聊用的全局「当前项目」指针（建项和推进步骤都显式指定项目，不读那个指针）。

import { app } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"
import { addRepoProfilesIfMissing, getChannel, getRepoProfiles } from "./config-store"
import { readLockFile, resolveMainChatId } from "./daemon-client"
import { reportCommandResult } from "./command-handler"
import {
  archiveProjectGroup,
  attachProjectToGroupForAi,
  enterProjectSession,
  executeProjectDelete,
  startProjectNode,
} from "./project-commands"
import { leaveProjectSession, releaseProjectRoutes, stopSessionAgent } from "./session-dispatcher"
import { inspectLocalRepo } from "./project-worktree"
import { createProjectAdminHandlers } from "./project-admin"
import { prepareProjectWorkspace, projectsRootDir } from "./project-workspace"
import { pushUiLog } from "./ui-logger"
import {
  isRemoteRepoUrl,
  projectNotOwnedHint,
  repoDisplayName,
  type AiProjectCreateResult,
  type InspectRepoResult,
  type ProjectActionResult,
  type ProjectCreateInput,
  type ProjectCreateResult,
  type ProjectListItem,
  type ProjectRepoOption,
  type ProjectTemplateInfo,
  type ProjectView,
} from "../src/shared/project-app-types.js"
import {
  buildProjectListItem,
  buildProjectView,
  checkExternalFolder,
  isProjectOwnedBy,
  parseGatewayCreateInput,
  planProjectCreate,
  syncedSnapshot,
  templateInfos,
} from "../src/shared/project-create-plan.js"
import {
  createProject,
  findProjectByGroupChat,
  getCurrentProject,
  getCurrentProjectId,
  getNodeGroups,
  getProject,
  initProjectStore,
  listProjects,
  projectGroups,
  projectNodes,
  saveProject,
  setCurrentProjectId,
  setProjectArchived,
} from "../src/shared/project-store.js"
import { snapshotGroups } from "../src/shared/project-templates.js"
import { APP_CHANNEL_CHAT_ID, makeChatKey, parseChatKey, resolveChannelAudience, type ChannelType } from "../src/shared/channel-types.js"
import { parseExistingGroupChatBinding, projectRootDir, projectSessionKey, type Project } from "../src/shared/project-types.js"
import { parseAiChatChoice } from "../src/shared/project-ai-format.js"

export { projectsRootDir }

function ensureStore(): void {
  initProjectStore(app.getPath("userData"))
}

const NOT_OWNED_HINT = "这个项目归其它通道管（比如飞书），请到它所在的聊天里推进；删除可以在设置的项目管理里做"
/** 应用内对话通道的 chatKey；不是应用内通道返回 undefined */
function appChatKeyOf(channelId: string): string | undefined {
  if (!channelId || getChannel(channelId)?.type !== "app") return undefined
  return makeChatKey(channelId, APP_CHANNEL_CHAT_ID)
}

export function listProjectTemplates(): ProjectTemplateInfo[] {
  ensureStore()
  return templateInfos(getNodeGroups())
}

/** 常用仓库（建项时勾选）：设置里配的和以前建项时自动记下的 */
export function listProjectRepoOptions(): ProjectRepoOption[] {
  return getRepoProfiles().map((p) => ({
    path: p.path,
    name: repoDisplayName(p.path),
    baseBranch: p.baseBranch,
    ...(p.testBranch ? { testBranch: p.testBranch } : {}),
    ...(p.developBranch ? { developBranch: p.developBranch } : {}),
    // 远程地址本机没有副本可用，一律克隆（设置页里这个勾选对它不可改）
    clone: isRemoteRepoUrl(p.path) || p.clone !== false,
  }))
}

/** 桌面端「添加本地仓库」：确认是 git 仓库根目录，给出默认基线分支和分支提示 */
export async function inspectProjectRepo(repoPath: string): Promise<InspectRepoResult> {
  const dir = String(repoPath ?? "").trim()
  const r = await inspectLocalRepo(dir)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, path: path.resolve(dir), name: repoDisplayName(dir), baseBranch: r.info.defaultBranch, branches: r.info.branches }
}

type FolderWorkspace = { ok: true; dir: string } | { ok: false; error: string }

/** 用户选了已有文件夹当项目目录（只有不接代码仓库的模板才能选）：校验一下，应用不动里面的任何东西 */
function prepareFolderWorkspace(folder: string): FolderWorkspace {
  const checked = checkExternalFolder(folder, {
    userDataDir: app.getPath("userData"),
    projects: listProjects().map((p) => ({
      name: p.name,
      dir: projectRootDir(p) || p.worktreePath || "",
      external: p.externalWorkspace === true,
    })),
  })
  if (!checked.ok) return { ok: false, error: checked.error }
  try {
    if (!fs.statSync(checked.dir).isDirectory()) return { ok: false, error: `不是文件夹：${checked.dir}` }
  } catch {
    return { ok: false, error: `文件夹不存在：${checked.dir}` }
  }
  return { ok: true, dir: checked.dir }
}

/**
 * 建项核心：校验 → 准备目录（用已有文件夹，或新建目录并按需克隆仓库）→ 落盘（带模板副本）→ 项目会话键绑到 chatKey。
 * 不进入项目会话：应用里点「新建」（createProjectFromApp）在它后面接着进入；AI 建项（createProjectForAi）不进，不打断当前对话。
 */
async function createProjectCore(
  chatKey: string,
  input: ProjectCreateInput,
): Promise<{ ok: true; project: Project } | { ok: false; error: string }> {
  ensureStore()
  const plan = planProjectCreate(input, getNodeGroups())
  if (!plan.ok) return { ok: false, error: plan.error }

  // 不接代码仓库的模板可以直接用一个已有文件夹；其余情况在项目存放目录下新建
  const folderInput = plan.group.workspace === "plain" ? (input.folder ?? "").trim() : ""
  let cwd: string
  let external = false
  let repoInfo: Record<string, string> = {}
  let undo: (() => Promise<void>) | undefined
  if (folderInput) {
    const prepared = prepareFolderWorkspace(folderInput)
    if (!prepared.ok) return { ok: false, error: prepared.error }
    cwd = prepared.dir
    external = true
  } else {
    const prepared = await prepareProjectWorkspace({
      name: plan.name,
      repos: plan.repos,
      workBranch: plan.workBranch,
      featureBranch: plan.featureBranch,
    })
    if (!prepared.ok) return { ok: false, error: prepared.error }
    cwd = prepared.cwd
    repoInfo = prepared.metadata
    undo = prepared.undo
  }

  // createProject 会把它设成全局当前项目；应用内建项不该改飞书私聊正在用的那个，建完还原
  const prevCurrent = getCurrentProjectId()
  let project: Project
  try {
    project = createProject({
      name: plan.name,
      goal: plan.goal,
      ...(plan.storyUrl ? { storyUrl: plan.storyUrl } : {}),
      ...(plan.relatedDocs ? { relatedDocs: plan.relatedDocs } : {}),
      worktreePath: cwd,
      groupIds: [plan.group.id],
      groupId: plan.group.id,
      groupSnapshot: snapshotGroups([plan.group]),
      ...(external ? { externalWorkspace: true } : {}),
      metadata: { ...plan.metadata, ...repoInfo },
      notifyChatId: chatKey,
    })
  } catch (e: unknown) {
    await undo?.()
    setCurrentProjectId(prevCurrent)
    return { ok: false, error: `无法保存项目：${e instanceof Error ? e.message : String(e)}` }
  }
  setCurrentProjectId(prevCurrent)
  // 这次用到的、还没记过的仓库记进常用仓库，下次建项直接勾选
  addRepoProfilesIfMissing(plan.repos.map((r) => ({ path: r.repoPath, baseBranch: r.baseBranch })))

  project.sessionKey = projectSessionKey(chatKey, project.id)
  saveProject(project)
  return { ok: true, project }
}

/** 新建项目（应用里点「新建」）：建项核心 → 进入项目会话 */
export async function createProjectFromApp(channelId: string, input: ProjectCreateInput): Promise<ProjectCreateResult> {
  ensureStore()
  const chatKey = appChatKeyOf(channelId)
  if (!chatKey) return { ok: false, error: "不是应用内对话的通道" }
  const created = await createProjectCore(chatKey, input)
  if (!created.ok) return created
  const project = created.project

  const lock = readLockFile()
  if (!lock?.port) {
    return { ok: true, projectId: project.id, sessionKey: project.sessionKey, warning: "项目已创建，但服务未运行，会话稍后再进入" }
  }
  const entered = await enterProjectSession(lock.port, chatKey, project)
  if (!entered.ok) {
    pushUiLog("Project", "WARN", `[AppCreate] 项目 ${project.id} 已创建，进入会话失败: ${entered.error}`)
    return { ok: true, projectId: project.id, sessionKey: project.sessionKey, warning: `项目已创建，但进入会话失败：${entered.error}` }
  }
  return { ok: true, projectId: project.id, sessionKey: getProject(project.id)?.sessionKey ?? project.sessionKey }
}

// ── AI 建项（管理 MCP 的 manage_project：templates / repos / create）────────────────
// 和应用里点「新建」走同一套校验和落盘（createProjectCore），区别有三：
// 任何通道的主用户都能建（应用内、飞书、微信）；建完不进入项目会话，不打断 AI 正在跑的这一轮对话；
// 项目的会话落点由调用方明确指定（chat_mode，没有默认值）：inline 绑在调用者所在的聊天上，
// group 建飞书独立群（群主是主用户）并把项目绑到群，bind 绑定已有的飞书群——后两种只有飞书私聊能用。

/** 同一个聊天里同名项目只允许一个在途：AI 的调用超时后重试、或同一轮里连发两次，不会建出两个一模一样的项目 */
const aiCreateInFlight = new Set<string>()

type AiCreateWhere = {
  ok: true
  chatKey: string
  channelId: string
  channelType: ChannelType
  /** 通道记录的主用户飞书 open_id（建独立群时设为群主）；没记到是空 */
  mainUserOpenId?: string
}

/**
 * 调用者的聊天键 → 项目该绑的聊天。只认主用户：管理 MCP 本来就只挂给主用户的会话，这里再兜一层。
 * 应用内对话通道永远是主用户私聊，项目绑在它固定的那个聊天上（和应用里点「新建」一致）。
 */
function resolveAiCreateChat(chatKey: string): AiCreateWhere | { ok: false; error: string } {
  const { channelId } = parseChatKey(String(chatKey ?? ""))
  const channel = channelId ? getChannel(channelId) : undefined
  if (!channel) return { ok: false, error: "找不到你所在的消息通道，无法确定项目归属" }
  if (channel.type === "app") {
    return { ok: true, chatKey: makeChatKey(channel.id, APP_CHANNEL_CHAT_ID), channelId: channel.id, channelType: "app" }
  }
  const audience = resolveChannelAudience({
    mainUserEnabled: channel.mainUserEnabled,
    mainUserChatId: channel.mainUserChatId,
    chatKey,
    chatType: "p2p",
  })
  if (audience !== "main") return { ok: false, error: "只有主用户的私聊可以创建项目" }
  return { ok: true, chatKey, channelId: channel.id, channelType: channel.type, mainUserOpenId: channel.mainUserOpenId?.trim() || undefined }
}

type AiGroupTarget = { mode: "group"; ownerOpenId: string } | { mode: "bind"; existingGroupChatId: string }

/** 建项之前就能判断的：这个通道能不能用所选的会话落点。不通过就一个目录、一个群都不建 */
function checkAiChat(
  where: AiCreateWhere,
  chat: { mode: string; existingGroupChatId?: string },
): { ok: true; target?: AiGroupTarget } | { ok: false; error: string } {
  if (chat.mode === "inline") return { ok: true }
  if (where.channelType !== "feishu") {
    return { ok: false, error: "应用内对话和微信里不能建群或绑群，chat_mode 只能用 inline（项目绑在当前聊天上）。飞书群只能从飞书私聊里建。" }
  }
  if (chat.mode === "group") {
    if (!where.mainUserOpenId) {
      return { ok: false, error: "没有记录到你的飞书身份（open_id），建群时没法把你设为群主并拉进群。稍后再试一次；仍然不行就改用 inline，或让用户在设置里重新绑定主用户。" }
    }
    return { ok: true, target: { mode: "group", ownerOpenId: where.mainUserOpenId } }
  }
  const existing = chat.existingGroupChatId ?? ""
  const parsed = parseExistingGroupChatBinding(existing, where.channelId)
  if ("error" in parsed) return { ok: false, error: parsed.error }
  const taken = findProjectByGroupChat(parsed.chatKey)
  if (taken) return { ok: false, error: `该群已绑定项目「${taken.name}」(${taken.id})` }
  return { ok: true, target: { mode: "bind", existingGroupChatId: existing } }
}

/**
 * AI 建项：建好就返回，不进入项目会话、不动全局「当前项目」指针。
 * chat 是项目的会话落点（没有默认值，不给或给错直接报错，让 AI 去问用户）；建群 / 绑群放在项目整个建成之后，
 * 校验不过、克隆失败都不会留下群。建群或绑群这一步本身失败：项目保留（绑在调用者的聊天上），warning 里写明原因。
 */
export async function createProjectForAi(
  chatKey: string,
  input: ProjectCreateInput,
  chat: { mode?: string; existingGroupChatId?: string },
): Promise<AiProjectCreateResult> {
  ensureStore()
  const where = resolveAiCreateChat(chatKey)
  if (!where.ok) return where
  const choice = parseAiChatChoice(chat?.mode, chat?.existingGroupChatId)
  if (!choice.ok) return choice
  const checked = checkAiChat(where, choice.choice)
  if (!checked.ok) return checked
  const name = String(input?.name ?? "").trim()
  const flightKey = name ? `${where.chatKey}\n${name.toLowerCase()}` : ""
  if (flightKey && aiCreateInFlight.has(flightKey)) {
    return { ok: false, error: `「${name}」正在创建中（克隆仓库可能要一会儿），请稍后用 list 确认，不要重复提交` }
  }
  if (flightKey) aiCreateInFlight.add(flightKey)
  try {
    const created = await createProjectCore(where.chatKey, input)
    if (!created.ok) return created
    const p = created.project

    let outcome: Pick<Extract<AiProjectCreateResult, { ok: true }>, "chatMode" | "groupName" | "groupChatId" | "warning"> = { chatMode: "inline" }
    if (checked.target) {
      const port = readLockFile()?.port
      const attached = port
        ? await attachProjectToGroupForAi(port, p, where.chatKey, checked.target)
        : ({ ok: false, error: "后台服务没有在运行" } as const)
      if (attached.ok) {
        outcome = { chatMode: checked.target.mode, groupName: attached.groupName, groupChatId: attached.rawChatId }
      } else {
        const what = checked.target.mode === "group" ? "建独立群" : "绑定群"
        pushUiLog("Project", "WARN", `[AiCreate] 项目 ${p.id} 已创建，但${what}失败: ${attached.error}`)
        outcome = {
          chatMode: "inline",
          warning: `${what}没成功：${attached.error}。项目已经建好，绑在当前聊天上（没有群）。请如实告诉用户，由他决定怎么处理（比如删掉这个项目重建）。`,
        }
      }
    }
    pushUiLog("Project", "INFO", `[AiCreate] AI 创建了项目「${p.name}」(${p.id})，聊天 ${where.chatKey}，会话落点 ${outcome.chatMode}`)
    return {
      ok: true,
      projectId: p.id,
      name: p.name,
      dir: projectRootDir(p) || p.worktreePath,
      templateName: projectGroups(p).map((g) => g.name).join("、"),
      ...outcome,
    }
  } finally {
    if (flightKey) aiCreateInFlight.delete(flightKey)
  }
}

function strOf(v: unknown): string | undefined {
  return typeof v === "string" ? v : undefined
}

/**
 * 管理 MCP（daemon 进程）经宿主通道（src/shared/host-rpc.ts）发来的项目请求。
 * 入参形状同手机端网关（只认字符串，其余丢掉），另外认 folder：不接代码仓库的模板可以指定一个已有文件夹，
 * 它和界面里选文件夹走同一套校验（不能是应用数据目录、不能已属于别的项目）。
 */
export const projectHostRpcHandlers: Record<string, (payload: unknown) => unknown | Promise<unknown>> = {
  // 设置 / 常用仓库 / 模板 / 已有项目的查看和修改（manage_project 的其余 action），实现见 project-admin.ts
  ...createProjectAdminHandlers({ setArchived: setProjectArchivedByUser, syncSteps: syncProjectSteps }),
  "project.templates": () => listProjectTemplates(),
  "project.repos": () => listProjectRepoOptions(),
  "project.create": (payload) => {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>
    const raw = (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>
    const folder = strOf(raw.folder)
    const input: ProjectCreateInput = { ...parseGatewayCreateInput(raw), ...(folder ? { folder } : {}) }
    return createProjectForAi(strOf(p.chatKey) ?? "", input, {
      mode: strOf(p.chatMode),
      existingGroupChatId: strOf(p.existingGroupChatId),
    })
  },
}

/** 设置页项目列表：每个项目的完整资料（字段、快捷操作取自项目实际在用的模板） */
export function listProjectItems(): ProjectListItem[] {
  ensureStore()
  const globals = getNodeGroups()
  // 已归档的排在后面（稳定排序，各自保持最近更新在前）
  return listProjects()
    .map((p) => buildProjectListItem(p, { groups: projectGroups(p), globals }))
    .sort((a, b) => Number(a.archived) - Number(b.archived))
}

/** 项目信息面板数据；项目不存在返回 null。channelId 是正在看的通道，用来标出项目归不归它 */
export function getProjectView(projectId: string, channelId: string): ProjectView | null {
  ensureStore()
  const p = getProject(String(projectId || "").trim())
  if (!p) return null
  return buildProjectView(p, {
    channelId,
    groups: projectGroups(p),
    globals: getNodeGroups(),
    fileExists: (f) => fs.existsSync(f),
  })
}

/** 点步骤条：把这个步骤的提示词投进项目会话 */
export async function runProjectStepFromApp(channelId: string, projectId: string, nodeId: string): Promise<ProjectActionResult> {
  ensureStore()
  const chatKey = appChatKeyOf(channelId)
  if (!chatKey) return { ok: false, error: "不是应用内对话的通道" }
  const p = getProject(String(projectId || "").trim())
  if (!p) return { ok: false, error: "项目不存在" }
  if (!projectNodes(p).some((n) => n.id === nodeId)) return { ok: false, error: "项目里没有这个快捷操作" }
  // 飞书里建的项目也会列在应用内会话里；在这边推进步骤会把它的会话绑定抢过来
  if (!isProjectOwnedBy(p, channelId)) return { ok: false, error: NOT_OWNED_HINT }
  const lock = readLockFile()
  if (!lock?.port) return { ok: false, error: "服务未运行" }

  const r = await startProjectNode(lock.port, chatKey, p, nodeId, { touchCurrent: false })
  if (!r.ok) return { ok: false, error: r.error }
  // 聊天里留一条记录：点了哪一步（步骤提示词本身很长，不当用户消息显示）
  await reportCommandResult(lock.port, "", true, `▶ 开始：${r.label}`, chatKey, undefined, { sessionKey: r.sessionKey })
  return { ok: true }
}

/**
 * 用户在界面上删除项目（设置页、应用内项目栏、手机端共用）：停掉项目会话的 Agent，
 * 删记录和工作目录（用户自己选的文件夹只解绑，见 executeProjectDelete），独立群归档，
 * 删的是当前项目就把主会话切回主目录。
 */
export async function deleteProjectByUser(
  projectId: string,
  /** 给了通道（手机端、应用内项目栏）就只能删归这个应用内通道的项目；设置页不传，可以管全部项目 */
  opts?: { channelId: string },
): Promise<{ ok: boolean; name?: string; error?: string }> {
  ensureStore()
  const id = String(projectId || "").trim()
  const target = getProject(id)
  if (!target) return { ok: false, error: "项目不存在" }
  if (opts && (!appChatKeyOf(opts.channelId) || !isProjectOwnedBy(target, opts.channelId))) {
    return { ok: false, error: NOT_OWNED_HINT }
  }
  const lock = readLockFile()
  const wasCurrent = getCurrentProject()?.id === id
  const sk = target.sessionKey || (lock?.port
    ? projectSessionKey(await resolveMainChatId(lock.port) || "", id)
    : "")
  if (sk) await stopSessionAgent(sk)
  const r = await executeProjectDelete(id)
  if (!r.ok) return { ok: false, error: "删除失败" }
  if (lock?.port) await archiveProjectGroup(lock.port, target)
  if (wasCurrent && lock?.port) {
    const chatId = await resolveMainChatId(lock.port)
    if (chatId) await leaveProjectSession(lock.port, chatId)
  }
  return { ok: true, name: target.name }
}

/**
 * 用户在界面上归档 / 取消归档项目（设置页、应用内会话列表和项目栏、手机端共用）。
 * 只改项目上的标记：会话、聊天记录、工作目录都原样留着，对话页把它收进最下面的「已归档」分组；
 * 归档后飞书专属群不再认领它、定时任务和 AI 排程不再投给它（见 archivedAt 的说明）。
 * 给了通道（手机端、应用内）就只能动归这个应用内通道的项目；设置页不传，可以管全部项目。
 */
export function setProjectArchivedByUser(
  projectId: string,
  archived: boolean,
  opts?: { channelId: string },
): { ok: boolean; name?: string; error?: string } {
  ensureStore()
  const target = getProject(String(projectId || "").trim())
  if (!target) return { ok: false, error: "项目不存在" }
  if (opts && (!appChatKeyOf(opts.channelId) || !isProjectOwnedBy(target, opts.channelId))) {
    return { ok: false, error: projectNotOwnedHint("归档") }
  }
  if (!setProjectArchived(target.id, archived)) return { ok: false, error: "项目不存在" }
  if (archived) releaseArchivedProject(target)
  return { ok: true, name: target.name }
}

/**
 * 归档后别让聊天还停在这个项目上：「当前项目」指针清掉，飞书 / 微信聊天的活跃会话挪回主会话（见 releaseProjectRoutes）。
 * 归档只改了项目上的标记，不做这一步，私聊会一直停在已归档的项目里。
 * 挪会话要问 daemon，是 best-effort，不拖归档本身：daemon 没起来就算了。
 */
function releaseArchivedProject(project: { id: string; groupChatId?: string }): void {
  if (getCurrentProjectId() === project.id) setCurrentProjectId(null)
  const lock = readLockFile()
  if (!lock?.port) return
  void releaseProjectRoutes(lock.port, project).catch(() => { /* best-effort */ })
}

/** 把项目步骤同步成最新模板（只对有自己步骤副本的项目有意义） */
export function syncProjectSteps(projectId: string): ProjectActionResult {
  ensureStore()
  const p = getProject(String(projectId || "").trim())
  if (!p) return { ok: false, error: "项目不存在" }
  if (!p.groupSnapshot?.length) return { ok: false, error: "这个项目的快捷操作本来就跟着模板走，不用同步" }
  p.groupSnapshot = syncedSnapshot(p.groupSnapshot, getNodeGroups())
  saveProject(p)
  return { ok: true }
}
