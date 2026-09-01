import { describe, expect, it } from "vitest"
import { loadFlowHubContext } from "../../electron/flow-hub-service.js"
import type { AppConfig } from "../../electron/config-store.js"

const baseCfg = (): AppConfig => ({
  agentResources: [],
  channels: [],
  channelsMigrated: true,
  favWorkspacesMigrated: true,
  workspaceDir: "",
  favoriteWorkspaces: [],
  favoriteModels: [],
  autoStart: false,
  setupComplete: true,
  httpProxy: "",
  httpsProxy: "",
  noProxy: "",
  closeWindowAction: "ask",
  mainChatIds: {},
  daemonPort: 19528,
  gitlabToken: "glpat-test",
  gitlabHost: "https://gitlab.wukongedu.net",
  repoRoots: [],
  repoProfiles: [],
  worktreeRoot: "",
  flowHubUrl: "https://gitlab.example.com/internal-shared/flow-hub",
  flowHubToken: "glpat-hub",
  flowHubAuthor: "测试",
  allowOthers: false,
  digitalIdentity: "",
  larkAppId: "",
  larkAppSecret: "",
  larkAppQuickCreated: false,
  larkReceiveId: "",
  model: "",
  modelParams: "",
  agentNewSession: false,
  feishuEnabled: false,
  wechatEnabled: false,
  wechatToken: "",
  wechatAccountId: "",
  agentMode: "cli",
  cursorApiKey: "",
  othersModel: "",
  othersModelParams: "",
  taskModel: "",
  taskModelParams: "",
})

describe("loadFlowHubContext", () => {
  it("accepts valid config", () => {
    const ctx = loadFlowHubContext(baseCfg())
    expect("error" in ctx).toBe(false)
    if (!("error" in ctx)) {
      expect(ctx.hubUrl).toContain("flow-hub")
      expect(ctx.client).toBeTruthy()
    }
  })

  it("rejects missing token", () => {
    const cfg = baseCfg()
    cfg.flowHubToken = ""
    cfg.gitlabToken = ""
    expect(loadFlowHubContext(cfg)).toEqual({ error: "请先配置 Hub Token" })
  })

  it("prefers flowHubToken over gitlabToken", () => {
    const cfg = baseCfg()
    cfg.gitlabHost = "https://gitlab.com"
    const ctx = loadFlowHubContext(cfg)
    expect("error" in ctx).toBe(false)
  })

  it("rejects host mismatch when using gitlabToken fallback", () => {
    const cfg = baseCfg()
    cfg.flowHubToken = ""
    cfg.gitlabHost = "https://gitlab.com"
    expect(loadFlowHubContext(cfg)).toEqual({ error: "Hub 地址与 GitLab Host 不一致" })
  })
})
