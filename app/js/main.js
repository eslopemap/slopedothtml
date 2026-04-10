// Entry point: creates map, imports modules, wires events.

import {
  DEM_HD_SOURCE_ID, DEM_MAX_Z, ANALYSIS_COLOR,
  DEM_TERRAIN_SOURCE_ID,
} from './constants.js';

import { createStore, STATE_DEFAULTS, STATE_TEST_MODE } from './state.js';

import {
  parseHashParams, syncViewToUrl, updateLegend,
  applyHillshadeVisibility, applyContourVisibility,
  applyTerrainState, applyModeState,
  basemapOpacityExpr, setGlobalStatePropertySafe, updateCursorInfoVisibility,
  setCursorInfo, showCursorTooltipAt, hideCursorTooltip,
  getDefaultViewState, getVisibleTriplesForMap, initSearch,
} from './ui.js';

import {
  getCatalogEntry, getBasemaps, getOverlays, getUserSources, getLayerIds,
  getAllEntries,
  registerUserSource, unregisterUserSource, clearUserSources,
} from './layer-registry.js';
import {
  setBasemap, setBasemapStack, setOverlay, applyAllOverlays, applyLayerOrder, applyAllLayerSettings,
  syncLayerOrder, reorderLayer, applyLayerOpacity, setLayerVisible, removeLayer,
  createBookmark, applyBookmark, deleteBookmark, renameBookmark,
  ensureCatalogEntry,
} from './layer-engine.js';

import {
  queryLoadedElevationAtLngLat,
} from './dem.js';

import { initTracks, getTracksState, resetForTest } from './tracks.js';
import { initProfile, updateProfile, getProfileChart } from './profile.js';
import { importFileContent } from './io.js';
import { loadSettings, saveSettings, loadUserSources } from './persist.js';
import { deriveInitialState, applyUrlOverrides } from './startup-state.js';
import { discoverAndRegisterDesktopTileSources } from './desktop-tile-sources.js';
import { addCustomTileSource, loadPersistedCustomTileSources } from './custom-tile-sources.js';
import { initShortcuts, registerShortcut } from './shortcuts.js';
import { openInfoEditor, openCurrentContextMenu } from './gpx-tree.js';
import { initSelectionTools, toggleRectangleMode, isRectangleModeActive, setRectangleMode, setActionPreview, clearSelection, getCurrentSelection } from './selection-tools.js';
import { describeOperationConsequence } from './track-ops.js';
import { initWebImport } from './web-import.js';
import { initSavedDataPanel } from './saved-data.js';

import { lonLatToTile, normalizeTileX, tileToLngLatBounds } from './utils.js';
import { buildCatalogEntryFromTileJson, getDemTileUrl, isTauri, onGpxSyncEvents, resolveConflict, loadGpx } from './tauri-bridge.js';
import { initPmtilesProtocol } from './pmtiles-protocol.js';

// ---- State (reactive via Proxy) ----
const state = createStore(STATE_DEFAULTS, handleStateChange);

function syncPrimaryControlsFromState(state) {
  document.getElementById('mode').value = state.mode;
  document.getElementById('terrain3d').checked = state.terrain3d;
  document.getElementById('terrainExaggeration').value = String(state.terrainExaggeration);
  document.getElementById('terrainExaggeration').disabled = !state.terrain3d;
  document.getElementById('terrainExaggerationValue').textContent = state.terrainExaggeration.toFixed(2);
  syncOverlayCheckboxes(state);
}

function handleStateChange(key) {
  if (
    key === 'mode'
    || key === 'terrain3d'
    || key === 'terrainExaggeration'
    || key === 'activeOverlays'
  ) {
    syncPrimaryControlsFromState(state);
  }
}

function migrateSettings(settings) {
  return settings;
}

// ---- Debug grid ----

function buildDebugGridGeoJSON(map) {
  const visible = getVisibleTriplesForMap(map);
  const features = [];
  const dedupe = new Set();

  for (const t of visible) {
    const id = `${t.z}/${t.x}/${t.y}`;
    if (dedupe.has(id)) continue;
    dedupe.add(id);

    const b = tileToLngLatBounds(t.x, t.y, t.z);
    features.push({
      type: 'Feature',
      properties: {id, z: t.z, x: t.x, y: t.y},
      geometry: {
        type: 'Polygon',
        coordinates: [[
          [b.west, b.north],
          [b.east, b.north],
          [b.east, b.south],
          [b.west, b.south],
          [b.west, b.north]
        ]]
      }
    });
  }

  return { type: 'FeatureCollection', features };
}

function updateDebugGridSource(map) {
  const src = map.getSource('dem-debug-grid');
  if (!src) return;
  src.setData(buildDebugGridGeoJSON(map));
}

function ensureDebugGridLayer(map) {
  if (!map.getSource('dem-debug-grid')) {
    map.addSource('dem-debug-grid', {
      type: 'geojson',
      data: {type: 'FeatureCollection', features: []}
    });
  }

  if (!map.getLayer('dem-debug-grid-line')) {
    map.addLayer({
      id: 'dem-debug-grid-line',
      type: 'line',
      source: 'dem-debug-grid',
      layout: {
        visibility: state.showTileGrid ? 'visible' : 'none'
      },
      paint: {
        'line-color': '#111111',
        'line-width': 1,
        'line-opacity': 0.8
      }
    });
  }
}

function applyTestModeMapState(map, state) {
  applyHillshadeVisibility(map, state);
  setGlobalStatePropertySafe(map, 'hillshadeOpacity', state.hillshadeOpacity);
  void setBasemapStack(map, state, state.basemapStack || []);
  applyAllOverlays(map, state);
  applyModeState(map, state);
  applyContourVisibility(map, state);
}

// ---- Initial view from URL hash + persisted settings ----

// Persisted settings as defaults, URL hash overrides
const persisted = loadSettings();
if (persisted) {
  // Migrate legacy per-overlay booleans → activeOverlays array
  migrateSettings(persisted);
  for (const k of Object.keys(persisted)) {
    if (persisted[k] !== undefined) state[k] = persisted[k];
  }
}

// Load custom user layers
if (!isTauri()) {
  const savedUserSources = loadUserSources();
  if (savedUserSources) {
    for (const src of savedUserSources) {
      registerUserSource({ ...src, persistence: src.persistence || 'browser' });
    }
  }
}

const hasUrlState = window.location.hash.includes('=');
const { initialView, isTestMode, shouldAttemptInitialGeolocate } = deriveInitialState({
  persistedSettings: persisted,
  urlOverrides: parseHashParams(),
  defaultView: getDefaultViewState(),
  hasUrlState,
});
if (Array.isArray(initialView.basemapStack)) state.basemapStack = [...initialView.basemapStack];
state.mode = initialView.mode;
state.slopeOpacity = initialView.slopeOpacity;
state.terrain3d = initialView.terrain3d;
state.terrainExaggeration = initialView.terrainExaggeration;
state.viewCenter = initialView.center;
state.viewZoom = initialView.zoom;
state.viewBearing = initialView.bearing;
state.viewPitch = initialView.pitch;
if (isTestMode) {
  Object.assign(state, STATE_TEST_MODE);
}
syncPrimaryControlsFromState(state);
// Sync additional persisted settings to UI
if (persisted) {
  if (persisted.basemapOpacity != null) {
    document.getElementById('basemapOpacity').value = String(state.basemapOpacity);
    document.getElementById('basemapOpacityValue').textContent = state.basemapOpacity.toFixed(2);
  }
  if (persisted.hillshadeMethod != null) {
    document.getElementById('hillshadeMethod').value = state.hillshadeMethod;
  }
  if (persisted.multiplyBlend != null) document.getElementById('multiplyBlend').checked = state.multiplyBlend;
  if (persisted.cursorInfoMode != null) document.getElementById('cursorInfoMode').value = state.cursorInfoMode;
  if (persisted.pauseThreshold != null) {
    document.getElementById('pauseThreshold').value = String(state.pauseThreshold);
    document.getElementById('pauseThresholdValue').textContent = state.pauseThreshold;
  }
  if (persisted.profileSmoothing != null) {
    syncProfileSmoothingControls();
  }
  if (persisted.showTileGrid != null) document.getElementById('showTileGrid').checked = state.showTileGrid;
}

// On mobile, default to corner cursor-info mode (center crosshair acts as pointer)
const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
if (isMobile && !(persisted && persisted.cursorInfoMode != null)) {
  state.cursorInfoMode = 'corner';
  document.getElementById('cursorInfoMode').value = 'corner';
}

