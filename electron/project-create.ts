// ── 应用内建项目 / 推进步骤 / 项目信息（桌面端 IPC 与手机端网关共用） ─────────────
// 项目归属：在应用里建的项目绑在「应用内对话」通道上，会话键 = <应用通道>|app_main::project_<id>。
// 不动飞书私聊用的全局「当前项目」指针（建项和推进步骤都显式指定项目，不读那个指针）。

import { app } from "electron"
import * as fs from "node:fs"
import * as path from "node:path"
import { addRepoProfilesIfMissing, findRepoProfile, getChannel, getConfig, getRepoProfiles } from "./config-store"
import { readLockFile, resolveMainChatId } from "./daemon-client"
import { reportCommandResult } from "./command-handler"
import {
  archiveProjectGroup,
  defaultFeatureBranch,
  enterProjectSession,
  executeProjectDelete,
  startProjectNode,
  uniqueProjectSlug,
} from "./project-commands"
import { leaveProjectSession, stopSessionAgent } from "./session-dispatcher"
import { addProjectClone, ensureArtifactDir, inspectLocalRepo, isUsableRepoRef, isValidBranchName, removeDirRobust } from "./project-worktree"
import { pushUiLog } from "./ui-logger"
import {
  projectNotOwnedHint,
  repoDisplayName,
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
  planProjectCreate,
  syncedSnapshot,
  templateInfos,
  type ProjectCreatePlan,
} from "../src/shared/project-create-plan.js"
import {
  createProject,
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
import { APP_CHANNEL_CHAT_ID, makeChatKey } from "../src/shared/channel-types.js"
import { projectRootDir, projectSessionKey, repoShortName, type Project, type ProjectRepo } from "../src/shared/project-types.js"

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
  return getRepoProfiles().map((p) => ({ path: p.path, name: repoDisplayName(p.path), baseBranch: p.baseBranch }))
}

/** 桌面端「添加本地仓库」：确认是 git 仓库根目录，给出默认基线分支和分支提示 */
export async function inspectProjectRepo(repoPath: string): Promise<InspectRepoResult> {
  const dir = String(repoPath ?? "").trim()
  const r = await inspectLocalRepo(dir)
  if (!r.ok) return { ok: false, error: r.error }
  return { ok: true, path: path.resolve(dir), name: repoDisplayName(dir), baseBranch: r.info.defaultBranch, branches: r.info.branches }
}

/** 项目文件夹的存放根目录：设置里配了就用它，没配用应用数据目录下的 claw-projects */
export function projectsRootDir(): string {
  return (getConfig().worktreeRoot || "").trim() || path.join(app.getPath("userData"), "claw-projects")
}

type FolderWorkspace = { ok: true; workDir: string; external: boolean } | { ok: false; error: string }

