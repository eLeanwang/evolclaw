#!/bin/bash

# EvolClaw 服务管理脚本

# 获取脚本真实路径（处理符号链接）
if [ -L "${BASH_SOURCE[0]}" ]; then
    SCRIPT_PATH="$(readlink -f "${BASH_SOURCE[0]}")"
else
    SCRIPT_PATH="${BASH_SOURCE[0]}"
fi

SCRIPT_DIR="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)"
PID_FILE="$SCRIPT_DIR/data/evolclaw.pid"
LOG_DIR="$SCRIPT_DIR/logs"
STDOUT_LOG="$SCRIPT_DIR/logs/stdout.log"
NODE_BIN="node"
APP_MAIN="$SCRIPT_DIR/dist/index.js"

# 环境变量配置
export LOG_LEVEL="${LOG_LEVEL:-INFO}"
export MESSAGE_LOG="${MESSAGE_LOG:-true}"
export EVENT_LOG="${EVENT_LOG:-true}"

# 清理 Claude Code 环境变量，防止 SDK 认为是嵌套会话
unset CLAUDECODE
unset CLAUDE_CODE_ENTRYPOINT
unset CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
unset CLAUDE_CONFIG_DIR
unset ANTHROPIC_AUTH_TOKEN
unset ANTHROPIC_BASE_URL

# 确保 PATH 包含 claude 命令
CLAUDE_PATH=$(which claude 2>/dev/null)
if [ -n "$CLAUDE_PATH" ]; then
    CLAUDE_DIR=$(dirname "$CLAUDE_PATH")
    export PATH="$CLAUDE_DIR:$PATH"
fi

# 检查进程是否运行
is_running() {
    if [ -f "$PID_FILE" ]; then
        PID=$(cat "$PID_FILE")
        if ps -p "$PID" > /dev/null 2>&1; then
            return 0
        else
            rm -f "$PID_FILE"
            return 1
        fi
    fi
    return 1
}

# 停止所有 EvolClaw 进程
kill_all_instances() {
    local pids=$(ps aux | grep "node.*dist/index.js" | grep -v grep | awk '{print $2}')
    if [ -n "$pids" ]; then
        local count=$(echo "$pids" | wc -w)
        echo "  Found $count running instance(s), stopping them..."
        echo "$pids" | xargs kill 2>/dev/null
        sleep 1
        # 强制杀死仍在运行的进程
        local remaining=$(ps aux | grep "node.*dist/index.js" | grep -v grep | awk '{print $2}')
        if [ -n "$remaining" ]; then
            echo "  Force killing remaining processes..."
            echo "$remaining" | xargs kill -9 2>/dev/null
        fi
    fi
}

