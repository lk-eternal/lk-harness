// ── 应用内预览：打开本地文件的校验与文本读取（Node 侧，不依赖 electron，依赖项由调用方注入）──
//
// 界面不直接读文件。预览协议 lkfile:// 只认登记过的令牌；登记前要校验这个文件能给这个会话看：
//   1. 会话记录里出现过（Agent 发的文件卡、用户发的图片），或
//   2. 在会话的工作目录之内。
// Agent 的输出不可信，所以任意路径、工作目录之外又没发过的文件，界面要不到令牌。

import * as fs from "node:fs";
import * as path from "node:path";
import { baseName, previewTypeOf } from "./preview-kinds.js";
import { isPathInside, type PreviewFileStore } from "./preview-file-store.js";
import { decodePreviewText } from "./preview-text.js";
import { PREVIEW_MAX_TEXT_BYTES, type PreviewOpenResult, type PreviewTextResult } from "./preview-types.js";

export interface PreviewOpenDeps {
  /** 是不是应用内对话的会话（别的通道的会话不给预览） */
  isAppSession(sessionKey: string): boolean;
  /** 这个路径在会话记录里出现过没有（Agent 发的文件卡等） */
  isReferenced(sessionKey: string, file: string): Promise<boolean>;
  /** 会话的工作目录；没有就返回 undefined */
  workDir(sessionKey: string): string | undefined;
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

export function createPreviewOpener(
  store: PreviewFileStore,
  deps: PreviewOpenDeps,
): (sessionKey: string, file: string) => Promise<PreviewOpenResult> {
  return async (sessionKey, file) => {
    // 参数来自界面（进程间调用没有类型保证），先确认形状
    if (typeof sessionKey !== "string" || !deps.isAppSession(sessionKey)) return fail("不是应用内对话的会话");
    if (typeof file !== "string" || !path.isAbsolute(file)) return fail("文件路径无效");

    let real: string;
    let stat: fs.Stats;
    try {
      real = fs.realpathSync(file);
      stat = fs.statSync(real);
    } catch {
      return fail("文件不存在，可能已被移动或删除");
    }
    if (!stat.isFile()) return fail("不是文件");

    // 查记录失败（守护进程没起来等）按「没出现过」处理：只放行工作目录里的文件，不因此抛到界面
    const referenced = await deps.isReferenced(sessionKey, file).catch(() => false);
    if (!referenced) {
      const dir = deps.workDir(sessionKey);
      let inside = false;
      try {
        inside = !!dir && isPathInside(fs.realpathSync(dir), real);
      } catch { /* 工作目录不存在：当作不在里面 */ }
      if (!inside) return fail("这个文件不在会话记录里，也不在会话的工作目录内，不能预览");
    }

    const type = previewTypeOf(real);
    // html / md 常引用同目录的样式、脚本、图片，令牌要覆盖所在目录
    const token = store.register(real, { scopeDir: type.kind === "html" || type.kind === "markdown" });
    return {
      ok: true,
      token,
      url: store.urlFor(token),
      name: baseName(real),
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      kind: type.kind,
      ...(type.lang ? { lang: type.lang } : {}),
    };
  };
}

/** 按令牌读文件开头一段（最多 PREVIEW_MAX_TEXT_BYTES）解成文本 */
export async function readPreviewTextByToken(store: PreviewFileStore, token: string): Promise<PreviewTextResult> {
  const entry = typeof token === "string" ? store.lookup(token) : undefined;
  if (!entry) return fail("预览已失效，请重新打开");
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(entry.file, "r");
    const size = (await handle.stat()).size;
    const length = Math.min(size, PREVIEW_MAX_TEXT_BYTES);
    const buffer = Buffer.alloc(length);
    const { bytesRead } = await handle.read(buffer, 0, length, 0);
    const truncated = size > PREVIEW_MAX_TEXT_BYTES;
    const decoded = decodePreviewText(buffer.subarray(0, bytesRead), truncated);
    if (decoded.binary) return fail("这是二进制文件，无法按文本显示");
    return { ok: true, text: decoded.text, encoding: decoded.encoding, size, truncated };
  } catch {
    return fail("读取文件失败，可能已被移动或删除");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
