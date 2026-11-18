// ── 应用内建项目 / 推进步骤 / 项目信息（桌面端 IPC 与手机端网关共用） ─────────────
// 项目归属：项目可以接入多个聊天入口（通道的主聊天、专属群），每个入口一条独立会话，见 project-types 的 ProjectBinding。
// 在应用里建的项目默认只接「应用内对话」通道的主聊天，会话键 = <应用通道>|app_main::project_<id>；
// 建项时也可以同时选别的通道。「当前项目」按通道记，应用内的操作不碰飞书私聊正在用的那个。

import { app } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"
import { addRepoProfilesIfMissing, getChannel, getChannels, getRepoProfiles } from "./config-store"
import { readLockFile } from "./daemon-client"
import { reportCommandResult } from "./command-handler"
import {
  archiveProjectGroup,
  attachPlannedBindings,
  enterProjectSession,
  executeProjectDelete,
  startProjectNode,
} from "./project-commands"
import { bindingChannelFacts, connectMainBinding } from "./project-bind"
import { bindProjectChoices, unbindProjectChoice } from "./project-bind-ops"
import { releaseProjectRoutes } from "./session-dispatcher"
import { inspectLocalRepo } from "./project-worktree"
import { createProjectAdminHandlers } from "./project-admin"
import { prepareProjectWorkspace, projectsRootDir } from "./project-workspace"
import { pushUiLog } from "./ui-logger"
import {
  isRemoteRepoUrl,
  projectNotOwnedHint,
  repoDisplayName,
  type AiProjectChannelsResult,
  type AiProjectCreateResult,
  type InspectRepoResult,
  type ProjectActionResult,
  type ProjectBindResult,
  type ProjectBindingChoice,
  type ProjectBindingOutcome,
  type ProjectChannelOption,
  type ProjectCreateInput,
  type ProjectCreateResult,
  type ProjectListItem,
  type ProjectRepoOption,
  type ProjectTemplateInfo,
  type ProjectUnbindResult,
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
import { parseBindingChoices, planBindingChoices, projectChannelOptions } from "../src/shared/project-bindings.js"
import {
  clearCurrentProjectOf,
  createProject,
  getNodeGroups,
  getProject,
  initProjectStore,
  listProjects,
  projectGroups,
  projectNodes,
  saveProject,
  setProjectArchived,
} from "../src/shared/project-store.js"
import { snapshotGroups } from "../src/shared/project-templates.js"
import { APP_CHANNEL_CHAT_ID, makeChatKey, parseChatKey, resolveChannelAudience, type ChannelType } from "../src/shared/channel-types.js"
import { canEnterProjectFromChat, projectRootDir, projectSessionKeyFor, type Project } from "../src/shared/project-types.js"

export { projectsRootDir }

function ensureStore(): void {
  initProjectStore(app.getPath("userData"))
}

const NOT_OWNED_HINT = "这个项目没有接入当前通道，请到它接入的聊天里推进；删除可以在设置的项目管理里做"
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
 * 建项核心：校验 → 准备目录（用已有文件夹，或新建目录并按需克隆仓库）→ 落盘（带模板副本）。
 * 建出来的项目还没有接入任何聊天（谁都看不到它）：调用方接着用 attachPlannedBindings 把它接到选好的通道上。
 * 不进入项目会话：应用里点「新建」（createProjectFromApp）在接入之后接着进入；AI 建项（createProjectForAi）不进，不打断当前对话。
 */
async function createProjectCore(
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
    })
  } catch (e: unknown) {
    await undo?.()
    return { ok: false, error: `无法保存项目：${e instanceof Error ? e.message : String(e)}` }
  }
  // 这次用到的、还没记过的仓库记进常用仓库，下次建项直接勾选
  addRepoProfilesIfMissing(plan.repos.map((r) => ({ path: r.repoPath, baseBranch: r.baseBranch })))
  return { ok: true, project }
}

