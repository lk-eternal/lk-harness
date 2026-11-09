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
管理 Agent 挂载的 MCP（list / add / delete）。

### manage_rules
管理 Harness 规则（list / read / save / delete）。

### manage_skills
管理 Harness Agent Skills（list / read / save / delete）。

### manage_tasks
管理**全局**定时任务，和设置页里的一样（list / add / update / delete / toggle）。它**不是**「给当前会话定时」：
- 独立运行（默认）：每次由全新 Agent 执行，结果按 `notify` 发出。
- `independent=false`：任务内容投给「所属通道」的**主会话**。飞书/微信通道的主会话就是主用户私聊，回复会发到飞书/微信，不一定是你当前所在的会话。
- 所属通道默认是你当前所在的通道；创建后工具会返回任务实际的去向，如实转述给用户，不要自己推断。

### schedule_create / schedule_list / schedule_cancel
给**你当前所在的会话**自己排定时任务（等 CI、定期检查、隔天复查）。用户说「给当前会话定时」时用它，不要用 manage_tasks。
- `mode=fresh`（默认）：每次由新 Agent 执行，结论投回本会话；`mode=session`：到点提醒本会话自己做。
- 只有主会话和项目会话能用。

### manage_workspace
管理工作目录（get / set）。切换后热更新生效。
