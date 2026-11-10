// ── 手机端文件预览：网关上的预览链接格式（电脑端网关和手机端共用）──────────────────
//
// 图片、音视频、网页的 src 带不了 Authorization 头，所以预览文件的内容走一个带令牌的链接：
//   /api/mobile/pv/<令牌>/<文件名>
// 令牌是打开预览时（那一步校验过会话权限和 Bearer 令牌）临时发的随机串，对应一个文件，有有效期，和电脑端界面用的 lkfile 令牌互相独立。
// html / md 的令牌覆盖所在目录，页面里的相对引用（样式、图片）会解析成同一个令牌下的子路径。

/** 预览链接的路径前缀 */
export const MOBILE_PREVIEW_ROUTE = "/api/mobile/pv";

/** 令牌多久没被用到就失效：够看完一份文档、听完一首歌；用一次续一次，所以看长视频不受影响 */
export const MOBILE_PREVIEW_TOKEN_TTL_MS = 30 * 60_000;

/** 预览链接（路径部分；手机端自己拼上网关地址）。文件名只是给浏览器和下载器看的，不参与寻址 */
export function mobilePreviewPath(token: string, name: string): string {
  return `${MOBILE_PREVIEW_ROUTE}/${token}/${encodeURIComponent(name)}`;
}

const TOKEN = /^[0-9a-f]{16,64}$/;

/**
 * 从请求路径里取出令牌和令牌之下的路径（未解码，原样交给令牌仓库去解码和防越界）。
 * 不是预览链接、令牌格式不对返回 undefined，这样乱七八糟的请求在进仓库之前就被挡掉。
 */
export function parseMobilePreviewPath(pathname: string): { token: string; rest: string } | undefined {
  const prefix = `${MOBILE_PREVIEW_ROUTE}/`;
  if (!pathname.startsWith(prefix)) return undefined;
  const tail = pathname.slice(prefix.length);
  const slash = tail.indexOf("/");
  const token = slash < 0 ? tail : tail.slice(0, slash);
  if (!TOKEN.test(token)) return undefined;
  return { token, rest: slash < 0 ? "/" : tail.slice(slash) };
}
