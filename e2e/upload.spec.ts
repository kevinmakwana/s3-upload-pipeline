import { readFile } from 'node:fs/promises';
import { expect, test, type Page, type Route } from '@playwright/test';
import { asUpload, binaryFile, MiB, pngFile, sha256 } from './support';

const fileInput = (page: Page) => page.getByTestId('file-input');

/** The finished row shows the worker's SHA-256; the full hash is in its tooltip. */
const checksum = (page: Page, hash: string) => page.locator(`[title="${hash}"]`);

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByText('Live updates')).toBeVisible();
});

test('uploads a multi-part file, processes it, downloads the same bytes, and deletes it', async ({ page }) => {
  const file = binaryFile('multipart.bin', 12 * MiB); // three parts at 5 MiB
  await fileInput(page).setInputFiles(asUpload(file));

  await expect(page.getByRole('heading', { name: file.name })).toBeVisible();
  await expect(checksum(page, file.sha256)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByRole('list', { name: 'Progress' }).getByText('Ready')).toBeVisible();

  const download = page.waitForEvent('download');
  await page.getByRole('button', { name: 'Download' }).click();
  const saved = await (await download).path();
  expect(sha256(await readFile(saved))).toBe(file.sha256);

  await page.getByRole('button', { name: 'Delete', exact: true }).click();
  await page.getByRole('button', { name: 'Delete permanently' }).click();
  await expect(page.getByText('No files yet')).toBeVisible();

  // Gone for good, not just hidden: a reload does not bring it back.
  await page.reload();
  await expect(page.getByText('No files yet')).toBeVisible();
});

test('reads the dimensions of an image and shows its thumbnail', async ({ page }) => {
  const image = pngFile('gradient.png', 64, 48);
  await fileInput(page).setInputFiles(asUpload(image));

  await expect(checksum(page, image.sha256)).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('64 × 48 px')).toBeVisible();
  await expect(page.locator('img.thumb')).toBeVisible();
});

test('picks up an interrupted upload after a reload instead of starting over', async ({ page }) => {
  const file = binaryFile('resume.bin', 22 * MiB, 7); // five parts at 5 MiB

  // Slow the parts down so there is time to interrupt. Preflight requests pass straight through. A request
  // still waiting when the page reloads is already abandoned by then, so continuing it may fail; that is fine.
  const slowParts = async (route: Route) => {
    if (route.request().method() === 'PUT') await new Promise((resolve) => setTimeout(resolve, 1500));
    await route.continue().catch(() => undefined);
  };
  await page.route('**/*partNumber=*', slowParts);

  // One part at a time makes "some parts done, some not" easy to hit.
  const fewer = page.getByRole('button', { name: 'Fewer parallel parts' });
  while (await fewer.isEnabled()) await fewer.click();

  await fileInput(page).setInputFiles(asUpload(file));
  await expect(page.getByText(/^[1-4] of 5 parts$/)).toBeVisible({ timeout: 60_000 });

  await page.reload();
  await page.unroute('**/*partNumber=*', slowParts);

  // The row comes back from the browser's storage, saying how far it got, and asks for the file again.
  await expect(page.getByText(/Interrupted with [1-4] of 5 parts uploaded/)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose file to resume' })).toBeVisible();

  await page.getByTestId('resume-input').setInputFiles(asUpload(file));
  await expect(checksum(page, file.sha256)).toBeVisible({ timeout: 60_000 });
});
