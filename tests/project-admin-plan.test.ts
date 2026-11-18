import { describe, expect, it } from "vitest"
import * as os from "node:os"
import * as path from "node:path"
import {
  ACTION_PROMPT_MAX,
  buildSettingsView,
  buildTemplateDetail,
  maskSecret,
  planProjectUpdate,
  planRepoSave,
  planSettingsSet,
  planTemplateDelete,
  planTemplateSave,
  type TemplateSavePlan,
} from "../src/shared/project-admin-plan"
import {
  formatProjectDetail,
  formatRepoRemoved,
  formatRepoSaved,
  formatSetupChecklist,
  formatSettings,
  formatTemplateDetail,
  formatTemplateSaved,
} from "../src/shared/project-admin-format"
import { DEFAULT_GIT_PRINCIPLES, GIT_PRINCIPLES_MAX } from "../src/shared/project-git-principles"
import { DEFAULT_NODE_GROUPS, type Project, type ProjectNodeGroupDef } from "../src/shared/project-types"
import type { ProjectListItem } from "../src/shared/project-app-types"

/**
 * AI 管理项目配置的纯逻辑：设置、常用仓库、模板、项目资料。
 * 守住的是「AI 和人走同一道门」：设置页里有的上限、重名、至少一个快捷操作、删模板的限制，AI 这边一条不少；
 * 以及密钥永远只以打码的样子出现在给 AI 的任何文字里。
 */

const ABS = path.join(os.tmpdir(), "claw-projects")
const TOKEN = "glpat-SECRET0123456789abc"

function groups(): ProjectNodeGroupDef[] {
  return structuredClone(DEFAULT_NODE_GROUPS)
}
function ok<T extends { ok: boolean }>(r: T): Extract<T, { ok: true }> {
  if (!r.ok) throw new Error(`期望成功，实际：${(r as unknown as { error: string }).error}`)
  return r as Extract<T, { ok: true }>
}
function err(r: { ok: boolean; error?: string }): string {
  if (r.ok) throw new Error("期望失败，实际成功了")
  return r.error ?? ""
}
const saved = (r: TemplateSavePlan) => ok(r)

describe("planSettingsSet：项目存放位置", () => {
  it("绝对路径：规整后写入，并要求宿主先建好目录", () => {
    const r = ok(planSettingsSet({ worktreeRoot: `  ${ABS}${path.sep}  ` }))
    expect(r.patch).toEqual({ worktreeRoot: ABS })
    expect(r.mkdir).toBe(ABS)
    expect(r.summary.join("\n")).toContain("只影响之后新建的项目")
  })

  it("相对路径、整个盘都拒绝；空串 = 改回默认位置", () => {
    expect(err(planSettingsSet({ worktreeRoot: "projects/x" }))).toContain("绝对路径")
    expect(err(planSettingsSet({ worktreeRoot: path.parse(ABS).root }))).toContain("整个盘")
    const r = ok(planSettingsSet({ worktreeRoot: "  " }))
    expect(r.patch).toEqual({ worktreeRoot: "" })
    expect(r.mkdir).toBeUndefined()
  })
})

