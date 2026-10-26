// ── 脱敏工具：诊断包等「要发给别人看」的内容在落盘前过一遍 ─────────────────
//
// 两道防线：
// 1. redactDeep：按**键名**递归遮配置/状态对象里的凭据。用「键名像凭据就遮」而不是「点名几个字段」，
//    这样以后新增 xxxToken / xxxSecret 字段默认就是安全的，不用记得回来改白名单。
// 2. redactText：按**模式**遮日志等自由文本（Authorization 头、key=value、URL 里的账号口令、常见令牌形状），
//    并把系统用户名从路径里抹掉。
//
// 这是尽力而为的启发式，不是保证：日志和队列快照里可能有消息片段，发给别人前仍应自己看一眼。

const MASK = "***"

/** 键名里出现这些词就当凭据（不含 session：sessionKey 是路由键，不是口令） */
const SECRET_WORDS =
  "secret|token|passw(?:or)?d|pwd|api[-_]?key|private[-_]?key|credential|authorization|cookie|ticket|signature|encrypt[-_]?key|access[-_]?key"

const SECRET_KEY_RE = new RegExp(SECRET_WORDS, "i")

/** 遮值时保留长度（能看出「设了」还是「没设」，以及大致是不是对的格式），不保留任何字符 */
export function maskSecretValue(v: string): string {
  return `${MASK}(len=${v.length})`
}

/**
 * 日志里的 key=value / "key":"value"（含被转义过的 \"key\":\"value\"）。
 * 键名前后各最多 40 个字符，限定回溯，避免遇到超长 base64 之类的内容时退化。
 * 值允许带 Bearer/Basic 前缀，这样 `Authorization: Bearer xxx` 一整段一起遮。
 */
const KV_RE = new RegExp(
  String.raw`((?:\\?["'])?[A-Za-z0-9_.-]{0,40}(?:${SECRET_WORDS})[A-Za-z0-9_.-]{0,40}(?:\\?["'])?\s*[:=]\s*)` +
    String.raw`(\\?["'])?((?:(?:Bearer|Basic)\s+)?[^\s"'\\,;&}\])]+)`,
  "gi",
)

/** 值本身不像凭据：短数字（用量计数）、布尔、空值、已遮的 */
function looksLikeNonSecret(v: string): boolean {
  return /^\d{1,9}$/.test(v) || /^(?:null|undefined|true|false|none)$/i.test(v) || v.startsWith(MASK)
}

/** 常见令牌的形状（不依赖键名，出现在任何位置都遮） */
const TOKEN_SHAPES: RegExp[] = [
  /\bsk-[A-Za-z0-9_-]{16,}/g, // OpenAI / Anthropic 风格
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  /\bglpat-[A-Za-z0-9_-]{16,}/g, // GitLab
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/g, // Slack
  /\b(?:crsr|key)_[A-Za-z0-9]{24,}/g, // Cursor 等
  /\b[tu]-[A-Za-z0-9_-]{28,}/g, // 飞书 tenant/user access token
  /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{5,}/g, // JWT
]

/** URL 里敏感的查询参数 */
const URL_SECRET_PARAM_RE = /([?&](?:access_token|token|ticket|key|api_?key|secret|sign|signature|code|password|pwd|auth)=)[^&\s"'\\]+/gi

/** scheme://user:pass@host 或 scheme://token@host */
const URL_USERINFO_RE = /(\b[a-z][a-z0-9+.-]*:\/\/)[^\/\s@"'\\]+@/gi

/** Windows 用户目录（C:\Users\x、C:\\Users\\x、C:/Users/x）与 unix 家目录，把用户名抹掉 */
const WIN_HOME_RE = /([A-Za-z]:(?:\\\\|\\|\/)Users(?:\\\\|\\|\/))[^\\\/\s"'<]+/g
const UNIX_HOME_RE = /(\/(?:Users|home)\/)[^\/\s"'<]+/g

const COOKIE_RE = /((?:set-)?cookie["']?\s*[:=]\s*)[^\r\n]+/gi

/** 对一段自由文本脱敏 */
export function redactText(text: string): string {
  if (!text) return text
  let out = text
  out = out.replace(COOKIE_RE, (_m, p1: string) => `${p1}${MASK}`)
  out = out.replace(URL_USERINFO_RE, `$1${MASK}@`)
  out = out.replace(URL_SECRET_PARAM_RE, `$1${MASK}`)
  out = out.replace(/\b(Bearer|Basic)\s+[A-Za-z0-9._~+\/=-]{8,}/g, `$1 ${MASK}`)
  out = out.replace(KV_RE, (m, prefix: string, quote: string | undefined, value: string) => {
    const bare = value.replace(/^(?:Bearer|Basic)\s+/i, "")
    if (looksLikeNonSecret(bare)) return m
    return `${prefix}${quote ?? ""}${MASK}`
  })
  for (const re of TOKEN_SHAPES) out = out.replace(re, MASK)
  out = out.replace(WIN_HOME_RE, "$1<user>")
  out = out.replace(UNIX_HOME_RE, "$1<user>")
  return out
}

/**
 * 递归脱敏对象：键名像凭据且值是非空字符串 → 遮成 `***(len=N)`；其余字符串过一遍 redactText
 * （处理 httpProxy 里的 user:pass@、路径里的用户名等）。空字符串保持原样，这样能看出「没配置」。
 * 返回新对象，不改入参。
 */
export function redactDeep<T>(value: T, depth = 0): T {
  if (depth > 12) return value
  if (typeof value === "string") return redactText(value) as unknown as T
  if (Array.isArray(value)) return value.map((v) => redactDeep(v, depth + 1)) as unknown as T
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (typeof v === "string" && v !== "" && SECRET_KEY_RE.test(k)) out[k] = maskSecretValue(v)
      else out[k] = redactDeep(v, depth + 1)
    }
    return out as T
  }
  return value
}

/**
 * 取日志尾部 N 行并脱敏。单行过长的（流式内容、base64）先截断：既控制文件体积，也避免正则在超长行上变慢。
 */
export function redactedTail(text: string, lines = 400, maxLineLength = 4000): string {
  const tail = text.split(/\r?\n/).slice(-lines)
  return tail
    .map((l) => (l.length > maxLineLength ? `${l.slice(0, maxLineLength)}…(截断 ${l.length - maxLineLength} 字符)` : l))
    .map(redactText)
    .join("\n")
}
