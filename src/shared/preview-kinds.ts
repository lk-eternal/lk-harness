// ── 应用内预览：文件类型判定（主进程、界面共用）──────────────────────────────

export type PreviewKind =
  | "text"
  | "code"
  | "markdown"
  | "html"
  | "csv"
  | "image"
  | "pdf"
  | "audio"
  | "video"
  | "docx"
  | "xlsx"
  | "archive"
  | "unsupported";

export interface PreviewType {
  kind: PreviewKind;
  /** highlight.js 的语言名，只有 code 有 */
  lang?: string;
}

/** 扩展名（不带点，小写）→ highlight.js 语言名 */
const CODE_LANGS: Record<string, string> = {
  js: "javascript", mjs: "javascript", cjs: "javascript", jsx: "javascript",
  ts: "typescript", mts: "typescript", cts: "typescript", tsx: "typescript",
  json: "json", jsonc: "json", json5: "json", jsonl: "json", ndjson: "json",
  yaml: "yaml", yml: "yaml",
  toml: "ini", ini: "ini", cfg: "ini", conf: "ini", properties: "ini", env: "ini",
  xml: "xml", xsd: "xml", xsl: "xml", xslt: "xml", plist: "xml", wsdl: "xml", vue: "xml", svelte: "xml",
  py: "python", pyw: "python",
  java: "java",
  kt: "kotlin", kts: "kotlin",
  go: "go",
  rs: "rust",
  c: "c", h: "c",
  cpp: "cpp", cc: "cpp", cxx: "cpp", hpp: "cpp", hh: "cpp", hxx: "cpp",
  cs: "csharp",
  php: "php",
  rb: "ruby",
  swift: "swift",
  sh: "bash", bash: "bash", zsh: "bash",
  ps1: "powershell", psm1: "powershell", psd1: "powershell",
  bat: "dos", cmd: "dos",
  sql: "sql",
  css: "css", scss: "scss", sass: "scss", less: "less",
  lua: "lua",
  dart: "dart",
  r: "r",
  pl: "perl", pm: "perl",
  scala: "scala",
  groovy: "groovy", gradle: "groovy",
  diff: "diff", patch: "diff",
  proto: "protobuf",
  graphql: "graphql", gql: "graphql",
  tf: "ini", hcl: "ini",
  dockerfile: "dockerfile",
  makefile: "makefile", mk: "makefile",
  nginx: "nginx",
};

/** 没有扩展名（或整个文件名就是约定名）的文件 */
const NAMED_FILES: Record<string, PreviewType> = {
  dockerfile: { kind: "code", lang: "dockerfile" },
  makefile: { kind: "code", lang: "makefile" },
  gemfile: { kind: "code", lang: "ruby" },
  rakefile: { kind: "code", lang: "ruby" },
  jenkinsfile: { kind: "code", lang: "groovy" },
  license: { kind: "text" },
  licence: { kind: "text" },
  readme: { kind: "text" },
  changelog: { kind: "text" },
  notice: { kind: "text" },
  authors: { kind: "text" },
  codeowners: { kind: "text" },
  ".gitignore": { kind: "text" },
  ".gitattributes": { kind: "text" },
  ".dockerignore": { kind: "text" },
  ".npmignore": { kind: "text" },
  ".editorconfig": { kind: "code", lang: "ini" },
  ".npmrc": { kind: "code", lang: "ini" },
  ".prettierrc": { kind: "code", lang: "json" },
  ".eslintrc": { kind: "code", lang: "json" },
  ".babelrc": { kind: "code", lang: "json" },
};

const TEXT_EXTS = new Set(["txt", "log", "text", "out", "err", "rst", "adoc", "org", "tex", "lst", "srt", "vtt", "lrc"]);
const MARKDOWN_EXTS = new Set(["md", "markdown", "mdx", "mdown"]);
const HTML_EXTS = new Set(["html", "htm", "xhtml"]);
const CSV_EXTS = new Set(["csv", "tsv"]);
const IMAGE_EXTS = new Set(["png", "jpg", "jpeg", "gif", "webp", "bmp", "svg", "ico", "avif"]);
const AUDIO_EXTS = new Set(["mp3", "wav", "ogg", "oga", "m4a", "aac", "flac", "opus", "weba"]);
const VIDEO_EXTS = new Set(["mp4", "m4v", "webm", "ogv", "mov", "mkv"]);
const DOCX_EXTS = new Set(["docx"]);
const XLSX_EXTS = new Set(["xlsx", "xlsm"]);
/** 只列文件清单：这些都是 zip 结构（jar/apk/whl/vsix 也是），不解压、不运行里面的东西 */
const ARCHIVE_EXTS = new Set(["zip", "jar", "war", "apk", "whl", "vsix"]);

/** 路径或文件名里的文件名部分（Windows 与 POSIX 分隔符都认） */
export function baseName(file: string): string {
  return file.split(/[\\/]/).filter(Boolean).pop() ?? file;
}

/** 小写扩展名，不带点；没有扩展名（含「.gitignore」这种只有点开头的名字）返回空串 */
export function fileExt(file: string): string {
  const name = baseName(file);
  const dot = name.lastIndexOf(".");
  return dot <= 0 ? "" : name.slice(dot + 1).toLowerCase();
}

