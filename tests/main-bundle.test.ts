import { describe, it, expect, afterAll } from "vitest"
import * as fs from "node:fs"
import * as path from "node:path"
import { execFile } from "node:child_process"
import { promisify } from "node:util"

/**
 * 打包产物回归：界面「切供应商」在源码下是对的，但 Rollup 曾把
 * applySessionProviderSwitch 按唯一的「全 null 字面量」调用点折叠成只清空覆盖，
 * 打出来的应用里点模型毫无反应（覆盖还会被清掉）。源码级测试看不见这种问题，
 * 所以这里真的构建一次主进程，只断言编译后的函数还按参数办事。
 */
const ROOT = path.resolve(__dirname, "..")
const CONFIG = path.join(ROOT, "electron.vite.bundle-test.config.ts")
const OUT = path.join(ROOT, "out-bundle-test")

function cleanup(): void {
  try { fs.rmSync(CONFIG, { force: true }) } catch { /* ignore */ }
  try { fs.rmSync(OUT, { recursive: true, force: true }) } catch { /* ignore */ }
}

function readAllJs(dir: string): string {
  let out = ""
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out += readAllJs(full)
    else if (e.name.endsWith(".js")) out += fs.readFileSync(full, "utf8")
  }
  return out
}

describe("主进程打包产物", () => {
  afterAll(cleanup)

  it("打包后 applySessionProviderSwitch 仍按参数写模型/供应商，不被折叠成只清空", async () => {
    cleanup()
    fs.writeFileSync(CONFIG, [
      'import { resolve } from "node:path"',
      'import { defineConfig, externalizeDepsPlugin } from "electron-vite"',
      "export default defineConfig({",
      "  main: {",
      '    plugins: [externalizeDepsPlugin({ exclude: ["electron-store", "electron-updater", "node-cron", "cron-parser", "semver"] })],',
      '    build: { outDir: "out-bundle-test/main", rollupOptions: { input: { index: resolve("electron/main.ts") } } },',
      "  },",
      "})",
      "",
    ].join("\n"))
    await promisify(execFile)(
      process.execPath,
      [path.join(ROOT, "node_modules", "electron-vite", "bin", "electron-vite.js"), "build", "-c", CONFIG],
      { cwd: ROOT, maxBuffer: 32 * 1024 * 1024 },
    )
    const js = readAllJs(path.join(OUT, "main"))
    const at = js.indexOf("function applySessionProviderSwitch")
    expect(at, "打包产物里找不到 applySessionProviderSwitch").toBeGreaterThan(-1)
    const body = js.slice(at, at + 900)
    expect(body).toContain("patch.model = opts.model.model")
    expect(body).toContain("patch.resourceId = opts.resourceId")
  }, 180_000)
})