/** 不接代码仓库的项目：用户选的已有文件夹，或在存放根目录下新建一个 */
function prepareFolderWorkspace(name: string, folder: string | undefined): FolderWorkspace {
  if (folder?.trim()) {
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
    return { ok: true, workDir: checked.dir, external: true }
  }
  const workDir = path.join(projectsRootDir(), uniqueProjectSlug(name), "workspace")
  try {
    fs.mkdirSync(workDir, { recursive: true })
  } catch (e: unknown) {
    return { ok: false, error: `无法创建项目目录：${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, workDir, external: false }
}

/**
 * 占一个项目目录：不递归地 mkdir，同名已经存在就换个名字再试。
 * 「检查不存在」和「创建」是一步完成的，两个同名项目同时在建时不会拿到同一个目录
 * （否则后到的那个失败清理时，会把先到的那份克隆一起删掉）；磁盘上没人认领的同名旧目录也不会撞上。
 */
function claimProjectDir(root: string, slug: string): { ok: true; dir: string } | { ok: false; error: string } {
  try {
    fs.mkdirSync(root, { recursive: true })
    for (let i = 0; i < 20; i++) {
      const dir = path.join(root, i === 0 ? slug : `${slug}-${Date.now().toString(36)}${i > 1 ? i : ""}`)
      try {
        fs.mkdirSync(dir)
        return { ok: true, dir }
      } catch (e: unknown) {
        if ((e as NodeJS.ErrnoException)?.code !== "EEXIST") throw e
      }
    }
    return { ok: false, error: `无法创建项目目录：「${slug}」的同名目录太多` }
  } catch (e: unknown) {
    return { ok: false, error: `无法创建项目目录：${e instanceof Error ? e.message : String(e)}` }
  }
}

/** 落盘失败后收拾新建的空目录：只删空的（目录里已经有东西就不是这次建的，不动），用户自己选的文件夹不会走到这里 */
async function dropEmptyWorkspace(workDir: string): Promise<void> {
  for (const dir of [workDir, path.dirname(workDir)]) {
    try { await fs.promises.rmdir(dir) } catch { return }
  }
}

type CodeWorkspace =
  | { ok: true; repos: ProjectRepo[]; featureBranch: string; undo: () => Promise<void> }
  | { ok: false; error: string }

/**
 * 接代码仓库的项目：给每个仓库克隆一份独立的工作目录并检出 feature 分支（用户自己的仓库不动）。
 * 任何一步失败都把已经克隆好的清掉再报错，不留半成品；调用方在后面落盘失败时也用 undo 收拾。
 */
async function prepareCodeWorkspace(plan: Extract<ProjectCreatePlan, { ok: true }>): Promise<CodeWorkspace> {
  const featureBranch = plan.featureBranch || defaultFeatureBranch(plan.name)
  if (!(await isValidBranchName(featureBranch))) {
    return { ok: false, error: `feature 分支名不合法：${featureBranch}（不能有空格，也不能以 - 开头）` }
  }
  for (const r of plan.repos) {
    const label = repoDisplayName(r.repoPath)
    if (!(await isValidBranchName(r.baseBranch))) return { ok: false, error: `「${label}」的基线分支名不合法：${r.baseBranch}` }
    if (!(await isUsableRepoRef(r.repoPath))) {
      return { ok: false, error: `「${label}」不是可用的仓库：本地要选 git 仓库的根目录，远程要 http(s)、ssh 或 git@ 开头的地址（${r.repoPath}）` }
    }
  }

  const claimed = claimProjectDir(projectsRootDir(), uniqueProjectSlug(plan.name))
  if (!claimed.ok) return { ok: false, error: claimed.error }
  const slugDir = claimed.dir

  const repos: ProjectRepo[] = []
  // slugDir 是上面刚建出来的（不是原来就有的），里面的东西全是这次克隆出来的，整个删掉
  const undo = () => removeDirRobust(slugDir)

  const usedNames = new Set<string>()
  for (const r of plan.repos) {
    let short = repoShortName(r.repoPath)
    // 两个仓库同名（不同位置的 foo）：目录名加序号
    for (let i = 2; usedNames.has(short.toLowerCase()); i++) short = `${repoShortName(r.repoPath)}-${i}`
    usedNames.add(short.toLowerCase())
    const worktreePath = path.join(slugDir, short)
    const cloned = await addProjectClone({ repoPath: r.repoPath, worktreePath, featureBranch, baseBranch: r.baseBranch })
    if (!cloned.ok) {
      await undo()
      return { ok: false, error: `「${repoDisplayName(r.repoPath)}」${cloned.error ?? "克隆失败"}` }
    }
    // 常用仓库里配过测试/开发分支的，带到项目里（研发流程的提示词要用）
    const known = findRepoProfile(r.repoPath)
    repos.push({
      repoPath: r.repoPath,
      baseBranch: r.baseBranch,
      ...(known?.testBranch ? { testBranch: known.testBranch } : {}),
      ...(known?.developBranch ? { developBranch: known.developBranch } : {}),
      worktreePath,
    })
  }
  try {
    for (const r of repos) await ensureArtifactDir(r.worktreePath)
  } catch (e: unknown) {
    await undo()
    return { ok: false, error: `无法准备成果目录：${e instanceof Error ? e.message : String(e)}` }
  }
  return { ok: true, repos, featureBranch, undo }
}

/** 新建项目：校验 → 准备目录（或克隆仓库）→ 落盘（带模板副本）→ 进入项目会话 */
export async function createProjectFromApp(channelId: string, input: ProjectCreateInput): Promise<ProjectCreateResult> {
  ensureStore()
  const chatKey = appChatKeyOf(channelId)
  if (!chatKey) return { ok: false, error: "不是应用内对话的通道" }

  const plan = planProjectCreate(input, getNodeGroups())
  if (!plan.ok) return { ok: false, error: plan.error }

  const isCode = plan.group.workspace !== "plain"
  let folder: Extract<FolderWorkspace, { ok: true }> | undefined
  let code: Extract<CodeWorkspace, { ok: true }> | undefined
  if (isCode) {
    const prepared = await prepareCodeWorkspace(plan)
    if (!prepared.ok) return { ok: false, error: prepared.error }
    code = prepared
  } else {
    const prepared = prepareFolderWorkspace(plan.name, input.folder)
    if (!prepared.ok) return { ok: false, error: prepared.error }
    folder = prepared
  }

  // createProject 会把它设成全局当前项目；应用内建项不该改飞书私聊正在用的那个，建完还原
  const prevCurrent = getCurrentProjectId()
  let project: Project
  try {
    const primary = code?.repos[0]
    project = createProject({
      name: plan.name,
      goal: plan.goal,
      ...(plan.storyUrl ? { storyUrl: plan.storyUrl } : {}),
      ...(plan.relatedDocs ? { relatedDocs: plan.relatedDocs } : {}),
      repoPath: primary?.repoPath ?? "",
      baseBranch: primary?.baseBranch ?? "",
      featureBranch: code?.featureBranch ?? "",
      worktreePath: primary?.worktreePath ?? folder!.workDir,
      ...(code ? { repos: code.repos } : {}),
      groupIds: [plan.group.id],
      groupId: plan.group.id,
      groupSnapshot: snapshotGroups([plan.group]),
      workspaceType: code ? "worktree" : "plain",
      ...(folder?.external ? { externalWorkspace: true } : {}),
      metadata: plan.metadata,
      notifyChatId: chatKey,
    })
  } catch (e: unknown) {
    await code?.undo()
    if (folder && !folder.external) await dropEmptyWorkspace(folder.workDir)
    setCurrentProjectId(prevCurrent)
    return { ok: false, error: `无法保存项目：${e instanceof Error ? e.message : String(e)}` }
  }
  setCurrentProjectId(prevCurrent)
  if (code) addRepoProfilesIfMissing(code.repos.map((r) => ({ path: r.repoPath, baseBranch: r.baseBranch })))

  project.sessionKey = projectSessionKey(chatKey, project.id)
  saveProject(project)

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
 * 归档后飞书专属群不再认领它、定时任务和 AI 排程不再投给它、也不再盯缺陷（见 archivedAt 的说明）。
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
  return { ok: true, name: target.name }
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
