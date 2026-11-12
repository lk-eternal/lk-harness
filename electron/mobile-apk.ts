import * as fs from "node:fs"
import type * as http from "node:http"
import * as path from "node:path"
import { MOBILE_APK_PATH, MOBILE_APK_URL, MOBILE_RELEASES_URL, parseVersion, type MobileUpdateInfo } from "../src/shared/app-update.js"

/**
 * 安装包里内置的手机端 APK，由电脑端直接发给手机。
 *
 * 为什么不让手机去 GitHub 下：国内经常打不开，而手机既然要更新，说明它已经和电脑配过对、两边一定是通的。
 * 版本也以电脑为准（内置的 APK 和这个电脑端同一个版本号）：手机比电脑旧才需要更新，
 * 不再依赖「电脑能不能访问 GitHub」，更新信息是本地读出来的，瞬间返回。
 *
 * 目录里放两个文件（CI 在打桌面安装包前放进来，见 .github/workflows/build.yml）：
 * - lk-harness-mobile.apk
 * - mobile-apk.json  `{ "version": "1.3.0", "size": 3638272 }`，大小对不上说明文件不完整，当作没有
 * 开发时想试，把这两个文件放进仓库的 resources/mobile-apk/ 即可。
 */

export const MOBILE_APK_FILE = "lk-harness-mobile.apk"
export const MOBILE_APK_MANIFEST = "mobile-apk.json"

export interface BundledApk {
  version: string
  filePath: string
  size: number
}

function readBundledApk(dir: string): BundledApk | null {
  try {
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, MOBILE_APK_MANIFEST), "utf-8")) as {
      version?: unknown
      size?: unknown
    }
    const version = typeof manifest.version === "string" ? manifest.version.trim() : ""
    // 版本号会进到下载文件名里，只放行版本号该有的字符
    if (!version || !/^[0-9A-Za-z.+-]+$/.test(version) || !parseVersion(version)) return null
    const filePath = path.join(dir, MOBILE_APK_FILE)
    const stat = fs.statSync(filePath)
    if (!stat.isFile() || stat.size === 0) return null
    if (typeof manifest.size !== "number" || manifest.size !== stat.size) return null
    return { version, filePath, size: stat.size }
  } catch {
    return null
  }
}

/** 按顺序在候选目录里找第一个完整可用的内置 APK；都没有返回 null（开发环境、没带 APK 的构建） */
export function findBundledApk(dirs: readonly string[]): BundledApk | null {
  for (const dir of dirs) {
    const found = readBundledApk(dir)
    if (found) return found
  }
  return null
}

/** 内置 APK 对应的更新信息。不含 apkUrl：绝对地址要按手机的来路拼，见 withDesktopApkUrl */
export function bundledApkInfo(apk: BundledApk): MobileUpdateInfo {
  return {
    ok: true,
    latestVersion: apk.version,
    apkPath: MOBILE_APK_PATH,
    releaseUrl: MOBILE_RELEASES_URL,
    source: "desktop",
  }
}

export interface RequestOrigin {
  /** 请求头 Host：手机是用哪个地址连上电脑的 */
  host?: string
  /** 请求头 X-Forwarded-Proto：反向代理转进来时才有 */
  forwardedProto?: string
  /** 设置里填的公网地址 */
  publicUrl?: string
}

const HOST_PATTERN = /^(?:[a-z0-9._-]+|\[[0-9a-f:.]+\])(?::\d{1,5})?$/

/**
 * 按「手机是用哪个地址连上我的」拼出 APK 的绝对下载地址，给不会自己拼地址的旧版 App 用。
 * 协议：反向代理给了 X-Forwarded-Proto 就用它；Host 正好是设置里的公网地址就沿用公网地址的协议和路径前缀；其余按局域网直连的 http 算。
 * Host 不是合法的主机名（缺失或带怪字符）返回 null。
 */
export function apkUrlForRequest(origin: RequestOrigin): string | null {
  const host = (origin.host ?? "").trim().toLowerCase()
  if (!HOST_PATTERN.test(host)) return null

  let pub: URL | null = null
  try {
    if (origin.publicUrl) pub = new URL(origin.publicUrl)
  } catch {
    pub = null
  }
  const viaPublic = pub !== null && pub.host.toLowerCase() === host

  const forwarded = (origin.forwardedProto ?? "").split(",")[0].trim().toLowerCase()
  const proto =
    forwarded === "https" || forwarded === "http" ? forwarded : viaPublic && pub ? pub.protocol.replace(":", "") : "http"
  const prefix = viaPublic && pub ? pub.pathname.replace(/\/+$/, "") : ""
  return `${proto}://${host}${prefix}${MOBILE_APK_PATH}`
}

/** 从请求里取出拼下载地址要用的来路信息 */
export function requestOrigin(headers: http.IncomingHttpHeaders, publicUrl: string): RequestOrigin {
  const forwarded = headers["x-forwarded-proto"]
  return {
    host: headers.host,
    forwardedProto: Array.isArray(forwarded) ? forwarded[0] : forwarded,
    publicUrl,
  }
}

/**
 * 给更新信息补上绝对下载地址（只对内置 APK 的信息生效）。
 * 旧版 App（1.1.4 ~ 当前）只认 apkUrl，补上后它们不用升级就能从电脑下载；拼不出来时退回 GitHub 地址，至少和以前一样。
 */
export function withDesktopApkUrl(info: MobileUpdateInfo, origin: RequestOrigin): MobileUpdateInfo {
  if (info.source !== "desktop") return info
  return { ...info, apkUrl: apkUrlForRequest(origin) ?? MOBILE_APK_URL }
}

/** 电脑设置页二维码用的下载地址：局域网优先（快，不占公网通道），最后才是公网地址 */
export function apkDownloadUrls(lanUrls: readonly string[], publicUrl: string): string[] {
  return [...lanUrls, publicUrl]
    .map((u) => u.trim().replace(/\/+$/, ""))
    .filter(Boolean)
    .map((u) => `${u}${MOBILE_APK_PATH}`)
}

/**
 * 请求的是 APK 下载路径就处理掉并返回 true，否则返回 false 交给后面的路由。
 * 必须排在网页兜底（任何路径都回首页）之前，否则会把首页当安装包发出去。
 */
export function handleMobileApkRequest(
  getApk: () => BundledApk | null,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
): boolean {
  if ((req.method !== "GET" && req.method !== "HEAD") || pathname !== MOBILE_APK_PATH) return false
  serveBundledApk(getApk(), req, res)
  return true
}

/** 把内置 APK 发给请求方；没有内置 APK 时明说，不要落到网页的兜底页面上让人下到一个 HTML */
export function serveBundledApk(apk: BundledApk | null, req: http.IncomingMessage, res: http.ServerResponse): void {
  if (!apk) {
    res.writeHead(404, { "Content-Type": "text/plain; charset=utf-8" })
    res.end("这个版本的电脑端没有内置手机安装包")
    return
  }
  res.writeHead(200, {
    "Content-Type": "application/vnd.android.package-archive",
    "Content-Length": apk.size,
    "Content-Disposition": `attachment; filename="lk-harness-mobile-${apk.version}.apk"`,
    "Cache-Control": "no-cache",
    "Accept-Ranges": "none",
  })
  if (req.method === "HEAD") {
    res.end()
    return
  }
  const stream = fs.createReadStream(apk.filePath)
  stream.on("error", () => res.destroy())
  // 手机中途断开时别让文件句柄一直挂着
  res.on("close", () => stream.destroy())
  stream.pipe(res)
}
