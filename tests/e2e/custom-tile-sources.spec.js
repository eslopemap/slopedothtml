// E2E tests for custom TileJSON source management (web mode).
// Verifies add/remove/persist lifecycle via the JS API and the "Add TileJSON…" button.

const { test: base, expect } = require('@playwright/test');
const path = require('path');
const { startTileServer, FIXTURES } = require('./tile-server-helper');

const APP_URL = '/app/index.html#test_mode=true';
const MAP_READY_TIMEOUT_MS = 10_000;

const test = base.extend({
  tileServer: [async ({}, use) => {
    const MBTILES_PATH = path.join(FIXTURES, 'dummy-z1-z3.mbtiles');
    const srv = await startTileServer({
      'custom-src': { path: MBTILES_PATH, kind: 'mbtiles' },
    });
    await use(srv);
    srv.close();
  }, { scope: 'worker' }],
});

async function loadApp(page) {
  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.evaluate(() => localStorage.clear());
  await page.goto(APP_URL, { waitUntil: 'load' });
  await page.waitForFunction(
    () => { try { return (0, eval)('mapReady'); } catch { return false; } },
    { timeout: MAP_READY_TIMEOUT_MS }
  );
}

test.describe('Custom TileJSON Sources (web mode)', () => {

  test('addCustomTileSource registers and persists a source across reload', async ({ page, tileServer }) => {
    await loadApp(page);

    // Add a custom source via the JS API
    const entryId = await page.evaluate(async ({ tileBaseUrl }) => {
      const { addCustomTileSource } = await import('/app/js/custom-tile-sources.js');
      const entry = await addCustomTileSource({
        id: 'e2e-test',
        name: 'E2E Test Source',
        tiles: [`${tileBaseUrl}/tiles/custom-src/{z}/{x}/{y}.png`],
      }, { refreshUi: (0, eval)('refreshTileLayers') });
      return entry.id;
    }, { tileBaseUrl: tileServer.url });

    expect(entryId).toBe('tilejson-e2e-test');

    // Verify it appears in the catalog
    const catalogCheck = await page.evaluate(() => {
      const registry = (0, eval)('layerRegistry');
      const entry = registry.getUserSources().find(s => s.id === 'tilejson-e2e-test');
      return { found: !!entry, persistence: entry?.persistence, label: entry?.label };
    });
    expect(catalogCheck.found).toBe(true);
    expect(catalogCheck.persistence).toBe('browser');
    expect(catalogCheck.label).toBe('E2E Test Source');

    // Verify it appears in the "Add layer" dropdown
    const optionExists = await page.evaluate(() => {
      const sel = document.getElementById('add-layer');
      return Array.from(sel?.options ?? []).some(o => o.value.includes('tilejson-e2e-test'));
    });
    expect(optionExists).toBe(true);

    // Reload and verify persistence
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(
      () => { try { return (0, eval)('mapReady'); } catch { return false; } },
      { timeout: MAP_READY_TIMEOUT_MS }
    );
    await page.waitForTimeout(300);

    const afterReload = await page.evaluate(() => {
      const registry = (0, eval)('layerRegistry');
      const entry = registry.getUserSources().find(s => s.id === 'tilejson-e2e-test');
      return { found: !!entry, label: entry?.label };
    });
    expect(afterReload.found).toBe(true);
    expect(afterReload.label).toBe('E2E Test Source');
  });

  test('removeCustomTileSource removes a source and clears persistence', async ({ page, tileServer }) => {
    await loadApp(page);

    // Add then remove
    await page.evaluate(async ({ tileBaseUrl }) => {
      const { addCustomTileSource, removeCustomTileSource } = await import('/app/js/custom-tile-sources.js');
      await addCustomTileSource({
        id: 'to-remove',
        tiles: [`${tileBaseUrl}/tiles/custom-src/{z}/{x}/{y}.png`],
      });
      await removeCustomTileSource('tilejson-to-remove', { refreshUi: (0, eval)('refreshTileLayers') });
    }, { tileBaseUrl: tileServer.url });

    const gone = await page.evaluate(() => {
      const registry = (0, eval)('layerRegistry');
      return registry.getUserSources().find(s => s.id === 'tilejson-to-remove');
    });
    expect(gone).toBeFalsy();

    // Verify not persisted after reload
    await page.reload({ waitUntil: 'load' });
    await page.waitForFunction(
      () => { try { return (0, eval)('mapReady'); } catch { return false; } },
      { timeout: MAP_READY_TIMEOUT_MS }
    );
    await page.waitForTimeout(300);

    const afterReload = await page.evaluate(() => {
      const registry = (0, eval)('layerRegistry');
      return registry.getUserSources().find(s => s.id === 'tilejson-to-remove');
    });
    expect(afterReload).toBeFalsy();
  });

  test('desktop-runtime sources are NOT persisted to localStorage', async ({ page }) => {
    await loadApp(page);

    // Simulate registering a desktop-runtime source (as desktop-tile-sources.js would)
    await page.evaluate(() => {
      const registry = (0, eval)('layerRegistry');
      registry.registerUserSource({
        id: 'tilejson-runtime-only',
        label: 'Runtime Only',
        category: 'basemap',
        userDefined: true,
        persistence: 'desktop-runtime',
        sources: { 'src-tj-runtime-only': { type: 'raster', tiles: ['http://localhost/tiles/{z}/{x}/{y}.png'], tileSize: 256 } },
        layers: [{ id: 'basemap-tilejson-runtime-only', type: 'raster', source: 'src-tj-runtime-only', paint: {} }],
      });
    });

    // Verify it's in the catalog but NOT in localStorage
    const check = await page.evaluate(() => {
      const registry = (0, eval)('layerRegistry');
      const found = !!registry.getUserSources().find(s => s.id === 'tilejson-runtime-only');
      const stored = JSON.parse(localStorage.getItem('slope:user-sources') || '[]');
      const inStorage = stored.some(s => s.id === 'tilejson-runtime-only');
      return { found, inStorage };
    });
    expect(check.found).toBe(true);
    expect(check.inStorage).toBe(false);
  });

  test('.tilejson file import via importFileContent registers a custom source', async ({ page, tileServer }) => {
    await loadApp(page);

    const tileJson = JSON.stringify({
      tilejson: '3.0.0',
      name: 'Imported TileJSON',
      tiles: [`${tileServer.url}/tiles/custom-src/{z}/{x}/{y}.png`],
    });

    await page.evaluate(({ content }) => {
      (0, eval)('importFileContent')('my-source.tilejson', content);
    }, { content: tileJson });

    await page.waitForTimeout(500);

    const result = await page.evaluate(() => {
      const registry = (0, eval)('layerRegistry');
      const entry = registry.getUserSources().find(s => s.label === 'Imported TileJSON');
      return { found: !!entry, persistence: entry?.persistence };
    });
    expect(result.found).toBe(true);
    expect(result.persistence).toBe('browser');
  });

  test('middle click on a layer-order row removes it via confirmation dialog', async ({ page }) => {
    await loadApp(page);

    await page.evaluate(() => {
      (0, eval)('setBasemap')((0, eval)('map'), (0, eval)('state'), 'osm', false);
      (0, eval)('renderLayerOrderPanel')();
    });
    await page.waitForTimeout(200);

    const layerRow = page.locator('.layer-order-row .layer-order-name').filter({ hasText: 'OpenStreetMap' }).first();
    await expect(layerRow).toBeVisible();

    /** @param {import('@playwright/test').Dialog} dialog */
    const handler = dialog => dialog.accept();
    page.on('dialog', handler);
    await layerRow.click({ button: 'middle' });
    await page.waitForTimeout(200);
    page.removeListener('dialog', handler);

    await expect(page.locator('.layer-order-row .layer-order-name').filter({ hasText: 'OpenStreetMap' })).toHaveCount(0);
  });
});
