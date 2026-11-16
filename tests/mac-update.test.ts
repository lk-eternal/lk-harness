import { createHash, randomBytes } from "node:crypto"
import { spawn, spawnSync } from "node:child_process"
import * as fs from "node:fs"
import * as os from "node:os"
import * as path from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import {
  MAC_STAGE_DIRNAME,
  checkMacInstallTarget,
  cleanupMacUpdateLeftovers,
  consumeSwapResult,
  downloadMacDmg,
  launchMacSwap,
  locateAppBundle,
  macYmlUrl,
  pickMacDmg,
  prepareMacApp,
  readMacYmlVersion,
  swapScriptText,
  type InstallIo,
  type MacDmgEntry,
  type RunFn,
} from "../electron/mac-update"
import { startServer, type TestServer } from "./helpers/range-server"

const RELEASES = "https://github.com/lk-eternal/lk-harness/releases"
const sha512 = (b: Buffer) => createHash("sha512").update(b).digest("base64")
const fast = { retryDelayMs: () => 0, sleep: async () => undefined }

/** 1.4.3 发布的真实 latest-mac.yml：地址是 LK-Harness-…（连字符），GitHub 上真实的资源名却是 LK.Harness-…（点） */
const REAL_YML = `version: 1.4.3
files:
  - url: LK-Harness-1.4.3.dmg
    sha512: U4sXZEDeK15CYxlonEvdcg/bCWmbfFQDVxhBRWfYdxMWFsMX2Txtrd91EoXWTiOvPF74JPIEys/WtRp37wV+Yw==
    size: 225355125
  - url: LK-Harness-1.4.3-arm64.dmg
    sha512: F5eGDZwOGk3L9qYLuzSpjdOqmWD6I2zfg3VnTdGIN/Y66my6uNUL0G/HrvMgBvlbb6hXIVXlplLpzrKtTXi4CA==
    size: 218927944
path: LK-Harness-1.4.3.dmg
sha512: U4sXZEDeK15CYxlonEvdcg/bCWmbfFQDVxhBRWfYdxMWFsMX2Txtrd91EoXWTiOvPF74JPIEys/WtRp37wV+Yw==
releaseDate: '2026-11-16T07:26:49.658Z'
`

