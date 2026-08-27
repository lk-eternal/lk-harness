import { app } from "electron"
import {
  initHarnessRuleStore,
  listHarnessRules as listRules,
  listEnabledHarnessRules as listEnabledRules,
  saveHarnessRule as saveRule,
  deleteHarnessRule as deleteRule,
  migrateLegacyRulesOnce as migrateOnce,
  harnessRulesStoreDir,
  exportHarnessRulesBundle as exportBundle,
  importHarnessRulesBundle as importBundle,
  mergeImportHarnessRulesBundle as mergeBundle,
  type HarnessRule,
} from "../src/shared/harness-rule-store.js"

export type { HarnessRule }

function ensureInit(): void {
  initHarnessRuleStore(app.getPath("userData"))
}

export function migrateLegacyRulesOnce(): void {
  ensureInit()
  migrateOnce()
}

export function listHarnessRules(): HarnessRule[] {
  ensureInit()
  return listRules()
}

export function listEnabledHarnessRules(): HarnessRule[] {
  ensureInit()
  return listEnabledRules()
}

export function saveHarnessRule(id: string | null, name: string, content: string, enabled = true): HarnessRule | null {
  ensureInit()
  return saveRule(id, name, content, enabled)
}

export function deleteHarnessRule(id: string): boolean {
  ensureInit()
  return deleteRule(id)
}

export function collectHarnessRulesForExport(): { name: string; content: string }[] {
  ensureInit()
  return listRules().map((r) => ({ name: r.name, content: r.content }))
}

export function HarnessRulesExportDir(): string {
  ensureInit()
  return harnessRulesStoreDir()
}

export function exportHarnessRulesBundle() {
  ensureInit()
  return exportBundle()
}

export function importHarnessRulesBundle(data: Parameters<typeof importBundle>[0]) {
  ensureInit()
  importBundle(data)
}

export function mergeImportHarnessRulesBundle(data: Parameters<typeof mergeBundle>[0]) {
  ensureInit()
  return mergeBundle(data)
}