# 日志轮转函数
rotate_logs() {
    if [ ! -d "$LOG_DIR" ]; then
        return
    fi

    for log in "$LOG_DIR"/*.log; do
        if [ -f "$log" ]; then
            # 获取文件大小（兼容 macOS 和 Linux）
            if [[ "$OSTYPE" == "darwin"* ]]; then
                size=$(stat -f%z "$log" 2>/dev/null || echo 0)
            else
                size=$(stat -c%s "$log" 2>/dev/null || echo 0)
            fi

            # 如果超过 10MB，则轮转
            if [ "$size" -gt 10485760 ]; then
                timestamp=$(date +%Y%m%d_%H%M%S)
                mv "$log" "${log}.${timestamp}"
                echo "  Rotated: $(basename "$log") -> $(basename "$log").${timestamp}"
            fi
        fi
    done

    # 清理 7 天前的旧日志
    find "$LOG_DIR" -name "*.log.*" -mtime +7 -delete 2>/dev/null
}

# 启动服务
start() {
    if is_running; then
        echo "❌ EvolClaw is already running (PID: $(cat "$PID_FILE"))"
        exit 1
    fi

    echo "🚀 Starting EvolClaw..."

    # 清理所有旧进程（防止多实例）
    kill_all_instances

    # 确保目录存在
    mkdir -p "$SCRIPT_DIR/data" "$LOG_DIR"

    # 日志轮转
    rotate_logs

    cd "$SCRIPT_DIR"  # 切换到项目目录
    nohup "$NODE_BIN" "$APP_MAIN" > "$STDOUT_LOG" 2>&1 &
    PID=$!
    echo $PID > "$PID_FILE"

    sleep 2
    if is_running; then
        echo "✓ EvolClaw started successfully (PID: $PID)"
        echo "  Log level: $LOG_LEVEL"
        echo "  Message log: $MESSAGE_LOG"
        echo "  Event log: $EVENT_LOG"
        echo "  Logs: $LOG_DIR/"
    else
        echo "❌ Failed to start EvolClaw"
        echo ""
        echo "📝 Error details (last 10 lines of stdout):"
        if [ -f "$STDOUT_LOG" ]; then
            tail -10 "$STDOUT_LOG" | sed 's/^/  /'
        else
            echo "  (no log file found)"
        fi
        rm -f "$PID_FILE"
        exit 1
    fi
}

# 停止服务
stop() {
    if ! is_running; then
        echo "⚠ EvolClaw is not running"
        exit 0
    fi

    PID=$(cat "$PID_FILE")
    echo "🛑 Stopping EvolClaw (PID: $PID)..."
    kill "$PID"

    # 等待进程退出
    for i in {1..10}; do
        if ! ps -p "$PID" > /dev/null 2>&1; then
            rm -f "$PID_FILE"
            echo "✓ EvolClaw stopped"
            return 0
        fi
        sleep 1
    done

    # 强制杀死
    echo "⚠ Force killing..."
    kill -9 "$PID" 2>/dev/null
    rm -f "$PID_FILE"
    echo "✓ EvolClaw stopped (forced)"
}

# 重启服务
restart() {
    echo "🔄 Restarting EvolClaw..."
    stop
    sleep 1
    start
}

# 查看状态
status() {
    if is_running; then
        PID=$(cat "$PID_FILE")
        echo "✓ EvolClaw is running (PID: $PID)"
        echo ""
        echo "📊 Process Info:"
        echo "  Uptime: $(ps -p "$PID" -o etime= | xargs)"
        echo "  CPU: $(ps -p "$PID" -o %cpu= | xargs)%"
        echo "  Memory: $(ps -p "$PID" -o rss= | xargs) KB"
        echo "  Working Dir: $SCRIPT_DIR"
        echo ""
        echo "📁 Log Files:"
        echo "  Main log: $LOG_DIR/evolclaw.log"
        if [ -f "$LOG_DIR/evolclaw.log" ]; then
            echo "    Size: $(du -h "$LOG_DIR/evolclaw.log" | cut -f1)"
            echo "    Lines: $(wc -l < "$LOG_DIR/evolclaw.log")"
        fi
        if [ "$MESSAGE_LOG" = "true" ] && [ -f "$LOG_DIR/messages.log" ]; then
            echo "  Message log: $LOG_DIR/messages.log"
            echo "    Size: $(du -h "$LOG_DIR/messages.log" | cut -f1)"
            echo "    Lines: $(wc -l < "$LOG_DIR/messages.log")"
        fi
        if [ "$EVENT_LOG" = "true" ] && [ -f "$LOG_DIR/events.log" ]; then
            echo "  Event log: $LOG_DIR/events.log"
            echo "    Size: $(du -h "$LOG_DIR/events.log" | cut -f1)"
            echo "    Lines: $(wc -l < "$LOG_DIR/events.log")"
        fi
        echo ""
        echo "⚙️  Configuration:"
        echo "  Log level: $LOG_LEVEL"
        echo "  Message log: $MESSAGE_LOG"
        echo "  Event log: $EVENT_LOG"
        echo ""
        echo "📝 Recent activity (last 5 lines):"
        if [ -f "$LOG_DIR/evolclaw.log" ]; then
            tail -5 "$LOG_DIR/evolclaw.log" | sed 's/^/  /'
        else
            echo "  (no log file yet)"
        fi
    else
        echo "⚠ EvolClaw is not running"
        echo ""
        if [ -f "$PID_FILE" ]; then
            echo "  Stale PID file found: $PID_FILE"
        fi
        if [ -f "$LOG_DIR/evolclaw.log" ]; then
            echo "📝 Last log entries:"
            tail -5 "$LOG_DIR/evolclaw.log" | sed 's/^/  /'
        fi
    fi
}

# 查看日志
logs() {
    if [ -f "$LOG_DIR/evolclaw.log" ]; then
        tail -f "$LOG_DIR/evolclaw.log"
    else
        echo "❌ Log file not found: $LOG_DIR/evolclaw.log"
    fi
}

# 主逻辑
case "$1" in
    start)
        start
        ;;
    stop)
        stop
        ;;
    restart)
        restart
        ;;
    status)
        status
        ;;
    logs)
        logs
        ;;
    *)
        echo "Usage: $0 {start|stop|restart|status|logs}"
        exit 1
        ;;
esac