let tmp: string
let server: TestServer | undefined

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "lkh-macupd-"))
})
afterEach(async () => {
  await server?.close()
  server = undefined
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe("pickMacDmg（latest-mac.yml）", () => {
  const src = (arch: string, extra: object = {}) => ({ version: "1.4.3", arch, releasesBase: RELEASES, ...extra })

  it("Apple 芯片取 arm64 的 dmg：sha512、大小来自 yml，地址用 GitHub 上真实的资源名", () => {
    expect(pickMacDmg(REAL_YML, src("arm64"))).toEqual({
      fileName: "LK.Harness-1.4.3-arm64.dmg",
      url: `${RELEASES}/download/v1.4.3/LK.Harness-1.4.3-arm64.dmg`,
      sha512: "F5eGDZwOGk3L9qYLuzSpjdOqmWD6I2zfg3VnTdGIN/Y66my6uNUL0G/HrvMgBvlbb6hXIVXlplLpzrKtTXi4CA==",
      size: 218927944,
    })
  })

  it("Intel 取不带 arm64 的 dmg，不会拿成 arm64 的", () => {
    const entry = pickMacDmg(REAL_YML, src("x64"))
    expect(entry?.fileName).toBe("LK.Harness-1.4.3.dmg")
    expect(entry?.sha512.startsWith("U4sX")).toBe(true)
    expect(entry?.size).toBe(225355125)
  })

  it("不用 yml 里的地址：连字符的名字在 GitHub 上是 404", () => {
    for (const arch of ["arm64", "x64"]) {
      const entry = pickMacDmg(REAL_YML, src(arch))
      expect(entry?.url).not.toContain("LK-Harness")
      expect(entry?.url).not.toContain("%20")
    }
  })

  it("yml 的版本和要装的版本对不上就不用（免得装错版本）", () => {
    expect(pickMacDmg(REAL_YML, { ...src("arm64"), version: "1.4.4" })).toBeNull()
  })

  it("没有对应芯片的 dmg、没有 sha512、不是 dmg，都返回 null", () => {
    const onlyIntel = `version: 1.4.3\nfiles:\n  - url: LK-Harness-1.4.3.dmg\n    sha512: abc==\n    size: 1\n`
    expect(pickMacDmg(onlyIntel, src("arm64"))).toBeNull()
    const noSha = `version: 1.4.3\nfiles:\n  - url: LK-Harness-1.4.3.dmg\n    size: 1\n`
    expect(pickMacDmg(noSha, src("x64"))).toBeNull()
    const zip = `version: 1.4.3\nfiles:\n  - url: LK-Harness-1.4.3.zip\n    sha512: abc==\n`
    expect(pickMacDmg(zip, src("x64"))).toBeNull()
  })

  it("files 为空时退回顶层的 path / sha512（electron-builder 旧格式）", () => {
    const old = `version: 1.4.3\npath: LK-Harness-1.4.3.dmg\nsha512: zzz==\n`
    const entry = pickMacDmg(old, src("x64"))
    expect(entry?.sha512).toBe("zzz==")
    expect(entry?.size).toBeUndefined()
  })

  it("读不懂的内容返回 null，不抛错", () => {
    expect(pickMacDmg("", src("arm64"))).toBeNull()
    expect(pickMacDmg("{{{ not yaml", src("arm64"))).toBeNull()
    expect(pickMacDmg("- just\n- a list\n", src("arm64"))).toBeNull()
  })

  it("测试更新源：dmg 从源里取，文件名用 yml 里写的", () => {
    const entry = pickMacDmg(REAL_YML, src("arm64", { feedBase: "http://127.0.0.1:8000/" }))
    expect(entry?.url).toBe("http://127.0.0.1:8000/LK-Harness-1.4.3-arm64.dmg")
    expect(entry?.fileName).toBe("LK-Harness-1.4.3-arm64.dmg")
  })
})

describe("macYmlUrl / readMacYmlVersion", () => {
  it("正式：GitHub 这个版本的发布目录；测试源：源根目录", () => {
    expect(macYmlUrl({ version: "1.4.3", releasesBase: RELEASES })).toBe(`${RELEASES}/download/v1.4.3/latest-mac.yml`)
    expect(macYmlUrl({ version: "1.4.3", releasesBase: RELEASES, feedBase: "http://127.0.0.1:8000/" })).toBe(
      "http://127.0.0.1:8000/latest-mac.yml",
    )
  })

  it("从 yml 里读版本号；不合法的返回 null", () => {
    expect(readMacYmlVersion(REAL_YML)).toBe("1.4.3")
    expect(readMacYmlVersion("version: nope\n")).toBeNull()
    expect(readMacYmlVersion("{{{")).toBeNull()
    expect(readMacYmlVersion("")).toBeNull()
  })
})

describe("locateAppBundle", () => {
  it("从主程序路径找到最外层的 .app", () => {
    expect(locateAppBundle("/Applications/LK Harness.app/Contents/MacOS/LK Harness")).toBe("/Applications/LK Harness.app")
    expect(locateAppBundle("/Users/me/Applications/LK Harness.app/Contents/MacOS/LK Harness")).toBe(
      "/Users/me/Applications/LK Harness.app",
    )
  })

  it("取最外层的：Helper 应用在主应用里面", () => {
    expect(
      locateAppBundle("/Applications/LK Harness.app/Contents/Frameworks/LK Harness Helper.app/Contents/MacOS/x"),
    ).toBe("/Applications/LK Harness.app")
  })

  it("路径里没有 .app（开发模式的 electron）返回 null", () => {
    expect(locateAppBundle("/usr/local/bin/node")).toBeNull()
    expect(locateAppBundle("")).toBeNull()
  })
})

describe("checkMacInstallTarget", () => {
  const GB = 1024 * 1024 * 1024
  const io = (over: Partial<InstallIo> = {}): InstallIo => ({
    realpath: async (p) => p,
    canWrite: async () => true,
    freeBytes: async () => 50 * GB,
    ...over,
  })
  const bundle = "/Applications/LK Harness.app"

  it("能写、空间够：通过，返回真实路径和所在文件夹", async () => {
    expect(await checkMacInstallTarget(bundle, io(), 200 * 1024 * 1024)).toEqual({
      ok: true,
      bundle,
      installDir: "/Applications",
    })
  })

  it("用解开符号链接后的真实路径判断", async () => {
    const r = await checkMacInstallTarget(bundle, io({ realpath: async () => "/Volumes/Data/Apps/LK Harness.app" }), undefined)
    expect(r).toEqual({ ok: true, bundle: "/Volumes/Data/Apps/LK Harness.app", installDir: "/Volumes/Data/Apps" })
  })

  it("找不到 .app：不能更新", async () => {
    const r = await checkMacInstallTarget(null, io(), 1)
    expect(r).toMatchObject({ ok: false, reason: "no-bundle" })
  })

  it("读不到真实路径：不能更新", async () => {
    const r = await checkMacInstallTarget(bundle, io({ realpath: async () => { throw new Error("ENOENT") } }), 1)
    expect(r).toMatchObject({ ok: false, reason: "no-bundle" })
  })

  it("App Translocation 的只读随机路径：提示先拖进「应用程序」", async () => {
    const r = await checkMacInstallTarget(
      bundle,
      io({ realpath: async () => "/private/var/folders/ab/xyz/AppTranslocation/1234-5678/d/LK Harness.app" }),
      1,
    )
    expect(r).toMatchObject({ ok: false, reason: "translocated" })
    if (!r.ok) expect(r.message).toContain("应用程序")
  })

  it("所在文件夹没有写入权限（标准用户、只读卷）：不能更新，说明文件夹是哪个", async () => {
    const r = await checkMacInstallTarget(bundle, io({ canWrite: async () => false }), 1)
    expect(r).toMatchObject({ ok: false, reason: "not-writable" })
    if (!r.ok) expect(r.message).toContain("/Applications")
  })

  it("磁盘空间不够（不到 dmg 大小的 3 倍）：不能更新，写明还剩多少", async () => {
    const r = await checkMacInstallTarget(bundle, io({ freeBytes: async () => 500 * 1024 * 1024 }), 300 * 1024 * 1024)
    expect(r).toMatchObject({ ok: false, reason: "low-disk" })
    if (!r.ok) expect(r.message).toContain("500 MB")
  })

  it("取不到剩余空间、或不知道 dmg 多大：不拦", async () => {
    expect((await checkMacInstallTarget(bundle, io({ freeBytes: async () => null }), 300 * 1024 * 1024)).ok).toBe(true)
    expect((await checkMacInstallTarget(bundle, io({ freeBytes: async () => 1 }), undefined)).ok).toBe(true)
  })
})

describe("downloadMacDmg", () => {
  const entryFor = (payload: Buffer, url: string, fileName = "LK.Harness-9.9.9-arm64.dmg"): MacDmgEntry => ({
    fileName,
    url,
    sha512: sha512(payload),
    size: payload.length,
  })

  it("下载、校验、放到目录里；第二次文件还在就不再下载", async () => {
    const payload = randomBytes(300_000)
    server = await startServer(payload, () => ({ kind: "ok" }), { fileName: "LK.Harness-9.9.9-arm64.dmg" })
    const dir = path.join(tmp, "mac-update")
    const entry = entryFor(payload, server.url)

    const first = await downloadMacDmg({ dir, entry, fetchImpl: fetch, ...fast })
    expect(first.reusedExisting).toBe(false)
    expect(fs.readFileSync(first.file).equals(payload)).toBe(true)
    expect(fs.existsSync(`${first.file}.part`)).toBe(false)

    const requestsAfterFirst = server.requests.length
    const second = await downloadMacDmg({ dir, entry, fetchImpl: fetch, ...fast })
    expect(second.reusedExisting).toBe(true)
    expect(server.requests.length).toBe(requestsAfterFirst)
  })

  it("成品被改坏了：不信它，重新下载", async () => {
    const payload = randomBytes(100_000)
    server = await startServer(payload, () => ({ kind: "ok" }), { fileName: "LK.Harness-9.9.9-arm64.dmg" })
    const dir = path.join(tmp, "mac-update")
    const entry = entryFor(payload, server.url)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, entry.fileName), randomBytes(100_000))

    const r = await downloadMacDmg({ dir, entry, fetchImpl: fetch, ...fast })
    expect(r.reusedExisting).toBe(false)
    expect(fs.readFileSync(r.file).equals(payload)).toBe(true)
  })

  it("别的版本的 dmg 和 .part 会清掉，脚本、结果文件、这次的 .part 留着", async () => {
    const payload = randomBytes(50_000)
    server = await startServer(payload, () => ({ kind: "ok" }), { fileName: "LK.Harness-9.9.9-arm64.dmg" })
    const dir = path.join(tmp, "mac-update")
    fs.mkdirSync(dir, { recursive: true })
    for (const name of ["LK.Harness-9.8.0-arm64.dmg", "LK.Harness-9.8.0.dmg.part", "LK.Harness-9.7.0.dmg", "apply-update.sh"]) {
      fs.writeFileSync(path.join(dir, name), "x")
    }
    await downloadMacDmg({ dir, entry: entryFor(payload, server.url), fetchImpl: fetch, ...fast })
    const left = fs.readdirSync(dir).sort()
    expect(left).toEqual(["LK.Harness-9.9.9-arm64.dmg", "apply-update.sh"])
  })

  it("sha512 对不上：失败，不留成品", async () => {
    const payload = randomBytes(50_000)
    server = await startServer(payload, () => ({ kind: "ok" }), { fileName: "LK.Harness-9.9.9-arm64.dmg" })
    const dir = path.join(tmp, "mac-update")
    const entry = { ...entryFor(payload, server.url), sha512: sha512(Buffer.from("别的内容")) }
    await expect(
      downloadMacDmg({ dir, entry, fetchImpl: fetch, ...fast, maxConsecutiveFailures: 2, maxAttempts: 2 }),
    ).rejects.toThrow()
    expect(fs.existsSync(path.join(dir, entry.fileName))).toBe(false)
  })
})

