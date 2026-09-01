import * as fs from "node:fs";
import * as path from "node:path";

export class JsonReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "JsonReadError";
  }
}

export function atomicWriteUtf8(file: string, data: string): void {
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tmp = path.join(dir, `${path.basename(file)}.tmp-${process.pid}-${Date.now()}`);
  fs.writeFileSync(tmp, data, "utf-8");
  fs.renameSync(tmp, file);
}

/** 文件缺失返回 fallback；损坏备份后抛 JsonReadError */
export function readJsonFile<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback;
  try {
    return JSON.parse(fs.readFileSync(file, "utf-8")) as T;
  } catch (e) {
    try {
      fs.copyFileSync(file, `${file}.corrupt-${Date.now()}`);
    } catch { /* ignore */ }
    const detail = e instanceof Error ? e.message : String(e);
    throw new JsonReadError(`JSON 损坏: ${file} (${detail})`);
  }
}

export function writeJsonFile(file: string, data: unknown): void {
  atomicWriteUtf8(file, JSON.stringify(data, null, 2));
}

export function writeJsonAtomic(file: string, data: unknown): void {
  writeJsonFile(file, data);
}

export function writeTextAtomic(file: string, data: string): void {
  atomicWriteUtf8(file, data);
}
