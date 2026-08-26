import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { getAgentDir } from "@mariozechner/pi-coding-agent"
import { SKILL_ROOT_DEFS } from "./skill-store"

/** 所�?Harness 管理�?skill 根目录（绝对路径，去重） */
export function allSkillRootAbsPaths(): string[] {
  const home = os.homedir()
  const seen = new Set<string>()
  const out: string[] = []
  for (const def of SKILL_ROOT_DEFS) {
    const abs = path.resolve(path.join(home, ...def.rel))
    const key = abs.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(abs)
  }
  return out
}

/** Pi 原生已扫的路径（无需 additionalSkillPaths 重复注入�?*/
function piNativeSkillRoots(): Set<string> {
  const home = os.homedir()
  const native = [
    path.join(getAgentDir(), "skills"),
    path.join(home, ".agents", "skills"),
  ]
  return new Set(native.map((p) => path.resolve(p).toLowerCase()))
}

/**
 * 传给 Pi DefaultResourceLoader 的额�?skill 目录�? * Harness 全量根目�?�?Pi 已原生扫描的路径（按绝对路径去重�? */
export function piAdditionalSkillPaths(): string[] {
  const native = piNativeSkillRoots()
  const out: string[] = []
  const seen = new Set<string>()
  for (const abs of allSkillRootAbsPaths()) {
    const key = abs.toLowerCase()
    if (native.has(key) || seen.has(key)) continue
    if (!dirExists(abs)) continue
    seen.add(key)
    out.push(abs)
  }
  return out
}

function dirExists(p: string): boolean {
  try { return fs.statSync(p).isDirectory() } catch { return false }
}