describe("prepareMacApp", () => {
  interface Call {
    cmd: string
    args: string[]
  }

  /** 假的系统命令：attach 在挂载点里放一个 .app，ditto 真的拷贝，plutil 回版本号，detach 清空挂载点 */
  function fakeRun(opts: {
    appName?: string | null
    version?: string
    failOn?: string
    failFirstDetach?: boolean
    failAllDetach?: boolean
  } = {}) {
    const calls: Call[] = []
    let detachCount = 0
    const run: RunFn = async (cmd, args) => {
      calls.push({ cmd, args })
      const name = path.basename(cmd)
      const verb = `${name} ${args[0]}`
      if (opts.failOn && (opts.failOn === name || opts.failOn === verb)) throw new Error(`${verb} 失败：boom`)
      if (verb === "hdiutil attach") {
        const mount = args[args.indexOf("-mountpoint") + 1]
        if (opts.appName !== null) {
          const app = path.join(mount, opts.appName ?? "LK Harness.app", "Contents")
          fs.mkdirSync(app, { recursive: true })
          fs.writeFileSync(path.join(app, "Info.plist"), "plist")
        }
        return ""
      }
      if (verb === "hdiutil detach" || (name === "hdiutil" && args[0] === "detach")) {
        detachCount++
        if (opts.failAllDetach || (opts.failFirstDetach && detachCount === 1)) throw new Error("Resource busy")
        const mount = args[args.length - 1]
        for (const e of fs.readdirSync(mount)) fs.rmSync(path.join(mount, e), { recursive: true, force: true })
        return ""
      }
      if (name === "ditto") {
        fs.cpSync(args[0], args[1], { recursive: true })
        return ""
      }
      if (name === "plutil") return `${opts.version ?? "1.4.4"}\n`
      return ""
    }
    return { run, calls }
  }

  function setup() {
    const installDir = path.join(tmp, "Applications")
    const targetBundle = path.join(installDir, "LK Harness.app")
    fs.mkdirSync(path.join(targetBundle, "Contents"), { recursive: true })
    const workDir = path.join(tmp, "work")
    return { installDir, targetBundle, workDir, dmgPath: path.join(workDir, "x.dmg") }
  }

  it("按顺序：挂载 → 拷贝 → 清隔离标记 → 读版本 → 卸载；暂存在旧应用旁边", async () => {
    const s = setup()
    const { run, calls } = fakeRun()
    const r = await prepareMacApp({ dmgPath: s.dmgPath, workDir: s.workDir, targetBundle: s.targetBundle, version: "1.4.4", run })

    expect(r.stageDir).toBe(path.join(s.installDir, MAC_STAGE_DIRNAME))
    expect(r.stagedApp).toBe(path.join(r.stageDir, "LK Harness.app"))
    expect(fs.existsSync(path.join(r.stagedApp, "Contents", "Info.plist"))).toBe(true)

    expect(calls.map((c) => `${path.basename(c.cmd)} ${c.args[0] === "attach" || c.args[0] === "detach" ? c.args[0] : ""}`.trim())).toEqual([
      "hdiutil attach",
      "ditto",
      "xattr",
      "plutil",
      "hdiutil detach",
    ])
    const attach = calls[0].args
    expect(attach[1]).toBe(s.dmgPath)
    for (const flag of ["-nobrowse", "-readonly", "-noautoopen", "-noverify"]) expect(attach).toContain(flag)
    // 挂载点是自己建的目录，不占 /Volumes
    const mount = attach[attach.indexOf("-mountpoint") + 1]
    expect(mount.startsWith(s.workDir)).toBe(true)
    expect(calls[1].args).toEqual([path.join(mount, "LK Harness.app"), r.stagedApp])
    // 卸载后挂载点目录也清掉了
    expect(fs.existsSync(mount)).toBe(false)
  })

  it("dmg 里的 .app 名字和当前不一样：照样找得到，暂存时用当前应用的名字", async () => {
    const s = setup()
    const { run } = fakeRun({ appName: "LK Harness 1.4.4.app" })
    const r = await prepareMacApp({ dmgPath: s.dmgPath, workDir: s.workDir, targetBundle: s.targetBundle, version: "1.4.4", run })
    expect(path.basename(r.stagedApp)).toBe("LK Harness.app")
    expect(fs.existsSync(path.join(r.stagedApp, "Contents", "Info.plist"))).toBe(true)
  })

  it("版本对不上：失败，暂存目录清掉，dmg 仍然卸载", async () => {
    const s = setup()
    const { run, calls } = fakeRun({ version: "1.4.3" })
    await expect(
      prepareMacApp({ dmgPath: s.dmgPath, workDir: s.workDir, targetBundle: s.targetBundle, version: "1.4.4", run }),
    ).rejects.toThrow(/1\.4\.3.*1\.4\.4/)
    expect(fs.existsSync(path.join(s.installDir, MAC_STAGE_DIRNAME))).toBe(false)
    expect(calls.some((c) => c.args[0] === "detach")).toBe(true)
    // 旧应用没被动过
    expect(fs.existsSync(path.join(s.targetBundle, "Contents"))).toBe(true)
  })

  it("拷贝失败：暂存目录清掉，dmg 仍然卸载", async () => {
    const s = setup()
    const { run, calls } = fakeRun({ failOn: "ditto" })
    await expect(
      prepareMacApp({ dmgPath: s.dmgPath, workDir: s.workDir, targetBundle: s.targetBundle, version: "1.4.4", run }),
    ).rejects.toThrow(/ditto/)
    expect(fs.existsSync(path.join(s.installDir, MAC_STAGE_DIRNAME))).toBe(false)
    expect(calls.some((c) => c.args[0] === "detach")).toBe(true)
  })

  it("挂载失败：没挂上就不卸载，暂存目录清掉", async () => {
    const s = setup()
    const { run, calls } = fakeRun({ failOn: "hdiutil attach" })
    await expect(
      prepareMacApp({ dmgPath: s.dmgPath, workDir: s.workDir, targetBundle: s.targetBundle, version: "1.4.4", run }),
    ).rejects.toThrow(/attach/)
    expect(calls.some((c) => c.args[0] === "detach")).toBe(false)
    expect(fs.existsSync(path.join(s.installDir, MAC_STAGE_DIRNAME))).toBe(false)
  })

  it("安装包里没有 .app：失败", async () => {
    const s = setup()
    const { run } = fakeRun({ appName: null })
    await expect(
      prepareMacApp({ dmgPath: s.dmgPath, workDir: s.workDir, targetBundle: s.targetBundle, version: "1.4.4", run }),
    ).rejects.toThrow(/没有找到 \.app/)
    expect(fs.existsSync(path.join(s.installDir, MAC_STAGE_DIRNAME))).toBe(false)
  })

  it("清隔离标记失败不影响结果（自己下载的文件本来就没有）", async () => {
    const s = setup()
    const { run } = fakeRun({ failOn: "xattr" })
    const r = await prepareMacApp({ dmgPath: s.dmgPath, workDir: s.workDir, targetBundle: s.targetBundle, version: "1.4.4", run })
    expect(fs.existsSync(r.stagedApp)).toBe(true)
  })

  it("第一次卸载被占用：用 -force 再卸一次", async () => {
    const s = setup()
    const { run, calls } = fakeRun({ failFirstDetach: true })
    await prepareMacApp({ dmgPath: s.dmgPath, workDir: s.workDir, targetBundle: s.targetBundle, version: "1.4.4", run })
    const detaches = calls.filter((c) => c.args[0] === "detach")
    expect(detaches).toHaveLength(2)
    expect(detaches[1].args).toContain("-force")
  })

  it("怎么都卸载不掉：不顺着挂载点去删里面的东西，也不让更新失败", async () => {
    const s = setup()
    const { run } = fakeRun({ failAllDetach: true })
    const r = await prepareMacApp({ dmgPath: s.dmgPath, workDir: s.workDir, targetBundle: s.targetBundle, version: "1.4.4", run })
    expect(fs.existsSync(r.stagedApp)).toBe(true)
    const mounts = fs.readdirSync(s.workDir).filter((n) => n.startsWith("mnt-"))
    expect(mounts).toHaveLength(1)
    // 挂载点里「dmg 的内容」原样还在
    expect(fs.existsSync(path.join(s.workDir, mounts[0], "LK Harness.app", "Contents", "Info.plist"))).toBe(true)
  })

  it("上次失败留下的暂存目录先清掉", async () => {
    const s = setup()
    const stale = path.join(s.installDir, MAC_STAGE_DIRNAME, "previous")
    fs.mkdirSync(stale, { recursive: true })
    fs.writeFileSync(path.join(stale, "junk"), "x")
    const { run } = fakeRun()
    const r = await prepareMacApp({ dmgPath: s.dmgPath, workDir: s.workDir, targetBundle: s.targetBundle, version: "1.4.4", run })
    expect(fs.existsSync(path.join(r.stageDir, "previous"))).toBe(false)
  })
})

