/**
 * 删除文件 / 文件夹 / 链接，而且永远不会顺着链接删到别处。
 *
 * 为什么不直接 fs.rmSync：Electron 41（Node 24.14）里，对指向别处的 junction / 符号链接执行
 * rmSync(link, { recursive: true }) 会顺着链接把**目标目录里的内容**删光（目标文件夹本身留成空壳），
 * 目录里嵌套的链接也一样。Skill 目录常常是指向 ~/.agents/skills 的链接，删一个链接就把原件毁了。
 * 同一台机器上的普通 Node（24.11.1）没有这个问题，所以单元测试里看不出来，
 * tests/safe-remove-electron.test.ts 会在 Electron 的 Node 里真跑一遍。
 *
 * 这里的做法：
 * - 链接（Windows 的 junction 在 lstat 里也是符号链接）只删链接本身，目标一概不碰；
 * - 真文件夹交给 fs.promises.rm（JS 实现，按 lstat 判断，遇到链接只删链接）；
 * - 删完回头确认确实没了，没了才算成功。rm 在个别情况下（比如路径含中文的 Node 版本）会静默什么都不做。
 */
import * as fs from "node:fs"

export type RemoveKind = "missing" | "file" | "dir" | "link"
export type RemoveResult = { ok: true; kind: RemoveKind } | { ok: false; error: string }

function errCode(e: unknown): string {
  return typeof e === "object" && e && "code" in e ? String((e as { code: unknown }).code) : ""
}

async function lstatOrNull(p: string): Promise<fs.Stats | null> {
  try {
    return await fs.promises.lstat(p)
  } catch (e) {
    const code = errCode(e)
    if (code === "ENOENT" || code === "ENOTDIR") return null
    throw e
  }
}

/** 只删链接本身。Windows 上目录链接有时 unlink 不认，退一步用 rmdir（对链接同样只删链接，不进目标） */
async function removeLink(p: string): Promise<void> {
  try {
    await fs.promises.unlink(p)
  } catch (e) {
    const code = errCode(e)
    if (code !== "EISDIR" && code !== "EPERM") throw e
    await fs.promises.rmdir(p)
  }
}

// 被杀毒软件、资源管理器、终端短暂占着时，隔一会儿就能删；真被占住就别等太久，让界面尽快报错
const RM_RETRY = { maxRetries: 3, retryDelay: 100 }

function describeFailure(target: string, e: unknown): string {
  const code = errCode(e)
  const msg = e instanceof Error ? e.message : String(e)
  if (code === "EBUSY" || code === "EPERM" || code === "EACCES") {
    return `删不掉（${code}）：「${target}」正被别的程序占用，或没有权限。关掉占用它的程序（比如终端、资源管理器窗口）再试。`
  }
  return `删除失败${code ? `（${code}）` : ""}：${msg}`
}

export async function removeNoFollow(target: string): Promise<RemoveResult> {
  try {
    const st = await lstatOrNull(target)
    if (!st) return { ok: true, kind: "missing" }

    let kind: RemoveKind
    if (st.isSymbolicLink()) {
      await removeLink(target)
      kind = "link"
    } else if (st.isDirectory()) {
      await fs.promises.rm(target, { recursive: true, force: true, ...RM_RETRY })
      kind = "dir"
    } else {
      await fs.promises.rm(target, { force: true, ...RM_RETRY })
      kind = "file"
    }

    if (await lstatOrNull(target)) {
      return { ok: false, error: `没有删干净：「${target}」仍然存在，可能被别的程序占用。` }
    }
    return { ok: true, kind }
  } catch (e) {
    return { ok: false, error: describeFailure(target, e) }
  }
}

/**
 * target 本身是不是链接，是的话指向哪里（真实路径）。目标不存在的悬空链接也算链接，返回空串。
 * 删除前用来告诉用户「只会删链接，原文件夹不动」。
 */
export function linkTargetOf(target: string): string | null {
  try {
    if (!fs.lstatSync(target).isSymbolicLink()) return null
  } catch {
    return null
  }
  try {
    return fs.realpathSync(target)
  } catch {
    return ""
  }
}
