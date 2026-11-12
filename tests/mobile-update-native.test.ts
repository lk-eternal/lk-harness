import * as fs from "node:fs"
import * as http from "node:http"
import * as os from "node:os"
import * as path from "node:path"
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest"
import {
  MOBILE_APK_FILE,
  MOBILE_APK_MANIFEST,
  bundledApkInfo,
  findBundledApk,
  handleMobileApkRequest,
  requestOrigin,
  withDesktopApkUrl,
} from "../electron/mobile-apk"
import { UPDATE_INFO_TIMEOUT_MS, fetchUpdateInfo } from "../src/mobile/api"
import { tryOpenInSystemBrowser } from "../src/mobile/native-browser"
import { createUpdateController } from "../src/mobile/update-controller"
import { pendingUpdate } from "../src/mobile/update-check"
import { MOBILE_APK_PATH } from "../src/shared/app-update"
// 「原生壳」是 Capacitor 注入页面的真实 native-bridge.js（取自已发布 APK），不是手写 mock，见该文件顶部说明
import { bootRealShell, installWindow } from "./helpers/real-native-shell"

/**
 * 手机更新这条链路从头到尾串起来：
 * 电脑端（真实的 HTTP 服务 + 真实的内置 APK 清单读取）→ 手机端（真实的 fetchUpdateInfo + 控制器）→ 真实原生桥的 Browser.open →
 * 系统浏览器拿着那个地址去下载。除了「电脑端 HTTP 服务」只接了 mobile-server.ts 里调用的那几个函数之外，没有 mock。
 */

const TOKEN = "t".repeat(32)
let dir = ""
let apkBytes: Buffer
let server: http.Server
let base = ""
let lastAuth: string | undefined

beforeAll(async () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "mobile-update-native-"))
  apkBytes = Buffer.from(Array.from({ length: 120_000 }, (_, i) => (i * 7) % 256))
  fs.writeFileSync(path.join(dir, MOBILE_APK_FILE), apkBytes)
  // 和 CI 写出来的清单一致
  fs.writeFileSync(path.join(dir, MOBILE_APK_MANIFEST), JSON.stringify({ version: "1.4.0", size: apkBytes.length }) + "\n")

  server = http.createServer((req, res) => {
    const url = new URL(req.url ?? "/", "http://x")
    if (handleMobileApkRequest(() => findBundledApk([dir]), req, res, url.pathname)) return
    if (url.pathname === "/api/mobile/update-info") {
      lastAuth = req.headers.authorization
      const bundled = findBundledApk([dir])
      const info = bundled ? withDesktopApkUrl(bundledApkInfo(bundled), requestOrigin(req.headers, "")) : { ok: false, error: "x" }
      res.writeHead(200, { "Content-Type": "application/json" })
      res.end(JSON.stringify(info))
      return
    }
    res.writeHead(404)
    res.end()
  })
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
  fs.rmSync(dir, { recursive: true, force: true })
})

beforeEach(() => installWindow({}))
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  delete (globalThis as { window?: unknown }).window
})

function waitFor<T>(read: () => T | null | undefined, ms = 3000): Promise<T> {
  const start = Date.now()
  return new Promise((resolve, reject) => {
    const tick = () => {
      const v = read()
      if (v) resolve(v)
      else if (Date.now() - start > ms) reject(new Error("等不到"))
      else setTimeout(tick, 5)
    }
    tick()
  })
}