describe("planSettingsSet：GitLab 与共享空间", () => {
  it("GitLab 地址只认域名部分：补 https、去尾斜杠；带仓库路径、非 http 一律拒绝", () => {
    expect(ok(planSettingsSet({ gitlabHost: "gitlab.example.com" })).patch).toEqual({ gitlabHost: "https://gitlab.example.com" })
    expect(ok(planSettingsSet({ gitlabHost: "http://git.corp:8080/" })).patch).toEqual({ gitlabHost: "http://git.corp:8080" })
    expect(err(planSettingsSet({ gitlabHost: "https://gitlab.example.com/group/repo" }))).toContain("域名部分")
    expect(err(planSettingsSet({ gitlabHost: "ftp://gitlab.example.com" }))).toContain("域名部分")
    expect(ok(planSettingsSet({ gitlabHost: "" })).patch).toEqual({ gitlabHost: "" })
  })

  it("Token：去首尾空白后写入；中间有空白 / 太长拒绝；空串清除", () => {
    expect(ok(planSettingsSet({ gitlabToken: `  ${TOKEN}\n` })).patch).toEqual({ gitlabToken: TOKEN })
    expect(err(planSettingsSet({ gitlabToken: "glpat abc" }))).toContain("空格或换行")
    expect(err(planSettingsSet({ flowHubToken: "x".repeat(301) }))).toContain("太长")
    expect(ok(planSettingsSet({ gitlabToken: "" })).summary.join("\n")).toContain("已清除")
  })

  it("密钥只写进 patch，不会出现在给 AI 的「改了什么」里", () => {
    const r = ok(planSettingsSet({ gitlabToken: TOKEN, flowHubToken: `${TOKEN}-hub`, gitlabHost: "https://gitlab.example.com" }))
    const text = r.summary.join("\n")
    expect(text).not.toContain("SECRET")
    expect(text).not.toContain("glpat")
    expect(text).toContain("GitLab Token：已更新")
    expect(text).toContain("共享空间 Token：已更新")
  })

  it("共享空间地址要能解析成 GitLab 仓库地址；署名有长度上限", () => {
    expect(err(planSettingsSet({ flowHubUrl: "not a url" }))).toContain("共享空间地址无效")
    expect(ok(planSettingsSet({ flowHubUrl: "https://gitlab.example.com/team/flow-hub" })).patch.flowHubUrl).toBe("https://gitlab.example.com/team/flow-hub")
    expect(ok(planSettingsSet({ flowHubUrl: "" })).patch).toEqual({ flowHubUrl: "" })
    expect(err(planSettingsSet({ flowHubAuthor: "x".repeat(61) }))).toContain("署名")
  })
})

describe("planSettingsSet：Git 基本原则", () => {
  it("空串 = 关闭；写成默认文案 = 恢复默认；换行统一；超长拒绝", () => {
    expect(ok(planSettingsSet({ gitPrinciples: "  " })).patch).toEqual({ gitPrinciples: "" })
    expect(ok(planSettingsSet({ gitPrinciples: "  " })).summary[0]).toContain("已关闭")
    expect(ok(planSettingsSet({ gitPrinciples: DEFAULT_GIT_PRINCIPLES })).summary[0]).toContain("恢复默认")
    expect(ok(planSettingsSet({ gitPrinciples: "1. 只用 main\r\n2. 不要 force push" })).patch.gitPrinciples).toBe("1. 只用 main\n2. 不要 force push")
    expect(err(planSettingsSet({ gitPrinciples: "x".repeat(GIT_PRINCIPLES_MAX + 1) }))).toContain(String(GIT_PRINCIPLES_MAX))
  })

  it("reset 写成默认文案（存储层把它当「没改过」）；和新内容一起给直接拒绝", () => {
    expect(ok(planSettingsSet({ resetGitPrinciples: true })).patch).toEqual({ gitPrinciples: DEFAULT_GIT_PRINCIPLES })
    expect(err(planSettingsSet({ resetGitPrinciples: true, gitPrinciples: "x" }))).toContain("只能给一个")
    // reset=false 不算给了
    expect(err(planSettingsSet({ resetGitPrinciples: false }))).toContain("没有要改的设置")
  })

  it("什么都没给：报错并列出能改的项", () => {
    const e = err(planSettingsSet({}))
    for (const w of ["worktree_root", "git_principles", "gitlab_host", "gitlab_token", "flow_hub"]) expect(e).toContain(w)
  })

  it("任何一项不合法，整次都不写（不会改一半）", () => {
    expect(err(planSettingsSet({ gitlabToken: TOKEN, worktreeRoot: "relative" }))).toContain("绝对路径")
  })
})

