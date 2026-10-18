/**
 * E2E：DOCX → Markdown 导入。
 *
 * 运行前提：http://127.0.0.1:5199 上 DocMax dev server 已启动（无需 API Key，转换不调用模型）。
 * 运行：node node_modules/@playwright/test/cli.js test e2e/docx-import.spec.ts
 *
 * 说明：真实 Chrome 的 File System Access Picker 无法在 headless 下操作，
 * 测试里把 window.showOpenFilePicker 置空，让前端走 <input type=file> 兜底，
 * 再用 Playwright 的 filechooser 事件注入夹具文件。
 */
import { expect, test, type Page } from '@playwright/test';
import { resolve } from 'node:path';

const SHOT_DIR = '.artifacts';
const BASIC_DOCX = resolve('tests/fixtures/docx/basic.docx');
const IMAGES_DOCX = resolve('tests/fixtures/docx/images.docx');

async function readEditor(page: Page): Promise<string> {
  return page.evaluate(() => {
    const root = document.querySelector('[data-testid="editor"]');
    if (!root) return '';
    return Array.from(root.querySelectorAll('.cm-line'))
      .map((line) => line.textContent ?? '')
      .join('\n');
  });
}

/** 让选择器走 input 兜底（headless 下无法操作系统文件选择器） */
async function stubFilePicker(page: Page): Promise<void> {
  await page.addInitScript(() => {
    try {
      Object.defineProperty(window, 'showOpenFilePicker', { value: undefined, configurable: true });
    } catch {
      // ignore
    }
  });
}

/** 点击「导入 Word」并通过 filechooser 注入文件，等待转换完成 */
async function pickDocx(page: Page, fixturePath: string): Promise<void> {
  const chooserPromise = page.waitForEvent('filechooser');
  await page.locator('[data-testid="import-docx"]').click();
  const chooser = await chooserPromise;
  await chooser.setFiles(fixturePath);
  await expect(page.locator('[data-testid="docx-import-dialog"]')).toBeVisible({ timeout: 20_000 });
  await expect(page.locator('[data-testid="docx-import-stats"]')).toBeVisible({ timeout: 30_000 });
}

test.describe('DOCX 导入', () => {
  test('导入 .docx：摘要 / Markdown 预览 / 确认后替换文档', async ({ page }) => {
    const consoleErrors: string[] = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    await stubFilePicker(page);
    await page.goto('/');

    // 先放一份会被替换的旧文档
    const editor = page.locator('[data-testid="editor"]');
    await editor.click();
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText('这是即将被 Word 文档替换的旧内容。\n');

    await pickDocx(page, BASIC_DOCX);

    // 摘要与预览
    const dialog = page.locator('[data-testid="docx-import-dialog"]');
    await expect(dialog).toContainText('导入 Word 文档');
    await expect(page.locator('[data-testid="docx-import-stats"]')).toContainText('标题');
    await expect(page.locator('[data-testid="docx-import-stats"]')).toContainText('表格');
    const preview = await page.locator('[data-testid="docx-import-preview"]').textContent();
    expect(preview).toContain('# DocMax 导入测试');
    expect(preview).toContain('第一章 基本结构');
    expect(preview).toContain('粗体文字');
    await page.screenshot({ path: `${SHOT_DIR}/e2e-docx-import-dialog.png`, fullPage: true });

    // 确认替换
    await page.locator('[data-testid="docx-import-confirm"]').click();
    await expect(dialog).toHaveCount(0, { timeout: 10_000 });
    const text = await readEditor(page);
    expect(text).toContain('# DocMax 导入测试');
    expect(text).toContain('第一章 基本结构');
    expect(text).toContain('| 姓名 | 角色 | 备注 |');
    expect(text).toContain('const answer: number = 42;');
    await expect(page.locator('[data-testid="doc-title"]')).toHaveValue('DocMax 导入测试');
    await expect(page.locator('[data-testid="toast"]')).toContainText('已导入 Word 文档');
    await page.screenshot({ path: `${SHOT_DIR}/e2e-docx-import-applied.png`, fullPage: true });

    expect(consoleErrors.filter((text) => /404|Failed to load resource/i.test(text))).toEqual([]);
  });

  test('取消导入：文档保持不变', async ({ page }) => {
    await stubFilePicker(page);
    await page.goto('/');
    await page.locator('[data-testid="editor"]').click();
    await page.keyboard.press('Control+a');
    await page.keyboard.insertText('原始内容，不能被导入取消操作改变。\n');
    const before = await readEditor(page);

    await pickDocx(page, BASIC_DOCX);
    await page.locator('[data-testid="docx-import-cancel"]').click();
    await expect(page.locator('[data-testid="docx-import-dialog"]')).toHaveCount(0);
    expect(await readEditor(page)).toBe(before);
  });

  test('图片占位：摘要提示 + 预览中的占位符', async ({ page }) => {
    await stubFilePicker(page);
    await page.goto('/');
    await pickDocx(page, IMAGES_DOCX);
    await expect(page.locator('[data-testid="docx-import-warnings"]')).toContainText('图片');
    const preview = await page.locator('[data-testid="docx-import-preview"]').textContent();
    expect(preview).toContain('[图片占位 1：image/png');
    expect(preview).not.toContain('data:image');
    await page.screenshot({ path: `${SHOT_DIR}/e2e-docx-import-images.png`, fullPage: true });
    await page.locator('[data-testid="docx-import-cancel"]').click();
  });

  test('非 docx 文件：显示可读错误并允许重试/关闭', async ({ page }) => {
    await stubFilePicker(page);
    await page.goto('/');
    const chooserPromise = page.waitForEvent('filechooser');
    await page.locator('[data-testid="import-docx"]').click();
    const chooser = await chooserPromise;
    await chooser.setFiles({
      name: 'broken.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: Buffer.from('this is not a zip file'),
    });
    await expect(page.locator('[data-testid="docx-import-error"]')).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[data-testid="docx-import-error"]')).toContainText('不是有效的 .docx');
    await expect(page.locator('[data-testid="docx-import-retry"]')).toBeVisible();
    await page.locator('[data-testid="docx-import-cancel"]').click();
    await expect(page.locator('[data-testid="docx-import-dialog"]')).toHaveCount(0);
  });
});
