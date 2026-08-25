import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"

export interface RuleRootInfo {
  id: string
  label: string
  path: string
  ruleCount: number
}

export interface RuleEntry {
  rootId: string
  name: string
  content: string
}

const HOME = os.homedir()

export const RULE_ROOT_DEFS = [
  { id: "cursor", label: "~/.cursor/rules", rel: [".cursor", "rules"] },
  { id: "agents", label: "~/.agents/rules", rel: [".agents", "rules"] },
  { id: "claude", label: "~/.claude/rules", rel: [".claude", "rules"] },
  { id: "codex", label: "~/.codex/rules", rel: [".codex", "rules"] },
] as const

export type RuleRootId = (typeof RULE_ROOT_DEFS)[number]["id"]

function absRoot(rootId: string): string | undefined {
  const def = RULE_ROOT_DEFS.find((r) => r.id === rootId)
  return def ? path.join(HOME, ...def.rel) : undefined
}

const RULE_EXT = /\.(mdc|md)$/i

export function listRuleRoots(): RuleRootInfo[] {
  return RULE_ROOT_DEFS.map((def) => {
    const abs = path.join(HOME, ...def.rel)
    let ruleCount = 0
    try {
      if (fs.existsSync(abs)) {
        ruleCount = fs.readdirSync(abs).filter((f) => RULE_EXT.test(f)).length
      }
    } catch { /* ignore */ }
    return { id: def.id, label: def.label, path: abs, ruleCount }
  })
}

export function listRules(rootId: string): RuleEntry[] {
  const rootAbs = absRoot(rootId)
  if (!rootAbs || !fs.existsSync(rootAbs)) return []
  return fs.readdirSync(rootAbs)
    .filter((f) => RULE_EXT.test(f))
    .sort((a, b) => a.localeCompare(b))
    .map((name) => {
      let content = ""
      try { content = fs.readFileSync(path.join(rootAbs, name), "utf-8") } catch { /* empty */ }
      return { rootId, name, content }
    })
}

export function resolveRulePath(rootId: string, name: string): string | undefined {
  const rootAbs = absRoot(rootId)
  if (!rootAbs) return undefined
  const base = path.basename(name)
  if (base !== name) return undefined
  const filePath = path.join(rootAbs, base)
  if (!path.resolve(filePath).startsWith(path.resolve(rootAbs))) return undefined
  return filePath
}

export function saveRule(rootId: string, name: string, content: string): boolean {
  const filePath = resolveRulePath(rootId, name)
  const rootAbs = absRoot(rootId)
  if (!rootAbs || !filePath) return false
  try {
    if (!fs.existsSync(rootAbs)) fs.mkdirSync(rootAbs, { recursive: true })
    fs.writeFileSync(filePath, content, "utf-8")
    return true
  } catch { return false }
}

export function deleteRule(rootId: string, name: string): boolean {
  const filePath = resolveRulePath(rootId, name)
  if (!filePath || !fs.existsSync(filePath)) return false
  try {
    fs.unlinkSync(filePath)
    return true
  } catch { return false }
}

/** 导出/备份：合并所有根目录下的 rules */
export function collectAllRulesForExport(): { rootId: string; name: string; content: string }[] {
  const out: { rootId: string; name: string; content: string }[] = []
  for (const def of RULE_ROOT_DEFS) {
    out.push(...listRules(def.id))
  }
  return out
}

export function rulesExportDir(): string {
  return path.join(HOME, ".cursor", "rules")
}
