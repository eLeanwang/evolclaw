#!/bin/bash

# 消息缓存机制测试脚本

echo "========================================="
echo "  消息缓存机制测试"
echo "========================================="
echo ""

# 颜色定义
GREEN='\033[0;32m'
RED='\033[0;31m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

# 运行单元测试
echo -e "${YELLOW}[1/4] 运行 MessageCache 单元测试...${NC}"
npm test -- tests/unit/message-cache.test.ts --reporter=verbose
if [ $? -ne 0 ]; then
    echo -e "${RED}✗ MessageCache 单元测试失败${NC}"
    exit 1
fi
echo -e "${GREEN}✓ MessageCache 单元测试通过${NC}"
echo ""

echo -e "${YELLOW}[2/4] 运行 ChannelProxy 单元测试...${NC}"
npm test -- tests/unit/channel-proxy.test.ts --reporter=verbose
if [ $? -ne 0 ]; then
    echo -e "${RED}✗ ChannelProxy 单元测试失败${NC}"
    exit 1
fi
echo -e "${GREEN}✓ ChannelProxy 单元测试通过${NC}"
echo ""

echo -e "${YELLOW}[3/4] 运行 MessageQueue 项目路径检查测试...${NC}"
npm test -- tests/unit/message-queue-project.test.ts --reporter=verbose
if [ $? -ne 0 ]; then
    echo -e "${RED}✗ MessageQueue 测试失败${NC}"
    exit 1
fi
echo -e "${GREEN}✓ MessageQueue 测试通过${NC}"
echo ""

echo -e "${YELLOW}[4/4] 运行集成测试...${NC}"
npm test -- tests/integration/message-cache.test.ts --reporter=verbose
if [ $? -ne 0 ]; then
    echo -e "${RED}✗ 集成测试失败${NC}"
    exit 1
fi
echo -e "${GREEN}✓ 集成测试通过${NC}"
echo ""

echo "========================================="
echo -e "${GREEN}✓ 所有测试通过！${NC}"
echo "========================================="
echo ""
echo "测试覆盖："
echo "  - MessageCache: 9 个测试"
echo "  - ChannelProxy: 8 个测试"
echo "  - MessageQueue: 7 个测试"
echo "  - 集成测试: 7 个场景"
echo "  - 总计: 31 个测试"
echo ""
echo "详细报告: docs/MESSAGE_CACHE_TEST_REPORT.md"
