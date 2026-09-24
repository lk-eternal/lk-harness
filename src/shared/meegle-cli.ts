import { execFile } from "node:child_process"
import fs from "node:fs"
import path from "node:path"
import { promisify } from "node:util"

const execFileAsync = promisify(execFile)

const MEEGLE_BIN = "meegle"

function parseJsonStdout(stdout: string): unknown {
  const i = stdout.indexOf("{")
  if (i < 0) throw new Error("meegle: no JSON in stdout")
  return JSON.parse(stdout.slice(i))
}

function resolveNodeBinary(): string {
  const npmNode = process.env.npm_node_execpath?.trim()
  if (npmNode && fs.existsSync(npmNode)) return npmNode
  if (process.versions.electron) return "node"
  return process.execPath
}

function resolveMeegleExec(): { file: string; prefixArgs: string[] } {
  if (process.platform !== "win32") {
    return { file: MEEGLE_BIN, prefixArgs: [] }
  }
  const custom = process.env.MEEGLE_CLI_PATH?.trim()
  const meegleJs = custom || path.join(
    process.env.APPDATA || "",
    "npm",
    "node_modules",
    "@lark-project",
    "meegle",
    "bin",
    "meegle.js",
  )
  if (meegleJs && fs.existsSync(meegleJs)) {
    return { file: resolveNodeBinary(), prefixArgs: [ meegleJs ] }
  }
  return { file: `${MEEGLE_BIN}.cmd`, prefixArgs: [] }
}

async function execMeegle(args: string[], timeoutMs: number): Promise<string> {
  const { file, prefixArgs } = resolveMeegleExec()
  const useElectronAsNode = file === process.execPath && !!process.versions.electron
  const opts = {
    encoding: "utf8" as const,
    timeout: timeoutMs,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: useElectronAsNode
      ? { ...process.env, ELECTRON_RUN_AS_NODE: "1" }
      : process.env,
  }
  const stdout = (await execFileAsync(file, [ ...prefixArgs, ...args ], opts)).stdout
  return stdout
}

export async function runMeegleJson(args: string[], timeoutMs = 8_000): Promise<unknown> {
  return parseJsonStdout(await execMeegle(args, timeoutMs))
}

export async function meegleAuthenticated(timeoutMs = 5_000): Promise<boolean> {
  try {
    const j = (await runMeegleJson([ "auth", "status" ], timeoutMs)) as { authenticated?: boolean }
    return j.authenticated === true
  } catch {
    return false
  }
}

export async function meegleCliAvailable(timeoutMs = 5_000): Promise<boolean> {
  try {
    await execMeegle([ "version" ], timeoutMs)
    return true
  } catch {
    return false
  }
}
