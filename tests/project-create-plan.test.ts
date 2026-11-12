import * as path from "node:path"
import { describe, expect, it } from "vitest"
import {
  isRemoteRepoUrl,
  projectIdOfSessionKey,
  PROJECT_NAME_MAX,
  PROJECT_REPOS_MAX,
  PROJECT_TEXT_MAX,
  projectDeleteConfirmText,
  projectDeleteNote,
  projectNotOwnedHint,
  repoDisplayName,
  repoPicksProblem,
  sortTemplatesForPicker,
} from "../src/shared/project-app-types.js"
import { isRemoteRepoRef } from "../src/shared/project-types.js"
import {
  buildProjectView,
  checkExternalFolder,
  isProjectOwnedBy,
  isSameOrInside,
  normalizeProjectName,
  parseGatewayCreateInput,
  planProjectCreate,
  snapshotDiffers,
  syncedSnapshot,
  templateInfos,
} from "../src/shared/project-create-plan.js"
import { snapshotGroups } from "../src/shared/project-templates.js"
import {
  DEFAULT_NODE_GROUPS,
  projectIdFromSessionKey,
  projectSessionKey,
  type Project,
  type ProjectNodeGroupDef,
} from "../src/shared/project-types.js"

const CH = "ch_app"
const groups = (): ProjectNodeGroupDef[] => structuredClone(DEFAULT_NODE_GROUPS)

describe("templateInfos", () => {
  it("所有模板都能在应用内创建；开发模板标明要接代码仓库，其余不用", () => {
    const infos = templateInfos(groups())
    const byId = Object.fromEntries(infos.map((i) => [i.id, i]))
    expect(byId.develop.needsRepo).toBe(true)
    expect(byId.general.needsRepo).toBe(false)
    expect(byId.research.needsRepo).toBe(false)
    expect(byId.test.needsRepo).toBe(false)
    // 不再有「不能建」的说法
    for (const i of infos) expect(Object.keys(i)).not.toContain("creatable")
    expect(byId.research.steps.map((s) => s.id)).toEqual(["scope", "gather", "analyze", "write-report"])
    expect(byId.research.fields.map((f) => f.label)).toContain("交付形式")
  })
})

describe("normalizeProjectName（建项和改名共用的项目名规则）", () => {
  it("两端空白去掉；中间的空白不动", () => {
    expect(normalizeProjectName("  周报 Q4  ")).toEqual({ ok: true, name: "周报 Q4" })
  })

  it("不能留空：空串、纯空白、不是字符串（界面或网关传错了类型）都拒绝，说法和建项一致", () => {
    for (const bad of ["", "   ", "\n\t", undefined, null, 123, {}]) {
      expect(normalizeProjectName(bad)).toEqual({ ok: false, error: "请填写项目名称" })
    }
  })

  it("上限刚好放行，多一个字就拒绝；长度按去掉空白之后算", () => {
    expect(normalizeProjectName("x".repeat(PROJECT_NAME_MAX)).ok).toBe(true)
    expect(normalizeProjectName(` ${"x".repeat(PROJECT_NAME_MAX)} `).ok).toBe(true)
    const over = normalizeProjectName("x".repeat(PROJECT_NAME_MAX + 1))
    expect(over).toEqual({ ok: false, error: `项目名称不要超过 ${PROJECT_NAME_MAX} 个字` })
  })
})

