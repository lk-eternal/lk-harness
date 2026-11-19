import { createHash } from "node:crypto"
import type { FlowHubGroupBody, FlowHubNodePayload } from "./flow-hub-types.js"

function stableValue(value: unknown): unknown {
  if (value == null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(stableValue)
  const obj = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(obj).sort()) {
    const v = obj[key]
    if (v === undefined) continue
    out[key] = stableValue(v)
  }
  return out
}

function digest(payload: unknown): string {
  return createHash("sha256").update(JSON.stringify(stableValue(payload))).digest("hex")
}

export function computeNodeContentHash(node: Pick<FlowHubNodePayload, "id" | "label" | "prompt">): string {
  return digest({
    id: node.id.trim(),
    label: node.label.trim(),
    ...(node.prompt?.trim() ? { prompt: node.prompt.trim() } : {}),
  })
}

export function computeGroupContentHash(
  group: Pick<FlowHubGroupBody, "name" | "workspace" | "branchMode" | "description" | "fields" | "nodes">,
): string {
  return digest({
    name: group.name.trim(),
    ...(group.workspace ? { workspace: group.workspace } : {}),
    ...(group.branchMode ? { branchMode: group.branchMode } : {}),
    ...(group.description?.trim() ? { description: group.description.trim() } : {}),
    ...(group.fields?.length ? { fields: group.fields } : {}),
    nodes: group.nodes.map((n) => ({
      id: n.id.trim(),
      label: n.label.trim(),
      ...(n.prompt?.trim() ? { prompt: n.prompt.trim() } : {}),
    })),
  })
}