// Debounced settings save
let _settingsSaveTimer = 0;
function scheduleSettingsSave() {
  clearTimeout(_settingsSaveTimer);
  _settingsSaveTimer = setTimeout(() => saveSettings(state), 300);
}

function showToast(message) {
  const toast = document.getElementById('toast');
  if (!toast) return;
  toast.textContent = message;
  toast.classList.add('visible');
  setTimeout(() => toast.classList.remove('visible'), 2000);
}

function syncProfileSmoothingControls() {
  const slider = document.getElementById('profileSmoothing');
  const valueEl = document.getElementById('profileSmoothingValue');
  if (!slider || !valueEl) return;
  const smoothing = Number(state.profileSmoothing);
  const safeValue = Number.isFinite(smoothing) && smoothing >= 0 ? smoothing : 0;
  slider.value = String(Math.min(safeValue, Number(slider.max) || safeValue));
  valueEl.textContent = String(safeValue);
}

function enableInlineNumberEdit(valueEl, onCommit) {
  if (!valueEl) return;
  valueEl.addEventListener('dblclick', () => {
    if (valueEl.querySelector('input')) return;
    const currentText = valueEl.textContent || '';
    const input = document.createElement('input');
    input.type = 'number';
    input.step = '1';
    input.min = '0';
    input.value = currentText;
    input.className = 'inline-number-edit';
    valueEl.textContent = '';
    valueEl.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
      const nextValue = Number(input.value);
      if (Number.isFinite(nextValue) && nextValue >= 0) onCommit(nextValue);
      else syncProfileSmoothingControls();
    };

    input.addEventListener('blur', commit, { once: true });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault();
        input.blur();
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        syncProfileSmoothingControls();
      }
    });
  });
}

function syncMapViewState() {
  const center = map.getCenter();
  state.viewCenter = [Number(center.lng.toFixed(6)), Number(center.lat.toFixed(6))];
  state.viewZoom = Number(map.getZoom().toFixed(2));
  state.viewBearing = Number(map.getBearing().toFixed(2));
  state.viewPitch = Number(map.getPitch().toFixed(2));
  syncViewToUrl(map, state);
}

// ---- Contour line source ----

const demTileUrl = getDemTileUrl();

const demContourSource = new mlcontour.DemSource({
  url: demTileUrl,
  encoding: 'terrarium',
  maxzoom: 12,
  worker: true
});
demContourSource.setupMaplibre(maplibregl);
const pmtilesProtocolReady = initPmtilesProtocol(maplibregl);

function buildContourSourceDefinition() {
  return {
    type: 'vector',
    tiles: [
      demContourSource.contourProtocolUrl({
        multiplier: 1,
        overzoom: 1,
        thresholds: {
          10: [200, 1000],
          11: [100, 500],
          12: [100, 500],
          13: [50, 200],
          14: [20, 100],
          16: [10, 50]
        },
        elevationKey: 'ele',
        levelKey: 'level',
        contourLayer: 'contours'
      })
    ],
    maxzoom: 16
  };
}

function buildTerrainSourceDefinition() {
  return {
    type: 'raster-dem',
    tiles: [demTileUrl],
    tileSize: 512,
    maxzoom: DEM_MAX_Z,
    encoding: 'terrarium'
  };
}

function buildDemLoaderLayer() {
  return {
    id: 'dem-loader',
    type: 'hillshade',
    source: DEM_HD_SOURCE_ID,
    layout: { visibility: isTestMode ? 'none' : 'visible' },
    paint: {
      'hillshade-method': state.hillshadeMethod,
      'hillshade-exaggeration': ['coalesce', ['global-state', 'hillshadeOpacity'], 0.35],
      'hillshade-shadow-color': '#000000',
      'hillshade-highlight-color': '#ffffff',
      'hillshade-accent-color': '#000000',
    }
  };
}

function buildAnalysisLayer() {
  return {
    id: 'analysis',
    type: 'terrain-analysis',
    source: DEM_HD_SOURCE_ID,
    layout: { visibility: 'none' },
    paint: {
      'attribute': 'slope',
      'opacity': state.slopeOpacity,
      'color': ANALYSIS_COLOR.slope,
      'blend-mode': state.multiplyBlend ? (state.slopeOpacity > 0.7 ? 'multiply' : 'soft-multiply') : 'normal'
    }
  };
}

function buildAnalysisReliefLayer() {
  return {
    id: 'analysis-relief',
    type: 'terrain-analysis',
    source: DEM_HD_SOURCE_ID,
    layout: { visibility: 'none' },
    paint: {
      'attribute': 'elevation',
      'opacity': state.slopeOpacity,
      'color': ANALYSIS_COLOR['color-relief'],
      'blend-mode': state.multiplyBlend ? (state.slopeOpacity > 0.7 ? 'multiply' : 'soft-multiply') : 'normal'
    }
  };
}

function buildAppStyle() {
  return {
    version: 8,
    glyphs: 'https://vectortiles.geo.admin.ch/fonts/{fontstack}/{range}.pbf',
    sprite: 'https://vectortiles.geo.admin.ch/styles/ch.swisstopo.basemap.vt/sprite/sprite',
    sources: {
      contourSource: buildContourSourceDefinition(),
      // Separate raster-dem sources for terrain and
      // hillshade/analysis on purpose: in current MapLibre,
      // one source means one shared TileManager, and terrain changes shared DEM
      // tile selection/preparation toward coarser tiles for performance. A
      // larger shared tile cache does not isolate those different behaviors.
      [DEM_TERRAIN_SOURCE_ID]: buildTerrainSourceDefinition(),
      [DEM_HD_SOURCE_ID]: buildTerrainSourceDefinition(),
    },
    layers: [
      {
        id: 'background',
        type: 'background',
        paint: { 'background-color': '#ffffff' }
      },
      buildDemLoaderLayer(),
      buildAnalysisLayer(),
      buildAnalysisReliefLayer(),
    ]
  };
}

function ensureSource(map, sourceId, sourceDefinition) {
  if (!map.getSource(sourceId)) {
    map.addSource(sourceId, sourceDefinition);
  }
}

function ensureLayer(map, layerDefinition, beforeId) {
  if (!map.getLayer(layerDefinition.id)) {
    map.addLayer(layerDefinition, beforeId);
  }
}

/**
 * Ensure sources/layers exist for all currently active catalog entries.
 * Used after style.load to re-inject only what's needed.
 */
function ensureActiveCatalogLayers(map, state) {
  const active = new Set([
    ...(state.basemapStack || []),
    ...(state.activeOverlays || []),
  ]);
  for (const catalogId of active) {
    ensureCatalogEntry(map, catalogId);
  }
}

function ensureContourLayers(map) {
  ensureLayer(map, {
    id: 'contours',
    type: 'line',
    source: 'contourSource',
    'source-layer': 'contours',
    paint: {
      'line-opacity': 0.2,
      'line-width': ['match', ['get', 'level'], 1, 1, 0.5]
    }
  });
  ensureLayer(map, {
    id: 'contour-text',
    type: 'symbol',
    source: 'contourSource',
    'source-layer': 'contours',
    filter: ['>', ['get', 'level'], 0],
    paint: {
      'text-halo-color': 'white',
      'text-halo-width': 1
    },
    layout: {
      'symbol-placement': 'line',
      'text-size': 10,
      'text-field': ['concat', ['number-format', ['get', 'ele'], {}], 'm'],
      'text-font': ['Frutiger Neue Regular']
    }
  });
}

function ensureAppRuntimeLayers(map) {
  ensureSource(map, 'contourSource', buildContourSourceDefinition());
  ensureSource(map, DEM_TERRAIN_SOURCE_ID, buildTerrainSourceDefinition());
  ensureSource(map, DEM_HD_SOURCE_ID, buildTerrainSourceDefinition());
  ensureLayer(map, buildDemLoaderLayer());
  ensureLayer(map, buildAnalysisLayer());
  ensureLayer(map, buildAnalysisReliefLayer());
  ensureActiveCatalogLayers(map, state);
  ensureContourLayers(map);
  ensureDebugGridLayer(map);
}

const map = new maplibregl.Map({
  container: 'map',
  center: initialView.center,
  zoom: initialView.zoom,
  bearing: initialView.bearing,
  pitch: initialView.pitch,
  maxTileCacheZoomLevels: 20,
  attributionControl: false,
  style: buildAppStyle(),
  canvasContextAttributes: {antialias: true}
});

// ---- Controls ----

