/**
 * manage_skills（AI 通过 MCP 管理 Harness 的 Skill）背后的读写：列出、读取、保存、删除。
 * 根目录由调用方传入（daemon 传 ~/.cursor/skills），所以能在临时目录里直接测。
 */
import * as fs from "node:fs"
import * as path from "node:path"
import { linkTargetOf, removeNoFollow } from "./safe-remove.js"
import { resolveSkillDirUnder } from "./skill-dir-path.js"
import { skillSummary } from "./skill-meta.js"

export type SkillAdminResult<T extends object = object> = ({ ok: true } & T) | { ok: false; status: number; error: string }

const BAD_NAME = "invalid name: 只能写 Skill 的目录名（可以用 / 分层），不能含 ..、绝对路径或盘符"
const PREVIEW_MAX = 100
const MAX_DEPTH = 6

function isFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

function isDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

/**
 * 根目录下所有 Skill（带 SKILL.md 的目录），符号链接 / junction 指过去的也算。
 * 说明取 SKILL.md 的 description，没有就取正文第一行。
 */
export function listHarnessSkills(root: string): { name: string; preview: string }[] {
  const out: { name: string; preview: string }[] = []
  const visited = new Set<string>()

  function walk(dir: string, rel: string, depth: number): void {
    if (depth > MAX_DEPTH) return
    let real: string
    try { real = fs.realpathSync(dir) } catch { return }
    if (visited.has(real)) return
    visited.add(real)

    const skillFile = path.join(dir, "SKILL.md")
    if (rel && isFile(skillFile)) {
      let text = ""
      try { text = fs.readFileSync(skillFile, "utf-8") } catch { /* 读不了就没有说明 */ }
      out.push({ name: rel, preview: skillSummary(text, PREVIEW_MAX) })
      return // Skill 自己的子目录（scripts、references…）不是别的 Skill
    }
    let names: string[] = []
    try { names = fs.readdirSync(dir) } catch { return }
    for (const n of names) {
      if (n.startsWith(".") || n === "node_modules") continue
      const child = path.join(dir, n)
      if (isDir(child)) walk(child, rel ? `${rel}/${n}` : n, depth + 1)
    }
  }

  walk(root, "", 0)
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

export function readHarnessSkill(root: string, name: string): SkillAdminResult<{ content: string }> {
  const dir = resolveSkillDirUnder(root, name)
  if (!dir) return { ok: false, status: 400, error: BAD_NAME }
  const file = path.join(dir, "SKILL.md")
  if (!isFile(file)) return { ok: false, status: 404, error: "not found" }
  return { ok: true, content: fs.readFileSync(file, "utf-8") }
}

export function saveHarnessSkill(root: string, name: string, content: string): SkillAdminResult<{ message: string }> {
  const dir = resolveSkillDirUnder(root, name)
  if (!dir) return { ok: false, status: 400, error: BAD_NAME }
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, "SKILL.md"), content, "utf-8")
  return { ok: true, message: `${name.trim()} saved` }
}

export async function deleteHarnessSkill(root: string, name: string): Promise<SkillAdminResult<{ message: string }>> {
  const dir = resolveSkillDirUnder(root, name)
  if (!dir) return { ok: false, status: 400, error: BAD_NAME }
  if (!isDir(dir)) return { ok: false, status: 404, error: "not found" }
  // 只删真正的 Skill：名字写成分类文件夹（里面有很多个 Skill）会一次删光
  if (!isFile(path.join(dir, "SKILL.md"))) {
    return { ok: false, status: 400, error: "not a skill: 这个目录里没有 SKILL.md，不删" }
  }
  // 不能直接 fs.rmSync：Electron 的 Node 里它会顺着链接把原目录的内容也删了（见 safe-remove.ts）
  const linked = linkTargetOf(dir)
  const removed = await removeNoFollow(dir)
  if (!removed.ok) return { ok: false, status: 500, error: removed.error }
  const note = linked === null ? "" : "（这是链接，只删了链接，原目录没动）"
  return { ok: true, message: `${name.trim()} deleted${note}` }
}
