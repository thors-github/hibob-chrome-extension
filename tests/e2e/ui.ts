import { expect, type Page } from '@playwright/test';

/** Navigate the real panel views; never rebuild a preview just to inspect it. */
export async function home(page: Page) {
  for (const id of ['day-back', 'run-details-back', 'tools-back', 'settings-back']) {
    const back = page.locator(`#${id}`);
    if (await back.isVisible()) await back.click();
  }
  await expect(page.locator('#month-view')).toBeVisible();
}

export async function settings(page: Page) {
  await home(page);
  await page.locator('#settings-toggle').click();
  await expect(page.locator('#settings-view')).toBeVisible();
}

export async function tools(page: Page, section: 'booking' | 'transfer' | 'connection') {
  await settings(page);
  await page.locator(`#${section === 'booking' ? 'booking-options' : section}-link`).click();
  await expect(page.locator('#tools-view')).toBeVisible();
  await expect(page.locator(`#${section === 'booking' ? 'booking-options' : `${section}-options`}`)).toBeVisible();
}

export async function day(page: Page, date: string) {
  await home(page);
  await page.locator(`#calendar-${date}`).click();
  await expect(page.locator('#day-view')).toBeVisible();
  await expect(page.locator(`#day-content [data-date="${date}"]`)).toBeVisible();
}

export async function checks(page: Page) {
  if (!(await page.locator('#additional-checks').isVisible())) await page.locator('#review-checks').click();
  await expect(page.locator('#additional-checks')).toBeVisible();
}
