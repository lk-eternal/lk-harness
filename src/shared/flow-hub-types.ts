import type { ProjectFieldDef, ProjectWorkspaceType, WorkBranchMode } from "./project-types.js"

export interface FlowHubSettings {
  flowHubUrl?: string
  flowHubToken?: string
  flowHubAuthor?: string
}

export interface FlowHubCatalog {
  version: 1
  updatedAt: string
  groups: FlowHubCatalogGroup[]
  nodes: FlowHubCatalogNode[]
}

export interface FlowHubCatalogGroup {
  hubId: string
  name: string
  nodeLabels: string[]
  nodeIds: string[]
  author: string
  updatedAt: string
  contentHash: string
}

export interface FlowHubCatalogNode {
  hubId: string
  label: string
  localId: string
  author: string
  updatedAt: string
  contentHash: string
  sourceGroupName?: string
}

/** 节点浏览列表项：独立节点 + 流程组内节点 */
export interface FlowHubBrowsableNode extends FlowHubCatalogNode {
  /** 来自流程组时填写，导�?预览�?groups/{groupHubId}.json */
  groupHubId?: string
}

export interface FlowHubNodePayload {
  hubId: string
  id: string
  label: string
  prompt?: string
}

export interface FlowHubGroupBody {
  id: string
  name: string
  workspace?: ProjectWorkspaceType
  /** 默认工作分支（新建/基线/测试/开发）；缺省=新建分支，只在非默认时才写，这样存量模板的同步内容不变 */
  branchMode?: WorkBranchMode
  /** 模板说明（建项时展示）；留空不写，没写这项的存量共享模板内容不变 */
  description?: string
  /** 建项时要填的信息；没有就不写 */
  fields?: ProjectFieldDef[]
  nodes: FlowHubNodePayload[]
}

export interface FlowHubGroupEnvelope {
  kind: "lk-harness-node-group"
  version: 2
  hubId: string
  hubRevision: number
  author: string
  updatedAt: string
  contentHash: string
  group: FlowHubGroupBody
}

export interface FlowHubNodeEnvelope {
  kind: "lk-harness-flow-node"
  version: 1
  hubId: string
  hubRevision: number
  author: string
  updatedAt: string
  contentHash: string
  node: FlowHubNodePayload
}

export type FlowHubSyncStatus = "missing" | "synced" | "outdated" | "local_modified"

export interface FlowHubHubTrack {
  hubId?: string
  hubRevision?: number
  hubContentHash?: string
  localRevision?: number
}
