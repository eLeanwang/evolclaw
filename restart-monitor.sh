#!/bin/bash

# EvolClaw 自动重启监控脚本

PID_FILE="/home/evolclaw/data/evolclaw.pid"
LOG_FILE="/home/evolclaw/data/evolclaw.log"
RESTART_LOG="/home/evolclaw/data/restart.log"

echo "[$(date '+%Y-%m-%d %H:%M:%S')] Restart monitor started" >> "$RESTART_LOG"

# 检查 PID 文件是否存在
if [ ! -f "$PID_FILE" ]; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: PID file not found" >> "$RESTART_LOG"
    exit 1
fi

OLD_PID=$(cat "$PID_FILE")
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Monitoring process PID: $OLD_PID" >> "$RESTART_LOG"

# 等待主进程退出（最多等待 30 秒）
for i in {1..30}; do
    if ! ps -p "$OLD_PID" > /dev/null 2>&1; then
        echo "[$(date '+%Y-%m-%d %H:%M:%S')] Process $OLD_PID has exited" >> "$RESTART_LOG"
        break
    fi
    sleep 1
done

# 检查进程是否真的退出了
if ps -p "$OLD_PID" > /dev/null 2>&1; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ERROR: Process still running after 30s" >> "$RESTART_LOG"
    exit 1
fi

# 等待 3 秒
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Waiting 3 seconds before restart..." >> "$RESTART_LOG"
sleep 3

# 启动新进程
echo "[$(date '+%Y-%m-%d %H:%M:%S')] Starting new process..." >> "$RESTART_LOG"
cd /home/evolclaw
nohup node dist/index.js > "$LOG_FILE" 2>&1 &
NEW_PID=$!

# 保存新的 PID
echo $NEW_PID > "$PID_FILE"

# 等待 2 秒验证启动成功
sleep 2

if ps -p "$NEW_PID" > /dev/null 2>&1; then
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ✓ Service restarted successfully (PID: $NEW_PID)" >> "$RESTART_LOG"
    exit 0
else
    echo "[$(date '+%Y-%m-%d %H:%M:%S')] ❌ Failed to start service" >> "$RESTART_LOG"
    rm -f "$PID_FILE"
    exit 1
fi
