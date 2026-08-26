import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

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

  function walk(dir: string, rel: string): void {
    if (statFile(path.join(dir, "SKILL.md"))) found.push(rel)
    for (const name of fs.readdirSync(dir)) {
      const child = path.join(dir, name)
      if (statDir(child)) walk(child, rel ? `${rel}/${name}` : name)
    }
  }

  for (const name of fs.readdirSync(rootAbs)) {
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
  if (!dir.startsWith(path.resolve(rootAbs))) return undefined
  return dir
}

export function resolveRootAbs(rootId: string): string | undefined {
  return absRoot(rootId)
}

export function resolveSkillFile(rootId: string, skillPath: string, relativePath: string): string | undefined {
  const skillDir = resolveSkillDir(rootId, skillPath)
  if (!skillDir) return undefined
  const filePath = path.resolve(skillDir, relativePath)
  if (!filePath.startsWith(path.resolve(skillDir))) return undefined
  return filePath
}