describe("planProjectCreate", () => {
  it("名称必填、有长度上限，名称两端空白去掉", () => {
    expect(planProjectCreate({ name: "  ", templateId: "general" }, groups())).toEqual({ ok: false, error: "请填写项目名称" })
    const long = planProjectCreate({ name: "x".repeat(PROJECT_NAME_MAX + 1), templateId: "general" }, groups())
    expect(long.ok).toBe(false)
    const ok = planProjectCreate({ name: "  周报  ", templateId: "general" }, groups())
    expect(ok.ok && ok.name).toBe("周报")
  })

  it("模板必须存在", () => {
    expect(planProjectCreate({ name: "a", templateId: "nope" }, groups())).toEqual({ ok: false, error: "模板不存在，请重新选择" })
  })

  describe("接代码仓库的模板（开发）", () => {
    const abs = path.resolve(path.sep, "repos", "shop")
    const dev = (extra: Partial<Parameters<typeof planProjectCreate>[0]> = {}) =>
      planProjectCreate({ name: "改版", templateId: "develop", repos: [{ repoPath: abs, baseBranch: "main" }], ...extra }, groups())

    it("必须选仓库，每个仓库要有基线分支", () => {
      expect(planProjectCreate({ name: "a", templateId: "develop" }, groups())).toEqual({ ok: false, error: "请至少选一个代码仓库" })
      expect(planProjectCreate({ name: "a", templateId: "develop", repos: [] }, groups()).ok).toBe(false)
      const noBase = planProjectCreate({ name: "a", templateId: "develop", repos: [{ repoPath: abs, baseBranch: "  " }] }, groups())
      expect(noBase).toEqual({ ok: false, error: "请填写「shop」的基线分支" })
    })

    it("通过后带出整理好的仓库（本地路径规范化、远程地址原样、两端空白去掉）", () => {
      const r = planProjectCreate({
        name: "改版",
        templateId: "develop",
        repos: [
          { repoPath: `  ${abs}${path.sep}  `, baseBranch: " main " },
          { repoPath: " https://git.example.com/team/api.git ", baseBranch: "release" },
        ],
        featureBranch: "  feature/redesign ",
      }, groups())
      expect(r.ok).toBe(true)
      if (!r.ok) return
      expect(r.repos).toEqual([
        { repoPath: abs, baseBranch: "main" },
        { repoPath: "https://git.example.com/team/api.git", baseBranch: "release" },
      ])
      expect(r.featureBranch).toBe("feature/redesign")
      expect(r.group.id).toBe("develop")
    })

    it("本地仓库必须是完整路径；同一个仓库选两次不行；数量有上限", () => {
      const rel = planProjectCreate({ name: "a", templateId: "develop", repos: [{ repoPath: "repos/shop", baseBranch: "main" }] }, groups())
      expect(!rel.ok && rel.error).toContain("完整路径")
      const dup = planProjectCreate({
        name: "a",
        templateId: "develop",
        repos: [{ repoPath: abs, baseBranch: "main" }, { repoPath: abs + path.sep, baseBranch: "dev" }],
      }, groups())
      expect(dup).toEqual({ ok: false, error: "「shop」选重了" })
      const many = Array.from({ length: PROJECT_REPOS_MAX + 1 }, (_, i) => ({ repoPath: `https://h/r${i}.git`, baseBranch: "main" }))
      expect(planProjectCreate({ name: "a", templateId: "develop", repos: many }, groups()).ok).toBe(false)
    })

    it("项目链接和相关文档收下（去空白、有长度上限）；feature 分支可以不填", () => {
      const r = dev({ storyUrl: " https://t.example.com/1 ", relatedDocs: " 见 wiki " })
      expect(r.ok && r.storyUrl).toBe("https://t.example.com/1")
      expect(r.ok && r.relatedDocs).toBe("见 wiki")
      expect(r.ok && r.featureBranch).toBe("")
      expect(dev({ storyUrl: "x".repeat(PROJECT_TEXT_MAX + 1) }).ok).toBe(false)
      expect(dev({ relatedDocs: "x".repeat(PROJECT_TEXT_MAX + 1) }).ok).toBe(false)
      const bare = dev()
      expect(bare.ok && "storyUrl" in bare).toBe(false)
    })
  })

  it("不接代码仓库的模板：传来的仓库和分支一概不理", () => {
    const r = planProjectCreate({
      name: "周报",
      templateId: "general",
      repos: [{ repoPath: "relative/不合法", baseBranch: "" }],
      featureBranch: "feature/x",
    }, groups())
    expect(r.ok).toBe(true)
    if (r.ok) expect(r).toMatchObject({ repos: [], featureBranch: "" })
  })

  it("字段值按模板声明收进 metadata，必填没填会提示", () => {
    const g = groups()
    g.find((x) => x.id === "research")!.fields = [{ label: "交付形式", required: true }, { label: "截止时间" }]
    const miss = planProjectCreate({ name: "a", templateId: "research", fields: { 截止时间: "周五" } }, g)
    expect(miss).toEqual({ ok: false, error: "请填写：交付形式" })
    const ok = planProjectCreate({ name: "a", goal: " 做调研 ", templateId: "research", fields: { 交付形式: " PPT ", 没声明: "x" } }, g)
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.goal).toBe("做调研")
      expect(ok.metadata).toEqual({ 交付形式: "PPT" })
      expect(ok.group.id).toBe("research")
    }
  })

  it("目标和字段值有长度上限", () => {
    expect(planProjectCreate({ name: "a", goal: "x".repeat(PROJECT_TEXT_MAX + 1), templateId: "general" }, groups()).ok).toBe(false)
    const r = planProjectCreate({ name: "a", templateId: "research", fields: { 交付形式: "x".repeat(PROJECT_TEXT_MAX + 1) } }, groups())
    expect(r.ok).toBe(false)
  })

  it("模板里没有步骤不能建", () => {
    const g = groups()
    g.push({ id: "empty", name: "空", workspace: "plain", nodes: [] })
    expect(planProjectCreate({ name: "a", templateId: "empty" }, g).ok).toBe(false)
  })
})

