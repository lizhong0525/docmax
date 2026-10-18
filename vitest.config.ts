/**
 * Vitest 配置（阶段 1 单元测试）。
 *
 * 只跑 tests/ 下的 Node 环境单测；e2e/ 下是 Playwright 用例（由 playwright.config.ts 负责），
 * 避免 `vitest run` 误收集 e2e/*.spec.ts。
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    exclude: ['node_modules/**', 'e2e/**', '.artifacts/**'],
  },
});