// ── 替换脚本：用真实的 sh 跑，不只是看文本 ─────────────────────────

const hasSh = (() => {
  try {
    const r = spawnSync("sh", ["-c", "echo ok"], { encoding: "utf8" })
    return r.status === 0 && r.stdout.trim() === "ok"
  } catch {
    return false
  }
})()
const fwd = (p: string) => p.replace(/\\/g, "/")

describe("swapScriptText", () => {
  it("是纯 LF 的脚本（带 \\r 的话 macOS 的 sh 会报错）", () => {
    expect(swapScriptText()).not.toContain("\r")
    expect(swapScriptText().startsWith("#!/bin/sh\n")).toBe(true)
  })

  it("第二步失败要把旧版挪回去，不能让应用没了", () => {
    const text = swapScriptText()
    expect(text).toMatch(/mv "\$NEW" "\$TARGET"/)
    expect(text).toMatch(/mv "\$PREV\/old\.app" "\$TARGET"/)
    // 先挪走旧版，再放新版：顺序反了的话旧版会被覆盖
    expect(text.indexOf('mv "$TARGET" "$PREV/old.app"')).toBeLessThan(text.indexOf('mv "$NEW" "$TARGET"'))
  })
})

describe.skipIf(!hasSh)("替换脚本（真实 sh）", () => {
  interface Layout {
    script: string
    target: string
    stage: string
    next: string
    result: string
  }

  function layout(): Layout {
    const apps = fwd(path.join(tmp, "Applications"))
    const target = `${apps}/LK Harness.app`
    const stage = `${apps}/${MAC_STAGE_DIRNAME}`
    const next = `${stage}/LK Harness.app`
    for (const [dir, tag] of [[target, "old"], [next, "new"]] as const) {
      fs.mkdirSync(`${dir}/Contents`, { recursive: true })
      fs.writeFileSync(`${dir}/Contents/version.txt`, tag)
    }
    const script = fwd(path.join(tmp, "apply.sh"))
    fs.writeFileSync(script, swapScriptText())
    return { script, target, stage, next, result: fwd(path.join(tmp, "result.txt")) }
  }

  const run = (l: Layout, pid = "0") =>
    spawnSync("sh", [l.script, pid, l.next, l.target, l.stage, l.result, "1.4.4", "echo"], { encoding: "utf8" })
  const readResult = (l: Layout) => fs.readFileSync(l.result, "utf-8").split("\n")
  const readLog = (l: Layout) => fs.readFileSync(`${l.result}.log`, "utf-8")

  it("成功：新版本换到旧位置，暂存目录和旧版都清掉，写 ok，并重新打开", () => {
    const l = layout()
    expect(run(l).status).toBe(0)
    expect(fs.readFileSync(`${l.target}/Contents/version.txt`, "utf-8")).toBe("new")
    expect(fs.existsSync(l.stage)).toBe(false)
    expect(readResult(l).slice(0, 3)).toEqual(["ok", "已更新到 v1.4.4", "1.4.4"])
    // 打开命令（测试里是 echo）拿到的参数是旧应用的位置
    expect(readLog(l)).toContain(l.target)
  })

  it("暂存的新版本不见了：不动旧版，写 failed，仍然重新打开", () => {
    const l = layout()
    fs.rmSync(l.next, { recursive: true, force: true })
    expect(run(l).status).toBe(1)
    expect(fs.readFileSync(`${l.target}/Contents/version.txt`, "utf-8")).toBe("old")
    const res = readResult(l)
    expect(res[0]).toBe("failed")
    expect(res[1]).toContain("不见了")
    expect(readLog(l)).toContain(l.target)
  })

  it("旧版移不开（比如已经不在原位置）：写 failed，新版留在暂存目录，不会出现只有一半的应用", () => {
    const l = layout()
    fs.rmSync(l.target, { recursive: true, force: true })
    expect(run(l).status).toBe(1)
    expect(readResult(l)[0]).toBe("failed")
    expect(readResult(l)[1]).toContain("旧版本")
    expect(fs.existsSync(`${l.target}/Contents/version.txt`)).toBe(false)
    expect(fs.readFileSync(`${l.next}/Contents/version.txt`, "utf-8")).toBe("new")
  })

  it("应用名里有空格（LK Harness.app）也没问题：每个路径都有引号", () => {
    const l = layout()
    expect(l.target).toContain(" ")
    expect(run(l).status).toBe(0)
    expect(fs.readFileSync(`${l.target}/Contents/version.txt`, "utf-8")).toBe("new")
  })

  it.skipIf(process.platform === "win32")("会等应用进程退出再动手（pid 还活着时不替换）", async () => {
    const l = layout()
    const child = spawn("sleep", ["1.5"], { stdio: "ignore" })
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()))
    const started = Date.now()
    const proc = spawn("sh", [l.script, String(child.pid), l.next, l.target, l.stage, l.result, "1.4.4", "echo"], {
      stdio: "ignore",
    })
    const done = new Promise<void>((resolve) => proc.once("exit", () => resolve()))
    await new Promise((r) => setTimeout(r, 600))
    // 进程还在：旧版必须还在原位
    expect(fs.readFileSync(`${l.target}/Contents/version.txt`, "utf-8")).toBe("old")
    await Promise.all([exited, done])
    expect(Date.now() - started).toBeGreaterThanOrEqual(1400)
    expect(fs.readFileSync(`${l.target}/Contents/version.txt`, "utf-8")).toBe("new")
  })
})