describe("checkExternalFolder", () => {
  const base = path.resolve(path.sep, "work")
  const userData = path.join(base, "app-data")
  const ctx = {
    userDataDir: userData,
    projects: [
      { name: "旧项目", dir: path.join(base, "projects", "old"), external: false },
      { name: "我的周报", dir: path.join(base, "docs", "weekly"), external: true },
    ],
  }

  it("普通文件夹通过，返回规范化后的路径", () => {
    const r = checkExternalFolder(path.join(base, "docs", "notes") + path.sep, ctx)
    expect(r).toEqual({ ok: true, dir: path.join(base, "docs", "notes") })
  })

  it("相对路径、空路径、磁盘根目录不行", () => {
    expect(checkExternalFolder("", ctx).ok).toBe(false)
    expect(checkExternalFolder("docs/notes", ctx).ok).toBe(false)
    expect(checkExternalFolder(path.parse(base).root, ctx).ok).toBe(false)
  })

  it("应用数据目录本身、它的上级、它里面的目录都不行", () => {
    // 不带别的项目，免得被「占用」那条规则顶替掉要测的这条
    const bare = { userDataDir: userData, projects: [] }
    const same = checkExternalFolder(userData, bare)
    expect(!same.ok && same.error).toContain("数据目录")
    const up = checkExternalFolder(base, bare)
    expect(!up.ok && up.error).toContain("包含了应用自己的数据目录")
    const down = checkExternalFolder(path.join(userData, "sessions"), bare)
    expect(!down.ok && down.error).toContain("数据目录")
  })

  it("已被别的项目占用（相同、在里面、把它包住）都不行，并说出是哪个项目", () => {
    const same = checkExternalFolder(path.join(base, "docs", "weekly"), ctx)
    expect(!same.ok && same.error).toContain("我的周报")
    const inside = checkExternalFolder(path.join(base, "projects", "old", "workspace"), ctx)
    expect(!inside.ok && inside.error).toContain("旧项目")
    const wraps = checkExternalFolder(path.join(base, "docs"), ctx)
    expect(!wraps.ok && wraps.error).toContain("我的周报")
  })

  it("名字相近的兄弟目录不算「在里面」", () => {
    expect(isSameOrInside(path.join(base, "docs", "weekly-2"), path.join(base, "docs", "weekly"))).toBe(false)
    expect(checkExternalFolder(path.join(base, "docs", "weekly-2"), ctx).ok).toBe(true)
  })
})

