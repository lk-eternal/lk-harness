// ── 手机端文件预览：网关上预览链接的 HTTP 响应（Node 侧，不依赖 electron，方便真起 HTTP 服务测试）──────

import type * as http from "node:http";
import { parseMobilePreviewPath } from "./mobile-preview.js";
import type { PreviewFileStore } from "./preview-file-store.js";

type Serve = PreviewFileStore["serve"];

/**
 * 响应一次预览链接请求（GET / HEAD）。不是预览链接返回 false，调用方接着走别的路由。
 * decorate 在确定要响应时调用（加 CORS 头之类，网关各接口共用的那部分）。
 *
 * 内容由令牌仓库的 serve 给：支持 Range（拖动播放进度）、不让路径走出令牌覆盖的目录。
 * 额外加 `Content-Security-Policy: sandbox allow-scripts`：这些内容来自 Agent 写的文件，和网关同源，
 * 万一被当成页面直接打开，脚本也只能跑在不透明的源里，碰不到网关页面的存储（手机端的访问令牌就存在那里）。
 */
export function handleMobilePreviewRequest(
  serve: Serve,
  req: http.IncomingMessage,
  res: http.ServerResponse,
  pathname: string,
  decorate: (res: http.ServerResponse) => void = () => undefined,
): boolean {
  const parsed = parseMobilePreviewPath(pathname);
  if (!parsed || (req.method !== "GET" && req.method !== "HEAD")) return false;

  const range = req.headers.range;
  const result = serve(parsed.token, parsed.rest, { range: typeof range === "string" ? range : null, method: req.method });
  decorate(res);
  res.writeHead(result.status, { ...result.headers, "Content-Security-Policy": "sandbox allow-scripts" });
  const body = result.body;
  if (!body) {
    res.end();
    return true;
  }
  body.on("error", () => res.destroy());
  // 手机切走、拖动进度条会提前断开连接：别让文件流一直开着
  res.on("close", () => body.destroy());
  body.pipe(res);
  return true;
}
