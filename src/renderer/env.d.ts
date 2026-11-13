import type { AgentResource as AgentResourceType, MessageChannel, ChannelStatusInfo as ChannelStatusInfoType } from "../shared/channel-types"
import type { ScheduledTask as ScheduledTaskType } from "../shared/scheduled-task"
import type { SessionScheduleItem as SessionScheduleItemType } from "../shared/session-schedule"
import type {
  ChannelImpactClearResult as ChannelImpactClearResultType,
  ChannelImpactPreviewResult as ChannelImpactPreviewResultType,
  ChannelImpactStopResult as ChannelImpactStopResultType,
} from "../shared/channel-model-impact"
import type {
  CleanupPreviewResult as CleanupPreviewResultType,
  CleanupRunResult as CleanupRunResultType,
  ManagerListResult as ManagerListResultType,
  ManagerOpResult as ManagerOpResultType,
} from "../shared/managed-sessions"
import type {
  AppChatEvent as AppChatEventType,
  AppChatResult as AppChatResultType,
  AppChatSendPayload as AppChatSendPayloadType,
} from "../shared/app-chat-types"
import type { HistoryQuery as HistoryQueryType } from "../shared/app-chat-history-page"
import type {
  BranchListResult as BranchListResultType,
  BranchSwitchResult as BranchSwitchResultType,
  BranchTarget as BranchTargetType,
} from "../shared/git-branch"
import type { ProjectNodeGroupDef as ProjectNodeGroupDefType } from "../shared/project-types"
import type {
  InspectRepoResult as InspectRepoResultType,
  ProjectActionResult as ProjectActionResultType,
  ProjectCreateInput as ProjectCreateInputType,
  ProjectCreateResult as ProjectCreateResultType,
  ProjectListItem as ProjectListItemType,
  ProjectRepoOption as ProjectRepoOptionType,
  ProjectTemplateInfo as ProjectTemplateInfoType,
  ProjectView as ProjectViewType,
} from "../shared/project-app-types"
import type {
  PreviewBytesResult as PreviewBytesResultType,
  PreviewOpenResult as PreviewOpenResultType,
  PreviewRect as PreviewRectType,
  PreviewTextResult as PreviewTextResultType,
  PreviewWebNav as PreviewWebNavType,
  PreviewWebOpenTab as PreviewWebOpenTabType,
  PreviewWebState as PreviewWebStateType,
  PreviewZipResult as PreviewZipResultType,
} from "../shared/preview-types"

