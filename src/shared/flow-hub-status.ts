/**
 * 「共享空间」配没配好：设置页「项目」里按钮要不要出现、点了能不能用都看这个。
 * 规则和主进程取凭据一致（flow-hub-service 的 loadFlowHubContext）：地址要填，Token 优先用共享空间自己的，
 * 没填就用「研发」里的 GitLab Token。纯逻辑，不依赖 node / react。
 */

export interface FlowHubConfigLike {
  flowHubUrl?: string | null
  flowHubToken?: string | null
  gitlabToken?: string | null
}

export interface FlowHubStatus {
  /** 填了共享空间地址（界面上才出现「共享空间」入口） */
  urlReady: boolean
  /** 地址和 Token 都有，可以用 */
  configured: boolean
}

const filled = (v: string | null | undefined): boolean => (v ?? "").trim().length > 0

export const NO_FLOW_HUB: FlowHubStatus = { urlReady: false, configured: false }

export function flowHubStatusOf(cfg: FlowHubConfigLike | null | undefined): FlowHubStatus {
  if (!cfg) return NO_FLOW_HUB
  const urlReady = filled(cfg.flowHubUrl)
  return { urlReady, configured: urlReady && (filled(cfg.flowHubToken) || filled(cfg.gitlabToken)) }
}

export function sameFlowHubStatus(a: FlowHubStatus, b: FlowHubStatus): boolean {
  return a.urlReady === b.urlReady && a.configured === b.configured
}

/** 没配好时弹窗里的说明：缺什么说什么，不让用户对着已经填好的那一项找问题 */
export function flowHubMissingMessage(status: FlowHubStatus): string {
  if (!status.urlReady) {
    return "还没填共享空间地址。请先在「项目设置 → 团队共享（高级）」里填好共享空间地址，再填共享空间 Token（或「研发」里的 GitLab Token）。"
  }
  return "共享空间地址已经填好了，还差 Token。请在「项目设置 → 团队共享（高级）」里填共享空间 Token，或者在「研发」里填 GitLab Token。"
}
