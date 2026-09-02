import type { AgentResource as AgentResourceType, MessageChannel, ChannelStatusInfo as ChannelStatusInfoType } from "../shared/channel-types"
import type { ScheduledTask as ScheduledTaskType } from "../shared/scheduled-task"

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
    favoriteModels?: { model: string; modelParams?: string; label?: string }[]
    autoStart: boolean
    setupComplete: boolean
    httpProxy: string
    httpsProxy: string
    noProxy: string
    closeWindowAction: "ask" | "minimize" | "quit"
    autoUpgradePrompt?: boolean
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
    agentMode: "cli" | "sdk"
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

  interface DaemonStatus {
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
    source: "claw"
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
    cliAvailable?: boolean
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
    applyAppUpdate(): Promise<{ ok: boolean; error?: string; message?: string }>
    onUpdaterProgress(cb: (percent: number) => void): () => void
    onUpdaterError(cb: (message: string) => void): () => void
    onUpdaterStatus(cb: (payload: { kind: "available" } | { kind: "downloaded"; version: string } | { kind: "downloading" }) => void): () => void
    getConfig(): Promise<AppConfig>
    getProjectNodeGroups(): Promise<{ id: string; name: string; workspace?: "worktree" | "plain"; nodes: { id: string; label: string; prompt?: string; defaultPrompt?: string }[] }[]>
    saveProjectNodeGroups(groups: { id: string; name: string; workspace?: "worktree" | "plain"; nodes: { id: string; label: string; prompt?: string }[] }[]): Promise<{ ok: boolean }>
    getProjectNodeGroupUsage(): Promise<Record<string, number>>
    exportProjectNodeGroup(groupId: string): Promise<{ ok: boolean; path?: string; error?: string }>
    importProjectNodeGroup(): Promise<{ ok: boolean; group?: { id: string; name: string; workspace?: "worktree" | "plain"; nodes: { id: string; label: string; prompt?: string }[] }; error?: string }>
    exportConfig(sections?: string[]): Promise<{ ok: boolean; path?: string; error?: string }>
    pickImportConfigFile(): Promise<{ ok: boolean; filePath?: string; sections?: string[]; items?: { id: string; label: string; count: number }[]; error?: string }>
    getLocalConfigSectionStats(): Promise<{ id: string; label: string; count: number }[]>
    importConfig(filePath: string, sections?: string[]): Promise<{ ok: boolean; error?: string; warnings?: string[] }>
    inspectCursorClawSections(userDataPath?: string): Promise<{ ok: boolean; sections?: string[]; items?: { id: string; label: string; count: number }[]; error?: string }>
    discoverCursorClawInstalls(): Promise<{ label: string; userDataPath: string }[]>
    migrateFromCursorClaw(userDataPath?: string, sections?: string[]): Promise<{ ok: boolean; error?: string; warnings?: string[] }>
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
    applyWorkspaceSwitch(workspaceDir: string, stopOldSessions: boolean, notifyMain?: boolean): Promise<{ ok: boolean; error?: string }>
    respondWindowClose(payload: { action: "minimize" | "quit" | "cancel"; remember: boolean }): Promise<void>
    selectDirectory(): Promise<string | null>
    getToolboxStatus(): Promise<{ larkCli: { installed: boolean; version?: string; loggedIn?: boolean; userName?: string }; meegle: { installed: boolean; version?: string }; nodeOk?: boolean; nodeVersion?: string }>
    installToolboxTool(key: "larkCli" | "meegle"): Promise<{ ok: boolean; error?: string }>
    loginLarkCli(): Promise<{ ok: boolean; error?: string }>
    injectWorkspace(): Promise<{ results: { file: string; action: "created" | "updated" | "skipped"; message: string }[] }>
    startDaemon(): Promise<{ ok: boolean; error?: string }>
    stopDaemon(): Promise<void>
    stopAgent(): Promise<{ ok: boolean }>
    getSessionAgents(): Promise<{ sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string; source?: "cli" | "sdk" }[]>
    getSessionDiagnostics(sessionKey: string): Promise<{ running: boolean; resumeAgentId?: string; resumeUpdatedAt?: number; lastRun?: { status: string; endedAt: number; durationMs?: number; error?: string }; lastReplyAt: number | null }>
    exportDiagnostics(): Promise<{ ok: boolean; path?: string; error?: string }>
    stopSessionAgent(sessionKey: string): Promise<{ ok: boolean }>
    setSessionModel(sessionKey: string, model: string, modelParams?: string): Promise<{ ok: boolean; deferred?: boolean; error?: string }>
    listSessionTabs(): Promise<{ ok: boolean; chatId?: string; activeKey?: string; tabs: { sessionKey: string; label: string; kind: "main" | "project" | "dir" | "temp" | "other"; running: boolean; current: boolean; removable?: boolean; model?: string; modelParams?: string }[]; error?: string }>
    listDashboardTree(): Promise<{
      ok: boolean
      channels: {
        channelId: string
        name: string
        mainUserChatId?: string
        mainTabs: { sessionKey: string; label: string; kind: "main" | "project" | "dir" | "temp" | "other"; running: boolean; current: boolean; removable?: boolean; model?: string; modelParams?: string }[]
        activeKey?: string
      }[]
      running: { sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string; source?: "cli" | "sdk"; model?: string; modelParams?: string }[]
      error?: string
    }>
    addChannelFavoriteWorkspace(channelId: string, dir: string): Promise<{ ok: boolean; favoriteWorkspaces?: string[]; error?: string }>
    switchSession(sessionKey: string): Promise<{ ok: boolean; error?: string }>
    deleteSession(sessionKey: string): Promise<{ ok: boolean; error?: string; label?: string }>
    listProjects(): Promise<{
      id: string; name: string; goal?: string; storyUrl?: string; productDocUrl?: string; techDocUrl?: string
      featureBranch: string; status: string; groupId?: string; groupIds?: string[]; worktreePath?: string; repoPath?: string; workspaceType?: string
      metadata?: Record<string, string>; groupChatId?: string
    }[]>
    deleteProject(projectId: string): Promise<{ ok: boolean; name?: string; error?: string }>
    updateProject(patch: {
      id: string; name?: string; goal?: string; storyUrl?: string; productDocUrl?: string; techDocUrl?: string
      status?: string; groupId?: string; groupIds?: string[]; metadata?: Record<string, string>
    }): Promise<{ ok: boolean; error?: string }>
    switchProject(projectId: string): Promise<{ ok: boolean; error?: string }>
    listQuickModels(): Promise<{ ok: boolean; models: { model: string; modelParams?: string; label?: string }[] }>
    forgetQuickModel(model: string, modelParams?: string): Promise<{ ok: boolean }>
    stopAllSessionAgents(): Promise<{ ok: boolean }>
    onSessionAgents(cb: (list: { sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string; source?: "cli" | "sdk" }[]) => void): () => void
    getDaemonStatus(): Promise<DaemonStatus>
    getLogBuffer(): Promise<string[]>
    getQueueMessages(): Promise<{ index: number; fileId: string; preview: string; status?: "pending" | "processing"; sessionKey?: string; chatType?: string; timestamp?: number; senderOpenId?: string; sessionLabel?: string }[]>
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
    getScheduledTaskStatus(): Promise<Record<string, { running: boolean; pid?: number; startedAt?: number }>>
    onScheduledTaskStatus(cb: (statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }>) => void): () => void
    getMcpServers(): Promise<McpServerEntry[]>
    saveMcpServer(name: string, entry: Record<string, unknown>, source?: "claw" | "global" | "project"): Promise<{ ok: boolean }>
    deleteMcpServer(name: string, source?: "claw" | "global" | "project"): Promise<{ ok: boolean }>
    loginMcp(name: string): Promise<{ ok: boolean; output: string }>
    toggleMcp(name: string, enabled: boolean): Promise<{ ok: boolean; output: string }>
    getMcpEnabledMap(force?: boolean): Promise<Record<string, boolean>>
    getMcpStatusMap(force?: boolean): Promise<Record<string, string>>
    getMcpTools(name: string, force?: boolean): Promise<{ ok: boolean; tools: { name: string; description?: string; params?: { name: string; type?: string; description?: string; required?: boolean }[] }[]; error?: string }>
    getHarnessRules(): Promise<{ id: string; name: string; content: string; enabled: boolean }[]>
    saveHarnessRule(id: string | null, name: string, content: string, enabled?: boolean): Promise<{ ok: boolean; rule?: { id: string; name: string; content: string; enabled: boolean } }>
    deleteHarnessRule(id: string): Promise<{ ok: boolean }>
    getClawRules(): Promise<{ id: string; name: string; content: string; enabled: boolean }[]>
    saveClawRule(id: string | null, name: string, content: string, enabled?: boolean): Promise<{ ok: boolean; rule?: { id: string; name: string; content: string; enabled: boolean } }>
    deleteClawRule(id: string): Promise<{ ok: boolean }>
    getSkillRoots(): Promise<{ id: string; label: string; path: string; skillCount: number }[]>
    getSkills(rootId: string): Promise<{ rootId: string; skillPath: string; name: string; content: string }[]>
    getSkillTree(rootId: string): Promise<SkillTreeNode[]>
    readSkillFile(rootId: string, skillPath: string, relativePath: string): Promise<{ ok: boolean; content?: string; error?: string }>
    saveSkillFile(rootId: string, skillPath: string, relativePath: string, content: string): Promise<{ ok: boolean }>
    deleteSkillFile(rootId: string, skillPath: string, relativePath: string): Promise<{ ok: boolean; error?: string }>
    createSkillDir(rootId: string, skillPath: string, relativePath: string): Promise<{ ok: boolean }>
    saveSkill(rootId: string, skillPath: string, content: string): Promise<{ ok: boolean }>
    renameSkill(rootId: string, oldPath: string, newPath: string): Promise<{ ok: boolean }>
    deleteSkill(rootId: string, skillPath: string): Promise<{ ok: boolean }>
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
    windowMinimize(): Promise<void>
    windowMaximize(): Promise<void>
    windowClose(): Promise<void>
    windowIsMaximized(): Promise<boolean>
    onWindowMaximizedChange(cb: (maximized: boolean) => void): () => void


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
