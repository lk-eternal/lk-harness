import { contextBridge, ipcRenderer } from "electron"
import type { AgentResource, MessageChannel, ChannelStatusInfo } from "../src/shared/channel-types"
import type { ScheduledTask } from "../src/shared/scheduled-task"

export type { AgentResource, MessageChannel, ChannelStatusInfo, ScheduledTask }

export interface AppConfig {
  agentResources: AgentResource[]
  channels: MessageChannel[]
  workspaceDir: string
  favoriteWorkspaces?: string[]
  allowOthers: boolean
  autoStart: boolean
  setupComplete: boolean
  httpProxy: string
  httpsProxy: string
  noProxy: string
  closeWindowAction: "ask" | "minimize" | "quit"
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
  repoRoots?: string[]
  worktreeRoot?: string
}

export interface DaemonStatus {
  running: boolean
  version?: string
  uptime?: number
  agentRunning?: boolean
  agentPid?: number | null
  sessionAgentCount?: number
  queueLength?: number
  hasChatId?: boolean
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

export interface ConfigSaveResult {
  ok: boolean
  needWorkspaceConfirm?: boolean
  oldWorkspaceDir?: string
  newWorkspaceDir?: string
  existingSessions?: { sessionKey: string; chatName?: string }[]
  deferredSetupComplete?: boolean
  workspaceDirChanged?: boolean
}

export type UpdaterCheckResult =
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

export interface UpdaterApplyResult {
  ok: boolean
  error?: string
  message?: string
}

export type UpdaterStatusPayload =
  | { kind: "available" }
  | { kind: "downloaded"; version: string }
  | { kind: "downloading" }

export interface AppModalRequestPayload {
  requestId: string
  title: string
  message: string
  detail?: string
  buttons: string[]
  defaultId?: number
  cancelId?: number
  variant?: "info" | "error" | "warning"
}

export interface SkillTreeNode {
  name: string
  type: "file" | "directory"
  children?: SkillTreeNode[]
}

export interface McpServerEntry {
  name: string
  type: "command" | "url"
  command?: string
  args?: string[]
  url?: string
  env?: Record<string, string>
  source: "claw"
  authenticated?: boolean
  enabled?: boolean
  rawConfig?: Record<string, unknown>
}

const api = {
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("updater:current-version"),
  checkAppUpdate: (): Promise<UpdaterCheckResult> => ipcRenderer.invoke("updater:check"),
  applyAppUpdate: (): Promise<UpdaterApplyResult> => ipcRenderer.invoke("updater:apply"),
  onUpdaterProgress: (cb: (percent: number) => void): (() => void) => {
    const handler = (_: unknown, percent: number) => cb(percent)
    ipcRenderer.on("updater:progress", handler)
    return () => ipcRenderer.removeListener("updater:progress", handler)
  },
  onUpdaterError: (cb: (message: string) => void): (() => void) => {
    const handler = (_: unknown, message: string) => cb(message)
    ipcRenderer.on("updater:error", handler)
    return () => ipcRenderer.removeListener("updater:error", handler)
  },
  onUpdaterStatus: (cb: (payload: UpdaterStatusPayload) => void): (() => void) => {
    const handler = (_: unknown, payload: UpdaterStatusPayload) => cb(payload)
    ipcRenderer.on("updater:status", handler)
    return () => ipcRenderer.removeListener("updater:status", handler)
  },
  getConfig: (): Promise<AppConfig> => ipcRenderer.invoke("config:get"),
  saveConfig: (config: Partial<AppConfig>): Promise<ConfigSaveResult> => ipcRenderer.invoke("config:save", config),
  setAutoStart: (enabled: boolean): Promise<{ ok: boolean }> => ipcRenderer.invoke("app:set-auto-start", enabled),
  applyWorkspaceSwitch: (workspaceDir: string, stopOldSessions: boolean, notifyMain?: boolean): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("config:apply-workspace-switch", workspaceDir, stopOldSessions, notifyMain),
  respondWindowClose: (payload: { action: "minimize" | "quit" | "cancel"; remember: boolean }): Promise<void> =>
    ipcRenderer.invoke("window:close-confirm-result", payload),
  selectDirectory: (): Promise<string | null> => ipcRenderer.invoke("dialog:selectDirectory"),
  getToolboxStatus: (): Promise<{ larkCli: { installed: boolean; version?: string; loggedIn?: boolean; userName?: string }; meegle: { installed: boolean; version?: string } }> => ipcRenderer.invoke("toolbox:status"),
  installToolboxTool: (key: "larkCli" | "meegle"): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("toolbox:install", key),
  loginLarkCli: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("toolbox:login-lark"),
  startDaemon: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("daemon:start"),
  stopAgent: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("agent:stop"),
  getSessionAgents: (): Promise<{ sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string; source?: "sdk" | "llm"; model?: string; modelParams?: string }[]> =>
    ipcRenderer.invoke("agent:sessions"),
  getSessionDiagnostics: (sessionKey: string): Promise<{ running: boolean; resumeAgentId?: string; resumeUpdatedAt?: number; lastRun?: { status: string; endedAt: number; durationMs?: number; error?: string }; lastReplyAt: number | null }> =>
    ipcRenderer.invoke("diagnostics:session", sessionKey),
  exportDiagnostics: (): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke("diagnostics:export"),
  stopSessionAgent: (sessionKey: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("agent:stop-session", sessionKey),
  setSessionModel: (sessionKey: string, model: string, modelParams?: string): Promise<{ ok: boolean; deferred?: boolean; error?: string }> =>
    ipcRenderer.invoke("session:set-model", sessionKey, model, modelParams),
  listSessionTabs: (): Promise<{ ok: boolean; chatId?: string; activeKey?: string; tabs: { sessionKey: string; label: string; kind: "main" | "project" | "dir" | "temp" | "other"; running: boolean; current: boolean; removable?: boolean; model?: string; modelParams?: string }[]; error?: string }> =>
    ipcRenderer.invoke("session:list-tabs"),
  listDashboardTree: (): Promise<{
    ok: boolean
    channels: {
      channelId: string
      name: string
      mainUserChatId?: string
      mainTabs: { sessionKey: string; label: string; kind: "main" | "project" | "dir" | "temp" | "other"; running: boolean; current: boolean; removable?: boolean; model?: string; modelParams?: string }[]
      activeKey?: string
    }[]
    running: { sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string; source?: "sdk" | "llm"; model?: string; modelParams?: string }[]
    error?: string
  }> => ipcRenderer.invoke("session:dashboard-tree"),
  addChannelFavoriteWorkspace: (channelId: string, dir: string): Promise<{ ok: boolean; favoriteWorkspaces?: string[]; error?: string }> =>
    ipcRenderer.invoke("channel:add-favorite-workspace", channelId, dir),
  switchSession: (sessionKey: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("session:switch", sessionKey),
  deleteSession: (sessionKey: string): Promise<{ ok: boolean; error?: string; label?: string }> =>
    ipcRenderer.invoke("session:delete", sessionKey),
  listProjects: (): Promise<{
    id: string; name: string; goal?: string; storyUrl?: string; productDocUrl?: string; techDocUrl?: string
    featureBranch: string; status: string; groupId?: string; groupIds?: string[]; worktreePath?: string; repoPath?: string; workspaceType?: string
    metadata?: Record<string, string>; groupChatId?: string
  }[]> =>
    ipcRenderer.invoke("project:list"),
  deleteProject: (projectId: string): Promise<{ ok: boolean; name?: string; error?: string }> =>
    ipcRenderer.invoke("project:delete", projectId),
  updateProject: (patch: {
    id: string; name?: string; goal?: string; storyUrl?: string; productDocUrl?: string; techDocUrl?: string
    status?: string; groupId?: string; groupIds?: string[]; metadata?: Record<string, string>
  }): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("project:update", patch),
  switchProject: (projectId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("project:switch", projectId),
  listQuickModels: (): Promise<{ ok: boolean; models: { model: string; modelParams?: string; label?: string }[] }> =>
    ipcRenderer.invoke("session:list-quick-models"),
  forgetQuickModel: (model: string, modelParams?: string): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("session:forget-quick-model", model, modelParams),
  stopAllSessionAgents: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("agent:stop-all-sessions"),
  onSessionAgents: (cb: (list: { sessionKey: string; pid: number; startedAt: number; chatType: string; lastActivityAt: number; chatName?: string; workspaceDir?: string; source?: "sdk" | "llm"; model?: string; modelParams?: string }[]) => void) => {
    const handler = (_e: Electron.IpcRendererEvent, list: Parameters<typeof cb>[0]) => cb(list)
    ipcRenderer.on("agent:sessions", handler)
    return () => { ipcRenderer.removeListener("agent:sessions", handler) }
  },
  stopDaemon: (): Promise<void> => ipcRenderer.invoke("daemon:stop"),
  getDaemonStatus: (): Promise<DaemonStatus> => ipcRenderer.invoke("daemon:status"),
  getLogBuffer: (): Promise<string[]> => ipcRenderer.invoke("daemon:get-log-buffer"),
  getQueueMessages: (): Promise<{ index: number; fileId: string; preview: string; status?: "pending" | "processing"; sessionKey?: string; chatType?: string; timestamp?: number; senderOpenId?: string; sessionLabel?: string }[]> => ipcRenderer.invoke("daemon:queue"),
  deleteQueueMessage: (fileId: string): Promise<boolean> => ipcRenderer.invoke("daemon:queue-delete", fileId),
  clearQueueMessages: (): Promise<number> => ipcRenderer.invoke("daemon:queue-clear"),
  listModels: (): Promise<{ ok: boolean; models: { id: string; label: string; current: boolean }[]; error?: string }> => ipcRenderer.invoke("models:list"),
  checkSdkApiKey: (apiKey: string): Promise<{ ok: boolean; email?: string; error?: string }> => ipcRenderer.invoke("sdk:check-api-key", apiKey),
  verifyLlmResource: (resource: AgentResource): Promise<{ ok: boolean; email?: string; error?: string }> => ipcRenderer.invoke("llm:verify-resource", resource),
  listLlmModels: (resource: AgentResource, currentModel?: string, currentParams?: string): Promise<{ ok: boolean; models: { id: string; label: string; current?: boolean }[]; error?: string }> => ipcRenderer.invoke("llm:list-models", resource, currentModel, currentParams),
  listSdkModels: (apiKey: string, currentModel?: string, currentParams?: string): Promise<{ ok: boolean; models: { id: string; label: string; params: string; current: boolean }[]; error?: string }> => ipcRenderer.invoke("sdk:list-models", apiKey, currentModel, currentParams),
  getScheduledTasks: (): Promise<ScheduledTask[]> => ipcRenderer.invoke("scheduled-tasks:get"),
  saveScheduledTasks: (tasks: ScheduledTask[]): Promise<{ ok: boolean }> => ipcRenderer.invoke("scheduled-tasks:save", tasks),
  validateCron: (expression: string): Promise<boolean> => ipcRenderer.invoke("scheduled-tasks:validate-cron", expression),
  previewCronNextRuns: (expression: string): Promise<{ ok: true; runs: string[] } | { ok: false; error: string }> =>
    ipcRenderer.invoke("scheduled-tasks:preview-cron", expression),
  triggerScheduledTask: (taskId: string): Promise<{ ok: boolean; error?: string }> =>
    ipcRenderer.invoke("scheduled-tasks:trigger", taskId),
  getScheduledTaskStatus: (): Promise<Record<string, { running: boolean; pid?: number; startedAt?: number }>> =>
    ipcRenderer.invoke("scheduled-tasks:get-status"),

  // ── 项目流程组 ──────────────────────────────────────
  getProjectNodeGroups: (): Promise<{ id: string; name: string; workspace?: "worktree" | "plain"; nodes: { id: string; label: string; prompt?: string; defaultPrompt?: string }[] }[]> =>
    ipcRenderer.invoke("project-node-groups:get"),
  saveProjectNodeGroups: (groups: { id: string; name: string; workspace?: "worktree" | "plain"; nodes: { id: string; label: string; prompt?: string }[] }[]): Promise<{ ok: boolean }> =>
    ipcRenderer.invoke("project-node-groups:save", groups),
  getProjectNodeGroupUsage: (): Promise<Record<string, number>> =>
    ipcRenderer.invoke("project-node-groups:usage"),
  exportProjectNodeGroup: (groupId: string): Promise<{ ok: boolean; path?: string; error?: string }> =>
    ipcRenderer.invoke("project-node-groups:export", groupId),
  importProjectNodeGroup: (): Promise<{ ok: boolean; group?: { id: string; name: string; workspace?: "worktree" | "plain"; nodes: { id: string; label: string; prompt?: string }[] }; error?: string }> =>
    ipcRenderer.invoke("project-node-groups:import"),

  exportConfig: (sections?: string[]): Promise<{ ok: boolean; path?: string; error?: string }> => ipcRenderer.invoke("config:export", sections),
  pickImportConfigFile: (): Promise<{ ok: boolean; filePath?: string; sections?: string[]; items?: { id: string; label: string; count: number }[]; error?: string }> => ipcRenderer.invoke("config:pick-import-file"),
  getLocalConfigSectionStats: (): Promise<{ id: string; label: string; count: number }[]> => ipcRenderer.invoke("config:local-section-stats"),
  importConfig: (filePath: string, sections?: string[]): Promise<{ ok: boolean; error?: string; warnings?: string[] }> => ipcRenderer.invoke("config:import", filePath, sections),
  inspectCursorClawSections: (userDataPath?: string): Promise<{ ok: boolean; sections?: string[]; items?: { id: string; label: string; count: number }[]; error?: string }> => ipcRenderer.invoke("config:inspect-cursor-claw", userDataPath),
  discoverCursorClawInstalls: (): Promise<{ label: string; userDataPath: string }[]> => ipcRenderer.invoke("config:discover-cursor-claw"),
  migrateFromCursorClaw: (userDataPath: string | undefined, sections: string[]): Promise<{ ok: boolean; error?: string; warnings?: string[] }> =>
    ipcRenderer.invoke("config:migrate-from-cursor-claw", userDataPath ?? "", sections),

  flowHub: {
    getCatalog: (force?: boolean): Promise<{ ok: true; catalog: import("../src/shared/flow-hub-types").FlowHubCatalog } | { ok: false; error: string }> =>
      ipcRenderer.invoke("flow-hub:get-catalog", force),
    listNodes: (): Promise<{ ok: true; nodes: import("../src/shared/flow-hub-types").FlowHubBrowsableNode[] } | { ok: false; error: string }> =>
      ipcRenderer.invoke("flow-hub:list-nodes"),
    getSyncStatus: (kind: "group" | "node", hubId: string, contentHash: string): Promise<import("../src/shared/flow-hub-types").FlowHubSyncStatus> =>
      ipcRenderer.invoke("flow-hub:get-sync-status", { kind, hubId, contentHash }),
    importGroup: (hubId: string): Promise<{ ok: true; group: unknown } | { ok: false; error: string }> =>
      ipcRenderer.invoke("flow-hub:import-group", hubId),
    importNode: (hubId: string, targetGroupId: string, opts?: { groupHubId?: string; nodeLocalId?: string }): Promise<{ ok: true; node: unknown } | { ok: false; error: string }> =>
      ipcRenderer.invoke("flow-hub:import-node", { hubId, targetGroupId, ...opts }),
    uploadGroup: (groupId: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke("flow-hub:upload-group", groupId),
    uploadNode: (groupId: string, nodeId: string): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke("flow-hub:upload-node", { groupId, nodeId }),
    syncGroup: (hubId: string, mode: "overwrite" | "keep"): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke("flow-hub:sync-group", { hubId, mode }),
    syncNode: (hubId: string, targetGroupId: string, mode: "overwrite" | "keep", opts?: { groupHubId?: string; nodeLocalId?: string }): Promise<{ ok: true } | { ok: false; error: string }> =>
      ipcRenderer.invoke("flow-hub:sync-node", { hubId, targetGroupId, mode, ...opts }),
    preview: (kind: "group" | "node", hubId: string, nodeLocalId?: string): Promise<{ ok: true; name: string; prompt?: string } | { ok: false; error: string }> =>
      ipcRenderer.invoke("flow-hub:preview", { kind, hubId, nodeLocalId }),
  },
  onScheduledTaskStatus: (cb: (statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }>) => void) => {
    const handler = (_: unknown, statuses: Record<string, { running: boolean; pid?: number; startedAt?: number }>) => cb(statuses)
    ipcRenderer.on("scheduled-tasks:status", handler)
    return () => ipcRenderer.removeListener("scheduled-tasks:status", handler)
  },
  getMcpServers: (): Promise<McpServerEntry[]> => ipcRenderer.invoke("mcp:list-all"),
  saveMcpServer: (name: string, entry: Record<string, unknown>, source?: "claw" | "global" | "project"): Promise<{ ok: boolean }> => ipcRenderer.invoke("mcp:save", name, entry, source),
  deleteMcpServer: (name: string, source?: "claw" | "global" | "project"): Promise<{ ok: boolean }> => ipcRenderer.invoke("mcp:delete", name, source),
  loginMcp: (name: string): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("mcp:login", name),
  toggleMcp: (name: string, enabled: boolean): Promise<{ ok: boolean; output: string }> => ipcRenderer.invoke("mcp:toggle", name, enabled),
  getMcpEnabledMap: (force?: boolean): Promise<Record<string, boolean>> => ipcRenderer.invoke("mcp:enabled-map", force),
  getMcpStatusMap: (force?: boolean): Promise<Record<string, string>> => ipcRenderer.invoke("mcp:status-map", force),
  getMcpTools: (name: string, force?: boolean): Promise<{ ok: boolean; tools: { name: string; description?: string; params?: { name: string; type?: string; description?: string; required?: boolean }[] }[]; error?: string }> => ipcRenderer.invoke("mcp:tools", name, force),
  getHarnessRules: (): Promise<{ id: string; name: string; content: string; enabled: boolean }[]> => ipcRenderer.invoke("harness-rules:list"),
  saveHarnessRule: (id: string | null, name: string, content: string, enabled?: boolean): Promise<{ ok: boolean; rule?: { id: string; name: string; content: string; enabled: boolean } }> => ipcRenderer.invoke("harness-rules:save", id, name, content, enabled),
  deleteHarnessRule: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("harness-rules:delete", id),
  getClawRules: (): Promise<{ id: string; name: string; content: string; enabled: boolean }[]> => ipcRenderer.invoke("claw-rules:list"),
  saveClawRule: (id: string | null, name: string, content: string, enabled?: boolean): Promise<{ ok: boolean; rule?: { id: string; name: string; content: string; enabled: boolean } }> => ipcRenderer.invoke("claw-rules:save", id, name, content, enabled),
  deleteClawRule: (id: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("claw-rules:delete", id),
  getSkillRoots: (): Promise<{ id: string; label: string; path: string; skillCount: number }[]> => ipcRenderer.invoke("skills:roots"),
  getSkills: (rootId: string): Promise<{ rootId: string; skillPath: string; name: string; content: string }[]> => ipcRenderer.invoke("skills:list", rootId),
  getSkillTree: (rootId: string): Promise<SkillTreeNode[]> => ipcRenderer.invoke("skills:tree", rootId),
  readSkillFile: (rootId: string, skillPath: string, relativePath: string): Promise<{ ok: boolean; content?: string; error?: string }> => ipcRenderer.invoke("skills:read-file", rootId, skillPath, relativePath),
  saveSkillFile: (rootId: string, skillPath: string, relativePath: string, content: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:save-file", rootId, skillPath, relativePath, content),
  deleteSkillFile: (rootId: string, skillPath: string, relativePath: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("skills:delete-file", rootId, skillPath, relativePath),
  createSkillDir: (rootId: string, skillPath: string, relativePath: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:create-dir", rootId, skillPath, relativePath),
  saveSkill: (rootId: string, skillPath: string, content: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:save", rootId, skillPath, content),
  renameSkill: (rootId: string, oldPath: string, newPath: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:rename", rootId, oldPath, newPath),
  deleteSkill: (rootId: string, skillPath: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("skills:delete", rootId, skillPath),
  onMcpLoginComplete: (cb: (data: { serverName: string; ok: boolean }) => void) => {
    const handler = (_: unknown, data: { serverName: string; ok: boolean }) => cb(data)
    ipcRenderer.on("mcp:login-complete", handler)
    return () => ipcRenderer.removeListener("mcp:login-complete", handler)
  },
  startTempConnection: (appId: string, appSecret: string): Promise<{ ok: boolean; chatId?: string; error?: string }> =>
    ipcRenderer.invoke("temp-conn:start", appId, appSecret),
  stopTempConnection: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("temp-conn:stop"),
  testBind: (channelId?: string): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("bind:test", channelId),
  testWechat: (): Promise<{ ok: boolean; error?: string }> => ipcRenderer.invoke("bind:test-wechat"),
  startChannelBind: (channelId: string): Promise<{ ok: boolean; chatId?: string; error?: string }> =>
    ipcRenderer.invoke("channel:bind-start", channelId),
  cancelChannelBind: (channelId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("channel:bind-cancel", channelId),
  unbindChannel: (channelId: string): Promise<{ ok: boolean }> => ipcRenderer.invoke("channel:unbind", channelId),
  onBindResult: (cb: (data: { ok: boolean; value: string; channelId?: string }) => void) => {
    const handler = (_: unknown, data: { ok: boolean; value: string; channelId?: string }) => cb(data)
    ipcRenderer.on("bind:result", handler)
    return () => ipcRenderer.removeListener("bind:result", handler)
  },
  onDaemonStatus: (cb: (status: DaemonStatus) => void) => {
    const handler = (_: unknown, status: DaemonStatus) => cb(status)
    ipcRenderer.on("daemon:status-update", handler)
    return () => ipcRenderer.removeListener("daemon:status-update", handler)
  },
  onDaemonLog: (cb: (line: string) => void) => {
    const handler = (_: unknown, line: string) => cb(line)
    ipcRenderer.on("daemon:log", handler)
    return () => ipcRenderer.removeListener("daemon:log", handler)
  },
  fetchFeishuAppInfo: (appId: string, appSecret: string): Promise<{ ok: boolean; name?: string; openId?: string; error?: string }> =>
    ipcRenderer.invoke("feishu:app-info", appId, appSecret),
  feishuRegisterApp: (preset?: { name?: string; desc?: string }): Promise<{ ok: boolean; appId?: string; appSecret?: string; error?: string }> =>
    ipcRenderer.invoke("feishu:register-app", preset),
  feishuRegisterAppCancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("feishu:register-app-cancel"),
  onFeishuSetupQrCode: (cb: (url: string) => void) => {
    const handler = (_: unknown, url: string) => cb(url)
    ipcRenderer.on("feishu:setup-qrcode", handler)
    return () => ipcRenderer.removeListener("feishu:setup-qrcode", handler)
  },
  onFeishuSetupStatus: (cb: (status: string) => void) => {
    const handler = (_: unknown, status: string) => cb(status)
    ipcRenderer.on("feishu:setup-status", handler)
    return () => ipcRenderer.removeListener("feishu:setup-status", handler)
  },
  wechatQrLogin: (): Promise<{ ok: boolean; botToken?: string; accountId?: string; baseUrl?: string; error?: string }> =>
    ipcRenderer.invoke("wechat:qr-login"),
  wechatQrLoginCancel: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("wechat:qr-login-cancel"),
  wechatWaitFirstMessage: (token: string, accountId: string, channelId?: string): Promise<{ ok: boolean; chatId?: string; error?: string }> =>
    ipcRenderer.invoke("wechat:wait-first-message", token, accountId, channelId),
  wechatCancelWaitMessage: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("wechat:cancel-wait-message"),
  onWechatSetupQrCode: (cb: (url: string) => void) => {
    const handler = (_: unknown, url: string) => cb(url)
    ipcRenderer.on("wechat:setup-qrcode", handler)
    return () => ipcRenderer.removeListener("wechat:setup-qrcode", handler)
  },
  onWechatSetupStatus: (cb: (status: string) => void) => {
    const handler = (_: unknown, status: string) => cb(status)
    ipcRenderer.on("wechat:setup-status", handler)
    return () => ipcRenderer.removeListener("wechat:setup-status", handler)
  },
  onWechatStatus: (cb: (status: string, channelId?: string) => void) => {
    const handler = (_: unknown, status: string, channelId?: string) => cb(status, channelId)
    ipcRenderer.on("wechat:status", handler)
    return () => ipcRenderer.removeListener("wechat:status", handler)
  },
  onWechatQrCode: (cb: (dataUrl: string, channelId?: string) => void) => {
    const handler = (_: unknown, dataUrl: string, channelId?: string) => cb(dataUrl, channelId)
    ipcRenderer.on("wechat:qrcode", handler)
    return () => ipcRenderer.removeListener("wechat:qrcode", handler)
  },
  onWindowCloseConfirm: (cb: () => void) => {
    const handler = () => cb()
    ipcRenderer.on("window:close-confirm", handler)
    return () => ipcRenderer.removeListener("window:close-confirm", handler)
  },
  onAppModalRequest: (cb: (payload: AppModalRequestPayload) => void) => {
    const handler = (_: unknown, payload: AppModalRequestPayload) => cb(payload)
    ipcRenderer.on("app:modal-request", handler)
    return () => ipcRenderer.removeListener("app:modal-request", handler)
  },
  respondAppModal: (requestId: string, response: number): Promise<void> =>
    ipcRenderer.invoke("app:modal-result", { requestId, response }),

  windowMinimize: (): Promise<void> => ipcRenderer.invoke("window:minimize"),
  windowMaximize: (): Promise<void> => ipcRenderer.invoke("window:maximize"),
  windowClose: (): Promise<void> => ipcRenderer.invoke("window:close"),
  windowIsMaximized: (): Promise<boolean> => ipcRenderer.invoke("window:is-maximized"),
  onWindowMaximizedChange: (cb: (maximized: boolean) => void) => {
    const handler = (_: unknown, maximized: boolean) => cb(maximized)
    ipcRenderer.on("window:maximized-change", handler)
    return () => ipcRenderer.removeListener("window:maximized-change", handler)
  },

}

contextBridge.exposeInMainWorld("electronAPI", api)

export type ElectronAPI = typeof api