describe("项目步骤副本同步", () => {
  it("全局模板改了才算有差异；同步后和全局一致", () => {
    const globals = groups()
    const snap = snapshotGroups([globals.find((g) => g.id === "writing")!])
    expect(snapshotDiffers(snap, globals)).toBe(false)

    const changed = globals.map((g) => g.id === "writing"
      ? { ...g, nodes: [...g.nodes, { id: "extra", label: "多一步" }] }
      : g)
    expect(snapshotDiffers(snap, changed)).toBe(true)
    const synced = syncedSnapshot(snap, changed)
    expect(synced[0].nodes.map((n) => n.id)).toContain("extra")
    expect(snapshotDiffers(synced, changed)).toBe(false)
  })

  it("全局已经删掉的模板，副本里保留原样，不算差异", () => {
    const globals = groups()
    const snap = snapshotGroups([globals.find((g) => g.id === "event")!])
    const without = globals.filter((g) => g.id !== "event")
    expect(snapshotDiffers(snap, without)).toBe(false)
    expect(syncedSnapshot(snap, without)[0].nodes).toHaveLength(4)
  })

  it("项目里的步骤改过自己的提示词，同步会被全局版本覆盖（同步就是以模板为准）", () => {
    const globals = groups()
    const snap = snapshotGroups([globals.find((g) => g.id === "general")!])
    snap[0].nodes[0].prompt = "项目里单独写的"
    expect(snapshotDiffers(snap, globals)).toBe(true)
    expect(syncedSnapshot(snap, globals)[0].nodes[0].prompt).toBeUndefined()
  })
})

describe("buildProjectView", () => {
  const base = path.resolve(path.sep, "work", "p1")
  const project = (extra: Partial<Project> = {}): Project => ({
    id: "abc123def456", name: "周报", goal: "每周五出报告", repoPath: "", baseBranch: "", featureBranch: "",
    worktreePath: path.join(base, "workspace"), workspaceType: "plain",
    groupIds: ["report"], groupId: "report", createdAt: 1, updatedAt: 2, ...extra,
  })

  it("步骤按模板顺序、多模板去重；项目信息逐条列出", () => {
    const gs = groups().filter((g) => g.id === "general" || g.id === "report")
    const v = buildProjectView(project({ metadata: { 汇报对象: "老板", 汇报周期: "每周五" }, storyUrl: "https://x", relatedDocs: "文档A" }), {
      channelId: CH, groups: gs, globals: groups(), fileExists: () => true,
    })
    expect(v.steps.map((s) => s.id)).toEqual(["clarify", "breakdown", "execute", "recap", "collect-progress", "draft-report", "next-plan"])
    expect(v.steps[0].group).toBe("通用任务")
    expect(v.templateNames).toEqual(["通用任务", "周报月报"])
    expect(v.info).toEqual([{ key: "汇报对象", value: "老板" }, { key: "汇报周期", value: "每周五" }])
    expect(v.isCode).toBe(false)
    expect(v.storyUrl).toBe("https://x")
    expect(v.relatedDocs).toBe("文档A")
    expect(v.featureBranch).toBeUndefined()
    expect(v.canSyncSteps).toBe(false)
  })

  it("普通项目的目录是项目根目录；外部文件夹项目的目录就是文件夹本身", () => {
    const opts = { channelId: CH, groups: groups(), globals: groups(), fileExists: () => true }
    expect(buildProjectView(project(), opts).dir).toBe(base)
    const folder = path.resolve(path.sep, "Users", "me", "周报")
    const ext = buildProjectView(project({ worktreePath: folder, externalWorkspace: true }), opts)
    expect(ext.dir).toBe(folder)
    expect(ext.externalDir).toBe(true)
  })

  it("最近成果：相对路径落到项目目录下，并标出文件在不在", () => {
    const rel = path.join(".lk-harness", "artifacts", "周报.md")
    const opts = (exists: boolean) => ({ channelId: CH, groups: groups(), globals: groups(), fileExists: () => exists })
    const p = project({ lastArtifactPath: rel, lastArtifactSummary: "本周周报", lastArtifactAt: 5 })
    const v = buildProjectView(p, opts(true))
    expect(v.artifact).toEqual({
      path: path.join(p.worktreePath, rel), name: "周报.md", summary: "本周周报", at: 5, exists: true,
    })
    expect(buildProjectView(p, opts(false)).artifact?.exists).toBe(false)
    expect(buildProjectView(project(), opts(true)).artifact).toBeUndefined()
  })

  it("研发项目标出 isCode 和分支；有副本且和全局不同才可同步", () => {
    const dev = project({ workspaceType: undefined, featureBranch: "feature/x", repoPath: "/r" })
    const v = buildProjectView(dev, { channelId: CH, groups: groups(), globals: groups(), fileExists: () => true })
    expect(v.isCode).toBe(true)
    expect(v.featureBranch).toBe("feature/x")

    const snap = snapshotGroups([groups().find((g) => g.id === "report")!])
    const globals = groups().map((g) => g.id === "report" ? { ...g, name: "周报月报（新）" } : g)
    const withSnap = project({ groupSnapshot: snap })
    expect(buildProjectView(withSnap, { channelId: CH, groups: snap, globals, fileExists: () => true }).canSyncSteps).toBe(true)
    expect(buildProjectView(withSnap, { channelId: CH, groups: snap, globals: groups(), fileExists: () => true }).canSyncSteps).toBe(false)
  })

  it("有归档时间才是已归档；视图里没有项目状态", () => {
    const opts = { channelId: CH, groups: groups(), globals: groups(), fileExists: () => true }
    const live = buildProjectView(project(), opts)
    expect(live.archived).toBe(false)
    expect(live).not.toHaveProperty("status")
    expect(buildProjectView(project({ archivedAt: 1700000000000 }), opts).archived).toBe(true)
  })

  it("项目归不归当前通道：按项目现在绑的会话判断", () => {
    const opts = { channelId: CH, groups: groups(), globals: groups(), fileExists: () => true }
    expect(buildProjectView(project({ sessionKey: projectSessionKey(`${CH}|app_main`, "abc123def456") }), opts).ownedHere).toBe(true)
    expect(buildProjectView(project({ sessionKey: projectSessionKey("ch_fs|oc_x", "abc123def456") }), opts).ownedHere).toBe(false)
  })
})

