// ── 应用内预览：打开本地文件和文件夹的校验、文件夹列表与文本读取（Node 侧，不依赖 electron，依赖项由调用方注入）──
//
// 界面不直接读文件。预览协议 lkfile:// 只认登记过的令牌；登记前要校验这个文件能给这个会话看。
// 「能看哪些路径」是调用方的决定（PreviewOpenDeps.canView）：电脑端的使用者对本机有完整权限，不限制；
// 手机端经网关远程访问，用 createScopedViewPolicy 限定在会话的工作目录和会话记录里出现过的文件。

import * as fs from "node:fs";
import * as path from "node:path";
import { baseName, previewTypeOf } from "./preview-kinds.js";
import { isPathInside, type PreviewFileStore } from "./preview-file-store.js";
import { decodePreviewText } from "./preview-text.js";
import {
  PREVIEW_CHECK_MAX_PATHS, PREVIEW_DIR_MAX_ENTRIES, PREVIEW_MAX_DOCUMENT_BYTES, PREVIEW_MAX_TEXT_BYTES, documentTooLargeMessage,
  type PreviewBytesResult, type PreviewDirEntry, type PreviewDirResult, type PreviewOpenResult, type PreviewPathCheck,
  type PreviewTextResult, type PreviewZipResult,
} from "./preview-types.js";
import { ZipFormatError, readZipListing } from "./preview-zip.js";

export interface PreviewOpenDeps {
  /** 是不是应用内对话的会话（别的通道的会话不给预览） */
  isAppSession(sessionKey: string): boolean;
  /** 会话的工作目录（相对路径按它解析）；没有就返回 undefined */
  workDir(sessionKey: string): string | undefined;
  /** 这个会话能不能看这个路径：file 是调用方给的原路径，real 是解开符号链接之后的真实路径 */
  canView(sessionKey: string, target: { file: string; real: string }): Promise<boolean>;
}

/** 手机端的可见范围：路径在会话的工作目录之内，或者在会话记录里出现过（Agent 发的文件卡、用户发的图片） */
export function createScopedViewPolicy(deps: {
  workDir(sessionKey: string): string | undefined;
  /** 这个路径在会话记录里出现过没有 */
  isReferenced(sessionKey: string, file: string): Promise<boolean>;
}): PreviewOpenDeps["canView"] {
  return async (sessionKey, { file, real }) => {
    // 先看工作目录（不用查记录，便宜）；不在里面再查会话记录。
    // 查记录失败（守护进程没起来等）按「没出现过」处理：只放行工作目录里的，不因此抛到界面
    const dir = deps.workDir(sessionKey);
    let inside = false;
    try {
      inside = !!dir && isPathInside(fs.realpathSync(dir), real);
    } catch { /* 工作目录不存在：当作不在里面 */ }
    if (inside) return true;
    return deps.isReferenced(sessionKey, file).catch(() => false);
  };
}

function fail(error: string): { ok: false; error: string } {
  return { ok: false, error };
}

type Authorized = { ok: true; real: string; stat: fs.Stats } | { ok: false; error: string };

/** 校验这个会话能不能看这个路径（绝对路径）：是应用内会话、存在、是文件或文件夹、在可见范围之内 */
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
    if (!stat.isFile() && !stat.isDirectory()) return fail("不是文件或文件夹");
    if (!(await deps.canView(sessionKey, { file, real }))) return fail("不在这个会话可预览的范围内，不能预览");
    return { ok: true, real, stat };
  };
}

/**
 * 批量检查对话里出现的路径能不能预览（界面据此决定哪些路径显示成可点击）。
 * 相对路径按会话的工作目录解析。返回和输入等长的数组：能预览的是绝对路径加「是文件还是文件夹」，
 * 不能的（不存在、没权限）是 null——「不存在」和「没权限」不区分，界面没法借它探测文件系统。
 */