describe("maskSecret / buildSettingsView：密钥不出宿主", () => {
  it("打码：空 = 未设置；短的只留 2 位；长的留头 6 尾 3", () => {
    expect(maskSecret("")).toBe("（未设置）")
    expect(maskSecret(undefined)).toBe("（未设置）")
    expect(maskSecret("abcd")).toBe("ab***")
    expect(maskSecret(TOKEN)).toBe("glpat-***abc")
    expect(maskSecret(TOKEN)).not.toContain("SECRET")
  })

  it("视图里只有打码后的 Token；Git 原则三态：没设过=默认，设成空=关闭，改过=自定义", () => {
    const base = { effectiveRoot: "D:\\p", repoCount: 2, templateCount: 7, projectCount: 3 }
    const v = buildSettingsView({ gitlabToken: TOKEN, flowHubToken: TOKEN, gitlabHost: " https://g.example.com " }, base)
    expect(JSON.stringify(v)).not.toContain("SECRET")
    expect(v.gitlabTokenMasked).toBe("glpat-***abc")
    expect(v.gitlabHost).toBe("https://g.example.com")
    expect(v.gitPrinciplesMode).toBe("default")
    expect(v.gitPrinciples).toBe(DEFAULT_GIT_PRINCIPLES)
    expect(buildSettingsView({ gitPrinciples: "" }, base).gitPrinciplesMode).toBe("off")
    expect(buildSettingsView({ gitPrinciples: "  \n " }, base).gitPrinciples).toBe("")
    expect(buildSettingsView({ gitPrinciples: "只用 main" }, base).gitPrinciplesMode).toBe("custom")
    expect(buildSettingsView({ gitPrinciples: DEFAULT_GIT_PRINCIPLES }, base).gitPrinciplesMode).toBe("default")
  })

  it("格式化后的设置现状、help 的当前状态里同样没有密钥原文", () => {
    const v = buildSettingsView({ gitlabToken: TOKEN, flowHubToken: TOKEN, flowHubUrl: "https://g.example.com/t/hub" }, { effectiveRoot: "D:\\p", repoCount: 0, templateCount: 7, projectCount: 0 })
    for (const text of [formatSettings(v), formatSetupChecklist(v)]) {
      expect(text).not.toContain("SECRET")
      expect(text).toContain("glpat-***abc")
    }
  })
})

describe("formatSetupChecklist：据现状告诉 AI 用户还缺什么", () => {
  const base = { effectiveRoot: "D:\\default-root", repoCount: 0, templateCount: 7, projectCount: 0 }
  it("什么都没配：默认位置不用动、没仓库要登记、GitLab 可选别主动提", () => {
    const t = formatSetupChecklist(buildSettingsView({}, base))
    expect(t).toContain("用默认位置 D:\\default-root")
    expect(t).toContain("还没有")
    expect(t).toContain("repo_save")
    expect(t).toContain("没配。可选")
    expect(t).toContain("不要主动让他配")
  })
  it("配过的：说配了什么", () => {
    const t = formatSetupChecklist(buildSettingsView({ worktreeRoot: "E:\\ws", gitlabToken: TOKEN }, { ...base, repoCount: 3 }))
    expect(t).toContain("已自定义为 E:\\ws")
    expect(t).toContain("3 个")
    expect(t).toContain("已配置")
  })
})

