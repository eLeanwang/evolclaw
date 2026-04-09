import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: './tests/e2e-browser',
  timeout: 120_000,
  retries: 0,
  use: {
    // 使用系统已安装的 Chrome，不需要下载 Chromium
    channel: 'chrome',
    headless: true,
    // 忽略 HTTPS 证书错误（Docker 测试环境）
    ignoreHTTPSErrors: true,
    // 禁用 CORS 限制（测试环境服务端未配置 CORS 头）
    launchOptions: {
      args: ['--disable-web-security', '--disable-features=IsolateOrigins,site-per-process'],
    },
  },
  // 单线程执行，避免并发冲突
  workers: 1,
});