declare global {
  type AgentResource = AgentResourceType
  type ChannelStatusInfo = ChannelStatusInfoType
  type ScheduledTask = ScheduledTaskType
  /** 注意：避免与 DOM 内置 MessageChannel 类型冲突，这里别名为 ChannelConfig */
  type ChannelConfig = MessageChannel

  interface AppConfig {
    agentResources: AgentResource[]
    channels: ChannelConfig[]
    workspaceDir: string
    favoriteWorkspaces?: string[]
    favoriteModels?: { model: string; modelParams?: string; label?: string; resourceId?: string }[]
    autoStart: boolean
    setupComplete: boolean
    httpProxy: string
    httpsProxy: string
    noProxy: string
    closeWindowAction: "ask" | "minimize" | "quit"
    theme: "system" | "light" | "dark"
    autoUpgradePrompt?: boolean
    silentUpdate?: boolean
    silentUpdateIdleRestart?: boolean
    allowOthers: boolean
    digitalIdentity: string
    // 旧字段（Setup 向导兼容）
    larkAppId: string
    larkAppSecret: string
    larkAppQuickCreated: boolean
    larkReceiveId: string
    model: string
    modelParams: string
    agentNewSession: boolean
    feishuEnabled: boolean
    wechatEnabled: boolean
    wechatToken: string
    wechatAccountId: string
    agentMode: "sdk"
    cursorApiKey: string
    gitlabToken?: string
    gitlabHost?: string
    flowHubUrl?: string
    flowHubToken?: string
    flowHubAuthor?: string
    repoRoots?: string[]
    repoProfiles?: { path: string; baseBranch: string; testBranch?: string; developBranch?: string }[]
    worktreeRoot?: string
  }

  interface SkillTreeNode {
    name: string
    type: "file" | "directory"
    children?: SkillTreeNode[]
  }

  interface McpServerEntry {
    name: string
    type: "command" | "url"
    command?: string
    args?: string[]
    url?: string
    env?: Record<string, string>
    source: "harness"
    authenticated?: boolean
    rawConfig?: Record<string, unknown>
    enabled?: boolean
  }

  interface DaemonStatus {
    running: boolean
    starting?: boolean
    version?: string
    uptime?: number
    queueLength?: number
    queueCounts?: { pending: number; processing: number }
    hasChatId?: boolean
    agentRunning?: boolean
    agentPid?: number | null
    sessionAgentCount?: number
    error?: string
    workspaceMismatch?: boolean
    daemonWorkspaceDir?: string
    channels?: ChannelStatusInfo[]
    feishuEnabled?: boolean
    feishuConnected?: boolean
    wechatEnabled?: boolean
    wechatStatus?: string
    wechatReady?: boolean
  }

  interface AppModalRequestPayload {
    requestId: string
    title: string
    message: string
    detail?: string
    buttons: string[]
    defaultId?: number
    cancelId?: number
    variant?: "info" | "error" | "warning"
  }

  interface ConfigSaveResult {
    ok: boolean
    needWorkspaceConfirm?: boolean
    oldWorkspaceDir?: string
    newWorkspaceDir?: string
    existingSessions?: { sessionKey: string; chatName?: string }[]
    deferredSetupComplete?: boolean
    workspaceDirChanged?: boolean
  }

  interface MobileServerStatus {
    enabled: boolean
    running: boolean
    port: number
    token: string
    publicUrl: string
    lanUrls: string[]
    pairUrl: string
    pairPayload: { v: 1; name: string; token: string; pub: string; lan: string }
    qrDataUrl: string
    /** 安装包里内置的手机端 APK：版本，和各个地址下的下载链接（局域网优先）；没有内置时是 null */
    apk: { version: string; urls: string[] } | null
    error?: string
  }

  interface ElectronAPI {
    getAppVersion(): Promise<string>
    checkAppUpdate(): Promise<
      | { status: "dev"; currentVersion: string; message: string }
      | { status: "error"; currentVersion: string; message: string }
      | { status: "latest"; currentVersion: string; latestVersion: string }
      | {
          status: "available"
          currentVersion: string
          latestVersion: string
          htmlUrl: string
          applyHint: string
          releaseNotes: string
        }
      | {
          status: "ready"
          currentVersion: string
          latestVersion: string
          htmlUrl: string
          applyHint: string
          releaseNotes: string
        }
    >
    applyAppUpdate(): Promise<{ ok: boolean; error?: string; message?: string; downloadUrl?: string }>
    onUpdaterProgress(cb: (percent: number) => void): () => void
    onUpdaterError(cb: (message: string) => void): () => void
    onUpdaterStatus(cb: (payload: { kind: "available" } | { kind: "downloaded"; version: string; silent?: boolean; idleRestart?: boolean } | { kind: "downloading" } | { kind: "retrying"; message: string }) => void): () => void
    getConfig(): Promise<AppConfig>
    getProjectNodeGroups(): Promise<(Omit<ProjectNodeGroupDefType, "nodes"> & { nodes: (ProjectNodeGroupDefType["nodes"][number] & { defaultPrompt?: string })[] })[]>
    saveProjectNodeGroups(groups: ProjectNodeGroupDefType[]): Promise<{ ok: boolean }>
    getProjectNodeGroupUsage(): Promise<Record<string, number>>
    exportProjectNodeGroup(groupId: string): Promise<{ ok: boolean; path?: string; error?: string }>
    importProjectNodeGroup(): Promise<{ ok: boolean; group?: ProjectNodeGroupDefType; error?: string }>
    exportConfig(sections?: string[]): Promise<{ ok: boolean; path?: string; error?: string }>
    pickImportConfigFile(): Promise<{ ok: boolean; filePath?: string; sections?: string[]; items?: { id: string; label: string; count: number }[]; error?: string }>
    getLocalConfigSectionStats(): Promise<{ id: string; label: string; count: number }[]>
    importConfig(filePath: string, sections?: string[]): Promise<{ ok: boolean; error?: string; warnings?: string[] }>
    flowHub: {
      getCatalog(force?: boolean): Promise<{ ok: true; catalog: import("../shared/flow-hub-types").FlowHubCatalog } | { ok: false; error: string }>
      listNodes(): Promise<{ ok: true; nodes: import("../shared/flow-hub-types").FlowHubBrowsableNode[] } | { ok: false; error: string }>
      getSyncStatus(kind: "group" | "node", hubId: string, contentHash: string): Promise<import("../shared/flow-hub-types").FlowHubSyncStatus>
      importGroup(hubId: string): Promise<{ ok: true; group: unknown } | { ok: false; error: string }>
      importNode(hubId: string, targetGroupId: string, opts?: { groupHubId?: string; nodeLocalId?: string }): Promise<{ ok: true; node: unknown } | { ok: false; error: string }>
      uploadGroup(groupId: string): Promise<{ ok: true } | { ok: false; error: string }>
      uploadNode(groupId: string, nodeId: string): Promise<{ ok: true } | { ok: false; error: string }>
      syncGroup(hubId: string, mode: "overwrite" | "keep"): Promise<{ ok: true } | { ok: false; error: string }>
      syncNode(hubId: string, targetGroupId: string, mode: "overwrite" | "keep", opts?: { groupHubId?: string; nodeLocalId?: string }): Promise<{ ok: true } | { ok: false; error: string }>
      preview(kind: "group" | "node", hubId: string, nodeLocalId?: string): Promise<{ ok: true; name: string; prompt?: string } | { ok: false; error: string }>
    }
    saveConfig(config: Partial<AppConfig>): Promise<ConfigSaveResult>
    setAutoStart(enabled: boolean): Promise<{ ok: boolean }>
    setTheme(theme: AppConfig["theme"]): Promise<{ ok: boolean }>
    applyWorkspaceSwitch(workspaceDir: string, stopOldSessions: boolean, notifyMain?: boolean): Promise<{ ok: boolean; error?: string }>
    respondWindowClose(payload: { action: "minimize" | "quit" | "cancel"; remember: boolean }): Promise<void>
    selectDirectory(): Promise<string | null>
    getToolboxStatus(): Promise<{ larkCli: { installed: boolean; version?: string; loggedIn?: boolean; userName?: string }; meegle: { installed: boolean; version?: string }; nodeOk?: boolean; nodeVersion?: string }>
    installToolboxTool(key: "larkCli" | "meegle"): Promise<{ ok: boolean; error?: string }>
    loginLarkCli(): Promise<{ ok: boolean; error?: string }>
    /** 带 query.limit 只给最近一页（返回 hasMore），query.before* 往前翻页；不带 query 是整段历史 */
    appChatHistory(sessionKey: string, query?: HistoryQueryType): Promise<AppChatResultType>
    appChatSend(payload: AppChatSendPayloadType): Promise<AppChatResultType>
    appChatClear(target: { sessionKey?: string; channelId?: string }): Promise<AppChatResultType>
    appChatDeleteSession(sessionKey: string): Promise<AppChatResultType>
    appChatRenameSession(sessionKey: string, name: string): Promise<AppChatResultType>
    appChatQueueEdit(sessionKey: string, messageId: string, text: string): Promise<AppChatResultType>
    appChatQueueRemove(sessionKey: string, messageId: string): Promise<AppChatResultType>
    /** 带 dir 时新会话直接选好这个工作目录 */
    appChatNewTempSession(channelId: string, dir?: string): Promise<AppChatResultType>
    /** 给还没开始的临时会话选（或改选）工作目录；会话开始后不能再换 */
    appChatSetSessionDir(sessionKey: string, dir: string): Promise<AppChatResultType>
    appChatUsage(channelId: string): Promise<AppChatResultType>
    appChatLastActive(sessionKeys: string[]): Promise<AppChatResultType>
    appChatSaveImage(bytes: ArrayBuffer, ext: string): Promise<{ ok: true; path: string } | { ok: false; error: string }>
    appChatReadImage(file: string): Promise<{ ok: true; dataUrl: string } | { ok: false; error: string }>
    appChatCopyImage(file: string): Promise<{ ok: boolean; error?: string }>
    appChatSaveImageAs(file: string): Promise<{ ok: boolean; canceled?: boolean; error?: string }>
    appChatOpenFile(file: string): Promise<{ ok: boolean; error?: string }>
    appChatShowInFolder(file: string): Promise<{ ok: boolean; error?: string }>
    /** 校验这个文件能给这个会话看（会话记录里出现过，或在工作目录内）后登记预览令牌 */
    previewFileOpen(sessionKey: string, file: string): Promise<PreviewOpenResultType>
    previewFileText(token: string): Promise<PreviewTextResultType>
    previewFileBytes(token: string): Promise<PreviewBytesResultType>
    previewFileZip(token: string): Promise<PreviewZipResultType>
    /** 批量检查对话里出现的路径能不能预览（相对路径按工作目录解析）：能的是绝对路径，不能的是 null，和输入一一对应 */
    previewFileCheck(sessionKey: string, paths: string[]): Promise<(string | null)[]>
    /** 打开（或让已有标签页跳转到）网页；加载结果经 onPreviewWebState 推回 */
    previewWebOpen(tabId: string, url: string): Promise<{ ok: boolean; error?: string }>
    previewWebNav(tabId: string, action: PreviewWebNavType): Promise<{ ok: boolean }>
    /** 让这个标签页的原生网页视图显示在给定位置、其余全部隐藏；tabId 或 rect 为 null 就全部隐藏 */
    previewWebBounds(tabId: string | null, rect: PreviewRectType | null): void
    previewWebClose(tabId: string): Promise<{ ok: boolean }>
    previewWebSnapshot(tabId: string): Promise<{ ok: true; dataUrl: string } | { ok: false }>
    previewWebClearData(): Promise<{ ok: boolean }>
    previewOpenExternalUrl(url: string): Promise<{ ok: boolean; error?: string }>
    onPreviewWebState(cb: (state: PreviewWebStateType) => void): () => void
    onPreviewWebOpenTab(cb: (payload: PreviewWebOpenTabType) => void): () => void
    appChatTitles(): Promise<Record<string, string>>
    onAppChatTitles(cb: (titles: Record<string, string>) => void): () => void
    appChatPins(): Promise<string[]>
    appChatSetPinned(sessionKey: string, pinned: boolean): Promise<AppChatResultType>
    onAppChatPins(cb: (pins: string[]) => void): () => void
    /** 会话工作目录的分支列表（现读 git）；项目会话、没选目录的会话返回原因 */
    appChatListBranches(sessionKey: string): Promise<BranchListResultType>
    appChatSwitchBranch(sessionKey: string, target: BranchTargetType): Promise<BranchSwitchResultType>
    /** 分支被切换了（手机端切的也会推）：重新读会话列表上的分支 */
    onAppChatBranchChanged(cb: () => void): () => void
    onAppChatEvent(cb: (event: AppChatEventType) => void): () => void
    /** 对话页告诉主进程用户正看着哪个会话（不在对话页传 null）；主进程据此决定要不要弹「回复完成」通知 */
    appChatViewing(sessionKey: string | null): void
    /** 点了「回复完成」通知：主进程已把窗口唤到前台，界面要切到这个会话 */
    onAppChatOpenSession(cb: (sessionKey: string) => void): () => void
    mobileStatus(): Promise<MobileServerStatus>
    mobileUpdate(patch: { enabled?: boolean; port?: number; publicUrl?: string }): Promise<MobileServerStatus>
    mobileResetToken(): Promise<MobileServerStatus>
    startDaemon(): Promise<{ ok: boolean; error?: string }>
    stopDaemon(): Promise<void>
    stopAgent(): Promise<{ ok: boolean }>
    getSessionAgents(): Promise<{ sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string; source?: "sdk" | "llm"; model?: string; modelParams?: string; resourceId?: string }[]>
    getSessionDiagnostics(sessionKey: string): Promise<{ running: boolean; resumeAgentId?: string; resumeUpdatedAt?: number; lastRun?: { status: string; endedAt: number; durationMs?: number; error?: string }; lastReplyAt: number | null }>
    exportDiagnostics(): Promise<{ ok: boolean; path?: string; error?: string }>
    stopSessionAgent(sessionKey: string, clearQueue?: boolean): Promise<{ ok: boolean }>
    /** via：soft=只打断当前回合（Agent 没重启）；launching=Agent 正在拉起，等它起来；relaunch/hard=重新拉起 */
    sendQueuedNow(sessionKey: string): Promise<{ ok: boolean; error?: string; via?: "soft" | "launching" | "relaunch" | "hard" }>
    setSessionModel(sessionKey: string, model: string, modelParams?: string, resourceId?: string): Promise<{ ok: boolean; deferred?: boolean; error?: string }>
    listSessionTabs(): Promise<{ ok: boolean; chatId?: string; activeKey?: string; tabs: { sessionKey: string; label: string; kind: "main" | "project" | "dir" | "temp" | "other"; running: boolean; current: boolean; removable?: boolean; model?: string; modelParams?: string; resourceId?: string }[]; error?: string }>
    listDashboardTree(): Promise<{
      ok: boolean
      channels: {
        channelId: string
        name: string
        mainUserChatId?: string
        mainTabs: { sessionKey: string; label: string; kind: "main" | "project" | "dir" | "temp" | "other"; running: boolean; current: boolean; removable?: boolean; archived?: boolean; branch?: string; boundDir?: string; model?: string; modelParams?: string; resourceId?: string }[]
        activeKey?: string
      }[]
      running: { sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string; source?: "sdk" | "llm"; model?: string; modelParams?: string; resourceId?: string }[]
      error?: string
    }>
    getSessionModels(sessionKeys: string[]): Promise<Record<string, { model?: string; modelParams?: string; resourceId?: string }>>
    addChannelFavoriteWorkspace(channelId: string, dir: string): Promise<{ ok: boolean; favoriteWorkspaces?: string[]; error?: string }>
    switchSession(sessionKey: string): Promise<{ ok: boolean; error?: string }>
    deleteSession(sessionKey: string): Promise<{ ok: boolean; error?: string; label?: string }>
    listManagedSessions(): Promise<ManagerListResultType>
    restoreSessionDefault(sessionKey: string): Promise<ManagerOpResultType>
    resetManagedSession(sessionKey: string): Promise<ManagerOpResultType>
    deleteManagedSession(sessionKey: string): Promise<ManagerOpResultType>
    previewSessionCleanup(opts: { olderThanDays?: number; channelId?: string }): Promise<CleanupPreviewResultType>
    runSessionCleanup(opts: { olderThanDays?: number; channelId?: string; sessionKeys: string[] }): Promise<CleanupRunResultType>
    previewChannelModelImpact(channelId: string, draft: unknown): Promise<ChannelImpactPreviewResultType>
    clearOthersModelOverrides(channelId: string): Promise<ChannelImpactClearResultType>
    stopOthersFollowingDefault(channelId: string): Promise<ChannelImpactStopResultType>
    listProjects(): Promise<ProjectListItemType[]>
    deleteProject(projectId: string, channelId?: string): Promise<{ ok: boolean; name?: string; error?: string }>
    setProjectArchived(projectId: string, archived: boolean, channelId?: string): Promise<{ ok: boolean; name?: string; error?: string }>
    updateProject(patch: {
      id: string; name?: string; goal?: string; storyUrl?: string; relatedDocs?: string; productDocUrl?: string; techDocUrl?: string
      groupId?: string; groupIds?: string[]; metadata?: Record<string, string>
    }): Promise<{ ok: boolean; error?: string }>
    listProjectTemplates(): Promise<ProjectTemplateInfoType[]>
    getProjectsRootDir(): Promise<string>
    listProjectRepoOptions(): Promise<ProjectRepoOptionType[]>
    inspectProjectRepo(repoPath: string): Promise<InspectRepoResultType>
    createProjectInApp(channelId: string, input: ProjectCreateInputType): Promise<ProjectCreateResultType>
    getProjectView(projectId: string, channelId: string): Promise<ProjectViewType | null>
    runProjectStep(channelId: string, projectId: string, nodeId: string): Promise<ProjectActionResultType>
    syncProjectSteps(projectId: string): Promise<ProjectActionResultType>
    listQuickModels(): Promise<{ ok: boolean; models: { model: string; modelParams?: string; label?: string; resourceId?: string }[] }>
    forgetQuickModel(model: string, modelParams?: string, resourceId?: string): Promise<{ ok: boolean }>
    stopAllSessionAgents(): Promise<{ ok: boolean }>
    onSessionAgents(cb: (list: { sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string; source?: "sdk" | "llm"; model?: string; modelParams?: string; resourceId?: string }[]) => void): () => void
    getDaemonStatus(): Promise<DaemonStatus>
    getLogBuffer(): Promise<string[]>
    getQueueMessages(): Promise<{ index: number; fileId: string; preview: string; status?: "pending" | "processing"; sessionKey?: string; chatType?: string; timestamp?: number; senderOpenId?: string; sessionLabel?: string; channelName?: string; audience?: "main" | "others" }[]>
    deleteQueueMessage(fileId: string): Promise<boolean>
    clearQueueMessages(): Promise<number>
    listModels(): Promise<{ ok: boolean; models: { id: string; label: string; current: boolean }[]; error?: string }>
    checkSdkApiKey(apiKey: string): Promise<{ ok: boolean; email?: string; error?: string }>
    verifyLlmResource(resource: AgentResource): Promise<{ ok: boolean; email?: string; error?: string }>
    listLlmModels(resource: AgentResource, currentModel?: string, currentParams?: string): Promise<{ ok: boolean; models: { id: string; label: string; current?: boolean }[]; error?: string }>
    listSdkModels(apiKey: string, currentModel?: string, currentParams?: string): Promise<{ ok: boolean; models: { id: string; label: string; params: string; current: boolean }[]; error?: string }>
    getScheduledTasks(): Promise<ScheduledTask[]>
    saveScheduledTasks(tasks: ScheduledTask[]): Promise<{ ok: boolean }>
    validateCron(expression: string): Promise<boolean>
    previewCronNextRuns(expression: string): Promise<{ ok: true; runs: string[] } | { ok: false; error: string }>
    triggerScheduledTask(taskId: string): Promise<{ ok: boolean; error?: string }>
    cancelAiScheduledTask(taskId: string): Promise<{ ok: boolean; error?: string }>
    getScheduledTaskStatus(): Promise<Record<string, { running: boolean; pid?: number; startedAt?: number }>>
    getSessionSchedules(sessionKey: string): Promise<SessionScheduleItemType[]>
    deleteScheduledTask(taskId: string): Promise<{ ok: boolean; error?: string }>
    onScheduledTaskStatus(cb: (statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }>) => void): () => void
    getMcpServers(): Promise<McpServerEntry[]>
    saveMcpServer(name: string, entry: Record<string, unknown>): Promise<{ ok: boolean }>
    deleteMcpServer(name: string): Promise<{ ok: boolean }>
    loginMcp(name: string): Promise<{ ok: boolean; output: string }>
    toggleMcp(name: string, enabled: boolean): Promise<{ ok: boolean; output: string }>
    getMcpEnabledMap(force?: boolean): Promise<Record<string, boolean>>
    getMcpStatusMap(force?: boolean): Promise<Record<string, string>>
    getMcpTools(name: string, force?: boolean): Promise<{ ok: boolean; tools: { name: string; description?: string; params?: { name: string; type?: string; description?: string; required?: boolean }[] }[]; error?: string }>
    getBuiltinMcpManifest(): Promise<{ key: string; title: string; scope: string; tools: { name: string; description: string }[] }[]>
    getHarnessRules(): Promise<{ id: string; name: string; content: string; enabled: boolean; scope?: { mode: "main" | "custom"; targets?: { channelId: string; audiences: ("main" | "others")[] }[] } }[]>
    saveHarnessRule(id: string | null, name: string, content: string, enabled?: boolean, scope?: { mode: "main" | "custom"; targets?: { channelId: string; audiences: ("main" | "others")[] }[] }): Promise<{ ok: boolean; rule?: { id: string; name: string; content: string; enabled: boolean; scope?: { mode: "main" | "custom"; targets?: { channelId: string; audiences: ("main" | "others")[] }[] } } }>
    deleteHarnessRule(id: string): Promise<{ ok: boolean }>
    getClawRules(): Promise<{ id: string; name: string; content: string; enabled: boolean }[]>
    saveClawRule(id: string | null, name: string, content: string, enabled?: boolean): Promise<{ ok: boolean; rule?: { id: string; name: string; content: string; enabled: boolean } }>
    deleteClawRule(id: string): Promise<{ ok: boolean }>
    getSkillRoots(): Promise<{ id: string; label: string; path: string; skillCount: number }[]>
    getSkills(rootId: string): Promise<{ rootId: string; skillPath: string; name: string; content: string }[]>
    getSkillTree(rootId: string): Promise<SkillTreeNode[]>
    readSkillFile(rootId: string, skillPath: string, relativePath: string): Promise<{ ok: boolean; content?: string; error?: string }>
    saveSkillFile(rootId: string, skillPath: string, relativePath: string, content: string): Promise<{ ok: boolean; error?: string }>
    deleteSkillFile(rootId: string, skillPath: string, relativePath: string): Promise<{ ok: boolean; error?: string }>
    createSkillDir(rootId: string, skillPath: string, relativePath: string): Promise<{ ok: boolean; error?: string }>
    saveSkill(rootId: string, skillPath: string, content: string): Promise<{ ok: boolean; error?: string }>
    renameSkill(rootId: string, oldPath: string, newPath: string): Promise<{ ok: boolean; error?: string }>
    deleteSkill(rootId: string, skillPath: string): Promise<{ ok: boolean; error?: string }>
    /** 这个 Skill 是不是指向别处的链接：是则返回真实路径（空串是悬空链接），普通文件夹返回 null */
    getSkillLinkTarget(rootId: string, skillPath: string): Promise<string | null>
    /** 在系统文件管理器里打开：文件夹直接打开，文件是在所在文件夹里选中它。skillPath、relativePath 都传空串是 Skill 根目录 */
    revealSkillPath(rootId: string, skillPath: string, relativePath: string): Promise<{ ok: boolean; error?: string }>
    onMcpLoginComplete(cb: (data: { serverName: string; ok: boolean }) => void): () => void
    onDaemonStatus(cb: (status: DaemonStatus) => void): () => void
    onDaemonLog(cb: (line: string) => void): () => void
    onWechatStatus(cb: (status: string, channelId?: string) => void): () => void
    onWechatQrCode(cb: (dataUrl: string, channelId?: string) => void): () => void
    onBindResult(cb: (data: { ok: boolean; value: string; channelId?: string }) => void): () => void
    onWindowCloseConfirm(cb: () => void): () => void
    onAppModalRequest(cb: (payload: AppModalRequestPayload) => void): () => void
    respondAppModal(requestId: string, response: number): Promise<void>
    startTempConnection(appId: string, appSecret: string): Promise<{ ok: boolean; chatId?: string; error?: string }>
    stopTempConnection(): Promise<{ ok: boolean }>
    /** 运行所在的系统（process.platform）：界面据此决定标题栏用自绘按钮还是系统的红绿灯 */
    platform: string
    windowMinimize(): Promise<void>
    windowMaximize(): Promise<void>
    windowClose(): Promise<void>
    windowIsMaximized(): Promise<boolean>
    onWindowMaximizedChange(cb: (maximized: boolean) => void): () => void
    windowIsFullScreen(): Promise<boolean>
    onWindowFullScreenChange(cb: (fullScreen: boolean) => void): () => void


    testBind(channelId?: string): Promise<{ ok: boolean; error?: string }>
    fetchFeishuAppInfo(appId: string, appSecret: string): Promise<{ ok: boolean; name?: string; openId?: string; error?: string }>
    testWechat(): Promise<{ ok: boolean; error?: string }>
    startChannelBind(channelId: string): Promise<{ ok: boolean; chatId?: string; error?: string }>
    cancelChannelBind(channelId: string): Promise<{ ok: boolean }>
    unbindChannel(channelId: string): Promise<{ ok: boolean }>
    feishuRegisterApp(preset?: { name?: string; desc?: string }): Promise<{ ok: boolean; appId?: string; appSecret?: string; error?: string }>
    feishuRegisterAppCancel(): Promise<{ ok: boolean }>
    onFeishuSetupQrCode(cb: (url: string) => void): () => void
    onFeishuSetupStatus(cb: (status: string) => void): () => void
    wechatQrLogin(): Promise<{ ok: boolean; botToken?: string; accountId?: string; baseUrl?: string; error?: string }>
    wechatQrLoginCancel(): Promise<{ ok: boolean }>
    wechatWaitFirstMessage(token: string, accountId: string, channelId?: string): Promise<{ ok: boolean; chatId?: string; error?: string }>
    wechatCancelWaitMessage(): Promise<{ ok: boolean }>
    onWechatSetupQrCode(cb: (url: string) => void): () => void
    onWechatSetupStatus(cb: (status: string) => void): () => void
  }

  interface Window {
    electronAPI: ElectronAPI
  }
}

export {}
