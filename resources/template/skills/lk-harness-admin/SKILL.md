# LK Harness — 自管理 Skill

你可以通过以下 MCP 工具管理 LK Harness 应用自身的运行状态、配置和环境。

## 可用 MCP 工具

### manage_agent
管理 Agent 生命周期。
| action | 说明 |
|--------|------|
| status | 查询运行状态 |
| stop | 停止 Agent |
| restart | 重启应用 |
| reset | 重置会话 |
| clean | 清空消息队列 |
| launch | 启动临时 Agent 会话（需传 message 参数） |

### manage_mcp
管理 MCP 服务器配置（list / add / delete）。

### manage_rules
管理 Cursor Rules 文件（list / read / save / delete）。

### manage_skills
管理 Agent Skills（list / read / save / delete）。

### manage_tasks
管理定时任务（list / add / update / delete / toggle）。

### manage_workspace
管理工作目录（get / set）。切换后热更新生效。