/** 接入点没按要求接成的原因，合成一句话（建项结果的提示用） */
function bindingWarnings(outcomes: readonly ProjectBindingOutcome[]): string[] {
  return outcomes.filter((o) => !o.ok).map((o) => `「${o.channelName}」${o.warning ?? "没接成"}`)
}

/** 新建项目（应用里点「新建」）：建项核心 → 接入选好的通道 → 接了应用内对话的话进入项目会话 */
export async function createProjectFromApp(channelId: string, input: ProjectCreateInput): Promise<ProjectCreateResult> {
  ensureStore()
  const chatKey = appChatKeyOf(channelId)
  if (!chatKey) return { ok: false, error: "不是应用内对话的通道" }
  // 没选就只接当前这个应用内对话。接入点要在建目录、建群之前校验：选得不对，一个目录、一个群都不建
  const choices = input.bindings?.length ? input.bindings : [{ channelId, mode: "inline" as const }]
  const planned = planBindingChoices(choices, bindingChannelFacts(), channelId)
  if (!planned.ok) return planned
  const created = await createProjectCore(input)
  if (!created.ok) return created
  const project = created.project

  const lock = readLockFile()
  const outcomes = await attachPlannedBindings(lock?.port, project, planned.items)
  const warnings = bindingWarnings(outcomes)
  // 一个都没接成：项目不能没有入口（谁都看不到），退回应用内对话
  if (!outcomes.some((o) => o.ok)) connectMainBinding(project, channelId, chatKey)
  const sessionKeyIfBound = () => projectSessionKeyFor(getProject(project.id) ?? project, chatKey)
  const withWarnings = (extra?: string): { warning?: string } => {
    const all = [...(extra ? [extra] : []), ...warnings]
    return all.length ? { warning: all.join("；") } : {}
  }

  // 没接应用内对话（比如只接了飞书群）：项目建好了，不进会话，界面也没有会话可切
  if (!canEnterProjectFromChat(project, chatKey)) {
    return { ok: true, projectId: project.id, ...withWarnings("项目已创建并接入了所选的聊天；没有接入应用内对话，所以这里不会出现它的会话") }
  }
  if (!lock?.port) {
    return { ok: true, projectId: project.id, sessionKey: sessionKeyIfBound(), ...withWarnings("项目已创建，但服务未运行，会话稍后再进入") }
  }
  const entered = await enterProjectSession(lock.port, chatKey, project)
  if (!entered.ok) {
    pushUiLog("Project", "WARN", `[AppCreate] 项目 ${project.id} 已创建，进入会话失败: ${entered.error}`)
    return { ok: true, projectId: project.id, sessionKey: sessionKeyIfBound(), ...withWarnings(`项目已创建，但进入会话失败：${entered.error}`) }
  }
  return { ok: true, projectId: project.id, sessionKey: sessionKeyIfBound(), ...withWarnings() }
}

// ── AI 建项（管理 MCP 的 manage_project：templates / repos / channels / create）──────────────
// 和应用里点「新建」走同一套校验和落盘（createProjectCore），区别有三：
// 任何通道的主用户都能建（应用内、飞书、微信）；建完不进入项目会话，不打断 AI 正在跑的这一轮对话；
// 项目接入哪些通道由调用方明确指定（bindings，没有默认值，AI 要先问用户）：每个通道可以接主聊天（inline）、
// 新建飞书独立群（group）、绑定已有飞书群（bind）；应用内对话里的 AI 可以接任何通道，飞书 / 微信里只能接自己所在的通道。

/** 同一个聊天里同名项目只允许一个在途：AI 的调用超时后重试、或同一轮里连发两次，不会建出两个一模一样的项目 */
const aiCreateInFlight = new Set<string>()

type AiCreateWhere = {
  ok: true
  chatKey: string
  channelId: string
  channelName: string
  channelType: ChannelType
}

/**
 * 调用者的聊天键 → 它所在的通道。只认主用户：管理 MCP 本来就只挂给主用户的会话，这里再兜一层。
 * 应用内对话通道永远是主用户私聊，项目的「当前聊天」就是它固定的那个聊天（和应用里点「新建」一致）。
 */