describe("手机更新：电脑端内置 APK → 手机提示 → 系统浏览器下载", () => {
  it("新版 App：查到比自己新的版本，点下载时把「当前连着的电脑地址 + APK 路径」交给原生的 Browser.open，浏览器真能把 APK 下完整", async () => {
    const shell = bootRealShell()
    installWindow(shell.win)
    const onError = vi.fn()
    const c = createUpdateController({
      fetchInfo: () => fetchUpdateInfo(base, TOKEN),
      getBaseUrl: () => base,
      currentVersion: "1.3.0",
      loadDismissed: () => "",
      saveDismissed: () => undefined,
      openUrl: tryOpenInSystemBrowser,
      onError,
    })

    c.autoCheck()
    const update = await waitFor(() => c.getState().update)
    expect(lastAuth).toBe(`Bearer ${TOKEN}`)
    expect(update).toMatchObject({ version: "1.4.0", apkUrl: `${base}${MOBILE_APK_PATH}` })

    const opened = c.startUpdate()
    expect(shell.calls).toHaveLength(1)
    expect(shell.calls[0]).toMatchObject({ pluginId: "Browser", methodName: "open", options: { url: `${base}${MOBILE_APK_PATH}` } })
    shell.reply(shell.calls[0], { success: true, data: {} })
    await opened
    expect(onError).not.toHaveBeenCalled()

    // 系统浏览器拿着这个地址去下载：不带令牌，下到的就是内置的那个 APK
    const downloaded = await fetch(String(shell.calls[0].options.url))
    expect(downloaded.status).toBe(200)
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(apkBytes)).toBe(true)
  })

  it("已经是电脑上这一版：不提示", async () => {
    const c = createUpdateController({
      fetchInfo: () => fetchUpdateInfo(base, TOKEN),
      getBaseUrl: () => base,
      currentVersion: "1.4.0",
      loadDismissed: () => "",
      saveDismissed: () => undefined,
      openUrl: tryOpenInSystemBrowser,
      onError: vi.fn(),
    })
    expect(await c.checkNow()).toBe("latest")
    expect(c.getState().update).toBeNull()
  })

  it("旧版 App（1.1.4 ~ 1.3.0）不用升级就能从电脑下载：它们只认响应里的绝对 apkUrl，那个地址按它连上来的地址拼好了", async () => {
    const res = await fetch(`${base}/api/mobile/update-info`, { headers: { Authorization: `Bearer ${TOKEN}` } })
    const info = (await res.json()) as Parameters<typeof pendingUpdate>[0]
    // 旧版的做法：pendingUpdate 只收三个参数，不拼地址
    const pending = pendingUpdate(info, "1.3.0", "")
    expect(pending?.version).toBe("1.4.0")
    expect(pending?.apkUrl).toBe(`${base}${MOBILE_APK_PATH}`)
    const downloaded = await fetch(pending!.apkUrl)
    expect(Buffer.from(await downloaded.arrayBuffer()).equals(apkBytes)).toBe(true)
  })

  it("电脑端换了新安装包（清单版本变了）不用重启：下一次检查就是新版本", async () => {
    fs.writeFileSync(path.join(dir, MOBILE_APK_MANIFEST), JSON.stringify({ version: "1.5.0", size: apkBytes.length }) + "\n")
    try {
      const info = await fetchUpdateInfo(base, TOKEN)
      expect(info.latestVersion).toBe("1.5.0")
    } finally {
      fs.writeFileSync(path.join(dir, MOBILE_APK_MANIFEST), JSON.stringify({ version: "1.4.0", size: apkBytes.length }) + "\n")
    }
  })
})

describe("fetchUpdateInfo 的超时", () => {
  it(`电脑端迟迟不回答（比如在查 GitHub）：${UPDATE_INFO_TIMEOUT_MS / 1000} 秒后放弃并说明原因，不让手机一直等`, async () => {
    vi.useFakeTimers()
    vi.stubGlobal(
      "fetch",
      (_url: string, init?: { signal?: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")))
        }),
    )
    const pending = fetchUpdateInfo("http://192.168.1.5:19529", TOKEN)
    await vi.advanceTimersByTimeAsync(UPDATE_INFO_TIMEOUT_MS - 1)
    let settled = false
    void pending.then(() => { settled = true })
    await Promise.resolve()
    expect(settled).toBe(false)
    await vi.advanceTimersByTimeAsync(2)
    expect(await pending).toEqual({ ok: false, error: "电脑端没有及时响应" })
  })

  it("正常回答时不会被超时误伤，也不留下定时器", async () => {
    vi.useFakeTimers()
    vi.stubGlobal("fetch", async () => new Response(JSON.stringify({ ok: true, latestVersion: "1.4.0" })))
    const info = await fetchUpdateInfo("http://192.168.1.5:19529", TOKEN)
    expect(info.latestVersion).toBe("1.4.0")
    expect(vi.getTimerCount()).toBe(0)
  })

  it("断网时说的是连不上，不是超时", async () => {
    vi.stubGlobal("fetch", async () => {
      throw new TypeError("Failed to fetch")
    })
    expect(await fetchUpdateInfo("http://192.168.1.5:19529", TOKEN)).toEqual({
      ok: false,
      error: "无法连接到电脑端，请检查网络",
    })
  })
})
