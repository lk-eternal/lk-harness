import { createHash } from "node:crypto"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { buildSkillCatalog, type CatalogRoot } from "../src/shared/skill-catalog.js"
import { parseSkillMeta } from "../src/shared/skill-meta.js"
import { allSkillRootAbsPaths } from "./skill-paths"
import { discoverSkillPaths } from "./skill-store"

/** SKILL.md 只读开头这一段：frontmatter 都在最前面，不用把整个文件读进来 */
const HEAD_BYTES = 16 * 1024
/** 说明先尽量完整地取出来，截断由名单构建函数按预算统一做 */
const DESC_READ_MAX = 1000

function readHead(file: string): string | null {
  let fd: number | undefined
  try {
    fd = fs.openSync(file, "r")
    const buf = Buffer.alloc(HEAD_BYTES)
    const n = fs.readSync(fd, buf, 0, HEAD_BYTES, 0)
    return buf.subarray(0, n).toString("utf8")
  } catch {
    return null
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd) } catch { /* ignore */ }
    }
  }
}

/** 扫描设置页那几个 Skill 目录：声明了不让模型自动使用的 Skill 不列 */
export function collectSkillCatalogRoots(home: string = os.homedir()): CatalogRoot[] {
  const roots: CatalogRoot[] = []
  for (const dir of allSkillRootAbsPaths(home)) {
    const skills: CatalogRoot["skills"] = []
    let folders: string[] = []
    try { folders = discoverSkillPaths(dir) } catch { /* 目录读不了就当没有 */ }
    for (const folder of folders) {
      const head = readHead(path.join(dir, folder, "SKILL.md"))
      if (head === null) continue
      const meta = parseSkillMeta(head, DESC_READ_MAX)
      if (meta.hidden) continue
      skills.push({ name: meta.name ?? folder, folder, description: meta.description })
    }
    roots.push({ dir, skills })
  }
  return roots
}

export interface SkillCatalog {
  /** 空串 = 没有可列的 Skill */
  text: string
  /** 内容指纹：名单变了它才变，用来判断「AI 手里的那份是不是过期了」 */
  hash: string
  count: number
}

const EMPTY: SkillCatalog = { text: "", hash: "", count: 0 }

export function computeSkillCatalog(home: string = os.homedir()): SkillCatalog {
  const built = buildSkillCatalog(collectSkillCatalogRoots(home))
  if (!built.text) return EMPTY
  return {
    text: built.text,
    hash: createHash("sha1").update(built.text).digest("hex").slice(0, 12),
    count: built.count,
  }
}

/** 每次拉起会话都要看一眼名单；扫一遍目录要读上百个文件头，短时间内复用上一次的结果 */
const CACHE_TTL_MS = 10_000
let cached: { at: number; value: SkillCatalog } | null = null

export function resetSkillCatalogCache(): void {
  cached = null
}

/** 拉起会话用：扫描失败不能挡住会话，按「没有 Skill」处理 */
export function getSkillCatalog(now: number = Date.now()): SkillCatalog {
  if (cached && now - cached.at < CACHE_TTL_MS) return cached.value
  let value = EMPTY
  try { value = computeSkillCatalog() } catch { /* 名单是锦上添花 */ }
  cached = { at: now, value }
  return value
}
