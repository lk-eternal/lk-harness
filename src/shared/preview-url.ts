// ── 内置浏览器：网址判定与地址栏输入规整（纯函数）─────────────────────────────

export function isHttpUrl(value: string | undefined | null): value is string {
  return !!value && /^https?:\/\/[^\s/?#]/i.test(value);
}

/** 本机或局域网地址：没写协议时按 http 打开（这类地址基本没有证书） */
function isLocalHost(host: string): boolean {
  const h = host.toLowerCase();
  return h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")
    || /^\d{1,3}(\.\d{1,3}){3}$/.test(h) || h.startsWith("[");
}

export type AddressResult = { ok: true; url: string } | { ok: false; error: string };

/**
 * 地址栏输入 → 要打开的网址。
 * - 带 http(s):// 的原样用；带别的协议（file:、javascript:、自定义协议）一律拒绝，内置浏览器只开网页
 * - 没写协议的：本机/内网地址补 http://，其它补 https://
 * - 不像网址的（没有点、不是 localhost）拒绝，不替用户猜成搜索
 */
export function normalizeAddressInput(input: string): AddressResult {
  const raw = input.trim();
  if (!raw) return { ok: false, error: "请输入网址" };
  if (/\s/.test(raw)) return { ok: false, error: "网址里不能有空格" };

  // host:port（localhost:3000）长得像「协议:」，先排除掉
  const hostPort = /^([^/?#:]+):(\d{1,5})(?:[/?#]|$)/.exec(raw);
  if (!hostPort && /^[a-z][a-z0-9+.-]*:/i.test(raw)) {
    return isHttpUrl(raw) ? { ok: true, url: raw } : { ok: false, error: "只支持打开 http / https 网址" };
  }
  if (raw.startsWith("//")) return { ok: false, error: "请输入完整的网址" };

  const host = (hostPort ? hostPort[1] : raw.split(/[/?#]/)[0]).split("@").pop() ?? "";
  if (!host) return { ok: false, error: "请输入网址" };
  if (!isLocalHost(host) && !/^[^.]+(\.[^.]+)+$/.test(host)) return { ok: false, error: "这看起来不是网址" };
  return { ok: true, url: `${isLocalHost(host) ? "http" : "https"}://${raw}` };
}

/** 标签页上没有标题时显示的名字：网址里的主机名 */
export function hostLabel(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "") || url;
  } catch {
    return url;
  }
}
