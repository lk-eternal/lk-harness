import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { isPathInside } from "../src/shared/path-inside.js"
import { removeNoFollow } from "../src/shared/safe-remove.js"

export interface SkillRootInfo {
  id: string
  label: string
  path: string
  skillCount: number
}

export interface SkillEntry {
  rootId: string
  skillPath: string
  content: string
}

export interface SkillTreeNode {
  name: string
  type: "file" | "directory"
  children?: SkillTreeNode[]
}

const HOME = os.homedir()

export const SKILL_ROOT_DEFS = [
  { id: "cursor", label: "~/.cursor/skills", rel: [".cursor", "skills"] },
  { id: "agents", label: "~/.agents/skills", rel: [".agents", "skills"] },
  { id: "pi", label: "~/.pi/agent/skills", rel: [".pi", "agent", "skills"] },
  { id: "claude", label: "~/.claude/skills", rel: [".claude", "skills"] },
  { id: "codex", label: "~/.codex/skills", rel: [".codex", "skills"] },
] as const

export type SkillRootId = (typeof SKILL_ROOT_DEFS)[number]["id"]

function absRoot(rootId: string): string | undefined {
  const def = SKILL_ROOT_DEFS.find((r) => r.id === rootId)
  return def ? path.join(HOME, ...def.rel) : undefined
}

function statDir(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}

function statFile(p: string): boolean {
  try { return fs.statSync(p).isFile() } catch { return false }
}

/** 递归发现�?SKILL.md 的目录（stat 识别 Windows symlink/junction�?*/
export function discoverSkillPaths(rootAbs: string): string[] {
  const found: string[] = []
  if (!fs.existsSync(rootAbs)) return found

  // 当前这条路径上走过的真实目录：链接绕回自己的祖先（a/b -> a）时不再往下钻，免得无限递归
  const chain = new Set<string>()
  const realOf = (p: string): string => { try { return fs.realpathSync(p) } catch { return p } }
  // 读不了的目录（没权限、被占用）当成空的，不能让一个坏目录带垮整个扫描
  const listDir = (dir: string): string[] => { try { return fs.readdirSync(dir) } catch { return [] } }

  function walk(dir: string, rel: string): void {
    const real = realOf(dir)
    if (chain.has(real)) return
    chain.add(real)
    if (statFile(path.join(dir, "SKILL.md"))) found.push(rel)
    for (const name of listDir(dir)) {
      const child = path.join(dir, name)
      if (statDir(child)) walk(child, rel ? `${rel}/${name}` : name)
    }
    chain.delete(real)
  }

  for (const name of listDir(rootAbs)) {
    const entry = path.join(rootAbs, name)
    if (statDir(entry)) walk(entry, name)
  }
  return [...new Set(found)].sort((a, b) => a.localeCompare(b))
}

export function listSkillRoots(): SkillRootInfo[] {
  return SKILL_ROOT_DEFS.map((def) => {
    const abs = path.join(HOME, ...def.rel)
    return { id: def.id, label: def.label, path: abs, skillCount: discoverSkillPaths(abs).length }
  })
}

export function listSkills(rootId: string): SkillEntry[] {
  const rootAbs = absRoot(rootId)
  if (!rootAbs) return []
  return discoverSkillPaths(rootAbs).map((skillPath) => {
    const skillFile = path.join(rootAbs, skillPath, "SKILL.md")
    let content = ""
    try { content = fs.readFileSync(skillFile, "utf-8") } catch { /* empty */ }
    return { rootId, skillPath, content }
  })
}

function buildDirTree(dir: string): SkillTreeNode[] {
  if (!fs.existsSync(dir)) return []
  return fs.readdirSync(dir)
    .map((name) => {
      const p = path.join(dir, name)
      return { name, isDir: statDir(p), path: p }
    })
    .sort((a, b) => {
      if (a.isDir !== b.isDir) return a.isDir ? -1 : 1
      return a.name.localeCompare(b.name)
    })
    .map(({ name, isDir, path: p }): SkillTreeNode => (
      isDir
        ? { name, type: "directory", children: buildDirTree(p) }
        : { name, type: "file" }
    ))
}