describe("isProjectOwnedBy", () => {
  const key = (ch: string) => projectSessionKey(`${ch}|app_main`, "abc123def456")

  it("会话键所在通道就是归属；换了通道就不是", () => {
    expect(isProjectOwnedBy({ sessionKey: key("ch_app") }, "ch_app")).toBe(true)
    expect(isProjectOwnedBy({ sessionKey: key("ch_fs") }, "ch_app")).toBe(false)
  })

  it("还没有会话键：看独立群，再看通知会话", () => {
    expect(isProjectOwnedBy({ groupChatId: "ch_fs|oc_group" }, "ch_app")).toBe(false)
    expect(isProjectOwnedBy({ notifyChatId: "ch_app|app_main" }, "ch_app")).toBe(true)
    expect(isProjectOwnedBy({ notifyChatId: "ch_fs|ou_x" }, "ch_app")).toBe(false)
  })

  it("什么都没绑过的项目谁都能认领；老版本没有通道前缀的飞书会话键认不出通道，算别人的", () => {
    expect(isProjectOwnedBy({}, "ch_app")).toBe(true)
    expect(isProjectOwnedBy({ notifyChatId: "oc_legacy_chat" }, "ch_app")).toBe(false)
    expect(isProjectOwnedBy({ sessionKey: "oc_legacy_chat::project_abc123def456" }, "ch_app")).toBe(false)
  })
})

describe("projectIdOfSessionKey", () => {
  it("和 project-types 里的 projectIdFromSessionKey 对所有形态给出同样结果", () => {
    const keys = [
      projectSessionKey("ch_app|app_main", "abc123def456"),
      projectSessionKey("ch_fs|oc_x", "0123456789ab"),
      "ch_app|app_main::D:\\work\\dir",
      "ch_app|app_main",
      "ch_app|app_main::project_",
      "::project_zzz",
      "no-separator",
    ]
    for (const k of keys) expect(projectIdOfSessionKey(k), k).toBe(projectIdFromSessionKey(k))
    expect(projectIdOfSessionKey(keys[0])).toBe("abc123def456")
  })
})

