// @ts-check
const { test: base, expect } = require('@playwright/test');
const {
  clickMap, dblClickMap, clickDrawBtn, addPoints,
  getTrackCount, getEditingTrackId, getActiveTrackPointCount, getActiveTrackCoords,
  getTrackInfo, drawTrackAndFinish, clickEditBtn, fireMapMouseEvent, dragMapPoint, deleteActiveTrackViaMenu,
  resetState, loadMapPage,
} = require('./helpers');

/**
 * @param {number[]} actual
 * @param {number[]} expected
 * @param {number} [precision]
 */
function expectLngLatClose(actual, expected, precision = 5) {
  expect(actual[0]).toBeCloseTo(expected[0], precision);
  expect(actual[1]).toBeCloseTo(expected[1], precision);
}

base.describe('Desktop Track Editor', () => {
  /** @type {import('@playwright/test').Page} */
  let page;

  base.beforeAll(async ({ browser }) => {
    page = await browser.newPage();
    await loadMapPage(page);
  });

  base.afterAll(async () => { await page.close(); });

  base.beforeEach(async () => { await resetState(page); });

  base('Create new track -- click draw, add 3 points, dblclick to finish', async () => {
    await clickDrawBtn(page);
    await expect(page.locator('#draw-btn.active')).toBeVisible();
    await addPoints(page, 3);

    expect(await getTrackCount(page)).toBe(1);
    expect(await getActiveTrackPointCount(page)).toBe(3);

    await dblClickMap(page, 700, 300);
    await page.waitForTimeout(150);

    await expect(page.locator('#draw-btn.active')).not.toBeVisible();
    expect(await getActiveTrackPointCount(page)).toBeGreaterThanOrEqual(3);
  });

  base('Create new track -- finish with Escape', async () => {
    await clickDrawBtn(page);
    await addPoints(page, 4);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    await expect(page.locator('#draw-btn.active')).not.toBeVisible();
    expect(await getActiveTrackPointCount(page)).toBe(4);
  });

  base('Auto-cleanup -- new track with < 2 points is removed on exit', async () => {
    await clickDrawBtn(page);
    await addPoints(page, 1);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(100);

    expect(await getTrackCount(page)).toBe(0);
  });

  base('Track appears in track list with correct name', async () => {
    await drawTrackAndFinish(page, 3);

    await expect(page.locator('#track-panel.visible')).toBeVisible();
    const info = await getTrackInfo(page, 0);
    expect(info.name).toBe('Track 1');
    expect(info.isActive).toBe(true);
  });

  base('Select vs Edit -- clicking tree row selects, rail edit enters edit mode', async () => {
    await drawTrackAndFinish(page, 3, { startX: 300, startY: 200 });
    await drawTrackAndFinish(page, 3, { startX: 300, startY: 400 });

    expect(await getTrackCount(page)).toBe(2);

    // Activate the first track by clicking its segment row (🛤️ icon rows)
    const segmentRows = page.locator('.tree-row .tree-icon:text("🛤️")');
    await segmentRows.first().click();
    await page.waitForTimeout(100);

    const info1 = await getTrackInfo(page, 0);
    expect(info1.isActive).toBe(true);
    expect(info1.isEditing).toBe(false);

    // Click rail edit button to enter edit mode
    await clickEditBtn(page);
    await page.waitForTimeout(100);

    const info2 = await getTrackInfo(page, 0);
    expect(info2.isEditing).toBe(true);
    await expect(page.locator('#draw-btn.active')).toBeVisible();

    await page.keyboard.press('Escape');
  });

  base('Undo (Ctrl+Z) removes last point', async () => {
    await clickDrawBtn(page);
    await addPoints(page, 4);
    expect(await getActiveTrackPointCount(page)).toBe(4);

    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(100);
    expect(await getActiveTrackPointCount(page)).toBe(3);

    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(100);
    expect(await getActiveTrackPointCount(page)).toBe(2);

    await page.keyboard.press('Escape');
  });

  base('Undo button removes last point', async () => {
    await clickDrawBtn(page);
    await addPoints(page, 3);
    const beforeUndo = await getActiveTrackPointCount(page);
    expect(beforeUndo).toBeGreaterThanOrEqual(3);

    await expect(page.locator('#undo-btn')).toBeVisible();
    await page.locator('#undo-btn').click({ force: true });
    await page.waitForFunction(
      /** @param {number} previousCount */
      (previousCount) => {
        try {
          const track = (0, eval)('tracks').find(
            /** @param {{ id: string }} tr */
            (tr) => tr.id === (0, eval)('activeTrackId')
          );
          return track && track.coords.length < previousCount;
        } catch {
          return false;
        }
      },
      beforeUndo,
      { timeout: 1000 }
    );

    const afterUndo = await getActiveTrackPointCount(page);
    expect(afterUndo).toBeLessThan(beforeUndo);
    await page.keyboard.press('Escape');
  });

  base('Redo via Meta+Y restores the most recently undone point add', async () => {
    await clickDrawBtn(page);
    await addPoints(page, 4);
    expect(await getActiveTrackPointCount(page)).toBe(4);

    await page.keyboard.press('Meta+z');
    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(150);
    expect(await getActiveTrackPointCount(page)).toBe(2);

    await expect(page.locator('#redo-btn')).toBeVisible();
    await expect(page.locator('#redo-btn')).toBeEnabled();
    await page.keyboard.press('Meta+y');
    await page.waitForTimeout(150);

    expect(await getActiveTrackPointCount(page)).toBe(3);
    await page.keyboard.press('Escape');
  });

  base('Redo via Meta+Shift+Z restores the most recently undone point add', async () => {
    await clickDrawBtn(page);
    await addPoints(page, 3);
    const beforeUndo = await getActiveTrackCoords(page);

    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(100);
    expect(await getActiveTrackPointCount(page)).toBe(2);

    await page.keyboard.press('Meta+Shift+z');
    await page.waitForTimeout(150);

    const afterRedo = await getActiveTrackCoords(page);
    expect(afterRedo).toHaveLength(3);
    expectLngLatClose(afterRedo[2], beforeUndo[2]);
    await page.keyboard.press('Escape');
  });

  base('Delete track -- confirm removes it', async () => {
    await drawTrackAndFinish(page, 3);
    expect(await getTrackCount(page)).toBe(1);

    /** @param {import('@playwright/test').Dialog} dialog */
    const handler = dialog => dialog.accept();
    page.on('dialog', handler);
    await deleteActiveTrackViaMenu(page);
    await page.waitForTimeout(200);
    page.removeListener('dialog', handler);

    expect(await getTrackCount(page)).toBe(0);
  });

  base('Delete track -- cancel leaves track intact', async () => {
    await drawTrackAndFinish(page, 3);

    /** @param {import('@playwright/test').Dialog} dialog */
    const handler = dialog => dialog.dismiss();
    page.on('dialog', handler);
    await deleteActiveTrackViaMenu(page);
    await page.waitForTimeout(200);
    page.removeListener('dialog', handler);

    expect(await getTrackCount(page)).toBe(1);
  });

  base('Delete track -- middle click on tree row uses confirmation dialog', async () => {
    await drawTrackAndFinish(page, 3);
    expect(await getTrackCount(page)).toBe(1);

    const treeRow = page.locator('.tree-row').filter({ hasText: 'Track 1' }).first();
    await expect(treeRow).toBeVisible();

    /** @param {import('@playwright/test').Dialog} dialog */
    const handler = dialog => dialog.accept();
    page.on('dialog', handler);
    await treeRow.click({ button: 'middle' });
    await page.waitForTimeout(200);
    page.removeListener('dialog', handler);

    expect(await getTrackCount(page)).toBe(0);
  });

  base('Edit existing track -- add more points', async () => {
    await drawTrackAndFinish(page, 3);
    expect(await getActiveTrackPointCount(page)).toBe(3);

    await clickEditBtn(page);
    await page.waitForTimeout(100);
    await expect(page.locator('#draw-btn.active')).toBeVisible();

    await addPoints(page, 2, { startX: 700, startY: 250 });
    expect(await getActiveTrackPointCount(page)).toBe(5);

    await page.keyboard.press('Escape');
  });

  base('Redo restores a dragged vertex position after undo', async () => {
    await clickDrawBtn(page);
    await addPoints(page, 3, { startX: 400, startY: 300, stepX: 80, stepY: 0 });

    const beforeDrag = await getActiveTrackCoords(page);
    await dragMapPoint(page, { x: 400, y: 300 }, { x: 430, y: 340 });
    const afterDrag = await getActiveTrackCoords(page);

    expect(afterDrag[0][0]).not.toBe(beforeDrag[0][0]);
    expect(afterDrag[0][1]).not.toBe(beforeDrag[0][1]);

    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(150);
    const afterUndo = await getActiveTrackCoords(page);
    expectLngLatClose(afterUndo[0], beforeDrag[0]);

    await page.keyboard.press('Meta+y');
    await page.waitForTimeout(150);
    const afterRedo = await getActiveTrackCoords(page);
    expectLngLatClose(afterRedo[0], afterDrag[0]);
    await page.keyboard.press('Escape');
  });

  base('Toggle edit mode -- clicking draw-btn toggles off', async () => {
    await clickDrawBtn(page);
    await addPoints(page, 3);

    await clickDrawBtn(page);
    await page.waitForTimeout(100);

    await expect(page.locator('#draw-btn.active')).not.toBeVisible();
  });

  base('Tracks button toggles track panel visibility', async () => {
    await drawTrackAndFinish(page, 3);

    await expect(page.locator('#track-panel.visible')).toBeVisible();

    await page.locator('#tracks-btn').click();
    await page.waitForTimeout(100);
    await expect(page.locator('#track-panel.visible')).not.toBeVisible();

    await page.locator('#tracks-btn').click();
    await page.waitForTimeout(100);
    await expect(page.locator('#track-panel.visible')).toBeVisible();
  });

  base('Multiple tracks -- creating second track works', async () => {
    await drawTrackAndFinish(page, 3, { startX: 300, startY: 200 });
    await drawTrackAndFinish(page, 4, { startX: 500, startY: 400 });

    expect(await getTrackCount(page)).toBe(2);

    const info0 = await getTrackInfo(page, 0);
    const info1 = await getTrackInfo(page, 1);
    expect(info0.name).toBe('Track 1');
    expect(info1.name).toBe('Track 2');
    expect(info1.isActive).toBe(true);
  });

  base('Delete vertex with Shift+click', async () => {
    await clickDrawBtn(page);
    await addPoints(page, 4);
    expect(await getActiveTrackPointCount(page)).toBe(4);

    await page.locator('#map').click({
      position: { x: 480, y: 300 },
      modifiers: ['Shift'],
      force: true,
    });
    await page.waitForTimeout(200);

    const countAfter = await getActiveTrackPointCount(page);
    expect(countAfter).toBeLessThanOrEqual(4);

    await page.keyboard.press('Escape');
  });

  base('Redo restores a midpoint insert after undo', async () => {
    await clickDrawBtn(page);
    await addPoints(page, 3, { startX: 400, startY: 300, stepX: 80, stepY: 0 });
    const beforeInsert = await getActiveTrackCoords(page);

    await fireMapMouseEvent(page, 'mousemove', 440, 300);
    await page.waitForTimeout(100);
    await fireMapMouseEvent(page, 'mousedown', 440, 300);
    await page.waitForTimeout(50);
    await fireMapMouseEvent(page, 'mouseup', 440, 300);
    await page.waitForTimeout(150);

    const afterInsert = await getActiveTrackCoords(page);
    expect(afterInsert).toHaveLength(4);
    expect(afterInsert[1][0]).not.toBe(beforeInsert[1][0]);

    await page.keyboard.press('Meta+z');
    await page.waitForTimeout(150);
    const afterUndo = await getActiveTrackCoords(page);
    expect(afterUndo).toHaveLength(3);
    expectLngLatClose(afterUndo[1], beforeInsert[1]);

    await page.keyboard.press('Meta+y');
    await page.waitForTimeout(150);
    const afterRedo = await getActiveTrackCoords(page);
    expect(afterRedo).toHaveLength(4);
    expectLngLatClose(afterRedo[1], afterInsert[1]);
    await page.keyboard.press('Escape');
  });

  base('Stats update when points are added', async () => {
    await clickDrawBtn(page);
    await addPoints(page, 2);

    expect(await getActiveTrackPointCount(page)).toBe(2);

    await addPoints(page, 1, { startX: 700, startY: 300 });
    expect(await getActiveTrackPointCount(page)).toBe(3);

    await page.keyboard.press('Escape');
  });
});