const navigationControl = new maplibregl.NavigationControl({
  visualizePitch: true,
  visualizeRoll: true,
  showZoom: true,
  showCompass: true
});
const geolocateControl = new maplibregl.GeolocateControl({
  positionOptions: { enableHighAccuracy: true },
  trackUserLocation: false,
  showUserLocation: true,
  showAccuracyCircle: false
});
// Custom 3D terrain toggle control
class Terrain3DControl {
  constructor(state, onToggle) {
    this._state = state;
    this._onToggle = onToggle;
  }
  onAdd(map) {
    this._map = map;
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group terrain3d-ctrl';
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.title = '3D terrain';
    btn.innerHTML = `<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"/>
      <path d="M12 12l8-4.5"/>
      <path d="M12 12v9"/>
      <path d="M12 12L4 7.5"/>
    </svg>`;
    btn.addEventListener('click', () => {
      this._state.terrain3d = !this._state.terrain3d;
      this._onToggle();
      this.sync();
    });
    container.appendChild(btn);
    this._container = container;
    this._btn = btn;
    this.sync();
    return container;
  }
  onRemove() { this._container.remove(); }
  sync() {
    this._btn.classList.toggle('active', this._state.terrain3d);
    document.getElementById('terrainExaggeration').disabled = !this._state.terrain3d;
    document.getElementById('terrain3d').checked = this._state.terrain3d;
  }
}

const terrain3dControl = new Terrain3DControl(state, () => {
  applyTerrainState(map, state);
  if (!state.terrain3d && map.getPitch() > 0) {
    map.easeTo({ pitch: 0, duration: 500 });
  }
  syncMapViewState();
  map.triggerRepaint();
  scheduleSettingsSave();
});

const scaleControl = new maplibregl.ScaleControl({ unit: 'metric', maxWidth: 120 });
map.addControl(scaleControl, 'bottom-right');
map.addControl(new maplibregl.AttributionControl(), 'bottom-right');
map.addControl(navigationControl, 'bottom-right');
map.addControl(terrain3dControl, 'bottom-right');
map.addControl(geolocateControl, 'bottom-right');

// ---- Settings panel ----

const controlsPanel = document.getElementById('controls');
const controlsToggleBtn = document.getElementById('settings-controls-toggle');

function syncControlsToggleLabel() {
  controlsToggleBtn.classList.toggle('active', !controlsPanel.classList.contains('collapsed'));
}

function setControlsCollapsed(collapsed) {
  controlsPanel.classList.toggle('collapsed', collapsed);
  syncControlsToggleLabel();
}

controlsToggleBtn.addEventListener('click', () => {
  const wasCollapsed = controlsPanel.classList.contains('collapsed');
  setControlsCollapsed(!wasCollapsed);
  // Close layers panel when opening settings (they overlap)
  if (wasCollapsed) {
    document.getElementById('layer-order-panel')?.classList.remove('visible');
    document.getElementById('layer-order-toggle')?.classList.remove('active');
  }
});
syncControlsToggleLabel();

const layerAdvancedToggle = document.getElementById('layer-advanced-toggle');
const layerAdvancedSection = document.getElementById('layer-advanced-section');
layerAdvancedToggle.addEventListener('click', () => {
  const open = layerAdvancedSection.classList.toggle('open');
  layerAdvancedToggle.querySelector('.arrow').classList.toggle('open', open);
});

// ---- Debug: MapLibre layers panel ----
function refreshDebugLayers() {
  const output = document.getElementById('debug-layers-output');
  if (!output) return;
  const style = map.getStyle();
  const layers = style?.layers || [];
  const sources = style?.sources || {};
  const lines = layers.map((l, i) => {
    const vis = l.layout?.visibility || 'visible';
    const flag = vis === 'visible' ? '●' : '○';
    const src = l.source ? sources[l.source] : null;
    const zMin = l.minzoom ?? src?.minzoom ?? '';
    const zMax = l.maxzoom ?? src?.maxzoom ?? '';
    const zRange = (zMin !== '' || zMax !== '') ? `z${zMin}-${zMax}` : '';
    const bounds = src?.bounds ? `[${src.bounds.map(v => v.toFixed(1)).join(',')}]` : '';
    const blend = l.paint?.['blend-mode'] || '';
    const meta = [zRange, bounds, blend].filter(Boolean).join(' ');
    return `${String(i).padStart(2)} ${flag} ${l.type.padEnd(16)} ${l.id.padEnd(38)} ${meta}`;
  });
  lines.push(`\nTotal: ${layers.length} layers | Sources: ${Object.keys(sources).length}`);
  output.textContent = lines.join('\n');
}

const debugLayersToggle = document.getElementById('debug-layers-toggle');
const debugLayersSection = document.getElementById('debug-layers-section');
if (debugLayersToggle && debugLayersSection) {
  debugLayersToggle.addEventListener('click', () => {
    const isOpen = !debugLayersSection.classList.contains('collapsed');
    debugLayersSection.classList.toggle('collapsed', isOpen);
    debugLayersToggle.querySelector('.arrow')?.classList.toggle('open', !isOpen);
    if (!isOpen) refreshDebugLayers();
  });
  document.getElementById('debug-layers-refresh')?.addEventListener('click', refreshDebugLayers);
}

map.on('dragstart', () => {
  setControlsCollapsed(true);
  document.getElementById('layer-order-panel')?.classList.remove('visible');
  document.getElementById('layer-order-toggle')?.classList.remove('active');
});

// ---- Init search ----
initSearch(map);

// ---- Init web import ----
initWebImport();

// ---- Init tracks & profile ----
initTracks(map, state, updateProfile);
const tracksState = getTracksState();
initProfile(map, state, tracksState);
const APP_STYLE_MODE = '__app_style__';
map.__activeStyleMode = APP_STYLE_MODE;
map.__nativeBasemapLayerIds = new Map();

map.__ensureBasemapStyle = async (catalogId) => {
  const entry = getCatalogEntry(catalogId);
  const targetMode = entry?.styleUrl ? entry.id : APP_STYLE_MODE;
  if (map.__activeStyleMode === targetMode) return;
  const styleReady = new Promise(resolve => map.once('style.load', resolve));
  map.__activeStyleMode = targetMode;
  map.setStyle(entry?.styleUrl ? entry.styleUrl : buildAppStyle());
  await styleReady;
};

map.on('style.load', async () => {
  const primaryBasemapId = state.basemapStack?.[0] || 'none';
  const entry = getCatalogEntry(primaryBasemapId);
  if (entry?.styleUrl) {
    map.__nativeBasemapLayerIds.set(entry.id, (map.getStyle()?.layers || []).map(layer => layer.id));
  }
  await pmtilesProtocolReady;
  ensureAppRuntimeLayers(map);
  tracksState.rehydrateTrackLayers();
  setGlobalStatePropertySafe(map, 'basemapOpacity', state.basemapOpacity);
  setGlobalStatePropertySafe(map, 'hillshadeOpacity', state.hillshadeOpacity);
  applyHillshadeVisibility(map, state);
  if (state.showTileGrid) updateDebugGridSource(map);
});

initSelectionTools(map, {
  getActiveTrack: () => tracksState.getActiveTrack(),
  onSelectionChanged: (selectionSpan) => {
    tracksState.setSelectionSpan(selectionSpan);
    syncOperationState();
  },
  onModeChanged: () => syncOperationState(),
  isSelectionBlocked: () => !tracksState.getActiveTrack(),
  keepSelectionCursor: () => Boolean(tracksState.editingTrackId),
  onAction: (action) => {
    if (action === 'simplify') simplifyBtn.click();
    else if (action === 'densify') densifyBtn.click();
    else if (action === 'split') splitBtn.click();
    else if (action === 'delete') {
      const sel = getCurrentSelection();
      if (sel?.trackId && sel.sourceIndices?.length) {
        const result = tracksState.deleteSelectionPoints(sel.trackId, sel.sourceIndices);
        if (result?.ok) {
          clearSelection();
          syncOperationState();
        }
      }
    }
  },
});

// Wire rectangle selection check into track-edit so vertex-adding is suppressed during rect selection
tracksState.wireRectangleSelectionCheck(isRectangleModeActive);

const selectionModeBtn = document.getElementById('selection-mode-btn');
const densifyBtn = document.getElementById('densify-btn');
const simplifyBtn = document.getElementById('simplify-btn');
const splitBtn = document.getElementById('split-btn');
const mergeBtn = document.getElementById('merge-btn');
const convertRouteBtn = document.getElementById('convert-route-btn');
const activeActionsBtn = document.getElementById('active-actions-btn');
const trackToolRow = document.getElementById('track-tool-row');