describe("sortTemplatesForPicker", () => {
  const t = (id: string) => ({ id })
  // 设置里的默认顺序：开发、测试、通用任务、调研……
  const stored = [t("develop"), t("test"), t("general"), t("research"), t("writing"), t("report"), t("event")]

  it("通用任务放最前，其余保持设置里的顺序（开发不再被挪到最后）", () => {
    expect(sortTemplatesForPicker(stored).map((x) => x.id)).toEqual(["general", "develop", "test", "research", "writing", "report", "event"])
  })

  it("不改动传进来的数组", () => {
    const copy = stored.map((x) => ({ ...x }))
    sortTemplatesForPicker(stored)
    expect(stored).toEqual(copy)
  })

  it("没有通用任务、空列表都不出错，顺序不变", () => {
    expect(sortTemplatesForPicker([t("b"), t("a")]).map((x) => x.id)).toEqual(["b", "a"])
    expect(sortTemplatesForPicker([])).toEqual([])
  })
})

describe("代码仓库表单的共用判断", () => {
  it("isRemoteRepoUrl 与主进程是同一条规则", () => {
    for (const s of ["https://a/b.git", "HTTP://a/b", "ssh://git@h/x", "git@h:x/y.git", "  https://a/b  "]) {
      expect(isRemoteRepoUrl(s), s).toBe(isRemoteRepoRef(s))
      expect(isRemoteRepoUrl(s), s).toBe(true)
    }
    for (const s of ["D:\\repos\\a", "/home/a", "ftp://a/b", "file:///a", "", "-oProxyCommand=x"]) {
      expect(isRemoteRepoUrl(s), s).toBe(isRemoteRepoRef(s))
      expect(isRemoteRepoUrl(s), s).toBe(false)
    }
  })

  it("repoDisplayName 取最后一段并去掉 .git", () => {
    expect(repoDisplayName("D:\\work\\shop\\")).toBe("shop")
    expect(repoDisplayName("/home/me/api")).toBe("api")
    expect(repoDisplayName("https://git.example.com/team/web.git")).toBe("web")
    expect(repoDisplayName("git@git.example.com:team/app.git")).toBe("app")
    expect(repoDisplayName("")).toBe("仓库")
  })

  it("repoPicksProblem：空、缺基线、重复、过多都有话说，正常返回空串", () => {
    const ok = [{ repoPath: "D:\\a\\shop", baseBranch: "main" }]
    expect(repoPicksProblem(ok)).toBe("")
    expect(repoPicksProblem([])).toBe("请至少选一个代码仓库")
    expect(repoPicksProblem([{ repoPath: "D:\\a\\shop", baseBranch: " " }])).toBe("请填写「shop」的基线分支")
    expect(repoPicksProblem([...ok, { repoPath: "d:\\A\\shop\\", baseBranch: "dev" }])).toBe("「shop」选重了")
    expect(repoPicksProblem([
      { repoPath: "https://h/x/api.git", baseBranch: "main" },
      { repoPath: "https://h/x/api", baseBranch: "main" },
    ])).toBe("「api」选重了")
    const many = Array.from({ length: PROJECT_REPOS_MAX + 1 }, (_, i) => ({ repoPath: `https://h/r${i}`, baseBranch: "main" }))
    expect(repoPicksProblem(many)).toContain("最多")
    expect(repoPicksProblem(many.slice(0, PROJECT_REPOS_MAX))).toBe("")
  })
})

describe("projectDeleteNote（删项目确认框里的那句话）", () => {
  it("普通项目：成果进回收站", () => {
    const t = projectDeleteNote({ externalDir: false, dir: "D:\\p", isCode: false })
    expect(t).toContain("AI 生成的全部成果")
    expect(t).toContain("回收站")
    expect(t).not.toContain("仓库")
  })

  it("研发项目：说清代码副本里没提交/没推送的改动会没，而用户自己的仓库和远程分支不受影响", () => {
    const t = projectDeleteNote({ externalDir: false, dir: "D:\\p", isCode: true })
    expect(t).toContain("还没提交或推送的改动")
    expect(t).toContain("你自己的仓库和远程分支不受影响")
  })

  it("用户自己选的文件夹：只说明文件夹不会被删，不提回收站；手机端把回收站说成电脑的", () => {
    const t = projectDeleteNote({ externalDir: true, dir: "D:\\我的资料", isCode: false })
    expect(t).toContain("「D:\\我的资料」不会被删除")
    expect(t).not.toContain("回收站")
    expect(projectDeleteNote({ externalDir: false, dir: "x", isCode: true }, "电脑的回收站")).toContain("移到电脑的回收站")
    expect(projectDeleteNote({ externalDir: false, dir: "x", isCode: false }, "电脑的回收站")).toContain("移到电脑的回收站")
  })
})

