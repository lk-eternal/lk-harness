import * as fs from "node:fs"
import * as path from "node:path"
import { writeJsonAtomic, writeTextAtomic } from "./atomic-json.js"

export interface HarnessRule {
  id: string
  name: string
  content: string
  enabled: boolean
  /** 生效范围：缺省 = 仅主用户（存量规则迁移默认值）；custom 按通道×人群多选 */
  scope?: RuleScope
}

export type RuleAudience = "main" | "others"

export interface RuleTarget {
  channelId: string
  audiences: RuleAudience[]
}

export interface RuleScope {
  mode: "main" | "custom"
  targets?: RuleTarget[]
}

interface Manifest {
  order: string[]
  migrated?: boolean
  scopes?: Record<string, RuleScope>
}

export interface HarnessRulesStoreFile {
  order: string[]
  rules: Record<string, { content: string; enabled?: boolean; scope?: RuleScope }>
}

export interface HarnessRulesBundle {
  order: string[]
  files: Record<string, { content: string; enabled?: boolean; scope?: RuleScope }>
}

const RULE_EXT = /\.(mdc|md)$/i

let userDataRoot = ""

export function initHarnessRuleStore(root: string): void {
  userDataRoot = root
}

function migrateLegacyRulesDir(): void {
  if (!userDataRoot) return
  const newDir = path.join(userDataRoot, "harness-rules")
  const oldDir = path.join(userDataRoot, "claw-rules")
  if (fs.existsSync(newDir) || !fs.existsSync(oldDir)) return
  try {
    fs.renameSync(oldDir, newDir)
  } catch {
    try {
      fs.cpSync(oldDir, newDir, { recursive: true })
    } catch { /* ignore */ }
  }
}

function rulesDir(): string {
  migrateLegacyRulesDir()
  return path.join(userDataRoot, "harness-rules")
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
  writeJsonAtomic(manifestPath(), m)
}

/** scope 归一化：缺省/非法视为仅主用户（存量与老备份的默认值）；
 * 显式 custom 即使 targets 为空也保留，表示"哪儿都不生效，仅存放" */
export function normalizeRuleScope(scope: RuleScope | undefined | null): RuleScope {
  if (!scope || scope.mode !== "custom") return { mode: "main" }
  const targets: RuleTarget[] = []
  for (const t of scope.targets ?? []) {
    const channelId = t?.channelId?.trim()
    if (!channelId) continue
    const audiences = [...new Set((t.audiences ?? []).filter((a) => a === "main" || a === "others"))]
    if (!audiences.length) continue
    if (!targets.some((x) => x.channelId === channelId)) targets.push({ channelId, audiences })
  }
  return { mode: "custom", targets }
}

function scopeOf(m: Manifest, id: string): RuleScope {
  return normalizeRuleScope(m.scopes?.[id])
}

/** 规则是否对指定通道×人群生效；channelId 缺失时仅 main 模式生效 */
export function ruleAppliesTo(
  rule: Pick<HarnessRule, "scope">,
  channelId: string | undefined,
  audience: RuleAudience,
): boolean {
  const scope = normalizeRuleScope(rule.scope)
  if (scope.mode !== "custom") return audience === "main"
  if (!channelId) return false
  return (scope.targets ?? []).some((t) => t.channelId === channelId && t.audiences.includes(audience))
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

export function listHarnessRules(): HarnessRule[] {
  migrateLegacyRulesOnce()
  const m = readManifest()
  const rules: HarnessRule[] = []
  for (const id of m.order) {
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
      scope: scopeOf(m, id),
    })
  }
  return rules
}

export function listEnabledHarnessRules(): HarnessRule[] {
  return listHarnessRules().filter((r) => r.enabled)
}

export function saveHarnessRule(id: string | null, name: string, content: string, enabled = true, scope?: RuleScope): HarnessRule | null {
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
  writeTextAtomic(rulePath(targetId), body.endsWith("\n") ? body : `${body}\n`)
  const normalized = normalizeRuleScope(scope ?? (oldId ? scopeOf(m, oldId) : undefined))
  const scopes = { ...(m.scopes ?? {}) }
  if (oldId && oldId !== targetId) delete scopes[oldId]
  if (normalized.mode === "custom") scopes[targetId] = normalized
  else delete scopes[targetId]
  writeManifest({ ...m, order, scopes })
  return { id: targetId, name: `${targetId}.mdc`, content, enabled, scope: normalized }
}

export function deleteHarnessRule(id: string): boolean {
  const m = readManifest()
  const fp = rulePath(id)
  if (fs.existsSync(fp)) fs.unlinkSync(fp)
  const scopes = { ...(m.scopes ?? {}) }
  delete scopes[id]
  writeManifest({ ...m, order: m.order.filter((x) => x !== id), scopes })
  return true
}