function getActiveGroupTrackIds() {
  const activeTrack = tracksState.getActiveTrack();
  if (!activeTrack?.groupId) return [];
  return tracksState.tracks.filter(track => track.groupId === activeTrack.groupId).map(track => track.id);
}

function showOperationError(result) {
  if (result?.ok !== false || !result.error) return;
  window.alert(result.error);
}

function syncOperationState() {
  const activeTrack = tracksState.getActiveTrack();
  const selectionSpan = tracksState.selectionSpan;
  const selectionContext = Boolean(selectionSpan?.ok && activeTrack && selectionSpan.trackId === activeTrack.id);
  const activeGroupTrackIds = getActiveGroupTrackIds();
  const canMergeGrouped = activeGroupTrackIds.length > 1;
  const isRoute = (activeTrack?.sourceKind || 'track') === 'route';
  const selectionBlocked = !activeTrack;

  if (selectionBlocked && isRectangleModeActive()) {
    setRectangleMode(false);
  }
  if (!selectionSpan?.ok) {
    setActionPreview('');
  }

  trackToolRow.classList.toggle('selection-context', selectionContext);

  if (activeActionsBtn) {
    activeActionsBtn.disabled = false;
    activeActionsBtn.title = activeTrack ? 'Actions for the selected item' : 'Workspace actions';
  }

  selectionModeBtn.disabled = selectionBlocked;
  selectionModeBtn.classList.toggle('active', isRectangleModeActive());

  densifyBtn.disabled = !activeTrack || isRoute;
  simplifyBtn.disabled = !activeTrack || isRoute;
  splitBtn.disabled = !activeTrack || isRoute;
  mergeBtn.disabled = !canMergeGrouped;
  convertRouteBtn.disabled = !isRoute;

  for (const button of [densifyBtn, simplifyBtn, splitBtn, mergeBtn, convertRouteBtn]) {
    button.classList.remove('selection-eligible', 'selection-dimmed');
  }

  if (selectionContext) {
    for (const button of [densifyBtn, simplifyBtn, splitBtn]) {
      if (!button.disabled) button.classList.add('selection-eligible');
    }
    for (const button of [mergeBtn, convertRouteBtn]) {
      if (!button.disabled) button.classList.add('selection-dimmed');
    }
  }
}

activeActionsBtn?.addEventListener('click', (e) => {
  e.stopPropagation();
  const rect = activeActionsBtn.getBoundingClientRect();
  openCurrentContextMenu(rect.left, rect.bottom + 2);
});

function promptSimplifyOptions() {
  const raw = window.prompt('Simplify tolerance in meters. Append ",dp" to use Douglas-Peucker.', '12');
  if (raw == null) return null;
  const [toleranceText, modeText] = raw.split(',').map(part => part.trim()).filter(Boolean);
  const horizontalTolerance = Number(toleranceText || raw);
  if (!Number.isFinite(horizontalTolerance) || horizontalTolerance <= 0) {
    window.alert('Enter a positive tolerance in meters.');
    return null;
  }
  return {
    horizontalTolerance,
    method: modeText?.toLowerCase() === 'dp' ? 'douglas-peucker' : 'visvalingam',
  };
}

function promptSplitOptions() {
  const selectionSpan = tracksState.selectionSpan;
  const defaultMode = selectionSpan?.ok && selectionSpan.pointCount === 1 ? 'point' : 'track';
  const raw = window.prompt('Split mode: point, track, or segment', defaultMode);
  if (raw == null) return null;
  const normalized = raw.trim().toLowerCase();
  if (normalized === 'point') return { mode: 'at-point' };
  if (normalized === 'segment') return { mode: 'extract-segment' };
  if (normalized === 'track') return { mode: 'extract-track' };
  window.alert('Use one of: point, track, segment.');
  return null;
}

selectionModeBtn?.addEventListener('click', () => {
  if (!tracksState.getActiveTrack()) return;
  if (tracksState.editingTrackId) {
    tracksState.exitEditMode();
  }
  toggleRectangleMode();
  syncOperationState();
});

densifyBtn?.addEventListener('click', () => {
  const result = tracksState.densifyActiveTrackSpan({ maxGapMeters: 5 });
  showOperationError(result);
  syncOperationState();
});

simplifyBtn?.addEventListener('click', () => {
  const options = promptSimplifyOptions();
  if (!options) return;
  const result = tracksState.simplifyActiveTrackSpan(options);
  showOperationError(result);
  syncOperationState();
});

splitBtn?.addEventListener('click', () => {
  const options = promptSplitOptions();
  if (!options) return;
  const result = tracksState.splitActiveTrackSpan(options);
  showOperationError(result);
  clearSelection();
  syncOperationState();
});

mergeBtn?.addEventListener('click', () => {
  const activeGroupTrackIds = getActiveGroupTrackIds();
  if (activeGroupTrackIds.length < 2) {
    window.alert('Activate a grouped track with at least two sibling segments to merge.');
    return;
  }
  const result = tracksState.mergeSelectedTracks(activeGroupTrackIds, {
    mode: 'single-segment',
    name: tracksState.getActiveTrack()?.groupName || tracksState.getActiveTrack()?.name || 'Track',
  });
  showOperationError(result);
  clearSelection();
  syncOperationState();
});

convertRouteBtn?.addEventListener('click', () => {
  const replace = window.confirm('Replace the route instead of creating a sibling track?');
  const result = tracksState.convertActiveRouteToTrack({ replace });
  showOperationError(result);
  syncOperationState();
});

const previewBindings = [
  [selectionModeBtn, () => describeOperationConsequence('rectangle-selection', { selectionSpan: tracksState.selectionSpan })],
  [densifyBtn, () => describeOperationConsequence('densify', { selectionSpan: tracksState.selectionSpan })],
  [simplifyBtn, () => describeOperationConsequence('simplify', { selectionSpan: tracksState.selectionSpan })],
  [splitBtn, () => describeOperationConsequence('split', { selectionSpan: tracksState.selectionSpan })],
  [mergeBtn, () => describeOperationConsequence('merge', { trackCount: getActiveGroupTrackIds().length, mode: 'single-segment' })],
  [convertRouteBtn, () => describeOperationConsequence('route-to-track', { replace: false })],
];

for (const [button, describe] of previewBindings) {
  button?.addEventListener('mouseenter', () => setActionPreview(describe()));
  button?.addEventListener('mouseleave', () => setActionPreview(''));
  button?.addEventListener('focus', () => setActionPreview(describe()));
  button?.addEventListener('blur', () => setActionPreview(''));
}
syncOperationState();

// ---- Init shortcuts ----
initShortcuts();

// Ctrl/Cmd+P — toggle profile
registerShortcut({ key: 'p', ctrl: true, handler: () => {
  const profilePanel = document.getElementById('profile-panel');
  const t = tracksState.getActiveTrack();
  if (!t || t.coords.length < 2) return;
  const isVisible = profilePanel.classList.contains('visible');
  if (isVisible) {
    profilePanel.classList.remove('visible');
    tracksState.profileClosed = true;
  } else {
    profilePanel.classList.add('visible');
    tracksState.profileClosed = false;
  }
  tracksState.syncProfileToggleButton();
  tracksState.syncBottomRightOffset();
}});

// Ctrl/Cmd+L — toggle track list
registerShortcut({ key: 'l', ctrl: true, handler: () => {
  const trackPanel = document.getElementById('track-panel');
  const isVisible = trackPanel.classList.contains('visible');
  trackPanel.classList.toggle('visible', !isVisible);
  // sync shell state
  const shell = document.getElementById('track-panel-shell');
  shell.classList.toggle('visible', !isVisible);
  shell.classList.toggle('panel-surface', !isVisible);
}});

// N — new track
registerShortcut({ key: 'n', handler: () => {
  document.getElementById('draw-btn')?.click();
}});

// E — edit active track
registerShortcut({ key: 'e', handler: () => {
  document.getElementById('rail-edit-btn')?.click();
}});

// R — toggle rectangle selection
registerShortcut({ key: 'r', handler: () => {
  document.getElementById('selection-mode-btn')?.click();
}});

// Ctrl/Cmd+I — Info editor for active track
registerShortcut({ key: 'i', ctrl: true, handler: async () => {
  const activeId = tracksState.activeTrackId;
  if (!activeId) return;
  const { getWorkspace } = await import('./gpx-tree.js');
  const { walkNodes } = await import('./gpx-model.js');
  const ws = getWorkspace();
  let targetNodeId = null;
  walkNodes(ws.children, n => {
    if (targetNodeId) return;
    if (n._trackId === activeId || n._trackIds?.includes(activeId)) {
      targetNodeId = n.id;
    }
  });
  if (targetNodeId) openInfoEditor(targetNodeId);
}});