describe("planRepoSave：登记 / 修改常用仓库", () => {
  const local = { isRemote: false, detectedBaseBranch: "master" }

  it("新登记：本地仓库不给基线分支就用探测到的默认分支；默认克隆", () => {
    const r = ok(planRepoSave({ repoPath: "/r/shop" }, local))
    expect(r.created).toBe(true)
    expect(r.profile).toEqual({ path: "/r/shop", baseBranch: "master" })
    expect(r.changed).toEqual([])
  })

  it("给了基线 / 测试 / 开发分支：去空白后原样记下；clone=false 才写 clone", () => {
    const r = ok(planRepoSave({ repoPath: "/r/shop", baseBranch: " main ", testBranch: "test", developBranch: "dev", clone: false }, local))
    expect(r.profile).toEqual({ path: "/r/shop", baseBranch: "main", testBranch: "test", developBranch: "dev", clone: false })
    expect(ok(planRepoSave({ repoPath: "/r/shop", clone: true }, local)).profile).not.toHaveProperty("clone")
  })

  it("远程仓库没法探测默认分支：必须明确给，没给就让 AI 去问用户；远程一定克隆", () => {
    expect(err(planRepoSave({ repoPath: "https://g.example.com/a/b.git" }, { isRemote: true }))).toContain("问用户")
    expect(err(planRepoSave({ repoPath: "https://g.example.com/a/b.git", baseBranch: "main", clone: false }, { isRemote: true }))).toContain("一定会克隆")
    const r = ok(planRepoSave({ repoPath: "https://g.example.com/a/b.git", baseBranch: "main" }, { isRemote: true }))
    expect(r.profile).toEqual({ path: "https://g.example.com/a/b.git", baseBranch: "main" })
  })

  it("本地仓库也没探测出默认分支、又没给：不猜", () => {
    expect(err(planRepoSave({ repoPath: "/r/x" }, { isRemote: false }))).toContain("基线分支")
  })

  it("修改已登记的：只改给了的项，没给的保持；测试 / 开发分支传空串 = 清掉", () => {
    const existing = { path: "/r/shop", baseBranch: "main", testBranch: "test", developBranch: "dev", clone: false }
    const r = ok(planRepoSave({ repoPath: "/r/shop", baseBranch: "release", testBranch: "" }, { ...local, existing }))
    expect(r.created).toBe(false)
    expect(r.profile).toEqual({ path: "/r/shop", baseBranch: "release", developBranch: "dev", clone: false })
    expect(r.changed).toEqual(["基线分支 main → release", "测试分支 → （清空）"])
  })

  it("改回克隆：clone=true 把原来的「不克隆」去掉；什么都没变就说没变", () => {
    const existing = { path: "/r/shop", baseBranch: "main", clone: false }
    const back = ok(planRepoSave({ repoPath: "/r/shop", clone: true }, { ...local, existing }))
    expect(back.profile).not.toHaveProperty("clone")
    expect(back.changed).toEqual(["改为建项时克隆副本"])
    const same = ok(planRepoSave({ repoPath: "/r/shop" }, { ...local, existing }))
    expect(same.changed).toEqual([])
    expect(formatRepoSaved(same)).toContain("没有变化")
  })

  it("文字：新登记提醒确认自动识别的分支；修改写出改动；移除说明不删磁盘文件", () => {
    const created = ok(planRepoSave({ repoPath: "/r/shop" }, local))
    expect(formatRepoSaved(created, "master")).toContain("自动识别的默认分支")
    expect(formatRepoSaved(ok(planRepoSave({ repoPath: "/r/shop", baseBranch: "main" }, local)), "master")).not.toContain("自动识别")
    const removed = formatRepoRemoved({ path: "/r/shop", baseBranch: "main" })
    expect(removed).toContain("磁盘上的仓库")
    expect(removed).toContain("都不受影响")
  })
})

