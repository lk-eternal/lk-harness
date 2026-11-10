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
import {
  PREVIEW_CHECK_MAX_PATHS, PREVIEW_MAX_DOCUMENT_BYTES, PREVIEW_MAX_TEXT_BYTES, documentTooLargeMessage,
  type PreviewBytesResult, type PreviewOpenResult, type PreviewTextResult, type PreviewZipResult,
} from "./preview-types.js";
import { ZipFormatError, readZipListing } from "./preview-zip.js";

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

type Authorized = { ok: true; real: string; stat: fs.Stats } | { ok: false; error: string };

/** 校验这个会话能不能看这个文件（绝对路径）：存在、是普通文件、在工作目录之内或会话记录里出现过 */
function createAuthorizer(deps: PreviewOpenDeps): (sessionKey: string, file: string) => Promise<Authorized> {
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

    // 先看工作目录（不用查记录，便宜）；不在里面再查会话记录。
    // 查记录失败（守护进程没起来等）按「没出现过」处理：只放行工作目录里的文件，不因此抛到界面
    const dir = deps.workDir(sessionKey);
    let inside = false;
    try {
      inside = !!dir && isPathInside(fs.realpathSync(dir), real);
    } catch { /* 工作目录不存在：当作不在里面 */ }
    if (!inside && !(await deps.isReferenced(sessionKey, file).catch(() => false))) {
      return fail("这个文件不在会话记录里，也不在会话的工作目录内，不能预览");
    }
    return { ok: true, real, stat };
  };
}

/**
 * 批量检查对话里出现的路径能不能预览（界面据此决定哪些路径显示成可点击）。
 * 相对路径按会话的工作目录解析。返回和输入等长的数组：能预览的是绝对路径，不能的（不存在、没权限、不是文件）是 null——
 * 「不存在」和「没权限」不区分，界面没法借它探测文件系统。
 */
export function createPreviewChecker(deps: PreviewOpenDeps): (sessionKey: string, paths: string[]) => Promise<(string | null)[]> {
  const authorize = createAuthorizer(deps);
  return async (sessionKey, paths) => {
    if (!Array.isArray(paths)) return [];
    return Promise.all(paths.map(async (raw, i) => {
      if (i >= PREVIEW_CHECK_MAX_PATHS || typeof raw !== "string") return null;
      let file = raw;
      if (!path.isAbsolute(raw)) {
        const dir = typeof sessionKey === "string" ? deps.workDir(sessionKey) : undefined;
        if (!dir) return null;
        file = path.resolve(dir, raw);
      }
      file = path.normalize(file);
      // 会话是不是应用内会话、文件能不能看，都由 authorize 判断
      return (await authorize(sessionKey, file)).ok ? file : null;
    }));
  };
}

export function createPreviewOpener(
  store: PreviewFileStore,
  deps: PreviewOpenDeps,
): (sessionKey: string, file: string) => Promise<PreviewOpenResult> {
  const authorize = createAuthorizer(deps);
  return async (sessionKey, file) => {
    const checked = await authorize(sessionKey, file);
    if (!checked.ok) return checked;
    const { real, stat } = checked;

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

/** 按令牌读整个文件（docx / xlsx 要整个交给界面解析）；超过 maxBytes 不读，免得把界面线程拖死 */
export async function readPreviewBytesByToken(
  store: PreviewFileStore,
  token: string,
  maxBytes = PREVIEW_MAX_DOCUMENT_BYTES,
): Promise<PreviewBytesResult> {
  const entry = typeof token === "string" ? store.lookup(token) : undefined;
  if (!entry) return fail("预览已失效，请重新打开");
  try {
    const size = (await fs.promises.stat(entry.file)).size;
    if (size > maxBytes) {
      return fail(documentTooLargeMessage(size, maxBytes));
    }
    return { ok: true, bytes: new Uint8Array(await fs.promises.readFile(entry.file)) };
  } catch {
    return fail("读取文件失败，可能已被移动或删除");
  }
}

/** 按令牌列出压缩包里的文件清单：只读文件尾和中央目录，不解压 */
export async function listZipByToken(store: PreviewFileStore, token: string): Promise<PreviewZipResult> {
  const entry = typeof token === "string" ? store.lookup(token) : undefined;
  if (!entry) return fail("预览已失效，请重新打开");
  let handle: fs.promises.FileHandle | undefined;
  try {
    handle = await fs.promises.open(entry.file, "r");
    const size = (await handle.stat()).size;
    const opened = handle;
    const listing = await readZipListing(async (offset, length) => {
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await opened.read(buffer, 0, length, offset);
      return buffer.subarray(0, bytesRead);
    }, size);
    return { ok: true, size, ...listing };
  } catch (e) {
    if (e instanceof ZipFormatError) return fail(e.message);
    return fail("读取文件失败，可能已被移动或删除");
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
