import { spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as path from "node:path"

export interface FeishuSyncResult {
  ok: boolean
  docUrl?: string
  error?: string
  skipped?: boolean
}

/** Best-effort: prefer lark-cli docs; fall back to skipped with local path note. */
export function syncArtifactToFeishu(opts: {
  artifactPath: string
  title: string
}): FeishuSyncResult {
  if (!opts.artifactPath || !fs.existsSync(opts.artifactPath)) {
    return { ok: false, error: `artifact 不存�? ${opts.artifactPath}` }
  }
  const abs = path.resolve(opts.artifactPath)
  const which = spawnSync("lark-cli", ["--help"], { encoding: "utf-8", windowsHide: true })
  if (which.status !== 0 && which.error) {
    return {
      ok: false,
      skipped: true,
      error: "未安�?lark-cli，已跳过飞书同步（本�?md 仍有效）。可在设置→工具箱安装后执行 /p sync",
    }
  }

  // Try shortcut create from markdown; schemas vary by CLI version �?degrade gracefully.
  const attempts: string[][] = [
    ["docs", "+create", "--title", opts.title, "--markdown", abs],
    ["docs", "create", "--title", opts.title, "--file", abs],
  ]
  for (const args of attempts) {
    const r = spawnSync("lark-cli", args, { encoding: "utf-8", windowsHide: true, timeout: 60_000 })
    const out = `${r.stdout || ""}\n${r.stderr || ""}`
    if (r.status === 0) {
      const url = out.match(/https?:\/\/\S+/)?.[0]
      if (url) return { ok: true, docUrl: url.replace(/[)\].,]+$/, "") }
      return { ok: true, docUrl: undefined, error: "已调�?lark-cli，但未解析到文档链接，请手动确认" }
    }
  }
  return {
    ok: false,
    skipped: true,
    error: "lark-cli 创建文档失败，已跳过。本�?artifact 仍保留，可用 /p sync 重试",
  }
}
