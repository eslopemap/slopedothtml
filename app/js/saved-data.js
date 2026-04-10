// Saved Data panel — shows storage usage per category with clear buttons.
// Works in both web (localStorage only) and desktop (localStorage + Tauri IPC).

import {
  getTrackStats, getSettingsStats, getAllStats,
  clearAll, clearTracks, clearSettings,
} from './persist.js';
import { isTauri, getCacheStats, clearTileCache, setTileCacheMaxSize } from './tauri-bridge.js';
import { getUserSources } from './layer-registry.js';
import { removeCustomTileSource } from './custom-tile-sources.js';

// ---- Helpers ----

function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function showToast(msg) {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.classList.add('visible');
  setTimeout(() => el.classList.remove('visible'), 2000);
}

// ---- Row builder ----

function buildRow(label, { path, size, detail, onClear, clearLabel }) {
  const row = document.createElement('div');
  row.className = 'saved-data-row';

  const info = document.createElement('div');
  info.className = 'saved-data-info';

  const title = document.createElement('strong');
  title.textContent = label;
  info.appendChild(title);

  if (path) {
    const pathEl = document.createElement('div');
    pathEl.className = 'saved-data-path';
    pathEl.textContent = path;
    pathEl.title = path;
    info.appendChild(pathEl);
  }

  const sizeEl = document.createElement('div');
  sizeEl.className = 'saved-data-size';
  sizeEl.textContent = size;
  if (detail) sizeEl.textContent += ` — ${detail}`;
  sizeEl.dataset.testid = `saved-data-size-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
  info.appendChild(sizeEl);

  row.appendChild(info);

  if (onClear) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'saved-data-clear-btn';
    btn.textContent = clearLabel || 'Clear';
    btn.dataset.testid = `saved-data-clear-${label.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;
    btn.addEventListener('click', async () => {
      const confirmMsg = `Clear ${label.toLowerCase()}?`;
      if (!confirm(confirmMsg)) return;
      await onClear();
      showToast(`${label} cleared`);
      // Refresh the panel after clearing
      await refreshPanel();
    });
    row.appendChild(btn);
  }

  return row;
}

// ---- Browser tile cache (CacheStorage) ----

async function getBrowserTileCacheStats() {
  if (typeof caches === 'undefined') return null;
  try {
    const keys = await caches.keys();
    // maplibre-contour uses 'demtiles' cache; maplibre-gl may use others
    let totalSize = 0;
    let totalCount = 0;
    const cacheNames = [];
    for (const name of keys) {
      const cache = await caches.open(name);
      const cacheKeys = await cache.keys();
      totalCount += cacheKeys.length;
      cacheNames.push(name);
      // CacheStorage doesn't expose size directly; estimate from response bodies
      for (const req of cacheKeys) {
        try {
          const resp = await cache.match(req);
          if (resp) {
            const buf = await resp.clone().arrayBuffer();
            totalSize += buf.byteLength;
          }
        } catch { /* skip unreadable entries */ }
      }
    }
    return { totalSize, totalCount, cacheNames };
  } catch { return null; }
}

async function clearBrowserTileCache() {
  if (typeof caches === 'undefined') return;
  try {
    const keys = await caches.keys();
    for (const name of keys) {
      await caches.delete(name);
    }
  } catch { /* ignore */ }
}

async function getStorageEstimate() {
  if (typeof navigator === 'undefined' || !navigator.storage?.estimate) return null;
  try {
    return await navigator.storage.estimate();
  } catch {
    return null;
  }
}

// ---- Panel refresh ----

let _panelEl = null;

