# EvolClaw CLI 调用问题报告

日期：2026-05-23

## 问题概述

在 Windows 11 + Git Bash（MSYS2）环境下，直接执行 `evolclaw` 命令失败，需改用 `node <路径>` 显式调用。

---

## 根本原因

### npm wrapper 脚本问题

npm 全局安装后生成的 wrapper 脚本位于：

```
C:\Users\agentcp\AppData\Roaming\npm\evolclaw
```

内容如下：

```sh
#!/bin/sh
basedir=$(dirname "$(echo "$0" | sed -e 's,\\,/,g')")

case `uname` in
    *CYGWIN*|*MINGW*|*MSYS*)
        if command -v cygpath > /dev/null 2>&1; then
            basedir=`cygpath -w "$basedir"`
        fi
    ;;
esac

exec "$basedir/node_modules/evolclaw/dist/cli/index.js"   "$@"
```

**问题所在**：最后一行用 `exec` 直接执行 JS 文件，而没有通过 `node` 调用。在 Linux/Mac 上，JS 文件通常有 `#!/usr/bin/env node` shebang，系统会自动用 node 执行。但在 Windows Git Bash 环境下，shebang 解析不可靠，导致 bash 把 JS 文件当 shell 脚本执行，遇到 ESM `import` 语句就报错：

```
import: command not found
syntax error near unexpected token '('
```

---

## 各命令测试结果

| 命令 | 直接调用 `evolclaw` | 用 `node <路径>` 调用 | 结果 |
|------|--------------------|-----------------------|------|
| `ctl send` | 失败（ESM 报错） | 成功（`已发送`） | 功能正常，调用方式问题 |
| `msg send` | 失败（ESM 报错） | 成功（有 message ID） | 功能正常，调用方式问题 |
| `ctl thought` | 失败（ESM 报错） | 失败（`不允许的指令: /thought`） | 子命令不存在 |

---

## 结论

1. **不是 ctl 或 msg 的功能问题**，两者均正常工作。
2. **是所有 evolclaw 命令行调用共有的问题**：在 Windows Git Bash 下，npm wrapper 无法正确通过 node 执行 ESM 模块。
3. **thought 子命令不存在**，与上述环境问题无关，是独立问题。

---

## 临时解决方案

将所有 `evolclaw <cmd>` 替换为：

```bash
node "C:\Users\agentcp\AppData\Roaming\npm\node_modules\evolclaw\dist\cli\index.js" <cmd>
```

或设置 shell alias：

```bash
alias evolclaw='node "C:\Users\agentcp\AppData\Roaming\npm\node_modules\evolclaw\dist\cli\index.js"'
```

---

## 修复方案（已执行）

直接修改了两个 npm wrapper 脚本，加上 `node` 前缀：

**`C:\Users\agentcp\AppData\Roaming\npm\evolclaw`（bash wrapper）**
```sh
# 修改前
exec "$basedir/node_modules/evolclaw/dist/cli/index.js"   "$@"
# 修改后
exec node "$basedir/node_modules/evolclaw/dist/cli/index.js"   "$@"
```

**`C:\Users\agentcp\AppData\Roaming\npm\evolclaw.cmd`（Windows CMD wrapper）**
```bat
# 修改前
"%dp0%\node_modules\evolclaw\dist\cli\index.js"   %*
# 修改后
node "%dp0%\node_modules\evolclaw\dist\cli\index.js"   %*
```

验证结果：`evolclaw --version` 返回 `3.0.0`，直接调用正常。

> 注意：npm 升级或重新安装 evolclaw 时会覆盖这两个 wrapper，需重新修复。长期方案是向 evolclaw 提交 issue，在 `dist/cli/index.js` 首行加上 `#!/usr/bin/env node` shebang。
