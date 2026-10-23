/**
 * 手机端 App（APK）的更新检查：电脑端与手机端共用的常量、版本比较和接口类型。
 *
 * 只做「提示 + 交给系统浏览器下载」。Android 不允许普通应用静默替换自己，
 * 所以这里不涉及安装；用户点一下下载、再点一下系统安装器即可。
 * 签名必须保持一致，否则系统安装器会拒绝覆盖安装（见 .github/workflows/mobile-apk.yml）。
 */

/** 指向最新发布的 APK，发布页始终有同名文件 */
export const MOBILE_APK_URL = "https://github.com/lk-eternal/lk-harness/releases/latest/download/lk-harness-mobile.apk"

/** 最新发布页，APK 下载失败时给用户手动去的地方 */
export const MOBILE_RELEASES_URL = "https://github.com/lk-eternal/lk-harness/releases/latest"

/** 电脑端 `/api/mobile/update-info` 的响应 */
export interface MobileUpdateInfo {
  ok: boolean
  /** 最新已发布版本，如 "1.1.3"；查询失败时没有 */
  latestVersion?: string
  apkUrl?: string
  releaseUrl?: string
  error?: string
}

interface ParsedVersion {
  nums: [number, number, number]
  /** 预发布标记（如 "beta.1"），没有则是正式版 */
  pre: string | null
}

/** 解析 `1.2.3` / `v1.2.3` / `1.2.3-beta.1+build`；缺的段按 0 补，解析不了返回 null */
export function parseVersion(raw: string): ParsedVersion | null {
  const m = /^v?(\d+)(?:\.(\d+))?(?:\.(\d+))?(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(raw.trim())
  if (!m) return null
  return {
    nums: [Number(m[1]), Number(m[2] ?? 0), Number(m[3] ?? 0)],
    pre: m[4] ?? null,
  }
}

/** a 比 b 新返回正数，旧返回负数，相同返回 0；任一边解析不了返回 null（调用方当作「不知道」处理） */
export function compareVersions(a: string, b: string): number | null {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (!pa || !pb) return null
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] > pb.nums[i] ? 1 : -1
  }
  // 同号时，正式版比预发布版新
  if (pa.pre === pb.pre) return 0
  if (pa.pre === null) return 1
  if (pb.pre === null) return -1
  return pa.pre > pb.pre ? 1 : -1
}

/** latest 严格新于 current 才算有更新；任何一边不是合法版本号都当没有，宁可漏提示也不误提示 */
export function isNewerVersion(latest: string, current: string): boolean {
  const c = compareVersions(latest, current)
  return c !== null && c > 0
}