describe("planTemplateSave：新建", () => {
  it("只给名字：英文名生成 id，自带一个「开始」快捷操作；默认不接代码仓库", () => {
    const g = groups()
    const r = saved(planTemplateSave(undefined, { name: "Weekly Plan", description: "排周计划" }, g))
    expect(r.created).toBe(true)
    expect(r.group).toMatchObject({ id: "weekly-plan", name: "Weekly Plan", workspace: "plain", description: "排周计划" })
    expect(r.group.nodes.map((n) => n.label)).toEqual(["开始"])
    expect(r.groups).toHaveLength(g.length + 1)
    expect(r.groups.slice(0, g.length)).toEqual(g)
  })

  it("带快捷操作和要填的信息：id 自动生成且全局不重复，顺序就是给的顺序", () => {
    const r = saved(planTemplateSave(undefined, {
      name: "客户拜访",
      fields: [{ label: "客户名称", required: true, placeholder: "某某公司" }, { label: "拜访目的", multiline: true }],
      actions: [{ label: "拜访准备", prompt: "整理客户背景" }, { label: "Visit Notes", prompt: "整理纪要" }, { label: "跟进", prompt: "列待办" }],
    }, groups()))
    expect(r.group.id).toBe("template-1")
    expect(r.group.nodes.map((n) => n.id)).toEqual(["action-1", "visit-notes", "action-2"])
    expect(r.group.nodes.map((n) => n.prompt)).toEqual(["整理客户背景", "整理纪要", "列待办"])
    expect(r.group.fields).toEqual([{ label: "客户名称", placeholder: "某某公司", required: true }, { label: "拜访目的", multiline: true }])
    expect(r.addedActions).toEqual(["拜访准备", "Visit Notes", "跟进"])
    // 所有模板的快捷操作 id 合起来没有重复
    const ids = r.groups.flatMap((g) => g.nodes.map((n) => n.id))
    expect(new Set(ids).size).toBe(ids.length)
  })

  it("接代码仓库 + 工作分支", () => {
    const r = saved(planTemplateSave(undefined, { name: "Code Review", needsRepo: true, workBranch: "test" }, groups()))
    expect(r.group).toMatchObject({ workspace: "worktree", branchMode: "test" })
    expect(err(planTemplateSave(undefined, { name: "Docs", workBranch: "test" }, groups()))).toContain("不接代码仓库")
    expect(err(planTemplateSave(undefined, { name: "Docs", needsRepo: true, workBranch: "main" as never }, groups()))).toContain("work_branch")
  })

  it("和设置页同一套校验：必须有名字、名字不重复不超长、说明不超长、要填的信息不超过 8 项且不重名", () => {
    const g = groups()
    expect(err(planTemplateSave(undefined, { description: "x" }, g))).toContain("name")
    expect(err(planTemplateSave(undefined, { name: "  " }, g))).toContain("name")
    expect(err(planTemplateSave(undefined, { name: "开发" }, g))).toContain("已经有叫「开发」的模板")
    expect(err(planTemplateSave(undefined, { name: "x".repeat(31) }, g))).toContain("30")
    expect(err(planTemplateSave(undefined, { name: "ok", description: "x".repeat(201) }, g))).toContain("200")
    const nine = Array.from({ length: 9 }, (_, i) => ({ label: `项${i}` }))
    expect(err(planTemplateSave(undefined, { name: "ok", fields: nine }, g))).toContain("最多 8")
    expect(err(planTemplateSave(undefined, { name: "ok", fields: [{ label: "甲" }, { label: "甲" }] }, g))).toContain("重复")
  })

  it("新增的快捷操作必须写 prompt；名字不能空 / 超长 / 重复；至少一个；自己指定的 id 不能撞别的模板或保留词", () => {
    const g = groups()
    const mk = (actions: { id?: string; label: string; prompt?: string }[]) => planTemplateSave(undefined, { name: "T", actions }, g)
    expect(err(mk([{ label: "做事" }]))).toContain("要写 prompt")
    expect(err(mk([{ label: " ", prompt: "p" }]))).toContain("缺少名称")
    expect(err(mk([{ label: "x".repeat(21), prompt: "p" }]))).toContain("20")
    expect(err(mk([{ label: "甲", prompt: "p" }, { label: "甲", prompt: "q" }]))).toContain("重复")
    expect(err(mk([]))).toContain("至少")
    expect(err(mk([{ id: "plan", label: "甲", prompt: "p" }]))).toContain("已经被占用")
    expect(err(mk([{ id: "help", label: "甲", prompt: "p" }]))).toContain("保留命令")
    expect(err(mk([{ id: "Bad Id", label: "甲", prompt: "p" }]))).toContain("小写字母开头")
    expect(err(mk([{ id: "same", label: "甲", prompt: "p" }, { id: "same", label: "乙", prompt: "q" }]))).toContain("已经被占用")
    expect(err(mk([{ label: "甲", prompt: "x".repeat(ACTION_PROMPT_MAX + 1) }]))).toContain("太长")
  })
})

