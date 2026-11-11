import * as os from "node:os"
import * as path from "node:path"
import { SKILL_ROOT_DEFS } from "./skill-store"

/** 设置页「Skills」里那几个 Skill 根目录的绝对路径（按显示顺序，大小写不敏感去重） */
export function allSkillRootAbsPaths(home: string = os.homedir()): string[] {
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
