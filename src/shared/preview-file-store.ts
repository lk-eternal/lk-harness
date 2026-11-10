// ── 应用内预览：本地文件的「令牌 → 文件」仓库与分段读取（Node 侧，不依赖 electron）──
//
// 界面不直接拿文件路径去读：主进程先校验这个文件能不能给这个会话看，通过后登记成一个随机令牌，
// 界面拿到的是 lkfile://<令牌>/<文件名>。预览协议只认登记过的令牌，所以界面（以及界面里渲染的任何内容）
// 读不到没登记过的文件。令牌只在本次运行里有效，登记数有上限，最旧的先被淘汰。

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Readable } from "node:stream";
import { baseName, previewMime } from "./preview-kinds.js";
import { parseByteRange } from "./preview-range.js";

export interface PreviewFileEntry {
  token: string;
  /** 真实路径（已解开符号链接） */
  file: string;
  /** 为真时令牌覆盖这个文件所在目录：html / md 里引用的同目录样式、脚本、图片要能一起加载 */
  scopeDir: boolean;
}

export interface ServeResult {
  status: number;
  headers: Record<string, string>;
  /** HEAD 请求和错误响应没有 body */
  body?: Readable;
}

/** child 在 parent 之内（含 parent 本身）。Windows 上不区分大小写，跨盘符不算 */
export function isPathInside(parent: string, child: string): boolean {
  const rel = path.relative(parent, child);
  if (rel === "") return true;
  return rel !== ".." && !rel.startsWith(".." + path.sep) && !path.isAbsolute(rel);
}

export interface PreviewFileStore {
  /** 登记一个文件（必须是 realpath 之后的普通文件），返回令牌；同一文件重复登记得到同一个令牌 */
  register(realFile: string, opts?: { scopeDir?: boolean }): string;
  lookup(token: string): PreviewFileEntry | undefined;
  /** 令牌对应的 URL：lkfile://<令牌>/<文件名> */
  urlFor(token: string): string;
  /** 响应一次预览协议请求。relPath 是 URL 的 pathname（以 / 开头，未解码） */
  serve(token: string, relPath: string, opts?: { range?: string | null; method?: string }): ServeResult;
}

export const PREVIEW_SCHEME = "lkfile";

function error(status: number): ServeResult {
  return { status, headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" } };
}

export function createPreviewFileStore(maxEntries = 300): PreviewFileStore {
  const byToken = new Map<string, PreviewFileEntry>();
  const byKey = new Map<string, string>();
  const keyOf = (file: string, scopeDir: boolean) => `${scopeDir ? "dir" : "file"}|${file}`;

  /** 令牌指向的真实文件：目录令牌按请求路径找，且不能走出目录 */
  const resolveTarget = (entry: PreviewFileEntry, relPath: string): string | number => {
    if (!entry.scopeDir) return entry.file;
    let rel: string;
    try {
      rel = decodeURIComponent(relPath);
    } catch {
      return 400;
    }
    if (rel.includes("\0")) return 400;
    rel = rel.replace(/^[\\/]+/, "");
    const root = path.dirname(entry.file);
    if (rel === "" || rel === path.basename(entry.file)) return entry.file;
    let real: string;
    try {
      real = fs.realpathSync(path.resolve(root, rel));
    } catch {
      return 404;
    }
    return isPathInside(root, real) ? real : 403;
  };

  return {
    register(realFile, opts) {
      const scopeDir = opts?.scopeDir === true;
      const key = keyOf(realFile, scopeDir);
      const existing = byKey.get(key);
      if (existing) {
        // 重新放到最新：淘汰按最近使用算
        const entry = byToken.get(existing)!;
        byToken.delete(existing);
        byToken.set(existing, entry);
        return existing;
      }
      const token = crypto.randomBytes(12).toString("hex");
      byToken.set(token, { token, file: realFile, scopeDir });
      byKey.set(key, token);
      while (byToken.size > maxEntries) {
        const oldest = byToken.keys().next().value as string;
        const gone = byToken.get(oldest)!;
        byToken.delete(oldest);
        byKey.delete(keyOf(gone.file, gone.scopeDir));
      }
      return token;
    },

    lookup: (token) => byToken.get(token),

    urlFor(token) {
      const entry = byToken.get(token);
      return `${PREVIEW_SCHEME}://${token}/${encodeURIComponent(entry ? baseName(entry.file) : "file")}`;
    },

    serve(token, relPath, opts) {
      const entry = byToken.get(token);
      if (!entry) return error(403);
      const target = resolveTarget(entry, relPath);
      if (typeof target === "number") return error(target);

      let size: number;
      try {
        const stat = fs.statSync(target);
        if (!stat.isFile()) return error(404);
        size = stat.size;
      } catch {
        return error(404);
      }

      const headers: Record<string, string> = {
        "content-type": previewMime(target),
        "accept-ranges": "bytes",
        "cache-control": "no-store",
        "x-content-type-options": "nosniff",
      };
      const range = parseByteRange(opts?.range, size);
      if (range === "unsatisfiable") {
        return { status: 416, headers: { ...headers, "content-range": `bytes */${size}` } };
      }
      const start = range ? range.start : 0;
      const end = range ? range.end : size - 1;
      headers["content-length"] = String(size === 0 ? 0 : end - start + 1);
      if (range) headers["content-range"] = `bytes ${start}-${end}/${size}`;
      const status = range ? 206 : 200;

      if (opts?.method === "HEAD" || size === 0) return { status, headers };
      return { status, headers, body: fs.createReadStream(target, { start, end }) };
    },
  };
}
