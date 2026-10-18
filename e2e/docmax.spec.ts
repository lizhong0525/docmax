/**
 * DocMax E2E（阶段 3）：真实浏览器 + 真实 DocMax 服务 + 真实 DeepSeek。
 *
 * 运行前提：http://127.0.0.1:5199 上 DocMax dev server 已启动且 API Key 已配置。
 * 运行：node node_modules/@playwright/test/cli.js test
 *
 * 覆盖：
 *  - 页面加载 / 健康状态 / 编辑器可用
 *  - 键盘输入文档 + 三击选行 + Ctrl+K 指令条 + 真实提交 + 等待审阅
 *  - 接受 → 文档变化；Ctrl+Z → 完整恢复（单一 undo 步）
 *  - 拒绝 → 文档不变
 *  - 空选区插入
 *  - 预览切换
 *  - 状态栏选区识别信息
 *  - 窄屏布局截图
 * 截图统一保存到 .artifacts/e2e-*.png。
 */
import { expect, test, type Page } from '@playwright/test';

const SHOT_DIR = '.artifacts';

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

/** 读取 CodeMirror 编辑器中当前可见行的文本（E2E 文档都短，全部可见） */
async function readEditor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="editor"]');
    if (!root) return '';
    const lines = Array.from(root.querySelectorAll('.cm-line')).map((line) => line.textContent ?? '');
    return lines.join('\n');
  });
}

/** 聚焦编辑器、全选并插入整篇文档 */
async function setDocument(page: Page, doc: string): Promise<void> {
  const editor = page.locator('[data-testid="editor"]');
  await editor.click();
  await page.keyboard.press('Control+a');
  await page.keyboard.insertText(doc);
  await expect(page.locator('[data-testid="doc-title"]')).toBeVisible();
}

/** 三击选中第 index 行（CodeMirror 原生行选择） */
async function selectLine(page: Page, index = 0): Promise<void> {
  const line = page.locator('.cm-line').nth(index);
  await expect(line).toBeVisible();
  await line.click({ clickCount: 3 });
  // 确认选区已生效（状态栏不再是“空白”光标状态）
  await expect(page.locator('[data-testid="selection-status"]')).not.toContainText('空白');
}

/** 打开指令条（Ctrl+K）。注意：不能先点击编辑器，否则三击选区会被折叠成光标 */
async function openCommandBar(page: Page): Promise<void> {
  await page.keyboard.press('Control+k');
  await expect(page.locator('[data-testid="command-bar"]')).toBeVisible();
}

/** 填写指令并真实提交 */
async function submitInstruction(page: Page, instruction: string): Promise<void> {
  const input = page.locator('[data-testid="command-input"]');
  await input.fill(instruction);
  await expect(page.locator('[data-testid="command-submit"]')).toBeEnabled();
  await page.locator('[data-testid="command-submit"]').click();
}

/** 等待审阅面板出现（不要求可接受：no-change / error 场景也可用） */
async function waitForReview(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="review-panel"]')).toBeVisible({ timeout: 60_000 });
  await expect(page.locator('[data-testid="proposal-card"]')).toBeVisible({ timeout: 60_000 });
}

/** 等待审阅面板出现且提案可接受（真实模型 1-3s，留足余量） */
async function waitForProposal(page: Page): Promise<void> {
  await waitForReview(page);
  await expect(page.locator('[data-testid="accept"]')).toBeEnabled({ timeout: 60_000 });
}

async function waitReviewClosed(page: Page): Promise<void> {
  await expect(page.locator('[data-testid="review-panel"]')).toHaveCount(0, { timeout: 20_000 });
}

/** 让焦点回到编辑器，确保 Ctrl+Z 由 CodeMirror 处理 */
async function focusEditor(page: Page): Promise<void> {
  await page.locator('[data-testid="editor"]').click();
}

/** 明显需要润色的第一行（避免模型判定“无需修改”） */
const FIRST_LINE =
  '这个功能目前有一个问题，就是当用户点击按钮以后页面会一直卡住不动，我们需要尽快修复它，否则会影响用户体验。';
const TEST_DOC = `${FIRST_LINE}\n\n第二段内容保持不变。\n`;
const POLISH_INSTRUCTION = '把这句话改得更简洁、更专业，保留原意，不要改变它在段落中的位置。';

/* ------------------------------------------------------------------ */
/* tests                                                               */
/* ------------------------------------------------------------------ */

test.describe('DocMax 基础加载', () => {
  test('页面加载、服务健康、编辑器可用', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });

    await page.goto('/');
    await expect(page.locator('.brand-name')).toHaveText('DocMax');
    await expect(page.locator('[data-testid="health"]')).toContainText('DeepSeek 就绪', { timeout: 20_000 });
    await expect(page.locator('[data-testid="editor"]')).toBeVisible();
    await expect(page.locator('[data-testid="selection-status"]')).toBeVisible();
    await page.screenshot({ path: `${SHOT_DIR}/e2e-load-desktop.png`, fullPage: true });

    // 输入文档：字数统计应更新
    await setDocument(page, TEST_DOC);
    await expect(page.locator('.doc-meta')).toContainText('行');
    expect(await readEditor(page)).toContain(FIRST_LINE);

    // favicon 404 等资源错误不应出现
    const resourceErrors = consoleErrors.filter((text) => /404|Failed to load resource/i.test(text));
    expect(resourceErrors, `页面控制台资源错误：${resourceErrors.join(' | ')}`).toEqual([]);
  });

  test('预览切换（按钮 / 渲染内容）', async ({ page }) => {
    await page.goto('/');
    await setDocument(page, '# 预览标题\n\n预览正文内容。\n');

    await page.locator('[data-testid="toggle-preview"]').click();
    await expect(page.locator('[data-testid="preview-pane"]')).toBeVisible();
    await expect(page.locator('[data-testid="preview"] h1')).toHaveText('预览标题');
    await page.screenshot({ path: `${SHOT_DIR}/e2e-preview.png`, fullPage: true });

    await page.locator('[data-testid="back-to-edit"]').click();
    await expect(page.locator('[data-testid="preview-pane"]')).toHaveCount(0);
    await expect(page.locator('[data-testid="editor"]')).toBeVisible();
  });
});

