/**
 * Playwright 配置（阶段 3 E2E）。
 *
 * 约定：
 * - 不配置 webServer：复用 Lead 已在 http://127.0.0.1:5199 运行的 DocMax dev server；
 *   如需换地址：DOCMAX_URL=http://127.0.0.1:5199 npx playwright test
 * - 浏览器使用系统已安装的 Chrome（channel: 'chrome'）；
 * - 真实模型 E2E 串行执行（workers: 1），避免并发请求影响延迟与断言；
 * - 截图/轨迹/JSON 结果统一落在 .artifacts/ 下。
 */
import { defineConfig, devices } from '@playwright/test';

const BASE_URL = process.env.DOCMAX_URL || 'http://127.0.0.1:5199';

export default defineConfig({
  testDir: './e2e',
  outputDir: './.artifacts/playwright',
  timeout: 120_000,
  expect: { timeout: 30_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  forbidOnly: false,
  reporter: [
    ['list'],
    ['json', { outputFile: './.artifacts/e2e-results.json' }],
  ],
  use: {
    baseURL: BASE_URL,
    channel: 'chrome',
    headless: true,
    viewport: { width: 1440, height: 900 },
    locale: 'zh-CN',
    actionTimeout: 20_000,
    navigationTimeout: 30_000,
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
    video: 'off',
  },
  projects: [
    {
      name: 'chrome',
      use: { ...devices['Desktop Chrome'], channel: 'chrome', viewport: { width: 1440, height: 900 } },
    },
  ],
});
