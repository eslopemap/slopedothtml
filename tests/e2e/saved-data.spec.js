// @ts-nocheck — helpers.js custom fixtures aren't typed
const {
  APP_URL,
  test, expect, drawTrackAndFinish, getTrackCount,
  evalInScope,
} = require('./helpers');

test.describe('Saved Data panel', () => {

  test('Panel opens and shows 5 data categories', async ({ mapPage: page }) => {
    // Open Settings panel if collapsed
    const controlsPanel = page.locator('#controls');
    if (await controlsPanel.evaluate(el => el.classList.contains('collapsed'))) {
      await page.locator('#settings-controls-toggle').click();
      await page.waitForTimeout(100);
    }

    // Click the Saved data toggle
    await page.locator('#saved-data-toggle').click();
    await page.waitForTimeout(300);

    // Panel should be visible
    const panel = page.locator('#saved-data-panel');
    await expect(panel).not.toHaveClass(/collapsed/);

    // Should show 4 rows in web mode (Local tile cache, GPX tracks, Settings, All browser data)
    // Server tile cache is hidden in web mode
    const rows = panel.locator('.saved-data-row');
    await expect(rows).toHaveCount(4);

    // Check category labels
    const labels = await rows.locator('.saved-data-info strong').allTextContents();
    expect(labels).toEqual([
      'Local tile cache',
      'GPX tracks',
      'Settings',
      'All browser data',
    ]);
  });

  test('Panel toggle opens and closes', async ({ mapPage: page }) => {
    // Open Settings panel if collapsed
    const controlsPanel = page.locator('#controls');
    if (await controlsPanel.evaluate(el => el.classList.contains('collapsed'))) {
      await page.locator('#settings-controls-toggle').click();
      await page.waitForTimeout(100);
    }

    const toggle = page.locator('#saved-data-toggle');
    const panel = page.locator('#saved-data-panel');

    // Initially collapsed
    await expect(panel).toHaveClass(/collapsed/);

    // Open
    await toggle.click();
    await page.waitForTimeout(200);
    await expect(panel).not.toHaveClass(/collapsed/);

    // Close
    await toggle.click();
    await page.waitForTimeout(200);
    await expect(panel).toHaveClass(/collapsed/);
  });

  test('GPX tracks row shows size after drawing a track', async ({ mapPage: page }) => {
    // Draw a track to create some localStorage data
    await drawTrackAndFinish(page, 3);
    await page.waitForTimeout(400);

    expect(await getTrackCount(page)).toBe(1);

    // Open Settings + Saved Data panel
    const controlsPanel = page.locator('#controls');
    if (await controlsPanel.evaluate(el => el.classList.contains('collapsed'))) {
      await page.locator('#settings-controls-toggle').click();
      await page.waitForTimeout(100);
    }
    await page.locator('#saved-data-toggle').click();
    await page.waitForTimeout(300);

    // GPX tracks row should show non-zero size
    const sizeEl = page.locator('[data-testid="saved-data-size-gpx-tracks"]');
    const sizeText = await sizeEl.textContent();
    // Size should be > 0 (not starting with "0 B")
    expect(sizeText).not.toMatch(/^0 B/);
    // Should mention track count
    expect(sizeText).toContain('1 tracks');
  });

  test('Settings row shows non-zero size', async ({ mapPage: page }) => {
    // Change a setting to ensure persistence
    await page.evaluate(() => {
      const el = document.getElementById('pauseThreshold');
      el.value = '15';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(400);

    // Open Settings + Saved Data panel
    const controlsPanel = page.locator('#controls');
    if (await controlsPanel.evaluate(el => el.classList.contains('collapsed'))) {
      await page.locator('#settings-controls-toggle').click();
      await page.waitForTimeout(100);
    }
    await page.locator('#saved-data-toggle').click();
    await page.waitForTimeout(300);

    const sizeEl = page.locator('[data-testid="saved-data-size-settings"]');
    const sizeText = await sizeEl.textContent();
    expect(sizeText).not.toContain('0 B');

    const quotaEl = page.locator('[data-testid="saved-data-opfs-quota"]');
    await expect(quotaEl).toBeVisible();
    await expect(quotaEl).toContainText('OPFS quota:');
  });

  test('Clear GPX tracks button removes tracks on reload', async ({ mapPage: page }) => {
    // Draw a track
    await drawTrackAndFinish(page, 3);
    await page.waitForTimeout(400);
    expect(await getTrackCount(page)).toBe(1);

    // Open Settings + Saved Data panel
    const controlsPanel = page.locator('#controls');
    if (await controlsPanel.evaluate(el => el.classList.contains('collapsed'))) {
      await page.locator('#settings-controls-toggle').click();
      await page.waitForTimeout(100);
    }
    await page.locator('#saved-data-toggle').click();
    await page.waitForTimeout(300);

    // Accept the confirm dialog and click Clear
    page.on('dialog', dialog => dialog.accept());
    await page.locator('[data-testid="saved-data-clear-gpx-tracks"]').click();

    // Page will reload — wait for it
    await page.waitForFunction(
      () => { try { return (0, eval)('mapReady'); } catch { return false; } },
      { timeout: 5_000 }
    );
    await page.waitForTimeout(300);

    // Tracks should be cleared
    expect(await getTrackCount(page)).toBe(0);
  });

  test('Clear all button removes everything on reload', async ({ mapPage: page }) => {
    // Draw a track and change a setting
    await drawTrackAndFinish(page, 3);
    await page.evaluate(() => {
      const el = document.getElementById('pauseThreshold');
      el.value = '20';
      el.dispatchEvent(new Event('input', { bubbles: true }));
    });
    await page.waitForTimeout(400);

    // Open Settings + Saved Data panel
    const controlsPanel = page.locator('#controls');
    if (await controlsPanel.evaluate(el => el.classList.contains('collapsed'))) {
      await page.locator('#settings-controls-toggle').click();
      await page.waitForTimeout(100);
    }
    await page.locator('#saved-data-toggle').click();
    await page.waitForTimeout(300);

    // Accept confirm and click Clear All
    page.on('dialog', dialog => dialog.accept());
    await page.locator('[data-testid="saved-data-clear-all-browser-data"]').click();

    // Page reloads
    await page.waitForFunction(
      () => { try { return (0, eval)('mapReady'); } catch { return false; } },
      { timeout: 5_000 }
    );
    await page.waitForTimeout(300);

    // Tracks gone
    expect(await getTrackCount(page)).toBe(0);
    // Settings back to default — pauseThreshold should be 5
    const val = await page.locator('#pauseThreshold').inputValue();
    expect(val).toBe('5');
  });

  test('Local tile cache row shows info about CacheStorage', async ({ mapPage: page }) => {
    // Open Settings + Saved Data panel
    const controlsPanel = page.locator('#controls');
    if (await controlsPanel.evaluate(el => el.classList.contains('collapsed'))) {
      await page.locator('#settings-controls-toggle').click();
      await page.waitForTimeout(100);
    }
    await page.locator('#saved-data-toggle').click();
    await page.waitForTimeout(300);

    const sizeEl = page.locator('[data-testid="saved-data-size-local-tile-cache"]');
    const sizeText = await sizeEl.textContent();
    // In test_mode, CacheStorage is available but may have 0 entries
    expect(sizeText).toMatch(/\d+ entries|Not available/);
  });
});
