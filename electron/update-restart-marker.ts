/**
 * 「空闲时自动重启安装」留给下一次启动的记号：重启前主窗口是不是收在托盘里。
 *
 * 应用启动时主窗口总会弹出来。人不在电脑前时重启装更新，窗口原本收在托盘里的话，
 * 装完还应该留在托盘，别在用户看视频、玩游戏时突然弹到最前面。记号带时间，过期作废。
 * 只读写 userData 下的一个小文件，不依赖 electron（目录由调用方传入，方便测试）。
 */

import * as fs from "node:fs"
import * as path from "node:path"
import { shouldStartHiddenAfterRestart, type RestartMarker } from "../src/shared/silent-update.js"

const MARKER_FILE = "silent-update-restart.json"

function markerPath(dir: string): string {
  return path.join(dir, MARKER_FILE)
}

/** 重启前写下记号。写不进去不影响重启：最坏是装完窗口照常弹出来 */
export function writeRestartMarker(dir: string, keepHidden: boolean, now: number = Date.now()): void {
  try {
    const marker: RestartMarker = { at: now, keepHidden }
    fs.writeFileSync(markerPath(dir), JSON.stringify(marker), "utf-8")
  } catch { /* best-effort */ }
}

/** 重启没有真正发生（安装器没接手）时撤销记号，免得影响后面手动打开 */
export function clearRestartMarker(dir: string): void {
  try {
    fs.rmSync(markerPath(dir), { force: true })
  } catch { /* best-effort */ }
}

/**
 * 启动时读走记号（读完即删，过期的也删），返回这次启动主窗口该不该留在托盘。
 * 文件不存在、内容坏了、已过期，都是「照常弹出来」。
 */
export function consumeStayHiddenMarker(dir: string, now: number = Date.now()): boolean {
  const file = markerPath(dir)
  let marker: RestartMarker | null = null
  try {
    if (!fs.existsSync(file)) return false
    const parsed = JSON.parse(fs.readFileSync(file, "utf-8")) as Partial<RestartMarker> | null
    if (parsed && typeof parsed === "object" && typeof parsed.at === "number" && typeof parsed.keepHidden === "boolean") {
      marker = { at: parsed.at, keepHidden: parsed.keepHidden }
    }
  } catch { /* 内容坏了：当没有 */ }
  try {
    fs.rmSync(file, { force: true })
  } catch { /* best-effort */ }
  return shouldStartHiddenAfterRestart(marker, now)
}