// Esc — exit edit mode / close panels
registerShortcut({ key: 'Escape', allowInInputs: false, handler: () => {
  if (tracksState.editingTrackId) {
    document.getElementById('rail-edit-btn')?.click();
  }
}});

// ---- Left edit rail wiring ----
{
  const railEditBtn = document.getElementById('rail-edit-btn');
  const railRectBtn = document.getElementById('rail-rect-btn');

  // Edit active track button
  railEditBtn?.addEventListener('click', () => {
    const t = tracksState.getActiveTrack();
    if (!t) return;
    if (tracksState.editingTrackId === t.id) {
      tracksState.exitEditMode();
    } else {
      tracksState.enterEditForTrack(t.id);
    }
    syncRailState();
  });

  // Rect select — delegates to selection-mode
  railRectBtn?.addEventListener('click', () => {
    document.getElementById('selection-mode-btn')?.click();
  });

  // Sync rail state periodically with track editing state
  function syncRailState() {
    const t = tracksState.getActiveTrack();
    railEditBtn.disabled = !t;
    railEditBtn.classList.toggle('active', Boolean(tracksState.editingTrackId));
    railRectBtn.disabled = !t;
    railRectBtn.classList.toggle('active', isRectangleModeActive());
    syncOperationState();
  }

  // Sync rail state on interval (lightweight)
  setInterval(syncRailState, 500);
}

// ---- Settings event handlers ----

document.getElementById('mode').addEventListener('change', (e) => {
  state.mode = e.target.value;
  updateLegend(state, map);
  applyModeState(map, state);
  renderLayerOrderPanel();
  syncMapViewState();
  map.triggerRepaint();
  scheduleSettingsSave();
});


document.getElementById('basemapOpacity').addEventListener('input', (e) => {
  state.basemapOpacity = Number(e.target.value);
  document.getElementById('basemapOpacityValue').textContent = state.basemapOpacity.toFixed(2);
  setGlobalStatePropertySafe(map, 'basemapOpacity', state.basemapOpacity);
  // Native-style basemaps need explicit opacity scaling; catalog layers use global-state
  const primaryBasemapId = state.basemapStack?.[0] || 'none';
  if (map.__nativeBasemapLayerIds?.has(primaryBasemapId)) {
    applyLayerOpacity(map, primaryBasemapId, state.basemapOpacity);
  }
  map.triggerRepaint();
  scheduleSettingsSave();
});


document.getElementById('hillshadeMethod').addEventListener('change', (e) => {
  state.hillshadeMethod = e.target.value;
  if (map.getLayer('dem-loader')) {
    map.setPaintProperty('dem-loader', 'hillshade-method', state.hillshadeMethod);
  }
  map.triggerRepaint();
  scheduleSettingsSave();
});


// Overlay toggle events are wired dynamically in renderOverlayList()

document.getElementById('showTileGrid').addEventListener('change', (e) => {
  state.showTileGrid = Boolean(e.target.checked);
  if (map.getLayer('dem-debug-grid-line')) {
    map.setLayoutProperty('dem-debug-grid-line', 'visibility', state.showTileGrid ? 'visible' : 'none');
  }
  if (state.showTileGrid) {
    updateDebugGridSource(map);
  }
  map.triggerRepaint();
});

document.getElementById('multiplyBlend').addEventListener('change', (e) => {
  state.multiplyBlend = Boolean(e.target.checked);
  applyModeState(map, state);
  scheduleSettingsSave();
});

document.getElementById('cursorInfoMode').addEventListener('change', (e) => {
  state.cursorInfoMode = e.target.value;
  updateCursorInfoVisibility(state);
  scheduleSettingsSave();
});

document.getElementById('terrain3d').addEventListener('change', (e) => {
  state.terrain3d = Boolean(e.target.checked);
  document.getElementById('terrainExaggeration').disabled = !state.terrain3d;
  terrain3dControl.sync();
  applyTerrainState(map, state);
  if (!state.terrain3d && map.getPitch() > 0) {
    map.easeTo({ pitch: 0, duration: 500 });
  }
  syncMapViewState();
  map.triggerRepaint();
  scheduleSettingsSave();
});

document.getElementById('terrainExaggeration').addEventListener('input', (e) => {
  state.terrainExaggeration = Number(e.target.value);
  document.getElementById('terrainExaggerationValue').textContent = state.terrainExaggeration.toFixed(2);
  if (state.terrain3d) {
    applyTerrainState(map, state);
  }
  syncMapViewState();
  map.triggerRepaint();
  scheduleSettingsSave();
});

document.getElementById('pauseThreshold').addEventListener('input', (e) => {
  state.pauseThreshold = Number(e.target.value);
  document.getElementById('pauseThresholdValue').textContent = state.pauseThreshold;
  updateProfile();
  scheduleSettingsSave();
});

document.getElementById('profileSmoothing').addEventListener('input', (e) => {
  state.profileSmoothing = Number(e.target.value);
  syncProfileSmoothingControls();
  updateProfile();
  scheduleSettingsSave();
});

enableInlineNumberEdit(document.getElementById('profileSmoothingValue'), (nextValue) => {
  state.profileSmoothing = nextValue;
  syncProfileSmoothingControls();
  updateProfile();
  scheduleSettingsSave();
});

initSavedDataPanel();

const addCustomTileBtn = document.getElementById('add-custom-tile-btn');
if (addCustomTileBtn) {
  addCustomTileBtn.addEventListener('click', async () => {
    const value = window.prompt('Paste a TileJSON URL');
    const url = value ? value.trim() : '';
    if (!url) return;
    try {
      const response = await fetch(url);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const tileJson = await response.json();
      await addCustomTileSource(tileJson, { refreshUi: refreshTileLayers });
      showToast(`Added custom source from ${url}`);
    } catch (error) {
      console.warn('[custom-tile-source] failed to add TileJSON URL:', error);
      showToast('Failed to add custom TileJSON source');
    }
  });
}

// Allow Cmd+drag (Mac) to act like Ctrl+drag for rotate/pitch
map.getCanvas().addEventListener('mousedown', (e) => {
  if (e.metaKey && !e.ctrlKey && e.button === 0) {
    const synth = new MouseEvent('mousedown', {
      bubbles: true, cancelable: true,
      clientX: e.clientX, clientY: e.clientY,
      button: e.button, buttons: e.buttons,
      ctrlKey: true, shiftKey: e.shiftKey, altKey: e.altKey, metaKey: false
    });
    e.target.dispatchEvent(synth);
    e.preventDefault();
    e.stopPropagation();
  }
}, {capture: true});

updateLegend(state, map);
updateCursorInfoVisibility(state);

// ---- Dynamic layer UI ----


/** Populate unified "Add layer" dropdown with optgroups for basemaps + overlays */
function renderAddLayerSelect() {
  const sel = document.getElementById('add-layer');
  if (!sel) return;
  sel.innerHTML = '';
  const placeholder = document.createElement('option');
  placeholder.value = '';
  placeholder.textContent = '+ Add layer…';
  sel.appendChild(placeholder);

  const inStack = new Set(state.basemapStack || []);
  const activeOvl = new Set(state.activeOverlays || []);

  // Basemaps group (built-in only; user-defined appear under Custom maps)
  const bmGroup = document.createElement('optgroup');
  bmGroup.label = 'Basemaps';
  let bmCount = 0;
  for (const entry of getBasemaps()) {
    if (entry.id === 'none') continue; // 'none' not useful as extra layer
    if (entry.userDefined) continue;   // shown in Custom maps group
    if (inStack.has(entry.id)) continue; // already in stack
    const opt = document.createElement('option');
    opt.value = `basemap:${entry.id}`;
    opt.textContent = entry.label;
    bmGroup.appendChild(opt);
    bmCount++;
  }
  if (bmCount) sel.appendChild(bmGroup);

  // Overlays group
  const ovlGroup = document.createElement('optgroup');
  ovlGroup.label = 'Overlays';
  let ovlCount = 0;
  for (const entry of getOverlays()) {
    if (activeOvl.has(entry.id)) continue; // already active
    const opt = document.createElement('option');
    opt.value = `overlay:${entry.id}`;
    opt.textContent = entry.label;
    ovlGroup.appendChild(opt);
    ovlCount++;
  }
  if (ovlCount) sel.appendChild(ovlGroup);

  // Custom maps group (user-defined / TileJSON sources)
  const userEntries = getUserSources().filter(e => !inStack.has(e.id) && !activeOvl.has(e.id));
  if (userEntries.length) {
    const customGroup = document.createElement('optgroup');
    customGroup.label = 'Custom maps';
    for (const entry of userEntries) {
      const opt = document.createElement('option');
      opt.value = `basemap:${entry.id}`;
      opt.textContent = entry.label;
      customGroup.appendChild(opt);
    }
    sel.appendChild(customGroup);
  }
}


