import { describe, expect, it } from "vitest"
import { builtinModules } from "node:module"
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import { dirname, join, resolve } from "node:path"

/**
 * 渲染进程（浏览器环境）打包时拿不到 node 内置模块 / electron / 只在 Node 跑的依赖。
 * 一旦某个被 src/renderer 间接引用的 shared 文件顺手 import 了 node:fs，
 * `tsc` 照样通过（类型都在），到 vite 打包或者窗口运行时才炸。
 * 这里从 src/renderer 的全部文件出发，顺着相对路径 import 走一遍，把这类错误提前到测试里。
 */

const ROOT = resolve(__dirname, "..")
const RENDERER_DIR = join(ROOT, "src", "renderer")

const NODE_ONLY_PACKAGES = new Set(["electron", "cron-parser"])
const NODE_BUILTINS = new Set(builtinModules.flatMap((m) => [m, `node:${m}`]))

function walk(dir: string, out: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name)
    if (statSync(full).isDirectory()) walk(full, out)
    else if (/\.(ts|tsx)$/.test(name) && !name.endsWith(".d.ts")) out.push(full)
  }
  return out
}

/** 取出运行时真正会打进包的 import / export-from / 动态 import（`import type` 编译后消失，跳过） */
export function runtimeSpecifiers(source: string): string[] {
  const out: string[] = []
  const stripped = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
  const staticRe = /(?:^|[\n;])\s*(import|export)\s+(type\s+)?([^"';]*?\s+from\s+)?["']([^"']+)["']/g
  for (const m of stripped.matchAll(staticRe)) {
    if (m[2]) continue
    // `import { type A, type B } from "x"` 整条只剩类型：同样不会进包
    const clause = m[3] ?? ""
    if (/^\s*\{[^}]*\}\s+from\s+$/.test(clause)) {
      const names = clause.replace(/[{}]|\s+from\s+$/g, "").split(",").map((s) => s.trim()).filter(Boolean)
      if (names.length > 0 && names.every((n) => n.startsWith("type "))) continue
    }
    out.push(m[4])
  }
  for (const m of stripped.matchAll(/\bimport\(\s*["']([^"']+)["']\s*\)/g)) out.push(m[1])
  return out
}

function resolveRelative(from: string, spec: string): string | null {
  const base = resolve(dirname(from), spec.replace(/\.(js|jsx)$/, ""))
  for (const cand of [`${base}.ts`, `${base}.tsx`, join(base, "index.ts"), join(base, "index.tsx"), base]) {
    if (existsSync(cand) && statSync(cand).isFile()) return cand
  }
  return null
}

interface Violation { file: string; specifier: string; via: string }

function findViolations(entries: string[]): { violations: Violation[]; visited: Set<string> } {
  const visited = new Set<string>()
  const parent = new Map<string, string>()
  const violations: Violation[] = []
  const queue = [...entries]
  while (queue.length) {
    const file = queue.shift()!
    if (visited.has(file)) continue
    visited.add(file)
    for (const spec of runtimeSpecifiers(readFileSync(file, "utf8"))) {
      if (spec.startsWith(".")) {
        const next = resolveRelative(file, spec)
        if (next && !visited.has(next)) {
          if (!parent.has(next)) parent.set(next, file)
          queue.push(next)
        }
        continue
      }
      const pkg = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]
      if (NODE_BUILTINS.has(spec) || NODE_BUILTINS.has(pkg) || NODE_ONLY_PACKAGES.has(pkg)) {
        violations.push({ file: file.slice(ROOT.length + 1), specifier: spec, via: parent.get(file)?.slice(ROOT.length + 1) ?? "(入口)" })
      }
    }
  }
  return { violations, visited }
}

describe("runtimeSpecifiers", () => {
  it("识别运行时 import，忽略 import type 与注释", () => {
    const src = [
      `import a from "node:fs"`,
      `import type { B } from "node:path"`,
      `import { type C, type D } from "electron"`,
      `import { e, type F } from "cron-parser"`,
      `export * from "./x.js"`,
      `export type { G } from "./y.js"`,
      `// import z from "node:os"`,
      `/* import q from "node:net" */`,
      `const m = await import("./lazy")`,
    ].join("\n")
    expect(runtimeSpecifiers(src).sort()).toEqual(["./lazy", "./x.js", "cron-parser", "node:fs"].sort())
  })
})

describe("渲染进程打包安全", () => {
  const entries = walk(RENDERER_DIR)

  it("src/renderer 可达的所有文件都没有 node 内置模块 / electron / cron-parser 的运行时 import", () => {
    const { violations, visited } = findViolations(entries)
    // 走查确实覆盖到了 shared 里的任务模块，防止解析器退化成空走
    const rel = [...visited].map((f) => f.slice(ROOT.length + 1).replace(/\\/g, "/"))
    expect(rel).toContain("src/shared/task-delivery.ts")
    expect(rel).toContain("src/shared/scheduled-task-rules.ts")
    expect(violations).toEqual([])
  })
})