describe.skipIf(!hasSh)("launchMacSwap", () => {
  it("写好脚本、以独立进程启动，替换完写出结果", async () => {
    const apps = path.join(tmp, "Applications")
    const target = path.join(apps, "LK Harness.app")
    const stageDir = path.join(apps, MAC_STAGE_DIRNAME)
    const stagedApp = path.join(stageDir, "LK Harness.app")
    for (const [dir, tag] of [[target, "old"], [stagedApp, "new"]] as const) {
      fs.mkdirSync(path.join(dir, "Contents"), { recursive: true })
      fs.writeFileSync(path.join(dir, "Contents", "version.txt"), tag)
    }
    const workDir = path.join(tmp, "work")
    fs.mkdirSync(workDir, { recursive: true })
    fs.writeFileSync(path.join(workDir, "apply-result.txt"), "failed\n上次的\n1.0.0\n")

    const { scriptPath, resultPath } = await launchMacSwap({
      workDir,
      pid: 0,
      version: "1.4.4",
      stagedApp,
      targetBundle: target,
      stageDir,
      shell: "sh",
      openCmd: "echo",
    })
    expect(fs.existsSync(scriptPath)).toBe(true)

    // 启动时先清掉上次的结果，免得把旧结果当成这次的
    const deadline = Date.now() + 15_000
    while (!fs.existsSync(resultPath) && Date.now() < deadline) await new Promise((r) => setTimeout(r, 100))
    expect(fs.readFileSync(resultPath, "utf-8")).toMatch(/^ok\n/)
    expect(fs.readFileSync(path.join(target, "Contents", "version.txt"), "utf-8")).toBe("new")
  })

  it("脚本启动不了（找不到 shell）：抛错，让调用方退回手动下载", async () => {
    await expect(
      launchMacSwap({
        workDir: path.join(tmp, "work"),
        pid: 0,
        version: "1.4.4",
        stagedApp: "/x/new.app",
        targetBundle: "/x/old.app",
        stageDir: "/x/stage",
        shell: path.join(tmp, "no-such-shell"),
      }),
    ).rejects.toThrow()
  })
})