/** Sync overlay state in UI (overlays now managed via Layers panel + Add layer dropdown) */
function syncOverlayCheckboxes(_st) {
  // No-op: overlays are shown in the Layers panel, not a separate checkbox list
}

/** Consolidate all layer UI refreshes into a single function to avoid glitchiness */
function refreshAllLayerUI() {
  renderAddLayerSelect();
  syncOverlayCheckboxes(state);
  renderLayerOrderPanel();
  renderBookmarkList();
}

/** Build a non-draggable system-layer row for the Layers panel */
function buildSystemLayerRow({ label, visible, opacity, onToggle, onOpacity }) {
  const row = document.createElement('div');
  row.className = 'layer-order-row layer-system' + (visible ? '' : ' layer-hidden');

  const handle = document.createElement('span');
  handle.className = 'layer-order-handle';
  handle.textContent = '';  // no drag handle

  const visBtn = document.createElement('button');
  visBtn.className = 'layer-order-vis' + (visible ? '' : ' vis-off');
  visBtn.textContent = '👁';
  visBtn.title = visible ? 'Hide layer' : 'Show layer';
  visBtn.addEventListener('click', () => {
    onToggle(!visible);
    renderLayerOrderPanel();
  });

  const nameSpan = document.createElement('span');
  nameSpan.className = 'layer-order-name';
  nameSpan.textContent = label;

  const opacityInput = document.createElement('input');
  opacityInput.type = 'range';
  opacityInput.min = '0';
  opacityInput.max = '1';
  opacityInput.step = '0.05';
  opacityInput.value = String(opacity);
  opacityInput.className = 'layer-order-opacity';
  opacityInput.title = 'Layer opacity';
  opacityInput.addEventListener('input', () => onOpacity(Number(opacityInput.value)));

  row.append(handle, visBtn, nameSpan, opacityInput);
  return row;
}

/** Render the Layers panel: basemaps + overlays with visibility, opacity, remove, drag */
function renderLayerOrderPanel() {
  const container = document.getElementById('layer-order-list');
  if (!container) return;
  container.innerHTML = '';

  const order = state.layerOrder || [];
  const settings = state.layerSettings || {};
  const basemapSet = new Set(state.basemapStack || []);

  function confirmAndRemoveLayer(catalogId, label) {
    if (!window.confirm(`Remove layer "${label}"?`)) return;
    removeLayer(map, state, catalogId);
    renderLayerOrderPanel();
    renderAddLayerSelect();
    syncOverlayCheckboxes(state);
    syncMapViewState();
    map.triggerRepaint();
    scheduleSettingsSave();
  }

  for (let i = order.length - 1; i >= 0; i--) {
    const catalogId = order[i];
    const entry = getCatalogEntry(catalogId);
    if (!entry) continue;

    // Handle virtual system layers
    if (entry.category === 'system') {
      if (catalogId === '_analysis') {
        const analysisVisible = !!state.mode && state.mode !== 'none';
        container.appendChild(buildSystemLayerRow({
          label: 'Terrain analysis',
          visible: analysisVisible,
          opacity: state.slopeOpacity,
          onToggle: (show) => {
            state.mode = show ? 'slope+relief' : '';
            document.getElementById('mode').value = state.mode;
            updateLegend(state, map);
            applyModeState(map, state);
            syncMapViewState();
            map.triggerRepaint();
            scheduleSettingsSave();
          },
          onOpacity: (val) => {
            state.slopeOpacity = val;
            applyModeState(map, state);
            map.triggerRepaint();
            scheduleSettingsSave();
          },
        }));
      } else if (catalogId === '_hillshade') {
        container.appendChild(buildSystemLayerRow({
          label: 'Hillshade',
          visible: state.showHillshade,
          opacity: state.hillshadeOpacity,
          onToggle: (show) => {
            state.showHillshade = show;
            applyHillshadeVisibility(map, state);
            syncMapViewState();
            scheduleSettingsSave();
          },
          onOpacity: (val) => {
            state.hillshadeOpacity = val;
            setGlobalStatePropertySafe(map, 'hillshadeOpacity', val);
            map.triggerRepaint();
            scheduleSettingsSave();
          },
        }));
      } else if (catalogId === '_contours') {
        container.appendChild(buildSystemLayerRow({
          label: 'Contours',
          visible: state.showContours,
          opacity: 1.0,
          onToggle: (show) => {
            state.showContours = show;
            applyContourVisibility(map, state);
            syncMapViewState();
            scheduleSettingsSave();
          },
          onOpacity: () => {},
        }));
      }
      continue;
    }

    // Handle catalog layers (basemaps + overlays)
    const s = settings[catalogId] || {};
    const isBasemap = basemapSet.has(catalogId);
    const isHidden = !!s.hidden;

    const row = document.createElement('div');
    row.className = 'layer-order-row' + (isBasemap ? ' layer-basemap' : ' layer-overlay');
    if (isHidden) row.classList.add('layer-hidden');
    row.draggable = true;
    row.dataset.index = String(i);

    const handle = document.createElement('span');
    handle.className = 'layer-order-handle';
    handle.textContent = '☰';

    const visBtn = document.createElement('button');
    visBtn.className = 'layer-order-vis';
    visBtn.textContent = '👁';
    if (isHidden) visBtn.classList.add('vis-off');
    visBtn.title = isHidden ? 'Show layer' : 'Hide layer';
    visBtn.addEventListener('click', () => {
      setLayerVisible(map, state, catalogId, isHidden);
      renderLayerOrderPanel();
      syncMapViewState();
      map.triggerRepaint();
      scheduleSettingsSave();
    });

    const isPrimary = isBasemap && catalogId === (state.basemapStack || [])[0];
    const nameSpan = document.createElement('span');
    nameSpan.className = 'layer-order-name';
    nameSpan.textContent = isPrimary ? `${entry.label} (primary)` : entry.label;
    if (isPrimary) nameSpan.style.fontWeight = 'bold';

    // Opacity: for basemaps, read from basemapOpacities; for overlays, from layerSettings
    const currentOpacity = isBasemap
      ? (state.basemapOpacities?.[catalogId] ?? 1)
      : (s.opacity != null ? s.opacity : 1);

    const opacityInput = document.createElement('input');
    opacityInput.type = 'range';
    opacityInput.min = '0';
    opacityInput.max = '1';
    opacityInput.step = '0.05';
    opacityInput.value = String(currentOpacity);
    opacityInput.className = 'layer-order-opacity';
    opacityInput.title = 'Layer opacity';
    opacityInput.draggable = false;
    opacityInput.addEventListener('dragstart', (e) => { e.stopPropagation(); e.preventDefault(); });
    opacityInput.addEventListener('mousedown', (e) => e.stopPropagation());
    opacityInput.addEventListener('touchstart', (e) => { e.stopPropagation(); e.preventDefault(); });
    opacityInput.addEventListener('input', () => {
      const val = Number(opacityInput.value);
      if (isBasemap) {
        const opacities = { ...(state.basemapOpacities || {}) };
        opacities[catalogId] = val;
        state.basemapOpacities = opacities;
        applyLayerOpacity(map, catalogId, val);
        // Backward compat: keep basemapOpacity synced to primary
        if (catalogId === (state.basemapStack || [])[0]) {
          state.basemapOpacity = val;
          setGlobalStatePropertySafe(map, 'basemapOpacity', val);
        }
      } else {
        state.layerSettings = { ...state.layerSettings, [catalogId]: { ...(state.layerSettings[catalogId] || {}), opacity: val } };
        applyLayerOpacity(map, catalogId, val);
      }
      map.triggerRepaint();
      scheduleSettingsSave();
    });

    const removeBtn = document.createElement('button');
    removeBtn.className = 'layer-order-remove';
    removeBtn.textContent = '✕';
    removeBtn.title = 'Remove layer';
    removeBtn.addEventListener('click', () => {
      confirmAndRemoveLayer(catalogId, entry.label);
    });

    row.append(handle, visBtn, nameSpan, opacityInput, removeBtn);
    container.appendChild(row);

    row.addEventListener('auxclick', (e) => {
      if (e.button !== 1) return;
      if (e.target === opacityInput || e.target === removeBtn || e.target === visBtn || e.target === handle) return;
      e.preventDefault();
      e.stopPropagation();
      confirmAndRemoveLayer(catalogId, entry.label);
    });

    // Drag-and-drop
    row.addEventListener('dragstart', (e) => {
      e.dataTransfer.setData('text/plain', String(i));
      row.classList.add('dragging');
    });
    row.addEventListener('dragend', () => row.classList.remove('dragging'));
    row.addEventListener('dragover', (e) => {
      e.preventDefault();
      row.classList.add('drag-over');
    });
    row.addEventListener('dragleave', () => row.classList.remove('drag-over'));
    row.addEventListener('drop', (e) => {
      e.preventDefault();
      row.classList.remove('drag-over');
      const fromIdx = Number(e.dataTransfer.getData('text/plain'));
      const toIdx = i;
      if (fromIdx !== toIdx) {
        reorderLayer(map, state, fromIdx, toIdx);
        renderLayerOrderPanel();
        map.triggerRepaint();
        scheduleSettingsSave();
      }
    });
  }

  if (order.length === 0) {
    const empty = document.createElement('div');
    empty.className = 'layer-order-empty';
    empty.textContent = 'No active layers';
    container.appendChild(empty);
  }
}

