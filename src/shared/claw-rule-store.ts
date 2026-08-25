import * as fs from "node:fs"
import * as path from "node:path"

export interface ClawRule {
  id: string
  name: string
  content: string
  enabled: boolean
}

interface Manifest {
  order: string[]
  migrated?: boolean
}

export interface ClawRulesStoreFile {
  order: string[]
  rules: Record<string, { content: string; enabled?: boolean }>
}

export interface ClawRulesBundle {
  order: string[]
  files: Record<string, { content: string; enabled?: boolean }>
}

const RULE_EXT = /\.(mdc|md)$/i

let userDataRoot = ""

export function initClawRuleStore(root: string): void {
  userDataRoot = root
}

function rulesDir(): string {
  return path.join(userDataRoot, "claw-rules")
}

function manifestPath(): string {
  return path.join(rulesDir(), "manifest.json")
}

function rulePath(id: string): string {
  return path.join(rulesDir(), `${id}.mdc`)
}

function readManifest(): Manifest {
  if (!userDataRoot) return { order: [] }
  try {
    if (fs.existsSync(manifestPath())) {
      return JSON.parse(fs.readFileSync(manifestPath(), "utf-8")) as Manifest
    }
  } catch { /* empty */ }
  return { order: [] }
}

function writeManifest(m: Manifest): void {
  const dir = rulesDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(manifestPath(), JSON.stringify(m, null, 2), "utf-8")
}

function slugId(name: string): string {
  const base = path.basename(name.trim()).replace(RULE_EXT, "").trim()
  if (!base) return "rule"
  const cleaned = base
    .replace(/[<>:"/\\|?*\x00-\x1f]/g, "")
    .replace(/[.\s]+$/g, "")
    .slice(0, 64)
  return cleaned || "rule"
}

function uniqueId(name: string, existing: Set<string>): string {
  let id = slugId(name)
  let n = 2
  while (existing.has(id)) {
    id = `${slugId(name)}-${n++}`
  }
  return id
}

export function migrateLegacyRulesOnce(): void {
  const m = readManifest()
  if (m.migrated) return
  const dir = rulesDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  writeManifest({ order: m.order, migrated: true })
}

export function listClawRules(): ClawRule[] {
  migrateLegacyRulesOnce()
  const { order } = readManifest()
  const rules: ClawRule[] = []
  for (const id of order) {
    const fp = rulePath(id)
    if (!fs.existsSync(fp)) continue
    let content = ""
    try { content = fs.readFileSync(fp, "utf-8") } catch { /* empty */ }
    const disabled = content.startsWith("<!-- disabled -->\n")
    rules.push({
      id,
      name: `${id}.mdc`,
      content: disabled ? content.slice("<!-- disabled -->\n".length) : content,
      enabled: !disabled,
    })
  }
  return rules
}

export function listEnabledClawRules(): ClawRule[] {
  return listClawRules().filter((r) => r.enabled)
}

export function saveClawRule(id: string | null, name: string, content: string, enabled = true): ClawRule | null {
  migrateLegacyRulesOnce()
  const m = readManifest()
  const order = [...m.order]
  const oldId = id?.trim() || ""
  if (!name.trim()) return null

  let targetId = slugId(name)
  if (!targetId) return null

  if (oldId) {
    if (oldId !== targetId) {
      if (order.includes(targetId)) return null
      const fp = rulePath(oldId)
      if (fs.existsSync(fp)) fs.unlinkSync(fp)
      const idx = order.indexOf(oldId)
      if (idx >= 0) order[idx] = targetId
      else order.push(targetId)
    }
  } else {
    targetId = uniqueId(name, new Set(order))
    order.push(targetId)
  }

  const dir = rulesDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const body = (enabled ? "" : "<!-- disabled -->\n") + content
  fs.writeFileSync(rulePath(targetId), body.endsWith("\n") ? body : `${body}\n`, "utf-8")
  writeManifest({ ...m, order })
  return { id: targetId, name: `${targetId}.mdc`, content, enabled }
}

export function deleteClawRule(id: string): boolean {
  const m = readManifest()
  const fp = rulePath(id)
  if (fs.existsSync(fp)) fs.unlinkSync(fp)
  writeManifest({ ...m, order: m.order.filter((x) => x !== id) })
  return true
}

export function readClawRulesStoreRaw(): ClawRulesStoreFile | null {
  migrateLegacyRulesOnce()
  const { order } = readManifest()
  const rules: Record<string, { content: string; enabled?: boolean }> = {}
  for (const id of order) {
    const fp = rulePath(id)
    if (!fs.existsSync(fp)) continue
    let raw = ""
    try { raw = fs.readFileSync(fp, "utf-8") } catch { /* empty */ }
    const disabled = raw.startsWith("<!-- disabled -->\n")
    rules[id] = {
      content: disabled ? raw.slice("<!-- disabled -->\n".length) : raw,
      enabled: !disabled,
    }
  }
  if (!order.length && !Object.keys(rules).length) return null
  return { order, rules }
}

export function writeClawRulesStoreRaw(data: ClawRulesStoreFile): void {
  const dir = rulesDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".mdc")) : []
  for (const f of existing) {
    try { fs.unlinkSync(path.join(dir, f)) } catch { /* ignore */ }
  }
  writeManifest({ order: data.order, migrated: true })
  for (const id of data.order) {
    const entry = data.rules[id]
    if (!entry) continue
    const body = (entry.enabled === false ? "<!-- disabled -->\n" : "") + entry.content
    fs.writeFileSync(rulePath(id), body.endsWith("\n") ? body : `${body}\n`, "utf-8")
  }
}

export function exportClawRulesBundle(): ClawRulesBundle | null {
  const raw = readClawRulesStoreRaw()
  if (!raw) return null
  return { order: raw.order, files: raw.rules }
}

export function importClawRulesBundle(data: ClawRulesBundle): void {
  writeClawRulesStoreRaw({ order: data.order, rules: data.files })
}

export function clawRulesStoreDir(): string {
  migrateLegacyRulesOnce()
  return rulesDir()
}

function ruleIdFromFileName(fileName: string): string {
  return slugId(fileName)
}

export function readClawRuleByFileName(fileName: string): string | null {
  const fp = rulePath(ruleIdFromFileName(fileName))
  if (!fs.existsSync(fp)) return null
  try { return fs.readFileSync(fp, "utf-8") } catch { return null }
}

export function saveClawRuleByFileName(fileName: string, content: string): boolean {
  let name = fileName.trim()
  if (!name.endsWith(".mdc") && !name.endsWith(".md")) name += ".mdc"
  const id = ruleIdFromFileName(name)
  const existing = listClawRules().find((r) => r.id === id)
  const disabled = content.startsWith("<!-- disabled -->\n")
  const body = disabled ? content.slice("<!-- disabled -->\n".length) : content
  return saveClawRule(existing?.id ?? null, id, body, !disabled) !== null
}

export function deleteClawRuleByFileName(fileName: string): boolean {
  const id = ruleIdFromFileName(fileName)
  if (!listClawRules().some((r) => r.id === id)) return false
  return deleteClawRule(id)
}