describe("planTemplateSave：修改", () => {
  it("只给说明：别的（名字、快捷操作、工作区、分支）原样不动；别的模板也不动", () => {
    const g = groups()
    const r = saved(planTemplateSave("test", { description: "新的说明" }, g))
    expect(r.created).toBe(false)
    const before = g.find((x) => x.id === "test")!
    expect(r.group).toEqual({ ...before, description: "新的说明" })
    expect(r.groups.filter((x) => x.id !== "test")).toEqual(g.filter((x) => x.id !== "test"))
    expect(r.groups.map((x) => x.id)).toEqual(g.map((x) => x.id))
  })

  it("存量模板没写 workspace 按「接仓库」算：改说明不会悄悄把它变成不接", () => {
    const g: ProjectNodeGroupDef[] = [
      { id: "old", name: "旧模板", nodes: [{ id: "go", label: "走", prompt: "p" }] },
      { id: "other", name: "别的", nodes: [{ id: "x", label: "X" }] },
    ]
    const r = saved(planTemplateSave("old", { description: "d" }, g))
    expect(r.group.workspace).toBe("worktree")
    expect(saved(planTemplateSave("old", { needsRepo: false }, g)).group.workspace).toBe("plain")
  })

  it("改名要避开别的模板的名字，改成自己原来的名字不算重名", () => {
    const g = groups()
    expect(err(planTemplateSave("test", { name: "开发" }, g))).toContain("已经有叫「开发」")
    expect(saved(planTemplateSave("test", { name: "测试" }, g)).group.name).toBe("测试")
  })

  it("共享空间的跟踪信息（hubId 等）改了别的东西也留着", () => {
    const g = groups()
    g[0] = { ...g[0], hubId: "h1", hubRevision: 3, hubContentHash: "abc", localRevision: 2 }
    const r = saved(planTemplateSave(g[0].id, { description: "x", actions: [{ id: g[0].nodes[0].id, label: "改个名" }, { id: g[0].nodes[1].id, label: g[0].nodes[1].label }] }, g))
    expect(r.group).toMatchObject({ hubId: "h1", hubRevision: 3, hubContentHash: "abc", localRevision: 2 })
  })

  it("快捷操作：带 id 或原名的保留原提示词（不给 prompt 不变），可以改名、调顺序；没列出的被删，并如实告知", () => {
    const g: ProjectNodeGroupDef[] = [{
      id: "t", name: "T", workspace: "plain",
      nodes: [{ id: "a1", label: "甲", prompt: "甲的要求" }, { id: "a2", label: "乙", prompt: "乙的要求" }, { id: "a3", label: "丙" }],
    }, { id: "u", name: "U", nodes: [{ id: "z1", label: "Z" }] }]
    const r = saved(planTemplateSave("t", {
      actions: [{ label: "乙" }, { id: "a1", label: "甲（改名）" }, { label: "新来的", prompt: "新要求" }],
    }, g))
    expect(r.group.nodes).toEqual([
      { id: "a2", label: "乙", prompt: "乙的要求" },
      { id: "a1", label: "甲（改名）", prompt: "甲的要求" },
      { id: "action-1", label: "新来的", prompt: "新要求" },
    ])
    expect(r.removedActions).toEqual(["丙"])
    expect(r.addedActions).toEqual(["新来的"])
    expect(formatTemplateSaved(r)).toContain("删掉的操作：丙")
    expect(formatTemplateSaved(r)).toContain("sync_steps")
  })

  it("给了新 prompt 就覆盖；给空串 = 去掉自定义提示词（回到内置默认）", () => {
    const g: ProjectNodeGroupDef[] = [{ id: "t", name: "T", nodes: [{ id: "plan2", label: "甲", prompt: "旧" }] }, { id: "u", name: "U", nodes: [{ id: "z", label: "Z" }] }]
    expect(saved(planTemplateSave("t", { actions: [{ id: "plan2", label: "甲", prompt: "新" }] }, g)).group.nodes[0].prompt).toBe("新")
    expect(saved(planTemplateSave("t", { actions: [{ id: "plan2", label: "甲", prompt: "" }] }, g)).group.nodes[0]).toEqual({ id: "plan2", label: "甲" })
  })

  it("内置模板的内置提示词：不给 prompt 就继续用默认（不会被写成空）", () => {
    const g = groups()
    const dev = g.find((x) => x.id === "develop")!
    const r = saved(planTemplateSave("develop", { actions: dev.nodes.map((n) => ({ id: n.id, label: n.label })) }, g))
    expect(r.group.nodes).toEqual(dev.nodes)
    expect(r.removedActions).toEqual([])
  })

  it("不能把已有操作的 id 指到别的模板的操作上；删光操作被拒", () => {
    const g = groups()
    expect(err(planTemplateSave("test", { actions: [{ id: "plan", label: "借来的", prompt: "p" }] }, g))).toContain("已经被占用")
    expect(err(planTemplateSave("test", { actions: [] }, g))).toContain("至少")
  })

  it("模板 id 不存在：报错并指路", () => {
    expect(err(planTemplateSave("nope", { name: "x" }, groups()))).toContain("templates")
  })

  it("要填的信息给了就是完整新列表；给空数组 = 清空", () => {
    const g = groups()
    const withFields = saved(planTemplateSave("research", { fields: [{ label: "主题", required: true }] }, g))
    expect(withFields.group.fields).toEqual([{ label: "主题", required: true }])
    expect(saved(planTemplateSave("research", { fields: [] }, g)).group.fields).toBeUndefined()
  })
})