export function readHarnessRulesStoreRaw(): HarnessRulesStoreFile | null {
  migrateLegacyRulesOnce()
  const m = readManifest()
  const { order } = m
  const rules: Record<string, { content: string; enabled?: boolean; scope?: RuleScope }> = {}
  for (const id of order) {
    const fp = rulePath(id)
    if (!fs.existsSync(fp)) continue
    let raw = ""
    try { raw = fs.readFileSync(fp, "utf-8") } catch { /* empty */ }
    const disabled = raw.startsWith("<!-- disabled -->\n")
    rules[id] = {
      content: disabled ? raw.slice("<!-- disabled -->\n".length) : raw,
      enabled: !disabled,
      scope: scopeOf(m, id),
    }
  }
  if (!order.length && !Object.keys(rules).length) return null
  return { order, rules }
}

export function writeHarnessRulesStoreRaw(data: HarnessRulesStoreFile): void {
  const dir = rulesDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })
  const existing = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith(".mdc")) : []
  for (const f of existing) {
    try { fs.unlinkSync(path.join(dir, f)) } catch { /* ignore */ }
  }
  const scopes: Record<string, RuleScope> = {}
  for (const id of data.order) {
    const normalized = normalizeRuleScope(data.rules[id]?.scope)
    if (normalized.mode === "custom") scopes[id] = normalized
  }
  writeManifest({ order: data.order, migrated: true, scopes })
  for (const id of data.order) {
    const entry = data.rules[id]
    if (!entry) continue
    const body = (entry.enabled === false ? "<!-- disabled -->\n" : "") + entry.content
    writeTextAtomic(rulePath(id), body.endsWith("\n") ? body : `${body}\n`)
  }
}

export function exportHarnessRulesBundle(): HarnessRulesBundle | null {
  const raw = readHarnessRulesStoreRaw()
  if (!raw) return null
  return { order: raw.order, files: raw.rules }
}

export function importHarnessRulesBundle(data: HarnessRulesBundle): void {
  writeHarnessRulesStoreRaw({ order: data.order, rules: data.files })
}

/** 合并导入规则：跳过本地已存在的 id，不删除任何本地规则 */
export function mergeImportHarnessRulesBundle(data: HarnessRulesBundle): string[] {
  const notes: string[] = []
  const raw = readHarnessRulesStoreRaw()
  const m = readManifest()
  const order = [...(raw?.order ?? [])]
  const scopes = { ...(m.scopes ?? {}) }
  const existing = new Set(order)
  const dir = rulesDir()
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true })

  for (const id of data.order) {
    const entry = data.files[id]
    if (!entry) continue
    if (existing.has(id) || fs.existsSync(rulePath(id))) {
      notes.push(`${id}：已跳过（本地已存在）`)
      continue
    }
    order.push(id)
    existing.add(id)
    const normalized = normalizeRuleScope(entry.scope)
    if (normalized.mode === "custom") scopes[id] = normalized
    const body = (entry.enabled === false ? "<!-- disabled -->\n" : "") + entry.content
    writeTextAtomic(rulePath(id), body.endsWith("\n") ? body : `${body}\n`)
  }
  writeManifest({ order, migrated: true, scopes })
  return notes
}

export function harnessRulesStoreDir(): string {
  migrateLegacyRulesOnce()
  return rulesDir()
}

function ruleIdFromFileName(fileName: string): string {
  return slugId(fileName)
}

export function readHarnessRuleByFileName(fileName: string): string | null {
  const fp = rulePath(ruleIdFromFileName(fileName))
  if (!fs.existsSync(fp)) return null
  try { return fs.readFileSync(fp, "utf-8") } catch { return null }
}

export function saveHarnessRuleByFileName(fileName: string, content: string): boolean {
  let name = fileName.trim()
  if (!name.endsWith(".mdc") && !name.endsWith(".md")) name += ".mdc"
  const id = ruleIdFromFileName(name)
  const existing = listHarnessRules().find((r) => r.id === id)
  const disabled = content.startsWith("<!-- disabled -->\n")
  const body = disabled ? content.slice("<!-- disabled -->\n".length) : content
  return saveHarnessRule(existing?.id ?? null, id, body, !disabled) !== null
}

export function deleteHarnessRuleByFileName(fileName: string): boolean {
  const id = ruleIdFromFileName(fileName)
  if (!listHarnessRules().some((r) => r.id === id)) return false
  return deleteHarnessRule(id)
}