/** 按文件名判断用什么方式预览；不认识的一律 unsupported（不当文本读，避免把二进制灌进界面） */
export function previewTypeOf(file: string): PreviewType {
  const name = baseName(file).toLowerCase();
  const named = NAMED_FILES[name];
  if (named) return named;
  if (name === ".env" || name.startsWith(".env.")) return { kind: "code", lang: "ini" };

  const ext = fileExt(name);
  if (!ext) return { kind: "unsupported" };
  if (MARKDOWN_EXTS.has(ext)) return { kind: "markdown" };
  if (HTML_EXTS.has(ext)) return { kind: "html" };
  if (CSV_EXTS.has(ext)) return { kind: "csv" };
  if (ext === "pdf") return { kind: "pdf" };
  if (IMAGE_EXTS.has(ext)) return { kind: "image" };
  if (AUDIO_EXTS.has(ext)) return { kind: "audio" };
  if (VIDEO_EXTS.has(ext)) return { kind: "video" };
  if (DOCX_EXTS.has(ext)) return { kind: "docx" };
  if (XLSX_EXTS.has(ext)) return { kind: "xlsx" };
  if (ARCHIVE_EXTS.has(ext)) return { kind: "archive" };
  const lang = CODE_LANGS[ext];
  if (lang) return { kind: "code", lang };
  if (TEXT_EXTS.has(ext)) return { kind: "text" };
  return { kind: "unsupported" };
}

/** 预览会用到的全部 highlight.js 语言名。界面里要都注册过才会高亮，测试靠它对账，免得加了扩展名却忘了注册语言 */
export function previewLanguages(): string[] {
  const langs = new Set(Object.values(CODE_LANGS));
  for (const t of Object.values(NAMED_FILES)) if (t.lang) langs.add(t.lang);
  return [...langs].sort();
}

export function isPreviewable(kind: PreviewKind): boolean {
  return kind !== "unsupported";
}

/** 内容要经主进程读成文本再显示的类型 */
export function isTextKind(kind: PreviewKind): boolean {
  return kind === "text" || kind === "code" || kind === "markdown" || kind === "html" || kind === "csv";
}

/** 内容要整个读进界面、在界面里解析的类型（Office 新格式） */
export function isDocumentKind(kind: PreviewKind): boolean {
  return kind === "docx" || kind === "xlsx";
}

/** 说明「为什么不能在应用内预览」，给不支持的文件的兜底页用；不认识的类型给通用说法 */
export function unsupportedReason(file: string): string {
  switch (fileExt(file)) {
    case "pptx": case "ppt": case "pps": case "ppsx": case "odp": case "key":
      return "演示文稿暂不支持在应用内预览";
    case "doc": case "dot": case "rtf": case "odt": case "pages": case "wps":
      return "这种文档格式暂不支持在应用内预览（.docx 可以）";
    case "xls": case "ods": case "numbers": case "et":
      return "这种表格格式暂不支持在应用内预览（.xlsx 可以）";
    case "7z": case "rar": case "tar": case "gz": case "tgz": case "bz2": case "xz":
      return "这种压缩格式暂不支持在应用内查看（.zip 可以）";
    case "exe": case "msi": case "dll": case "so": case "dylib": case "bin": case "dmg": case "iso":
      return "这是程序或二进制文件，不能预览";
    default:
      return "暂不支持在应用内预览这种文件";
  }
}

const MIME: Record<string, string> = {
  html: "text/html; charset=utf-8", htm: "text/html; charset=utf-8", xhtml: "application/xhtml+xml; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8", mjs: "text/javascript; charset=utf-8",
  json: "application/json; charset=utf-8", map: "application/json; charset=utf-8",
  txt: "text/plain; charset=utf-8", md: "text/markdown; charset=utf-8",
  csv: "text/csv; charset=utf-8", tsv: "text/tab-separated-values; charset=utf-8",
  xml: "application/xml; charset=utf-8",
  pdf: "application/pdf",
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  xlsm: "application/vnd.ms-excel.sheet.macroEnabled.12",
  zip: "application/zip", jar: "application/java-archive", war: "application/java-archive",
  apk: "application/vnd.android.package-archive", whl: "application/zip", vsix: "application/zip",
  png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg", gif: "image/gif", webp: "image/webp",
  bmp: "image/bmp", svg: "image/svg+xml", ico: "image/x-icon", avif: "image/avif",
  mp3: "audio/mpeg", wav: "audio/wav", ogg: "audio/ogg", oga: "audio/ogg", m4a: "audio/mp4",
  aac: "audio/aac", flac: "audio/flac", opus: "audio/ogg", weba: "audio/webm",
  mp4: "video/mp4", m4v: "video/mp4", webm: "video/webm", ogv: "video/ogg", mov: "video/quicktime", mkv: "video/x-matroska",
  woff: "font/woff", woff2: "font/woff2", ttf: "font/ttf", otf: "font/otf",
  wasm: "application/wasm",
};

/** 预览协议返回的 Content-Type；不认识的给 octet-stream（配合 nosniff 不让浏览器猜） */
export function previewMime(file: string): string {
  return MIME[fileExt(file)] ?? "application/octet-stream";
}

/**
 * 能不能交给系统默认程序打开。只放行文档/媒体/压缩包：
 * Agent 发来的文件不可信，脚本和可执行文件（.js 在 Windows 上默认由 WSH 执行）只给「所在位置」，防一键运行。
 */
const OPEN_WITH_DEFAULT_APP = new Set([
  "txt", "md", "log", "json", "csv", "tsv", "xml", "yaml", "yml", "sql",
  "pdf", "doc", "docx", "xls", "xlsx", "ppt", "pptx", "zip", "rtf", "odt", "ods", "odp",
  "png", "jpg", "jpeg", "gif", "webp", "bmp",
  "mp3", "wav", "ogg", "m4a", "aac", "flac", "opus",
  "mp4", "m4v", "webm", "mov", "mkv", "avi", "wmv",
]);

export function canOpenWithDefaultApp(file: string): boolean {
  return OPEN_WITH_DEFAULT_APP.has(fileExt(file));
}