test.describe('选区识别状态栏', () => {
  test('选中整行后显示字符数、块类型与识别详情', async ({ page }) => {
    await page.goto('/');
    await setDocument(page, TEST_DOC);
    await selectLine(page, 0);

    const status = page.locator('[data-testid="selection-status"]');
    await expect(status).toContainText('字');
    await expect(status).toContainText('段落');
    await page.screenshot({ path: `${SHOT_DIR}/e2e-selection-status.png` });

    const toggle = page.locator('[data-testid="toggle-selection-detail"]');
    await expect(toggle).toBeVisible();
    await toggle.click();
    await expect(page.locator('[data-testid="selection-detail"]')).toBeVisible();
    // 识别详情应展示块类型与位置等确定性信息
    await expect(page.locator('[data-testid="selection-detail"]')).toContainText('段落');
    await page.screenshot({ path: `${SHOT_DIR}/e2e-selection-detail.png` });
  });
});

test.describe('真实 AI 修改：接受 / 撤销 / 拒绝', () => {
  test('接受修改 → 文本变化 → Ctrl+Z 完整恢复', async ({ page }) => {
    await page.goto('/');
    await setDocument(page, TEST_DOC);
    const before = await readEditor(page);
    expect(before).toContain(FIRST_LINE);

    await selectLine(page, 0);
    await openCommandBar(page);
    await submitInstruction(page, POLISH_INSTRUCTION);
    await waitForProposal(page);

    // 审阅面板应展示 before/after 词级 diff 与提案信息
    await expect(page.locator('[data-testid="diff"]')).toBeVisible();
    await expect(page.locator('[data-testid="proposal-card"]')).toContainText('词级差异');
    await page.screenshot({ path: `${SHOT_DIR}/e2e-review.png` });

    await page.locator('[data-testid="accept"]').click();
    await waitReviewClosed(page);

    const after = await readEditor(page);
    expect(after).not.toBe(before);
    expect(after.length).toBeGreaterThan(0);
    // 选区之外的内容必须保持：第二段原文与结尾换行逐字不变
    expect(after).toContain('第二段内容保持不变。');
    expect(after.trimEnd().endsWith('第二段内容保持不变。')).toBe(true);
    expect(after.endsWith('\n')).toBe(true);
    await page.screenshot({ path: `${SHOT_DIR}/e2e-accepted.png` });

    // 单步 undo 恢复原文
    await focusEditor(page);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => readEditor(page), { timeout: 10_000 }).toBe(before);
    await page.screenshot({ path: `${SHOT_DIR}/e2e-undo-restored.png` });
  });

  test('拒绝修改 → 文档不变', async ({ page }) => {
    await page.goto('/');
    await setDocument(page, TEST_DOC);
    const before = await readEditor(page);

    await selectLine(page, 0);
    await openCommandBar(page);
    await submitInstruction(page, '把这句话改得更口语化、更简短一些。');
    await waitForReview(page);

    await expect(page.locator('[data-testid="reject"]')).toBeEnabled();
    await page.locator('[data-testid="reject"]').click();
    await waitReviewClosed(page);

    expect(await readEditor(page)).toBe(before);
  });
});

test.describe('空选区插入', () => {
  test('光标处插入文字并被接受 → 文档变长 → Ctrl+Z 恢复', async ({ page }) => {
    await page.goto('/');
    await setDocument(page, TEST_DOC);
    const before = await readEditor(page);

    // 光标移动到文档末尾，Ctrl+K 打开插入模式
    await page.locator('[data-testid="editor"]').click();
    await page.keyboard.press('Control+End');
    await page.keyboard.press('Control+k');
    await expect(page.locator('[data-testid="command-bar"]')).toContainText('在光标处插入');
    await submitInstruction(page, '在这里插入一句：这是新增的一句话。');
    await waitForProposal(page);
    await page.screenshot({ path: `${SHOT_DIR}/e2e-insert-review.png` });

    await page.locator('[data-testid="accept"]').click();
    await waitReviewClosed(page);

    const after = await readEditor(page);
    expect(after.length).toBeGreaterThan(before.length);
    expect(after).toContain('第二段内容保持不变。');
    // 原文前缀保持（选区外零改动）
    expect(after.startsWith(before.replace(/\n$/, ''))).toBe(true);

    await focusEditor(page);
    await page.keyboard.press('Control+z');
    await expect.poll(async () => readEditor(page), { timeout: 10_000 }).toBe(before);
  });
});

test.describe('响应式布局', () => {
  test('窄屏下指令条可用且截图留档', async ({ page }) => {
    await page.setViewportSize({ width: 520, height: 900 });
    await page.goto('/');
    await setDocument(page, TEST_DOC);
    await selectLine(page, 0);
    await openCommandBar(page);
    await expect(page.locator('[data-testid="command-input"]')).toBeVisible();
    const box = await page.locator('[data-testid="command-bar"]').boundingBox();
    expect(box).not.toBeNull();
    // 指令条在窄屏下应基本占满宽度（不要求像素精确）
    expect(box!.width).toBeGreaterThan(460);
    await page.screenshot({ path: `${SHOT_DIR}/e2e-narrow-command.png` });
    await page.locator('[data-testid="command-cancel"]').click();
    await expect(page.locator('[data-testid="command-bar"]')).toHaveCount(0);
  });
});