function resolveAiCreateChat(chatKey: string): AiCreateWhere | { ok: false; error: string } {
  const { channelId } = parseChatKey(String(chatKey ?? ""))
  const channel = channelId ? getChannel(channelId) : undefined
  if (!channel) return { ok: false, error: "找不到你所在的消息通道，无法确定项目归属" }
  if (channel.type === "app") {
    return { ok: true, chatKey: makeChatKey(channel.id, APP_CHANNEL_CHAT_ID), channelId: channel.id, channelName: channel.name, channelType: "app" }
  }
  const audience = resolveChannelAudience({
    mainUserEnabled: channel.mainUserEnabled,
    mainUserChatId: channel.mainUserChatId,
    chatKey,
    chatType: "p2p",
  })
  if (audience !== "main") return { ok: false, error: "只有主用户的私聊可以创建项目" }
  return { ok: true, chatKey, channelId: channel.id, channelName: channel.name, channelType: channel.type }
}

/**
 * AI 建项：建好就返回，不进入项目会话、不动「当前项目」。
 * bindings 是项目接入的通道和方式（没有默认值，不给或给错直接报错，让 AI 去问用户）；先校验再建：
 * 校验不过、克隆失败都不会留下目录和群。建群或绑群这一步本身失败：项目保留，成功的接入照常，warning 里写明原因；
 * 一个都没接成就退回调用者当前的聊天，项目不会没有入口。
 */