/** Render bookmark list */
function renderBookmarkList() {
  const container = document.getElementById('bookmark-list');
  if (!container) return;
  container.innerHTML = '';
  const bookmarks = state.bookmarks || [];

  for (const bm of bookmarks) {
    const row = document.createElement('div');
    row.className = 'bookmark-row';

    const nameBtn = document.createElement('button');
    nameBtn.className = 'bookmark-name';
    nameBtn.textContent = bm.name;
    nameBtn.title = 'Apply this bookmark';
    nameBtn.addEventListener('click', async () => {
      await applyBookmark(map, state, bm);

      // Apply system layer state to the map (moved from applyBookmark to avoid ui.js import in layer-engine)
      applyModeState(map, state);
      applyHillshadeVisibility(map, state);
      setGlobalStatePropertySafe(map, 'hillshadeOpacity', state.hillshadeOpacity);
      applyContourVisibility(map, state);

      refreshAllLayerUI();
      updateLegend(state, map);
      syncMapViewState();
      
      // Sync UI controls with restored state
      const modeSelect = document.getElementById('mode');
      if (modeSelect) modeSelect.value = state.mode || '';
      
      map.triggerRepaint();
      scheduleSettingsSave();
    });

    const editBtn = document.createElement('button');
    editBtn.className = 'bookmark-edit';
    editBtn.textContent = '✎';
    editBtn.title = 'Rename';
    editBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      const newName = window.prompt('Bookmark name:', bm.name);
      if (newName != null && newName.trim()) {
        renameBookmark(state, bm.id, newName.trim());
        renderBookmarkList();
        scheduleSettingsSave();
      }
    });

    const delBtn = document.createElement('button');
    delBtn.className = 'bookmark-del';
    delBtn.textContent = '×';
    delBtn.title = 'Delete';
    delBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteBookmark(state, bm.id);
      renderBookmarkList();
      scheduleSettingsSave();
    });

    row.append(nameBtn, editBtn, delBtn);
    container.appendChild(row);
  }
}

// Wire bookmark save button
document.getElementById('bookmark-save-btn')?.addEventListener('click', () => {
  createBookmark(state);
  renderBookmarkList();
  scheduleSettingsSave();
});

// Wire layer-order panel toggle
const layerOrderToggleBtn = document.getElementById('layer-order-toggle');
const layerOrderPanel = document.getElementById('layer-order-panel');
layerOrderToggleBtn?.addEventListener('click', () => {
  const isVisible = layerOrderPanel.classList.toggle('visible');
  layerOrderToggleBtn.classList.toggle('active', isVisible);
  if (isVisible) {
    renderLayerOrderPanel();
    // Close settings panel when opening layers (they overlap)
    setControlsCollapsed(true);
  }
});

// Initial render of dynamic UI
renderAddLayerSelect();
renderBookmarkList();

// Wire unified "Add layer" dropdown
document.getElementById('add-layer')?.addEventListener('change', async (e) => {
  const val = e.target.value;
  if (!val) return;
  e.target.value = ''; // reset

  const [type, id] = val.split(':');
  if (type === 'basemap') {
    const newStack = [...(state.basemapStack || []), id];
    await setBasemapStack(map, state, newStack);
  } else if (type === 'overlay') {
    setOverlay(map, state, id, true);
  }

  syncLayerOrder(state);
  renderLayerOrderPanel();
  renderAddLayerSelect();
  syncMapViewState();
  map.triggerRepaint();
  scheduleSettingsSave();

  // Auto-open Layers panel when adding a layer
  const layerPanel = document.getElementById('layer-order-panel');
  const layerToggle = document.getElementById('layer-order-toggle');
  if (layerPanel && !layerPanel.classList.contains('visible')) {
    layerPanel.classList.add('visible');
    layerToggle?.classList.add('active');
  }
});

// ---- Map load ----

map.on('load', async () => {
  setGlobalStatePropertySafe(map, 'basemapOpacity', state.basemapOpacity);
  setGlobalStatePropertySafe(map, 'hillshadeOpacity', state.hillshadeOpacity);
  ensureAppRuntimeLayers(map);
  tracksState.rehydrateTrackLayers();
  await setBasemapStack(map, state, state.basemapStack || []);
  syncLayerOrder(state);
  applyAllOverlays(map, state);
  applyAllLayerSettings(map, state);
  applyModeState(map, state);
  applyTerrainState(map, state);
  applyHillshadeVisibility(map, state);
  applyContourVisibility(map, state);
  if (state.showTileGrid) updateDebugGridSource(map);
  renderLayerOrderPanel();
  syncMapViewState();
  map.on('moveend', () => {
    syncMapViewState();
    if (state.showTileGrid) updateDebugGridSource(map);
    scheduleSettingsSave();
  });
  map.on('zoomend', () => {
    syncMapViewState();
    if (state.showTileGrid) updateDebugGridSource(map);
    if (state.mode === 'slope+relief') {
      applyModeState(map, state);
      updateLegend(state, map);
    }
    scheduleSettingsSave();
  });
  map.on('rotateend', () => {
    syncMapViewState();
    scheduleSettingsSave();
  });
  map.on('pitchend', () => {
    syncMapViewState();
    scheduleSettingsSave();
  });

  if (shouldAttemptInitialGeolocate) {
    window.setTimeout(() => {
      if (typeof geolocateControl.trigger === 'function') {
        geolocateControl.trigger();
      }
    }, 0);
  }

  // Elevation sampling on mousemove
  const isMobile = 'ontouchstart' in window || navigator.maxTouchPoints > 0;
  const mobileCrosshair = document.getElementById('mobile-crosshair');
  const drawCrosshair = document.getElementById('draw-crosshair');
  let cursorRaf = 0;
  let lastPointerLngLat = null;
  let lastPointerScreenXY = null;

  // On mobile, always show center crosshair and update elevation from map center
  if (isMobile) {
    drawCrosshair.classList.add('visible');
    updateCursorInfoVisibility(state);
    map.on('move', () => {
      lastPointerLngLat = map.getCenter();
      const canvas = map.getCanvas();
      lastPointerScreenXY = { x: canvas.clientWidth / 2, y: canvas.clientHeight / 2 };
      if (!cursorRaf) cursorRaf = requestAnimationFrame(updateCursorElevation);
    });
  }
  const updateCursorElevation = () => {
    cursorRaf = 0;
    if (!lastPointerLngLat) {
      setCursorInfo(state, null, 'n/a');
      hideCursorTooltip();
      return;
    }

    const result = queryLoadedElevationAtLngLat(map, lastPointerLngLat);
    if (!result) {
      setCursorInfo(state, lastPointerLngLat, 'no loaded tile');
      if (lastPointerScreenXY) showCursorTooltipAt(state, lastPointerScreenXY.x, lastPointerScreenXY.y, lastPointerLngLat, 'no tile', 'n/a');
      return;
    }

    const eleText = `${result.elevation.toFixed(0)} m`;
    const slopeStr = result.slopeDeg != null ? `${result.slopeDeg.toFixed(0)}°` : 'n/a';
    setCursorInfo(state, lastPointerLngLat, eleText, slopeStr);
    if (lastPointerScreenXY) showCursorTooltipAt(state, lastPointerScreenXY.x, lastPointerScreenXY.y, lastPointerLngLat, eleText, slopeStr);
  };

  map.on('mousemove', (e) => {
    lastPointerLngLat = e.lngLat;
    lastPointerScreenXY = {x: e.originalEvent.clientX, y: e.originalEvent.clientY};
    if (!cursorRaf) cursorRaf = requestAnimationFrame(updateCursorElevation);
  });

  map.on('mouseout', () => {
    lastPointerLngLat = null;
    lastPointerScreenXY = null;
    if (!cursorRaf) cursorRaf = requestAnimationFrame(updateCursorElevation);
  });

  // Map click for track selection — queries the merged line layer + promoted track layer
  map.on('click', (e) => {
    if (tracksState.editingTrackId) return;
    const layers = ['tracks-merged-line'];
    // Also check the promoted (active) track's own line layer
    if (tracksState.activeTrackId) {
      const promoLayer = 'track-line-' + tracksState.activeTrackId;
      if (map.getLayer(promoLayer)) layers.push(promoLayer);
    }
    const queryLayers = layers.filter(l => map.getLayer(l));
    if (!queryLayers.length) return;
    const bbox = [[e.point.x - 5, e.point.y - 5], [e.point.x + 5, e.point.y + 5]];
    const features = map.queryRenderedFeatures(bbox, { layers: queryLayers });
    if (features.length > 0) {
      const f = features[0];
      const trackId = f.properties?.trackId || f.properties?.id
        || f.layer.id.replace('track-line-', '');
      tracksState.setActiveTrack(trackId);
    }
  });

  // Mobile: show crosshair on tap with elevation info
  if (isMobile) {
    map.on('click', (e) => {
      if (tracksState.editingTrackId) return;
      const result = queryLoadedElevationAtLngLat(map, e.lngLat);
      if (state.cursorInfoMode !== 'no') {
        mobileCrosshair.style.left = e.originalEvent.clientX + 'px';
        mobileCrosshair.style.top = e.originalEvent.clientY + 'px';
        mobileCrosshair.classList.add('visible');
        if (state.cursorInfoMode === 'cursor' && result) {
          const eleText = `${result.elevation.toFixed(0)} m`;
          const slopeStr = result.slopeDeg != null ? `${result.slopeDeg.toFixed(0)}°` : 'n/a';
          showCursorTooltipAt(state, e.originalEvent.clientX, e.originalEvent.clientY, eleText, slopeStr);
        }
      }
    });
    map.on('dragstart', () => {
      mobileCrosshair.classList.remove('visible');
      hideCursorTooltip();
    });
  }
});

