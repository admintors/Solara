'use strict';

const assert = require('node:assert/strict');
const { chromium } = require('playwright');

const origin = process.env.SOLARA_E2E_ORIGIN || 'http://127.0.0.1:18787';
const password = process.env.SOLARA_E2E_PASSWORD;
if (!password) throw new Error('SOLARA_E2E_PASSWORD is required');

(async () => {
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1280, height: 900 } });
    await context.route('https://**/*', route => route.abort());
    const page = await context.newPage();
    const pageErrors = [];
    page.on('pageerror', error => pageErrors.push(error.message));

    const home = await context.request.get(origin + '/', { maxRedirects: 0 });
    assert.equal(home.status(), 302, 'unauthenticated homepage should redirect');
    assert.equal(new URL(home.headers().location, origin).pathname, '/login');

    const api = await context.request.get(origin + '/api/me/bootstrap', { maxRedirects: 0 });
    assert.equal(api.status(), 401, 'unauthenticated API should remain unauthorized');

    await page.goto(origin + '/', { waitUntil: 'domcontentloaded' });
    assert.equal(new URL(page.url()).pathname, '/login');

    await page.locator('#login-username').fill('ci-admin');
    await page.locator('#login-password').fill(password);
    await Promise.all([
      page.waitForURL(url => url.origin === origin && url.pathname === '/', { timeout: 20000 }),
      page.locator('#login-form button[type="submit"]').click(),
    ]);

    await page.locator('#solaraAccountBar').waitFor({ state: 'visible', timeout: 20000 });
    await page.waitForFunction(() => {
      const startup = document.getElementById('authStartupStatus');
      return document.documentElement.dataset.solaraAppReady === 'true'
        || startup?.dataset.error === 'true';
    }, null, { timeout: 30000 });
    const ready = await page.evaluate(() => document.documentElement.dataset.solaraAppReady === 'true');
    const startupMessage = await page.locator('#authStartupStatus').textContent().catch(() => '');
    assert.equal(ready, true, 'native player startup failed: ' + startupMessage + '; page errors: ' + pageErrors.join(' | '));
    assert.equal(await page.locator('#audioPlayer').count(), 1, 'native player element should remain mounted');

    await page.getByRole('button', { name: '恢复设备进度' }).click();
    const dialog = page.locator('dialog.named-playlist-dialog');
    await dialog.waitFor({ state: 'visible', timeout: 5000 });
    assert.equal(await dialog.evaluate(node => node.open || node.hasAttribute('open')), true, 'resume dialog should open');
    assert.match(await dialog.locator('h2').innerText(), /恢复其他设备的进度/);
    assert.deepEqual(pageErrors, [], 'the page should start without uncaught JavaScript errors');
    console.log('Browser checks passed: login, player startup, and resume dialog.');
  } finally {
    await browser.close();
  }
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
