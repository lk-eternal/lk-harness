/**
 * 端到端（真实 daemon 进程）：AI 通过 manage_skills 管理 ~/.cursor/skills。
 *
 * 修过的问题：list 的说明显示成 `---`（取了 frontmatter 的分隔线）；链接过来的 Skill 列不出来；
 * 名字里的 `..` / `.` / 绝对路径没校验——delete 能把 Skill 根目录甚至别的目录整个删掉。
 *
 * daemon 的用户目录指到临时目录（isolatedHome），测试不碰真实的 ~/.cursor。
 * 用 `npm run test:e2e` 运行；不在默认的 `npm test` 里。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { startIsolatedDaemon, type IsolatedDaemon } from "../helpers/isolated-daemon"

let d: IsolatedDaemon

beforeEach(async () => { d = await startIsolatedDaemon({ isolatedHome: true }) })
afterEach(async () => { await d?.stop() })

const skillsRoot = () => path.join(d.homeDir, ".cursor", "skills")
const skillFile = (name: string) => path.join(skillsRoot(), ...name.split("/"), "SKILL.md")

/** 调 MCP 工具（无状态 streamable HTTP，直接发 JSON-RPC） */
async function mcp(tool: string, args: Record<string, unknown>): Promise<string> {
  const res = await fetch(`${d.base}/mcp-admin`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", "X-Harness-Session-Key": d.sessionKey },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: tool, arguments: args } }),
  })
  const raw = await res.text()
  const line = raw.split("\n").find((l) => l.startsWith("data:"))
  const payload = JSON.parse(line ? line.slice(5).trim() : raw)
  if (payload.error) throw new Error(`MCP 错误: ${JSON.stringify(payload.error)}`)
  return (payload.result.content as Array<{ text: string }>).map((c) => c.text).join("\n")
}
const manageSkills = (args: Record<string, unknown>) => mcp("manage_skills", args)

/** 直接打 /api/skills，要看状态码 */
async function api(body: unknown): Promise<{ status: number; json: any }> {
  const res = await fetch(`${d.base}/api/skills`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) })
  return { status: res.status, json: await res.json() }
}

const MD = (name: string, desc: string) => `---\nname: ${name}\ndescription: ${desc}\n---\n# ${name}\n正文\n`

/** 根目录外面的东西：sentinel 在 ~/.cursor 下（Skill 根目录的上一级），outside 在 HOME 下 */
function seedOutside(): void {
  fs.mkdirSync(path.join(d.homeDir, ".cursor"), { recursive: true })
  fs.writeFileSync(path.join(d.homeDir, ".cursor", "sentinel.txt"), "keep")
  fs.mkdirSync(path.join(d.homeDir, "outside"), { recursive: true })
  fs.writeFileSync(path.join(d.homeDir, "outside", "SKILL.md"), "outside skill")
}
function expectOutsideUntouched(): void {
  expect(fs.readFileSync(path.join(d.homeDir, ".cursor", "sentinel.txt"), "utf8")).toBe("keep")
  expect(fs.readFileSync(path.join(d.homeDir, "outside", "SKILL.md"), "utf8")).toBe("outside skill")
}

describe("manage_skills：保存 → 列出 → 读取 → 删除", () => {
  it("用的是隔离的用户目录：保存的文件落在临时 HOME 下", async () => {
    expect(d.homeDir.startsWith(d.dataDir)).toBe(true)
    expect(await manageSkills({ action: "save", name: "weekly", content: MD("weekly", "写周报") })).toContain("✅")
    expect(fs.readFileSync(skillFile("weekly"), "utf8")).toContain("写周报")
  })

  it("list 的说明是 SKILL.md 的 description，不是 `---`", async () => {
    await manageSkills({ action: "save", name: "weekly", content: MD("weekly", "写周报用的") })
    await manageSkills({ action: "save", name: "plain", content: "# 没有 frontmatter\n细节" })
    const out = await manageSkills({ action: "list" })
    expect(out).toContain("- **weekly**: 写周报用的")
    expect(out).toContain("- **plain**: 没有 frontmatter")
    expect(out).not.toContain("**: ---")
  })

  it("没有任何 Skill：如实说没有", async () => {
    expect(await manageSkills({ action: "list" })).toBe("当前没有任何技能。")
  })

  it("read 读出内容；不存在报 not found", async () => {
    await manageSkills({ action: "save", name: "weekly", content: MD("weekly", "d") })
    expect(await manageSkills({ action: "read", name: "weekly" })).toBe(MD("weekly", "d"))
    expect(await manageSkills({ action: "read", name: "nope" })).toContain("not found")
  })

  it("delete 删掉整个目录；再 list 就没有了", async () => {
    await manageSkills({ action: "save", name: "tmp", content: MD("tmp", "x") })
    fs.mkdirSync(path.join(skillsRoot(), "tmp", "scripts"), { recursive: true })
    fs.writeFileSync(path.join(skillsRoot(), "tmp", "scripts", "run.sh"), "echo")
    expect(await manageSkills({ action: "delete", name: "tmp" })).toContain("✅")
    expect(fs.existsSync(path.join(skillsRoot(), "tmp"))).toBe(false)
    expect(await manageSkills({ action: "list" })).toBe("当前没有任何技能。")
  })

  it("delete 链接过来的 Skill：只删链接，原目录的文件不能丢，回复里说明", async (ctx) => {
    const real = path.join(d.homeDir, "elsewhere", "linked")
    fs.mkdirSync(path.join(real, "scripts"), { recursive: true })
    fs.writeFileSync(path.join(real, "SKILL.md"), MD("linked", "原件"))
    fs.writeFileSync(path.join(real, "scripts", "run.sh"), "echo 原件脚本")
    fs.mkdirSync(skillsRoot(), { recursive: true })
    try { fs.symlinkSync(real, path.join(skillsRoot(), "linked"), "junction") } catch { return ctx.skip() }

    const out = await manageSkills({ action: "delete", name: "linked" })
    expect(out).toContain("✅")
    expect(out).toContain("只删了链接")
    expect(fs.existsSync(path.join(skillsRoot(), "linked"))).toBe(false)
    expect(fs.readFileSync(path.join(real, "SKILL.md"), "utf8")).toBe(MD("linked", "原件"))
    expect(fs.readFileSync(path.join(real, "scripts", "run.sh"), "utf8")).toBe("echo 原件脚本")
  })

  it("分层名字（group/foo、group\\bar）能存能读能列能删", async () => {
    await manageSkills({ action: "save", name: "group/foo", content: MD("foo", "甲") })
    await manageSkills({ action: "save", name: "group\\bar", content: MD("bar", "乙") })
    const out = await manageSkills({ action: "list" })
    expect(out).toContain("- **group/bar**: 乙")
    expect(out).toContain("- **group/foo**: 甲")
    expect(await manageSkills({ action: "read", name: "group/foo" })).toContain("# foo")
    expect(await manageSkills({ action: "delete", name: "group/foo" })).toContain("✅")
    expect(fs.existsSync(skillFile("group/bar"))).toBe(true)
  })
})