// ---- Hashchange navigation ----

let hashNavInProgress = false;
window.addEventListener('hashchange', async () => {
  if (hashNavInProgress) return;
  const p = parseHashParams();
  hashNavInProgress = true;

  const overrides = applyUrlOverrides(state, p, {
    center: [map.getCenter().lng, map.getCenter().lat],
    zoom: map.getZoom(),
    bearing: map.getBearing(),
    pitch: map.getPitch(),
  });

  const { nextView, isTestMode: hashTestMode } = overrides;

  map.jumpTo({
    center: nextView.center,
    zoom: nextView.zoom,
    bearing: nextView.bearing,
    pitch: nextView.pitch,
  });

  if (hashTestMode) {
    Object.assign(state, STATE_TEST_MODE);
  }

  syncPrimaryControlsFromState(state);
  renderLayerOrderPanel();
  renderAddLayerSelect();

  updateLegend(state, map);
  await setBasemapStack(map, state, state.basemapStack || [], true);
  applyAllOverlays(map, state);
  applyModeState(map, state);
  applyTerrainState(map, state);

  if (hashTestMode) {
    applyTestModeMapState(map, state);
  }

  hashNavInProgress = false;
  syncMapViewState();
  scheduleSettingsSave();
  map.triggerRepaint();
});

map.on('error', (e) => {
  console.error('Map error:', e && e.error ? e.error.message : e);
});

// ---- Desktop: auto-discover tile sources via TileJSON ----

const refreshTileLayers = () => {
  renderAddLayerSelect();
  renderLayerOrderPanel();
};

if (isTauri()) {
  loadPersistedCustomTileSources()
    .then(() => refreshTileLayers())
    .catch(e => console.warn('[custom-tile-source] restore failed:', e));
  discoverAndRegisterDesktopTileSources({
    refreshUi: refreshTileLayers,
    logPrefix: '[tile-sources]'
  }).catch(e => console.warn('[tile-sources] discovery failed:', e));
}

// ---- Desktop: GPX sync event listener ----

if (isTauri()) {
  onGpxSyncEvents((events) => {
    for (const event of events) {
      switch (event.kind) {
        case 'file_added':
        case 'file_changed': {
          const name = event.path.split('/').pop() || 'track.gpx';
          console.info(`[gpx-sync] ${event.kind}: ${name}`);
          importFileContent(name, event.content);
          break;
        }
        case 'file_removed':
          console.info(`[gpx-sync] removed: ${event.path}`);
          break;
        case 'conflict': {
          const cName = event.path.split('/').pop() || 'file';
          console.warn(`[gpx-sync] conflict: ${cName}`);
          const keepDisk = confirm(
            `"${cName}" was changed both on disk and in the app.\n\nOK = load disk version\nCancel = keep your edits`
          );
          resolveConflict(event.path, keepDisk ? 'disk' : 'app', null)
            .then(() => {
              if (keepDisk && event.disk_content) {
                importFileContent(cName, event.disk_content);
              }
            })
            .catch(e => console.error('[gpx-sync] resolve failed:', e));
          break;
        }
        default:
          console.debug('[gpx-sync] unhandled event:', event);
      }
    }
  }).catch(e => console.warn('[gpx-sync] listener setup failed:', e));
}

// ---- Expose key variables for E2E tests ----

const _layerRegistryProxy = {
  buildCatalogEntryFromTileJson, registerUserSource, unregisterUserSource,
  clearUserSources, getUserSources, getAllEntries, getBasemaps, getOverlays,
};

Object.defineProperties(window, {
  mapReady:            { get() { return tracksState.mapReady; } },
  map:                 { get() { return map; } },
  state:               { get() { return state; } },
  tracks:              { get() { return tracksState.tracks; } },
  waypoints:           { get() { return tracksState.waypoints; } },
  activeTrackId:       { get() { return tracksState.activeTrackId; } },
  editingTrackId:      { get() { return tracksState.editingTrackId; } },
  selectedVertexIndex: { get() { return tracksState.selectedVertexIndex; } },
  insertAfterIdx:      { get() { return tracksState.insertAfterIdx; } },
  mobileFriendlyMode:  { get() { return tracksState.mobileFriendlyMode; } },
  importFileContent:   { get() { return importFileContent; } },
  setActiveTrack:      { get() { return tracksState.setActiveTrack; } },
  promotedTrackId:     { get() { return tracksState.promotedTrackId; } },
  profileChart:        { get() { return getProfileChart(); } },
  profileClosed:       { get() { return tracksState.profileClosed; } },
  resetForTest:        { get() { return resetForTest; } },
  layerRegistry:       { get() { return _layerRegistryProxy; } },
  renderAddLayerSelect: { get() { return renderAddLayerSelect; } },
  renderLayerOrderPanel: { get() { return renderLayerOrderPanel; } },
  refreshTileLayers:   { get() { return refreshTileLayers; } },
  // Layer engine functions for E2E tests
  applyModeState:        { get() { return (m, s) => applyModeState(m, s); } },
  applyAllOverlays:      { get() { return (m, s) => applyAllOverlays(m, s); } },
  applyHillshadeVisibility: { get() { return (m, s) => applyHillshadeVisibility(m, s); } },
  applyContourVisibility: { get() { return (m, s) => applyContourVisibility(m, s); } },
  setGlobalStatePropertySafe: { get() { return (m, k, v) => setGlobalStatePropertySafe(m, k, v); } },
  syncLayerOrder:        { get() { return (s) => syncLayerOrder(s); } },
  createBookmark:        { get() { return (s) => createBookmark(s); } },
  applyBookmark:         { get() { return (m, s, bm) => applyBookmark(m, s, bm); } },
  setBasemap:            { get() { return (m, s, id, fly) => setBasemap(m, s, id, fly); } },
  setBasemapStack:       { get() { return (m, s, ids) => setBasemapStack(m, s, ids); } },
});
