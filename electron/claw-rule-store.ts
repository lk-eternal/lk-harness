import { app } from "electron"
import {
  initClawRuleStore,
  listClawRules as listRules,
  listEnabledClawRules as listEnabledRules,
  saveClawRule as saveRule,
  deleteClawRule as deleteRule,
  migrateLegacyRulesOnce as migrateOnce,
  clawRulesStoreDir,
  exportClawRulesBundle as exportBundle,
  importClawRulesBundle as importBundle,
  type ClawRule,
} from "../src/shared/claw-rule-store.js"

export type { ClawRule }

function ensureInit(): void {
  initClawRuleStore(app.getPath("userData"))
}

export function migrateLegacyRulesOnce(): void {
  ensureInit()
  migrateOnce()
}

export function listClawRules(): ClawRule[] {
  ensureInit()
  return listRules()
}

export function listEnabledClawRules(): ClawRule[] {
  ensureInit()
  return listEnabledRules()
}

export function saveClawRule(id: string | null, name: string, content: string, enabled = true): ClawRule | null {
  ensureInit()
  return saveRule(id, name, content, enabled)
}

export function deleteClawRule(id: string): boolean {
  ensureInit()
  return deleteRule(id)
}

export function collectClawRulesForExport(): { name: string; content: string }[] {
  ensureInit()
  return listRules().map((r) => ({ name: r.name, content: r.content }))
}

export function clawRulesExportDir(): string {
  ensureInit()
  return clawRulesStoreDir()
}

export function exportClawRulesBundle() {
  ensureInit()
  return exportBundle()
}

export function importClawRulesBundle(data: Parameters<typeof importBundle>[0]) {
  ensureInit()
  importBundle(data)
}