describe("manage_skills：名字不能指到 Skill 根目录外面或根目录自己", () => {
  it.each(["..", ".", "../outside", "a/../../outside", "../../outside", "..\\outside"])(
    "delete %j：被拒绝，根目录和外面的东西一个不少",
    async (name) => {
      seedOutside()
      await manageSkills({ action: "save", name: "keep-me", content: MD("keep-me", "x") })
      const out = await manageSkills({ action: "delete", name })
      expect(out).toContain("❌")
      expect(out).toContain("invalid name")
      expect(fs.existsSync(skillFile("keep-me"))).toBe(true)
      expectOutsideUntouched()
    },
  )

  it.each(["..", ".", "../escaped", "a/../../escaped"])("save %j：被拒绝，什么都没写出去", async (name) => {
    seedOutside()
    const out = await manageSkills({ action: "save", name, content: "evil" })
    expect(out).toContain("❌")
    expect(fs.existsSync(path.join(d.homeDir, ".cursor", "escaped"))).toBe(false)
    expect(fs.existsSync(path.join(d.homeDir, "escaped"))).toBe(false)
    expect(fs.existsSync(path.join(skillsRoot(), "SKILL.md"))).toBe(false)
    expectOutsideUntouched()
  })

  it.each(["..", "../outside", path.join("..", "outside")])("read %j：被拒绝，不会把外面的内容读出来", async (name) => {
    seedOutside()
    const out = await manageSkills({ action: "read", name })
    expect(out).toContain("❌")
    expect(out).not.toContain("outside skill")
  })

  it("绝对路径（指向 Skill 根目录外的真实 Skill）：delete / read 都被拒绝", async () => {
    seedOutside()
    const abs = path.join(d.homeDir, "outside")
    expect(await manageSkills({ action: "delete", name: abs })).toContain("❌")
    expect(await manageSkills({ action: "read", name: abs })).not.toContain("outside skill")
    expectOutsideUntouched()
  })

  it("名字写成分类目录：delete 拒绝，里面的 Skill 都在", async () => {
    await manageSkills({ action: "save", name: "group/a", content: MD("a", "x") })
    await manageSkills({ action: "save", name: "group/b", content: MD("b", "y") })
    const out = await manageSkills({ action: "delete", name: "group" })
    expect(out).toContain("❌")
    expect(out).toContain("not a skill")
    expect(fs.existsSync(skillFile("group/a"))).toBe(true)
    expect(fs.existsSync(skillFile("group/b"))).toBe(true)
  })
})

describe("/api/skills 的 HTTP 状态码", () => {
  it("非法名字 400、不存在 404、缺参数 400、未知动作 400", async () => {
    expect((await api({ action: "delete", name: ".." })).status).toBe(400)
    expect((await api({ action: "save", name: "../x", content: "c" })).status).toBe(400)
    expect((await api({ action: "read", name: "../x" })).status).toBe(400)
    expect((await api({ action: "read", name: "nope" })).status).toBe(404)
    expect((await api({ action: "delete", name: "nope" })).status).toBe(404)
    expect((await api({ action: "read" })).status).toBe(400)
    expect((await api({ action: "save", name: "x" })).status).toBe(400)
    expect((await api({ action: "explode", name: "x" })).status).toBe(400)
  })

  it("name 不是字符串（AI 传错类型）：400，不会让 daemon 抛 500", async () => {
    expect((await api({ action: "delete", name: 123 })).status).toBe(400)
    expect((await api({ action: "read", name: { a: 1 } })).status).toBe(400)
  })

  it("GET 列出；成功的保存回 ok + message", async () => {
    const saved = await api({ action: "save", name: "weekly", content: MD("weekly", "写周报") })
    expect(saved).toMatchObject({ status: 200, json: { ok: true, message: "weekly saved" } })
    const list = await (await fetch(`${d.base}/api/skills`)).json()
    expect(list).toEqual({ ok: true, skills: [{ name: "weekly", preview: "写周报" }] })
  })
})
