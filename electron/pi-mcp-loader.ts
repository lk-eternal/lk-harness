import { createRequire } from "node:module"
import * as fs from "node:fs"
import * as path from "node:path"
import { fileURLToPath } from "node:url"
import type { ExtensionFactory } from "@mariozechner/pi-coding-agent"
import type { PiMcpConfig } from "./pi-mcp-config"

function findProjectRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url))
  for (let i = 0; i < 8; i++) {
    if (
      fs.existsSync(path.join(dir, "node_modules", "@mariozechner", "pi-coding-agent"))
      || fs.existsSync(path.join(dir, "node_modules", "@earendil-works", "pi-coding-agent"))
    ) return dir
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return process.cwd()
}

function nm(root: string, ...segments: string[]): string {
  return path.join(root, "node_modules", ...segments)
}

function piPkgRoot(root: string, name: string): string {
  for (const scope of ["@earendil-works", "@mariozechner"]) {
    const dir = nm(root, scope, name)
    if (fs.existsSync(dir)) return dir
  }
  return nm(root, "@mariozechner", name)
}

function buildJitiAliases(root: string): Record<string, string> {
  const projectRequire = createRequire(path.join(root, "package.json"))
  const typeboxEntry = projectRequire.resolve("typebox")
  const typeboxCompileEntry = projectRequire.resolve("typebox/compile")
  const typeboxValueEntry = projectRequire.resolve("typebox/value")
  const piCodingAgent = path.join(piPkgRoot(root, "pi-coding-agent"), "dist/index.js")
  const piAgentCore = path.join(piPkgRoot(root, "pi-agent-core"), "dist/index.js")
  const piAiRoot = piPkgRoot(root, "pi-ai")
  const piAi = path.join(piAiRoot, "dist/index.js")
  const piAiCompat = path.join(piAiRoot, "dist/compat.js")
  const piAiOauth = path.join(piAiRoot, "dist/oauth.js")
  const piTui = path.join(piPkgRoot(root, "pi-tui"), "dist/index.js")

  return {
    "@mariozechner/pi-coding-agent": piCodingAgent,
    "@mariozechner/pi-agent-core": piAgentCore,
    "@mariozechner/pi-ai": piAi,
    "@mariozechner/pi-ai/compat": piAiCompat,
    "@mariozechner/pi-ai/oauth": piAiOauth,
    "@mariozechner/pi-tui": piTui,
    "@earendil-works/pi-coding-agent": piCodingAgent,
    "@earendil-works/pi-agent-core": piAgentCore,
    "@earendil-works/pi-ai": piAi,
    "@earendil-works/pi-ai/compat": piAiCompat,
    "@earendil-works/pi-tui": piTui,
    typebox: typeboxEntry,
    "typebox/compile": typeboxCompileEntry,
    "typebox/value": typeboxValueEntry,
    "@sinclair/typebox": typeboxEntry,
    "@sinclair/typebox/compile": typeboxCompileEntry,
    "@sinclair/typebox/value": typeboxValueEntry,
  }
}

type JitiImporter = { import: (id: string) => Promise<unknown> }

let jitiInstance: JitiImporter | null = null
let jitiRoot: string | null = null

async function loadCreateJiti() {
  const loader = new Function("spec", "return import(spec)") as (
    spec: string,
  ) => Promise<{ createJiti: (id: string, opts?: { moduleCache?: boolean; alias?: Record<string, string> }) => JitiImporter }>
  const mod = await loader("@mariozechner/jiti")
  return mod.createJiti
}

async function getJiti(root: string): Promise<JitiImporter> {
  if (jitiInstance && jitiRoot === root) return jitiInstance
  const createJiti = await loadCreateJiti()
  jitiInstance = createJiti(fileURLToPath(import.meta.url), {
    moduleCache: false,
    alias: buildJitiAliases(root),
  })
  jitiRoot = root
  return jitiInstance
}

/** 运行时经 jiti 加载 pi-mcp-adapter（.ts 源码），避免 Node 原生 import 无法 strip node_modules 内 TS */
export async function loadMcpExtension(config: PiMcpConfig): Promise<ExtensionFactory | undefined> {
  if (Object.keys(config.mcpServers).length === 0) return undefined
  const root = findProjectRoot()
  const adapterPath = path.join(nm(root, "pi-mcp-adapter"), "index.ts")
  const jiti = await getJiti(root)
  const mod = (await jiti.import(adapterPath)) as {
    createMcpAdapter: (opts: { config: PiMcpConfig }) => ExtensionFactory
  }
  return mod.createMcpAdapter({ config })
}