describe("planTemplateDelete：和设置页同一套限制", () => {
  it("正常删除：只去掉这一个", () => {
    const g = groups()
    const r = ok(planTemplateDelete("event", g, {}))
    expect(r.groups.map((x) => x.id)).toEqual(g.map((x) => x.id).filter((id) => id !== "event"))
    expect(r.removed.name).toBe("活动策划")
  })
  it("不存在 / 只剩一个 / 还有老项目在用：拒绝并说明", () => {
    const g = groups()
    expect(err(planTemplateDelete("nope", g, {}))).toContain("templates")
    expect(err(planTemplateDelete("only", [{ id: "only", name: "唯一", nodes: [{ id: "a", label: "A" }] }], {}))).toContain("至少要保留")
    expect(err(planTemplateDelete("develop", g, { develop: 2 }))).toContain("还有 2 个老项目")
    expect(ok(planTemplateDelete("develop", g, { develop: 0 })).removed.id).toBe("develop")
  })
})

describe("buildTemplateDetail / formatTemplateDetail", () => {
  it("内置默认提示词和自定义提示词分开标；老项目还在用要提醒", () => {
    const g: ProjectNodeGroupDef[] = [{
      id: "t", name: "T", workspace: "worktree", branchMode: "test",
      fields: [{ label: "需求链接", required: true, placeholder: "https://x" }],
      nodes: [{ id: "plan", label: "规划" }, { id: "mine", label: "我的", prompt: "第一行\n第二行" }, { id: "bare", label: "空白" }],
    }]
    const d = buildTemplateDetail(g[0], { t: 2 })
    expect(d.actions[0].defaultPrompt).toBeTruthy()
    expect(d.actions[0].customPrompt).toBeUndefined()
    expect(d.actions[1]).toEqual({ id: "mine", label: "我的", customPrompt: "第一行\n第二行" })
    expect(d.actions[2]).toEqual({ id: "bare", label: "空白" })
    const text = formatTemplateDetail(d)
    expect(text).toContain("接（建项时可选；默认工作分支：测试分支）")
    expect(text).toContain("需求链接（必填，例：https://x）")
    expect(text).toContain("内置默认提示词")
    expect(text).toContain("自定义：第一行 第二行")
    expect(text).toContain("没写提示词")
    expect(text).toContain("还有 2 个老项目")
  })

  it("带 action_id 展开提示词全文：自定义的 / 内置默认的 / 没写的", () => {
    const g: ProjectNodeGroupDef = { id: "t", name: "T", nodes: [{ id: "plan", label: "规划" }, { id: "mine", label: "我的", prompt: "第一行\n第二行" }, { id: "bare", label: "空白" }] }
    const d = buildTemplateDetail(g, {})
    expect(formatTemplateDetail(d, "mine")).toContain("（自定义）：\n第一行\n第二行")
    expect(formatTemplateDetail(d, "plan")).toContain("内置默认，没自定义过")
    expect(formatTemplateDetail(d, "bare")).toContain("完成 空白 工作")
    expect(formatTemplateDetail(d, "zzz")).toContain("没有 id 为「zzz」")
  })
})