export async function createProjectForAi(
  chatKey: string,
  input: ProjectCreateInput,
  bindings: ProjectBindingChoice[],
): Promise<AiProjectCreateResult> {
  ensureStore()
  const where = resolveAiCreateChat(chatKey)
  if (!where.ok) return where
  const planned = planBindingChoices(bindings, bindingChannelFacts(), where.channelId)
  if (!planned.ok) return planned
  const name = String(input?.name ?? "").trim()
  const flightKey = name ? `${where.chatKey}\n${name.toLowerCase()}` : ""
  if (flightKey && aiCreateInFlight.has(flightKey)) {
    return { ok: false, error: `「${name}」正在创建中（克隆仓库可能要一会儿），请稍后用 list 确认，不要重复提交` }
  }
  if (flightKey) aiCreateInFlight.add(flightKey)
  try {
    const created = await createProjectCore(input)
    if (!created.ok) return created
    const p = created.project

    const port = readLockFile()?.port
    const outcomes = await attachPlannedBindings(port, p, planned.items)
    const failed = bindingWarnings(outcomes)
    let fallback = false
    if (!outcomes.some((o) => o.ok)) {
      connectMainBinding(p, where.channelId, where.chatKey)
      outcomes.push({ channelId: where.channelId, channelName: where.channelName, ok: true, mode: "inline" })
      fallback = true
    }
    const warning = failed.length
      ? `${failed.join("；")}。项目已经建好${fallback ? `，退回绑在你当前所在的「${where.channelName}」主聊天上` : "，其余接入照常"}。请如实告诉用户，由他决定怎么处理（比如用 bind 补接，或删掉这个项目重建）。`
      : undefined
    pushUiLog("Project", "INFO", `[AiCreate] AI 创建了项目「${p.name}」(${p.id})，调用者 ${where.chatKey}，接入 ${outcomes.map((o) => `${o.channelName}:${o.mode}${o.ok ? "" : "(失败)"}`).join("、")}`)
    return {
      ok: true,
      projectId: p.id,
      name: p.name,
      dir: projectRootDir(p) || p.worktreePath,
      templateName: projectGroups(p).map((g) => g.name).join("、"),
      bindings: outcomes,
      ...(warning ? { warning } : {}),
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
  "project.channels": (payload): AiProjectChannelsResult => {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>
    const where = resolveAiCreateChat(strOf(p.chatKey) ?? "")
    if (!where.ok) return where
    return { ok: true, current: where.channelId, channels: projectChannelOptions(bindingChannelFacts(), where.channelId) }
  },
  "project.create": (payload) => {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>
    const raw = (p.input && typeof p.input === "object" ? p.input : {}) as Record<string, unknown>
    const folder = strOf(raw.folder)
    const input: ProjectCreateInput = { ...parseGatewayCreateInput(raw), ...(folder ? { folder } : {}) }
    return createProjectForAi(strOf(p.chatKey) ?? "", input, parseBindingChoices(p.bindings))
  },
  "project.bind": (payload) => {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>
    return bindProjectForAi(strOf(p.chatKey) ?? "", strOf(p.projectId) ?? "", parseBindingChoices(p.bindings))
  },
  "project.unbind": (payload) => {
    const p = (payload && typeof payload === "object" ? payload : {}) as Record<string, unknown>
    const choice = parseBindingChoices([p.binding])[0]
    if (!choice) return { ok: false, error: "要指明取消哪个接入：channel_id + mode" }
    return unbindProjectForAi(strOf(p.chatKey) ?? "", strOf(p.projectId) ?? "", choice)
  },
}

// ── 给已有项目增减接入点（AI 用 manage_project bind / unbind，设置页项目详情用 *FromSettings） ──

/** AI 补接入：项目要是接入了调用者所在通道的项目才能动；能接到哪些通道同建项 */
async function bindProjectForAi(chatKey: string, projectId: string, choices: ProjectBindingChoice[]): Promise<ProjectBindResult> {
  ensureStore()
  const where = resolveAiCreateChat(chatKey)
  if (!where.ok) return where
  const p = getProject(projectId.trim())
  if (!p || !isProjectOwnedBy(p, where.channelId)) return { ok: false, error: "未找到项目（只能管接入了当前消息通道的项目）" }
  return bindProjectChoices(p, choices, where.channelId)
}

async function unbindProjectForAi(chatKey: string, projectId: string, choice: ProjectBindingChoice): Promise<ProjectUnbindResult> {
  ensureStore()
  const where = resolveAiCreateChat(chatKey)
  if (!where.ok) return where
  const p = getProject(projectId.trim())
  if (!p || !isProjectOwnedBy(p, where.channelId)) return { ok: false, error: "未找到项目（只能管接入了当前消息通道的项目）" }
  return unbindProjectChoice(p, choice, where.channelId)
}

/** 设置页是本机管理员在操作：按应用内通道的权限（能动任何通道、任何项目） */
function localAdminChannelId(): string | undefined {
  return getChannels().find((c) => c.type === "app")?.id
}

/** 建项对话框 / 设置页的通道清单：能接哪些通道、各自能用什么方式。channelId 是对话框所在的应用内通道；设置页不传 */
export function listProjectChannelOptions(channelId?: string): ProjectChannelOption[] {
  return projectChannelOptions(bindingChannelFacts(), channelId || localAdminChannelId())
}

export async function bindProjectFromSettings(projectId: string, choices: ProjectBindingChoice[]): Promise<ProjectBindResult> {
  ensureStore()
  const p = getProject(String(projectId || "").trim())
  if (!p) return { ok: false, error: "项目不存在" }
  return bindProjectChoices(p, parseBindingChoices(choices), localAdminChannelId())
}

export async function unbindProjectFromSettings(projectId: string, choice: ProjectBindingChoice): Promise<ProjectUnbindResult> {
  ensureStore()
  const p = getProject(String(projectId || "").trim())
  if (!p) return { ok: false, error: "项目不存在" }
  const parsed = parseBindingChoices([choice])[0]
  if (!parsed) return { ok: false, error: "要指明取消哪个接入" }
  return unbindProjectChoice(p, parsed, localAdminChannelId())
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
  // 停每个入口上的会话 Agent、清路由和应用内聊天记录、把停在它上面的聊天挪回主会话，都在 executeProjectDelete 里做
  const r = await executeProjectDelete(id)
  if (!r.ok) return { ok: false, error: "删除失败" }
  if (lock?.port) await archiveProjectGroup(lock.port, target)
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
function releaseArchivedProject(project: Pick<Project, "id" | "bindings">): void {
  clearCurrentProjectOf(project.id)
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
