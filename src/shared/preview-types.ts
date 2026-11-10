// ── 应用内预览：主进程 ↔ 界面的载荷类型 ───────────────────────────────────────

import type { PreviewKind } from "./preview-kinds.js";
import type { PreviewEncoding } from "./preview-text.js";

/** 打开本地文件预览的结果：文件校验通过后登记了令牌，界面凭 url 加载、凭 token 读文本 */
export type PreviewOpenResult =
  | {
      ok: true;
      token: string;
      /** lkfile://<令牌>/<文件名>，图片、PDF、音视频、HTML 直接拿它当 src */
      url: string;
      name: string;
      size: number;
      mtimeMs: number;
      kind: PreviewKind;
      lang?: string;
    }
  | { ok: false; error: string };

export type PreviewFileInfo = Extract<PreviewOpenResult, { ok: true }>;

export type PreviewTextResult =
  | { ok: true; text: string; encoding: PreviewEncoding; size: number; truncated: boolean }
  | { ok: false; error: string };

/** 内置浏览器一个标签页当前的状态，主进程在变化时推给界面 */
export interface PreviewWebState {
  tabId: string;
  url: string;
  title: string;
  loading: boolean;
  canGoBack: boolean;
  canGoForward: boolean;
  /** 加载失败的原因；没失败为空 */
  error?: string;
  favicon?: string;
}

/** 网页里要求新开窗口（target=_blank、window.open）：界面开成新标签页 */
export interface PreviewWebOpenTab {
  fromTabId: string;
  url: string;
}

export type PreviewWebNav = "back" | "forward" | "reload" | "stop";

/** 内置浏览器视图在窗口里的位置（CSS 像素，相对窗口内容区左上角） */
export interface PreviewRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export const PREVIEW_MAX_TEXT_BYTES = 2 * 1024 * 1024;
