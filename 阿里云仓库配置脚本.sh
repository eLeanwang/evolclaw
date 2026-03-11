#!/bin/bash

# 阿里云代码仓库配置脚本

echo "=========================================="
echo "  阿里云代码仓库 SSH 配置脚本"
echo "=========================================="
echo ""

# 检查 SSH 密钥是否存在
if [ -f ~/.ssh/id_ed25519.pub ]; then
    echo "✓ SSH 密钥已存在"
else
    echo "→ 未找到 SSH 密钥，正在生成..."
    ssh-keygen -t ed25519 -C "ali_codeup" -N "" -f ~/.ssh/id_ed25519
    echo "✓ SSH 密钥生成完成"
fi

echo ""
echo "=========================================="
echo "  请复制以下 SSH 公钥内容："
echo "=========================================="
echo ""
echo "┌────────────────────────────────────────┐"
cat ~/.ssh/id_ed25519.pub
echo ""
echo "└────────────────────────────────────────┘"
echo ""
echo "=========================================="
echo "  请将上述公钥添加到阿里云云效页面："
echo "  https://account-devops.aliyun.com/settings/ssh"
echo "=========================================="
echo ""

read -p "公钥已保存到阿里云后，按 Enter 继续..."

echo ""
echo "请输入 evolclaw 项目的本地绝对路径"
echo "（直接按 Enter 使用当前目录: $(pwd)）"
read -p "路径: " project_path

# 使用当前目录作为默认值
if [ -z "$project_path" ]; then
    project_path=$(pwd)
fi

# 展开波浪号
project_path="${project_path/#\~/$HOME}"

# 检查路径是否存在
if [ ! -d "$project_path" ]; then
    echo "→ 目录不存在，正在创建..."
    mkdir -p "$project_path"
fi

echo ""
echo "→ 进入目录: $project_path"
cd "$project_path" || exit 1

# 初始化 git 仓库
if [ -d ".git" ]; then
    echo "✓ Git 仓库已存在"
else
    echo "→ 初始化 Git 仓库..."
    git init
    echo "✓ Git 仓库初始化完成"
fi

# 添加远程仓库
if git remote | grep -q "origin"; then
    echo "→ 远程仓库 origin 已存在，正在更新..."
    git remote set-url origin git@codeup.aliyun.com:6808da56fb3da14b899afd54/evolclaw.git
else
    echo "→ 添加远程仓库..."
    git remote add origin git@codeup.aliyun.com:6808da56fb3da14b899afd54/evolclaw.git
fi

echo "✓ 远程仓库配置完成"

echo ""
echo "=========================================="
echo "  ✓ 所有配置已完成！"
echo "=========================================="
echo ""
echo "项目路径: $project_path"
echo "远程仓库: git@codeup.aliyun.com:6808da56fb3da14b899afd54/evolclaw.git"
echo ""
echo "你现在可以执行以下命令拉取代码："
echo "  git pull origin main"
echo ""