export function createPreviewChecker(deps: PreviewOpenDeps): (sessionKey: string, paths: string[]) => Promise<(PreviewPathCheck | null)[]> {
  const authorize = createAuthorizer(deps);
  return async (sessionKey, paths) => {
    if (!Array.isArray(paths)) return [];
    return Promise.all(paths.map(async (raw, i) => {
      // 空串按工作目录解析会指向工作目录本身（现在文件夹也能预览），它不指向任何东西，不能放行
      if (i >= PREVIEW_CHECK_MAX_PATHS || typeof raw !== "string" || raw === "") return null;
      let file = raw;
      if (!path.isAbsolute(raw)) {
        const dir = typeof sessionKey === "string" ? deps.workDir(sessionKey) : undefined;
        if (!dir) return null;
        file = path.resolve(dir, raw);
      }
      file = path.normalize(file);
      // 会话是不是应用内会话、路径能不能看，都由 authorize 判断
      const checked = await authorize(sessionKey, file);
      if (!checked.ok) return null;
      // 文件夹去掉结尾的分隔符（「docs/」和「docs」是同一个标签页）
      return checked.stat.isDirectory() ? { path: path.resolve(file), isDir: true } : { path: file, isDir: false };
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
    if (!stat.isFile()) return fail("不是文件");

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

interface DirItem {
  name: string;
  isDir: boolean;
  stat?: fs.Stats;
}

/** 断开的链接、刚被删掉的文件 stat 不出来：返回 undefined，列表里照样显示这一项 */
async function statOrUndefined(file: string): Promise<fs.Stats | undefined> {
  try {
    return await fs.promises.stat(file);
  } catch {
    return undefined;
  }
}

const NAME_ORDER = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });

/** 文件夹排在文件前面，各自按名字排（file2 排在 file10 前面） */
function compareDirItems(a: DirItem, b: DirItem): number {
  if (a.isDir !== b.isDir) return a.isDir ? -1 : 1;
  return NAME_ORDER.compare(a.name, b.name);
}

/**
 * 列出一个文件夹里的内容（只一层，不递归）。超过 PREVIEW_DIR_MAX_ENTRIES 项只返回排在前面的部分。
 * 条目的路径接在调用方给的路径后面（不解开符号链接）：界面凭它进入子文件夹、打开文件，每次打开都会重新校验。
 */
export function createPreviewDirLister(deps: PreviewOpenDeps): (sessionKey: string, dir: string) => Promise<PreviewDirResult> {
  const authorize = createAuthorizer(deps);
  return async (sessionKey, dir) => {
    const checked = await authorize(sessionKey, dir);
    if (!checked.ok) return checked;
    if (!checked.stat.isDirectory()) return fail("不是文件夹");

    let dirents: fs.Dirent[];
    try {
      dirents = await fs.promises.readdir(checked.real, { withFileTypes: true });
    } catch {
      return fail("读取文件夹失败，可能没有权限，或已被移动、删除");
    }
    // 符号链接本身的类型不是它指向的类型，要 stat 一次才知道是文件还是文件夹
    const items = await Promise.all(dirents.map(async (d): Promise<DirItem> => {
      if (!d.isSymbolicLink()) return { name: d.name, isDir: d.isDirectory() };
      const stat = await statOrUndefined(path.join(checked.real, d.name));
      return { name: d.name, isDir: stat?.isDirectory() ?? false, stat };
    }));
    items.sort(compareDirItems);

    const base = path.resolve(dir);
    const entries = await Promise.all(items.slice(0, PREVIEW_DIR_MAX_ENTRIES).map(async (item): Promise<PreviewDirEntry> => {
      const stat = item.stat ?? await statOrUndefined(path.join(checked.real, item.name));
      return {
        name: item.name,
        path: path.join(base, item.name),
        isDir: item.isDir,
        size: item.isDir ? 0 : stat?.size ?? 0,
        mtimeMs: stat?.mtimeMs ?? 0,
      };
    }));
    return { ok: true, path: base, entries, total: items.length };
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