describe("项目的删除确认和归档提示", () => {
  const view = { name: "官网改版", externalDir: false, dir: "D:\\p", isCode: false }

  it("删除确认：说清删什么，并提醒想留着成果可以归档", () => {
    const t = projectDeleteConfirmText(view)
    expect(t).toContain("确定删除项目「官网改版」吗？")
    expect(t).toContain("清除聊天记录")
    expect(t).toContain(projectDeleteNote(view))
    expect(t).toContain("可以归档")
  })

  it("手机端把回收站说成电脑的", () => {
    expect(projectDeleteConfirmText(view, "电脑的回收站")).toContain("移到电脑的回收站")
  })

  it("项目归别的通道管：删除 / 归档都指到设置的项目管理里做", () => {
    expect(projectNotOwnedHint("删除")).toContain("删除可以在设置的项目管理里做")
    expect(projectNotOwnedHint("归档")).toContain("归档可以在设置的项目管理里做")
  })
})

describe("parseGatewayCreateInput（手机网关收到的建项请求体）", () => {
  it("完整的研发类请求：名称、模板、字段、仓库、分支、链接、文档都带过去", () => {
    const input = parseGatewayCreateInput({
      name: "改版", goal: "g", templateId: "develop", fields: { 备注: "x" },
      repos: [{ repoPath: "https://h/x/shop.git", baseBranch: "develop" }],
      featureBranch: "feature/x", storyUrl: "https://s/1", relatedDocs: "doc",
    })
    expect(input).toEqual({
      name: "改版", goal: "g", templateId: "develop", fields: { 备注: "x" },
      repos: [{ repoPath: "https://h/x/shop.git", baseBranch: "develop" }],
      featureBranch: "feature/x", storyUrl: "https://s/1", relatedDocs: "doc",
    })
  })

  it("手机不能指定本机文件夹：folder 一律丢掉", () => {
    const input = parseGatewayCreateInput({ name: "n", templateId: "general", folder: "C:\\Windows" })
    expect("folder" in input).toBe(false)
  })

  it("形状不对的东西丢掉而不是抛错：非字符串字段、非数组 repos、缺字段的仓库", () => {
    const input = parseGatewayCreateInput({
      name: 5, templateId: null, goal: {}, fields: { a: "ok", b: 1, c: null },
      repos: [null, { repoPath: 7 }, { repoPath: "r", baseBranch: "b" }],
      featureBranch: 1,
    })
    expect(input.name).toBe("")
    expect(input.templateId).toBe("")
    expect(input.goal).toBeUndefined()
    expect(input.fields).toEqual({ a: "ok" })
    expect(input.repos).toEqual([
      { repoPath: "", baseBranch: "" }, { repoPath: "", baseBranch: "" }, { repoPath: "r", baseBranch: "b" },
    ])
    expect(input.featureBranch).toBeUndefined()
    expect(parseGatewayCreateInput({ name: "n", templateId: "t", repos: "x" }).repos).toBeUndefined()
    expect(parseGatewayCreateInput(null)).toMatchObject({ name: "", templateId: "", fields: {} })
  })

  it("整理出来的空仓库会被建项校验拦下，不会被当成没选", () => {
    const groups = DEFAULT_NODE_GROUPS
    const dev = groups.find((g) => g.workspace === "worktree")!
    const r = planProjectCreate(parseGatewayCreateInput({ name: "n", templateId: dev.id, repos: [{}] }), groups)
    expect(r.ok).toBe(false)
  })
})