describe("consumeSwapResult", () => {
  it("读出结果并删掉文件，只报一次", async () => {
    fs.writeFileSync(path.join(tmp, "apply-result.txt"), "failed\n无法移开旧版本（没有权限？）\n1.4.4\n")
    expect(await consumeSwapResult(tmp)).toEqual({ ok: false, detail: "无法移开旧版本（没有权限？）", version: "1.4.4" })
    expect(await consumeSwapResult(tmp)).toBeNull()
  })

  it("成功的结果", async () => {
    fs.writeFileSync(path.join(tmp, "apply-result.txt"), "ok\r\n已更新到 v1.4.4\r\n1.4.4\r\n")
    expect(await consumeSwapResult(tmp)).toEqual({ ok: true, detail: "已更新到 v1.4.4", version: "1.4.4" })
  })

  it("没有结果文件（没做过应用内更新）：null", async () => {
    expect(await consumeSwapResult(tmp)).toBeNull()
    expect(await consumeSwapResult(path.join(tmp, "不存在的目录"))).toBeNull()
  })
})

describe("cleanupMacUpdateLeftovers", () => {
  it("清掉暂存目录、不高于当前版本的 dmg 和空的挂载点；新版本的 dmg 和别的文件留着", async () => {
    const installDir = path.join(tmp, "Applications")
    const bundle = path.join(installDir, "LK Harness.app")
    fs.mkdirSync(path.join(bundle, "Contents"), { recursive: true })
    fs.mkdirSync(path.join(installDir, MAC_STAGE_DIRNAME, "previous"), { recursive: true })
    const workDir = path.join(tmp, "work")
    fs.mkdirSync(path.join(workDir, "mnt-empty"), { recursive: true })
    fs.mkdirSync(path.join(workDir, "mnt-busy"), { recursive: true })
    fs.writeFileSync(path.join(workDir, "mnt-busy", "still-mounted"), "x")
    for (const name of [
      "LK.Harness-1.4.3.dmg",
      "LK.Harness-1.4.4-arm64.dmg",
      "LK.Harness-1.4.4-arm64.dmg.part",
      "LK.Harness-1.4.5-arm64.dmg",
      "LK.Harness-1.4.5-arm64.dmg.part",
      "apply-update.sh",
      "apply-result.txt.log",
    ]) {
      fs.writeFileSync(path.join(workDir, name), "x")
    }

    const removed = await cleanupMacUpdateLeftovers({ workDir, currentVersion: "1.4.4", bundle })
    expect(removed.length).toBe(5)
    expect(fs.existsSync(path.join(installDir, MAC_STAGE_DIRNAME))).toBe(false)
    expect(fs.existsSync(bundle)).toBe(true)
    expect(fs.readdirSync(workDir).sort()).toEqual([
      "LK.Harness-1.4.5-arm64.dmg",
      "LK.Harness-1.4.5-arm64.dmg.part",
      "apply-result.txt.log",
      "apply-update.sh",
      "mnt-busy",
    ])
  })

  it("没有可清的东西、目录不存在、找不到应用：都不抛错", async () => {
    expect(await cleanupMacUpdateLeftovers({ workDir: path.join(tmp, "nope"), currentVersion: "1.4.4", bundle: null })).toEqual([])
    const workDir = path.join(tmp, "work")
    fs.mkdirSync(workDir)
    fs.writeFileSync(path.join(workDir, "LK.Harness-1.0.0.dmg"), "x")
    // 当前版本号不合法时不动 dmg
    await cleanupMacUpdateLeftovers({ workDir, currentVersion: "not-a-version", bundle: null })
    expect(fs.existsSync(path.join(workDir, "LK.Harness-1.0.0.dmg"))).toBe(true)
  })
})
