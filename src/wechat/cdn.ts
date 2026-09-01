import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { encryptAesEcb, decryptAesEcb, aesEcbPaddedSize, parseAesKey } from "./crypto.js";
import type { ILinkApi } from "./api.js";
import type { MessageItem, UploadResult, DownloadResult, UploadMediaType } from "./types.js";
import { MessageItemKind } from "./types.js";

const UPLOAD_MAX_RETRIES = 3;

const CDN_DOWNLOAD_PATH = "/download?encrypted_query_param=";
const CDN_UPLOAD_PATH = "/upload?encrypted_query_param=";

const EXT_TO_MIME: Record<string, string> = {
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
  ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
  ".mp4": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm",
  ".mkv": "video/x-matroska", ".avi": "video/x-msvideo",
  ".mp3": "audio/mpeg", ".ogg": "audio/ogg", ".wav": "audio/wav",
  ".pdf": "application/pdf", ".zip": "application/zip", ".txt": "text/plain",
  ".doc": "application/msword", ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".xls": "application/vnd.ms-excel", ".xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};

export function getMimeFromFilename(filename: string): string {
  return EXT_TO_MIME[path.extname(filename).toLowerCase()] ?? "application/octet-stream";
}

// ─── Download ───

function buildDownloadUrl(cdnBase: string, encryptedQueryParam: string): string {
  return `${cdnBase}${CDN_DOWNLOAD_PATH}${encodeURIComponent(encryptedQueryParam)}`;
}

async function fetchCdnBytes(url: string): Promise<Buffer> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`CDN download ${res.status}: ${await res.text().catch(() => "")}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function downloadAndDecrypt(encQP: string, aesKeyB64: string, cdnBase: string): Promise<Buffer> {
  const key = parseAesKey(aesKeyB64);
  return decryptAesEcb(await fetchCdnBytes(buildDownloadUrl(cdnBase, encQP)), key);
}

export async function downloadPlain(encQP: string, cdnBase: string): Promise<Buffer> {
  return fetchCdnBytes(buildDownloadUrl(cdnBase, encQP));
}

export async function downloadMediaFromItem(item: MessageItem, cdnBase: string): Promise<DownloadResult | null> {
  if (item.type === MessageItemKind.IMAGE) {
    const img = item.image_item;
    if (!img?.media?.encrypt_query_param) return null;
    const aesKeyB64 = img.aeskey
      ? Buffer.from(img.aeskey, "hex").toString("base64")
      : img.media.aes_key;
    return {
      data: aesKeyB64
        ? await downloadAndDecrypt(img.media.encrypt_query_param, aesKeyB64, cdnBase)
        : await downloadPlain(img.media.encrypt_query_param, cdnBase),
      kind: "image",
    };
  }
  if (item.type === MessageItemKind.VOICE) {
    const v = item.voice_item;
    if (!v?.media?.encrypt_query_param || !v.media.aes_key) return null;
    return { data: await downloadAndDecrypt(v.media.encrypt_query_param, v.media.aes_key, cdnBase), kind: "voice" };
  }
  if (item.type === MessageItemKind.FILE) {
    const f = item.file_item;
    if (!f?.media?.encrypt_query_param || !f.media.aes_key) return null;
    return { data: await downloadAndDecrypt(f.media.encrypt_query_param, f.media.aes_key, cdnBase), kind: "file", fileName: f.file_name ?? undefined };
  }
  if (item.type === MessageItemKind.VIDEO) {
    const v = item.video_item;
    if (!v?.media?.encrypt_query_param || !v.media.aes_key) return null;
    return { data: await downloadAndDecrypt(v.media.encrypt_query_param, v.media.aes_key, cdnBase), kind: "video" };
  }
  return null;
}

// ─── Upload ───

async function uploadBufferToCdn(buf: Buffer, uploadUrl: string, aeskey: Buffer): Promise<string> {
  const ciphertext = encryptAesEcb(buf, aeskey);
  let downloadParam: string | undefined;
  let lastError: unknown;
  for (let i = 1; i <= UPLOAD_MAX_RETRIES; i++) {
    try {
      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream" },
        body: new Uint8Array(ciphertext),
      });
      if (res.status >= 400 && res.status < 500) {
        throw new Error(`CDN upload client error ${res.status}: ${res.headers.get("x-error-message") ?? await res.text()}`);
      }
      if (res.status !== 200) throw new Error(`CDN upload ${res.status}: ${res.headers.get("x-error-message") ?? ""}`);
      downloadParam = res.headers.get("x-encrypted-param") ?? undefined;
      if (!downloadParam) throw new Error("CDN response missing x-encrypted-param header");
      break;
    } catch (err) {
      lastError = err;
      if (err instanceof Error && err.message.includes("client error")) throw err;
      if (i >= UPLOAD_MAX_RETRIES) break;
    }
  }
  if (!downloadParam) throw lastError instanceof Error ? lastError : new Error(`CDN upload failed after ${UPLOAD_MAX_RETRIES} attempts`);
  return downloadParam;
}

export async function uploadMedia(
  api: ILinkApi, filePath: string, toUserId: string,
  mediaType: typeof UploadMediaType[keyof typeof UploadMediaType],
): Promise<UploadResult> {
  const plaintext = await fs.readFile(filePath);
  const rawsize = plaintext.length;
  const rawfilemd5 = crypto.createHash("md5").update(plaintext).digest("hex");
  const filesize = aesEcbPaddedSize(rawsize);
  const filekey = crypto.randomBytes(16).toString("hex");
  const aeskey = crypto.randomBytes(16);

  const resp = await api.getUploadUrl({
    filekey, media_type: mediaType, to_user_id: toUserId,
    rawsize, rawfilemd5, filesize, no_need_thumb: true,
    aeskey: aeskey.toString("hex"),
  });

  // 兼容两种响应: upload_param (构造 URL) 和 upload_full_url (直接使用)
  let uploadUrl: string;
  if (resp.upload_full_url) {
    uploadUrl = resp.upload_full_url;
  } else if (resp.upload_param) {
    uploadUrl = `${api.cdnBaseUrl}${CDN_UPLOAD_PATH}${encodeURIComponent(resp.upload_param)}&filekey=${encodeURIComponent(filekey)}`;
  } else {
    throw new Error(`getUploadUrl returned no upload_param nor upload_full_url: ${JSON.stringify(resp)}`);
  }

  const downloadParam = await uploadBufferToCdn(plaintext, uploadUrl, aeskey);

  return {
    filekey,
    downloadEncryptedQueryParam: downloadParam,
    aeskey: aeskey.toString("hex"),
    fileSize: rawsize,
    fileSizeCiphertext: filesize,
  };
}