async function refreshPanel() {
  const panel = _panelEl;
  if (!panel) return;

  const container = panel.querySelector('#saved-data-rows');
  if (!container) return;
  container.innerHTML = '';

  // 1. Local JS tile cache (CacheStorage)
  const browserCache = await getBrowserTileCacheStats();
  if (browserCache) {
    container.appendChild(buildRow('Local tile cache', {
      size: formatBytes(browserCache.totalSize),
      detail: `${browserCache.totalCount} entries` + (browserCache.cacheNames.length ? ` in ${browserCache.cacheNames.join(', ')}` : ''),
      onClear: clearBrowserTileCache,
    }));
  } else {
    container.appendChild(buildRow('Local tile cache', {
      size: 'Not available',
      detail: 'CacheStorage API not supported',
    }));
  }

  // 2. Server-side tile cache (Tauri only)
  if (isTauri()) {
    const stats = await getCacheStats();
    if (stats) {
      const row = buildRow('Server tile cache', {
        path: stats.root,
        size: formatBytes(stats.total_size_bytes),
        detail: `${stats.file_count} tiles`,
        onClear: clearTileCache,
      });
      // Editable max-size control
      const maxSizeCtrl = document.createElement('div');
      maxSizeCtrl.className = 'saved-data-max-size';
      const label = document.createElement('span');
      label.textContent = 'Max: ';
      const input = document.createElement('input');
      input.type = 'number';
      input.min = '10';
      input.max = '10000';
      input.step = '10';
      input.value = String(Math.round(stats.max_size_bytes / (1024 * 1024)));
      input.style.width = '5em';
      input.title = 'Maximum cache size in MB';
      const unitLabel = document.createElement('span');
      unitLabel.textContent = ' MB';
      input.addEventListener('change', async () => {
        const mb = Math.max(10, Number(input.value) || 100);
        input.value = String(mb);
        await setTileCacheMaxSize(mb);
        showToast(`Cache max size set to ${mb} MB`);
        await refreshPanel();
      });
      maxSizeCtrl.append(label, input, unitLabel);
      row.querySelector('.saved-data-info').appendChild(maxSizeCtrl);
      container.appendChild(row);
    }
  }

  // 3. Custom user sources (if any)
  const userSources = getUserSources().filter(src => src?.persistence !== 'desktop-runtime');
  if (userSources.length > 0) {
    const heading = document.createElement('div');
    heading.className = 'saved-data-section-heading';
    heading.innerHTML = `<strong>Custom sources</strong> <span style="opacity:0.6">(${userSources.length})</span>`;
    container.appendChild(heading);
    for (const src of userSources) {
      const row = document.createElement('div');
      row.className = 'saved-data-row saved-data-source-row';
      const info = document.createElement('div');
      info.className = 'saved-data-info';
      const nameEl = document.createElement('span');
      nameEl.textContent = src.label || src.id;
      nameEl.title = src.id;
      info.appendChild(nameEl);
      row.appendChild(info);

      const delBtn = document.createElement('button');
      delBtn.type = 'button';
      delBtn.className = 'saved-data-clear-btn';
      delBtn.textContent = 'Remove';
      delBtn.title = `Remove custom source: ${src.label || src.id}`;
      delBtn.addEventListener('click', async () => {
        if (!confirm(`Remove custom source "${src.label || src.id}"?`)) return;
        await removeCustomTileSource(src.id);
        showToast(`Removed ${src.label || src.id}`);
        await refreshPanel();
      });
      row.appendChild(delBtn);
      container.appendChild(row);
    }
  }

  // 4. GPX tracks & waypoints
  const trackStats = getTrackStats();
  container.appendChild(buildRow('GPX tracks', {
    path: 'localStorage (slope:tracks, slope:waypoints, slope:workspace)',
    size: formatBytes(trackStats.bytes),
    detail: `${trackStats.trackCount} tracks, ${trackStats.waypointCount} waypoints`,
    onClear: () => { clearTracks(); location.reload(); },
    clearLabel: 'Clear & reload',
  }));

  // 5. Settings
  const settingsStats = getSettingsStats();
  const settingsRow = buildRow('Settings', {
    path: 'localStorage (slope:settings, slope:profile-settings)',
    size: formatBytes(settingsStats.bytes),
    onClear: () => { clearSettings(); location.reload(); },
    clearLabel: 'Reset & reload',
  });
  const storageEstimate = await getStorageEstimate();
  if (storageEstimate) {
    const quota = storageEstimate.quota ?? 0;
    const usage = storageEstimate.usage ?? 0;
    const quotaEl = document.createElement('div');
    quotaEl.className = 'saved-data-size';
    quotaEl.textContent = `OPFS quota: ${formatBytes(usage)} / ${formatBytes(quota)}`;
    quotaEl.dataset.testid = 'saved-data-opfs-quota';
    settingsRow.querySelector('.saved-data-info').appendChild(quotaEl);
  }
  container.appendChild(settingsRow);

  // 6. All browser data
  const allStats = getAllStats();
  container.appendChild(buildRow('All browser data', {
    path: `localStorage (${allStats.keyCount} slope:* keys)`,
    size: formatBytes(allStats.bytes),
    onClear: () => { clearAll(); location.reload(); },
    clearLabel: 'Clear all & reload',
  }));
}

// ---- Init ----

export function initSavedDataPanel() {
  _panelEl = document.getElementById('saved-data-panel');
  if (!_panelEl) return;

  const toggle = document.getElementById('saved-data-toggle');
  if (toggle) {
    toggle.addEventListener('click', async () => {
      const isOpen = !_panelEl.classList.contains('collapsed');
      _panelEl.classList.toggle('collapsed', isOpen);
      toggle.classList.toggle('open', !isOpen);
      if (!isOpen) await refreshPanel();
    });
  }
}

export { refreshPanel as refreshSavedData };
