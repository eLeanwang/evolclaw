# Trigger - 定时触发器

通过 `/trigger` 命令设置延迟或定时任务，系统在指定时间重新激活 Agent 执行。

## 注册

```
/trigger set --delay <时长> --prompt "<任务内容>"
/trigger set --at <ISO时间> --prompt "<任务内容>"
/trigger set --cron <表达式> --prompt "<任务内容>"
```

**时间格式：**
- `--delay`：`30m`、`2h`、`1d`、`2h30m`
- `--at`：ISO 格式，如 `2026-05-15T09:00`
- `--cron`：标准 cron 表达式，如 `0 9 * * *`（每天 9 点）

## 可选参数

| 参数 | 说明 | 默认值 |
|------|------|--------|
| `--channel <实例名>` | 目标通道实例 | 当前通道 |
| `--channelid <id>` | 目标对话 ID | 当前对话 |
| `--thread <id>` | 目标 thread（与 --session 互斥） | 无 |
| `--session latest` | 续接最后活跃会话（用户可见输出） | 默认 |
| `--session silent` | 新建独立会话静默执行 | - |
| `--name <标识>` | 触发器名称 | 自动生成 |
| `--agent <名称>` | 目标 agent | 当前 agent |

## 管理

```
/trigger              查看活跃触发器
/trigger list         查看所有触发器（含历史）
/trigger cancel <名称|ID>   取消触发器
```

## 会话策略

- **latest**：续接已有会话，输出对用户可见。适合提醒、跟进对话。
- **silent**：新建独立 autonomous 会话，不打扰用户。适合后台清理、扫描、生成文件。

## 权限

- 所有用户可注册触发器
- cancel 自己的触发器：按名称或 ID
- cancel 他人的触发器：需 owner/admin 权限

## 示例

```
/trigger set --delay 30m --prompt "检查构建状态并汇报"
/trigger set --at 2026-05-16T09:00 --prompt "生成日报" --session silent
/trigger set --cron "0 */6 * * *" --prompt "检查服务健康" --session silent --name health-check
/trigger cancel health-check
```

## 注意事项

- 触发器不支持修改，需 cancel 后重建
- `--thread` 与 `--session` 互斥
- `--channel` 与 `--channelid` 必须同时指定或同时省略
- delay/at 类型触发一次后自动归档；cron 类型持续触发直到 cancel