export function listSkillTree(rootId: string): SkillTreeNode[] {
  const rootAbs = absRoot(rootId)
  if (!rootAbs) return []
  return discoverSkillPaths(rootAbs).map((skillPath) => ({
    name: skillPath,
    type: "directory" as const,
    children: buildDirTree(path.join(rootAbs, skillPath)),
  }))
}

export function resolveSkillDir(rootId: string, skillPath: string): string | undefined {
  const rootAbs = absRoot(rootId)
  if (!rootAbs) return undefined
  const dir = path.resolve(rootAbs, skillPath)
  if (!isPathInside(rootAbs, dir)) return undefined
  return dir
}

export function resolveRootAbs(rootId: string): string | undefined {
  return absRoot(rootId)
}

export function resolveSkillFile(rootId: string, skillPath: string, relativePath: string): string | undefined {
  const skillDir = resolveSkillDir(rootId, skillPath)
  if (!skillDir) return undefined
  const filePath = path.resolve(skillDir, relativePath)
  if (!isPathInside(skillDir, filePath)) return undefined
  return filePath
}

export type SkillDeleteResult = { ok: true } | { ok: false; error: string }

const INVALID_PATH: SkillDeleteResult = { ok: false, error: "路径无效" }

/** a 严格在 b 里面（不含 b 自己）。isPathInside 把自身也算在里面，删除绝不能这样放行 */
function isStrictlyInside(b: string, a: string): boolean {
  return isPathInside(b, a) && path.relative(b, a) !== ""
}

/**
 * 删除 rootAbs 下的一个 Skill：普通文件夹整个删；链接（比如指向 ~/.agents/skills 的）只删链接，原文件夹不动。
 * skillPath 为空或 "." 会指到 Skill 根目录自己，拒绝。
 * 不能直接 fs.rmSync：Electron 的 Node 里它会顺着链接把原目录的内容也删了（见 shared/safe-remove.ts）。
 */
export async function removeSkillUnder(rootAbs: string, skillPath: string): Promise<SkillDeleteResult> {
  const dir = path.resolve(rootAbs, String(skillPath))
  if (!isStrictlyInside(rootAbs, dir)) return INVALID_PATH
  const removed = await removeNoFollow(dir)
  return removed.ok ? { ok: true } : { ok: false, error: removed.error }
}

/**
 * 删除 Skill 里的一个文件或文件夹。relativePath 为空或 "." 会指到 Skill 文件夹自己，
 * 那是「删除 Skill」的事，不能从这里删。
 */
export async function removeSkillEntryUnder(rootAbs: string, skillPath: string, relativePath: string): Promise<SkillDeleteResult> {
  const skillDir = path.resolve(rootAbs, String(skillPath))
  if (!isStrictlyInside(rootAbs, skillDir)) return INVALID_PATH
  const target = path.resolve(skillDir, String(relativePath))
  if (!isStrictlyInside(skillDir, target)) return INVALID_PATH
  const removed = await removeNoFollow(target)
  if (!removed.ok) return { ok: false, error: removed.error }
  if (removed.kind === "missing") return { ok: false, error: "文件不存在" }
  return { ok: true }
}

export function deleteSkill(rootId: string, skillPath: string): Promise<SkillDeleteResult> {
  const rootAbs = absRoot(rootId)
  return rootAbs ? removeSkillUnder(rootAbs, skillPath) : Promise.resolve(INVALID_PATH)
}

export function deleteSkillEntry(rootId: string, skillPath: string, relativePath: string): Promise<SkillDeleteResult> {
  const rootAbs = absRoot(rootId)
  return rootAbs ? removeSkillEntryUnder(rootAbs, skillPath, relativePath) : Promise.resolve(INVALID_PATH)
}
