import crypto from "node:crypto";
import type {
  GetUpdatesResp, GetUploadUrlResp, GetConfigResp,
  QRCodeResp, QRCodeStatusResp, TypingStatus,
} from "./types.js";
import { proxyAwareFetch } from "./proxy.js";

const DEFAULT_API_TIMEOUT = 15_000;
const DEFAULT_LONG_POLL_TIMEOUT = 35_000;
const DEFAULT_CONFIG_TIMEOUT = 10_000;
const QR_LONG_POLL_TIMEOUT = 35_000;

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), "utf-8").toString("base64");
}

export class ILinkApi {
  baseUrl: string;
  cdnBaseUrl: string;
  private token: string | undefined;
  private channelVersion: string;
  private routeTag?: string;

  constructor(opts: { baseUrl?: string; cdnBaseUrl?: string; token?: string; channelVersion?: string; routeTag?: string } = {}) {
    this.baseUrl = opts.baseUrl ?? "https://ilinkai.weixin.qq.com";
    this.cdnBaseUrl = opts.cdnBaseUrl ?? "https://novac2c.cdn.weixin.qq.com/c2c";
    this.token = opts.token;
    this.channelVersion = opts.channelVersion ?? "standalone-0.1.0";
    this.routeTag = opts.routeTag;
  }

  setToken(token: string): void { this.token = token; }
  getToken(): string | undefined { return this.token; }

  private baseInfo() { return { channel_version: this.channelVersion }; }

  private headers(bodyStr: string): Record<string, string> {
    const h: Record<string, string> = {
      "Content-Type": "application/json",
      "AuthorizationType": "ilink_bot_token",
      "Content-Length": String(Buffer.byteLength(bodyStr, "utf-8")),
      "X-WECHAT-UIN": randomWechatUin(),
    };
    if (this.token?.trim()) h["Authorization"] = `Bearer ${this.token.trim()}`;
    if (this.routeTag) h["SKRouteTag"] = this.routeTag;
    return h;
  }

  private async post<T>(endpoint: string, body: Record<string, unknown>, timeoutMs: number): Promise<T> {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL(endpoint, base);
    const bodyStr = JSON.stringify(body);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await proxyAwareFetch(url.toString(), { method: "POST", headers: this.headers(bodyStr), body: bodyStr, signal: ctrl.signal });
      clearTimeout(timer);
      const raw = await res.text();
      if (!res.ok) throw new Error(`API ${endpoint} ${res.status}: ${raw}`);
      return JSON.parse(raw) as T;
    } catch (err) {
      clearTimeout(timer);
      throw err;
    }
  }

  async getUpdates(buf: string, timeoutMs?: number): Promise<GetUpdatesResp> {
    const timeout = timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT;
    try {
      return await this.post<GetUpdatesResp>("ilink/bot/getupdates", { get_updates_buf: buf, base_info: this.baseInfo() }, timeout);
    } catch (err) {
      if (err instanceof Error && err.name === "AbortError") {
        return { ret: 0, msgs: [], get_updates_buf: buf };
      }
      throw err;
    }
  }

  async sendMessage(req: Record<string, unknown>): Promise<void> {
    await this.post<unknown>("ilink/bot/sendmessage", { ...req, base_info: this.baseInfo() }, DEFAULT_API_TIMEOUT);
  }

  async getUploadUrl(req: Record<string, unknown>): Promise<GetUploadUrlResp> {
    return this.post<GetUploadUrlResp>("ilink/bot/getuploadurl", { ...req, base_info: this.baseInfo() }, DEFAULT_API_TIMEOUT);
  }

  async getConfig(userId: string, contextToken: string): Promise<GetConfigResp> {
    return this.post<GetConfigResp>("ilink/bot/getconfig", { ilink_user_id: userId, context_token: contextToken, base_info: this.baseInfo() }, DEFAULT_CONFIG_TIMEOUT);
  }

  async sendTyping(req: { ilink_user_id: string; typing_ticket: string; status: typeof TypingStatus[keyof typeof TypingStatus] }): Promise<void> {
    await this.post<unknown>("ilink/bot/sendtyping", { ...req, base_info: this.baseInfo() }, DEFAULT_CONFIG_TIMEOUT);
  }

  async getQRCode(botType = "3"): Promise<QRCodeResp> {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
    const headers: Record<string, string> = {};
    if (this.routeTag) headers["SKRouteTag"] = this.routeTag;
    const res = await proxyAwareFetch(url.toString(), { headers });
    if (!res.ok) throw new Error(`getQRCode ${res.status}: ${await res.text().catch(() => "")}`);
    return (await res.json()) as QRCodeResp;
  }

  async pollQRCodeStatus(qrcode: string): Promise<QRCodeStatusResp> {
    const base = this.baseUrl.endsWith("/") ? this.baseUrl : `${this.baseUrl}/`;
    const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
    const headers: Record<string, string> = { "iLink-App-ClientVersion": "1" };
    if (this.routeTag) headers["SKRouteTag"] = this.routeTag;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), QR_LONG_POLL_TIMEOUT);
    try {
      const res = await proxyAwareFetch(url.toString(), { headers, signal: ctrl.signal });
      clearTimeout(timer);
      if (!res.ok) throw new Error(`pollQRCodeStatus ${res.status}: ${await res.text().catch(() => "")}`);
      return (await res.json()) as QRCodeStatusResp;
    } catch (err) {
      clearTimeout(timer);
      if (err instanceof Error && err.name === "AbortError") return { status: "wait" };
      throw err;
    }
  }
}
