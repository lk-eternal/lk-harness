import { randomUUID } from "node:crypto"
import type {
  FlowHubGroupBody,
  FlowHubGroupEnvelope,
  FlowHubNodeEnvelope,
  FlowHubNodePayload,
} from "./flow-hub-types.js"
import { computeGroupContentHash, computeNodeContentHash } from "./flow-hub-hash.js"
import { parseNodeGroupExport } from "./project-store.js"
import type { ProjectNodeDef, ProjectNodeGroupDef } from "./project-types.js"

export function ensureHubId<T extends { hubId?: string }>(item: T): T & { hubId: string } {
  return { ...item, hubId: item.hubId?.trim() || randomUUID() }
}

export function buildGroupEnvelope(opts: {
  group: FlowHubGroupBody
  hubId: string
  hubRevision: number
  author: string
  updatedAt?: string
}): FlowHubGroupEnvelope {
  const updatedAt = opts.updatedAt ?? new Date().toISOString()
  const group: FlowHubGroupBody = {
    ...opts.group,
    nodes: opts.group.nodes.map((n) => ({
      ...n,
      id: n.id.trim(),
      label: n.label.trim(),
      ...(n.prompt?.trim() ? { prompt: n.prompt.trim() } : {}),
    })),
  }
  const contentHash = computeGroupContentHash(group)
  return {
    kind: "lk-harness-node-group",
    version: 2,
    hubId: opts.hubId,
    hubRevision: opts.hubRevision,
    author: opts.author.trim(),
    updatedAt,
    contentHash,
    group,
  }
}

export function buildNodeEnvelope(opts: {
  node: FlowHubNodePayload
  hubId: string
  hubRevision: number
  author: string
  updatedAt?: string
}): FlowHubNodeEnvelope {
  const updatedAt = opts.updatedAt ?? new Date().toISOString()
  const node: FlowHubNodePayload = {
    ...opts.node,
    id: opts.node.id.trim(),
    label: opts.node.label.trim(),
    ...(opts.node.prompt?.trim() ? { prompt: opts.node.prompt.trim() } : {}),
  }
  return {
    kind: "lk-harness-flow-node",
    version: 1,
    hubId: opts.hubId,
    hubRevision: opts.hubRevision,
    author: opts.author.trim(),
    updatedAt,
    contentHash: computeNodeContentHash(node),
    node,
  }
}

export function parseGroupEnvelope(raw: unknown): FlowHubGroupEnvelope | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as Record<string, unknown>
  let candidate: unknown
  if (obj.kind === "lk-harness-node-group" && obj.group && typeof obj.group === "object") {
    candidate = obj
  } else {
    const legacy = parseNodeGroupExport(raw)
    if (!legacy) return null
    return legacyGroupToEnvelope(legacy)
  }
  const env = candidate as FlowHubGroupEnvelope
  if (!env.group?.name?.trim() || !Array.isArray(env.group.nodes)) return null
  const hubId = (env.hubId ?? "").trim() || randomUUID()
  const group: FlowHubGroupBody = {
    id: (env.group.id ?? "").trim() || "import",
    name: env.group.name.trim(),
    ...(env.group.workspace === "plain" || env.group.workspace === "worktree" ? { workspace: env.group.workspace } : {}),
    nodes: env.group.nodes
      .filter((n) => n?.id?.trim() && n?.label?.trim())
      .map((n) => ({
        hubId: (n.hubId ?? "").trim() || randomUUID(),
        id: n.id.trim(),
        label: n.label.trim(),
        ...(n.prompt?.trim() ? { prompt: n.prompt.trim() } : {}),
      })),
  }
  const contentHash = computeGroupContentHash(group)
  return {
    kind: "lk-harness-node-group",
    version: 2,
    hubId,
    hubRevision: typeof env.hubRevision === "number" ? env.hubRevision : 1,
    author: (env.author ?? "").trim(),
    updatedAt: (env.updatedAt ?? "").trim() || new Date().toISOString(),
    contentHash: (env.contentHash ?? "").trim() || contentHash,
    group,
  }
}

export function parseNodeEnvelope(raw: unknown): FlowHubNodeEnvelope | null {
  if (!raw || typeof raw !== "object") return null
  const obj = raw as FlowHubNodeEnvelope
  if (obj.kind !== "lk-harness-flow-node" || !obj.node?.id?.trim() || !obj.node?.label?.trim()) return null
  const node: FlowHubNodePayload = {
    hubId: (obj.node.hubId ?? "").trim() || randomUUID(),
    id: obj.node.id.trim(),
    label: obj.node.label.trim(),
    ...(obj.node.prompt?.trim() ? { prompt: obj.node.prompt.trim() } : {}),
  }
  return {
    kind: "lk-harness-flow-node",
    version: 1,
    hubId: (obj.hubId ?? "").trim() || randomUUID(),
    hubRevision: typeof obj.hubRevision === "number" ? obj.hubRevision : 1,
    author: (obj.author ?? "").trim(),
    updatedAt: (obj.updatedAt ?? "").trim() || new Date().toISOString(),
    contentHash: (obj.contentHash ?? "").trim() || computeNodeContentHash(node),
    node,
  }
}

function legacyGroupToEnvelope(group: ProjectNodeGroupDef): FlowHubGroupEnvelope {
  const body: FlowHubGroupBody = {
    id: group.id,
    name: group.name,
    ...(group.workspace ? { workspace: group.workspace } : {}),
    nodes: group.nodes.map((n) => nodeDefToPayload(n)),
  }
  return buildGroupEnvelope({
    group: body,
    hubId: randomUUID(),
    hubRevision: 1,
    author: "",
  })
}

export function nodeDefToPayload(n: ProjectNodeDef & { hubId?: string }): FlowHubNodePayload {
  return ensureHubId({
    id: n.id.trim(),
    label: n.label.trim(),
    ...(n.prompt?.trim() ? { prompt: n.prompt.trim() } : {}),
    hubId: n.hubId,
  })
}

export function groupDefToBody(g: ProjectNodeGroupDef): FlowHubGroupBody {
  return {
    id: g.id,
    name: g.name,
    ...(g.workspace ? { workspace: g.workspace } : {}),
    nodes: g.nodes.map((n) => nodeDefToPayload(n)),
  }
}

export function envelopeToGroupDef(env: FlowHubGroupEnvelope): ProjectNodeGroupDef {
  return {
    id: env.group.id,
    name: env.group.name,
    ...(env.group.workspace ? { workspace: env.group.workspace } : {}),
    nodes: env.group.nodes.map((n) => ({
      id: n.id,
      label: n.label,
      ...(n.prompt ? { prompt: n.prompt } : {}),
      hubId: n.hubId,
      hubRevision: env.hubRevision,
      hubContentHash: computeNodeContentHash(n),
      localRevision: 0,
    })),
    hubId: env.hubId,
    hubRevision: env.hubRevision,
    hubContentHash: env.contentHash,
    localRevision: 0,
  }
}