describe("planProjectUpdate：改项目资料", () => {
  const base = (): Project => ({
    id: "p1", name: "旧名", goal: "旧目标", worktreePath: "/w/p1", createdAt: 1, updatedAt: 1,
    storyUrl: "https://old", metadata: { 代码仓库: "shop", 截止: "周五" },
  })

  it("只改给了的项；不动传入的项目对象", () => {
    const p = base()
    const r = ok(planProjectUpdate(p, { name: "  新名 ", goal: "新目标" }))
    expect(r.project).toMatchObject({ name: "新名", goal: "新目标", storyUrl: "https://old", worktreePath: "/w/p1" })
    expect(r.changed.join("\n")).toContain("项目目录名不会跟着改")
    expect(p).toEqual(base())
  })

  it("链接 / 文档给空串 = 清掉；项目信息合并写入，空值删除，名字去空白", () => {
    const r = ok(planProjectUpdate(base(), { storyUrl: "", relatedDocs: "见 wiki", info: { " 截止 ": "", 负责人: " 小王 ", 新增: "x" } }))
    expect(r.project.storyUrl).toBeUndefined()
    expect(r.project.relatedDocs).toBe("见 wiki")
    expect(r.project.metadata).toEqual({ 代码仓库: "shop", 负责人: "小王", 新增: "x" })
    expect(r.changed).toEqual(expect.arrayContaining(["项目链接已清空", "相关文档已更新", "信息「截止」已删除", "信息「负责人」已更新"]))
  })

  it("删光项目信息：metadata 整个去掉", () => {
    const r = ok(planProjectUpdate(base(), { info: { 代码仓库: "", 截止: "" } }))
    expect(r.project.metadata).toBeUndefined()
  })

  it("校验：名字不能空 / 超长；文本不超长；信息名不能空 / 超长；一项都没给报错；给了但没变化不算错", () => {
    expect(err(planProjectUpdate(base(), { name: " " }))).toContain("不能为空")
    expect(err(planProjectUpdate(base(), { name: "x".repeat(61) }))).toContain("60")
    expect(err(planProjectUpdate(base(), { goal: "x".repeat(2001) }))).toContain("2000")
    expect(err(planProjectUpdate(base(), { info: { " ": "x" } }))).toContain("不能为空")
    expect(err(planProjectUpdate(base(), { info: { [`k${"x".repeat(60)}`]: "x" } }))).toContain("太长")
    expect(err(planProjectUpdate(base(), {}))).toContain("没有要改的内容")
    expect(err(planProjectUpdate(base(), { info: {} }))).toContain("没有要改的内容")
    expect(ok(planProjectUpdate(base(), { name: "旧名" })).changed).toEqual([])
    // 和现在一样的目标 / 信息、删一个本来就没有的信息：都不算改动
    expect(ok(planProjectUpdate(base(), { goal: "旧目标", storyUrl: "https://old", info: { 代码仓库: "shop", 不存在: "" } })).changed).toEqual([])
  })

  it("项目详情文字：目标、模板、目录、项目信息、快捷操作都在", () => {
    const item: ProjectListItem = {
      id: "p1", name: "改版", goal: "做完", archived: true, groupIds: ["general"], groupNames: ["通用任务"], fields: [],
      actions: [{ id: "a", label: "开始" }], hasGroupSnapshot: true, canSyncSteps: true, externalWorkspace: false, isCode: false,
      dir: "D:\\p\\改版", metadata: { 截止: "周五" }, storyUrl: "https://t/1",
    }
    const t = formatProjectDetail(item)
    for (const w of ["「改版」id=p1（已归档）", "目标：做完", "模板：通用任务", "D:\\p\\改版", "https://t/1", "截止：周五", "快捷操作：开始", "sync_steps"]) expect(t).toContain(w)
  })
})
