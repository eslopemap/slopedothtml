// GPX workspace tree renderer, context menu, and Info editor.
// Renders a hierarchical tree in the track panel area, with disclosure, context menus, and Info editing.

import {
  createWorkspaceModel, createFileNode, createTrackNode, createSegmentNode,
  createRouteNode, createWaypointNode, createFolderNode,
  walkNodes, findNodeById, findParentOf,
} from './gpx-model.js';
import { saveWorkspace, loadWorkspace } from './persist.js';
import { exportNodeGPX } from './io.js';

let workspace = createWorkspaceModel();
let treeState = {
  expandedNodeIds: new Set(),
  selectedNodeId: null,       // primary (last-clicked) selection — drives active track
  selectedNodeIds: new Set(),  // all selected nodes (ctrl/shift multi-select)
  contextMenu: null,    // { nodeId, x, y }
  infoEditor: null,     // { nodeId }
};

let _deps = {};   // injected from tracks.js
let _trackListEl = null;
let _contextMenuEl = null;
let _infoOverlayEl = null;
let _scheduleSave = null;
let _workspaceMenuBtn = null;
let _clipboard = null;

// Node type icons
const NODE_ICONS = {
  folder: '📁',
  file: '📄',
  track: '🛤️',
  segment: '┗',
  route: '🧭',
  waypoint: '📍',
};

// ---- Public API ----

export function initGpxTree(deps) {
  _deps = deps;
  _trackListEl = document.getElementById('track-list');
  _scheduleSave = deps.scheduleSave;

  // Create context menu element
  _contextMenuEl = document.createElement('div');
  _contextMenuEl.id = 'tree-context-menu';
  _contextMenuEl.className = 'tree-context-menu';
  document.body.appendChild(_contextMenuEl);

  // Create Info editor overlay
  _infoOverlayEl = document.createElement('div');
  _infoOverlayEl.id = 'info-editor-overlay';
  _infoOverlayEl.className = 'info-editor-overlay';
  document.body.appendChild(_infoOverlayEl);

  // Close context menu on outside click
  document.addEventListener('click', (e) => {
    if (_contextMenuEl.classList.contains('visible') && !_contextMenuEl.contains(e.target)) {
      closeContextMenu();
    }
  });
  document.addEventListener('contextmenu', (e) => {
    if (_contextMenuEl.classList.contains('visible') && !_contextMenuEl.contains(e.target)) {
      closeContextMenu();
    }
  });

  ensureWorkspaceMenuButton();

  // Keyboard navigation in tree list
  _trackListEl.tabIndex = 0;
  _trackListEl.addEventListener('keydown', handleTreeKeydown);

  // Build initial tree from tracks
  rebuildTree();
}

export function getWorkspace() { return workspace; }

export function getPrimarySelectionNode() {
  return treeState.selectedNodeId ? findNodeById(workspace.children, treeState.selectedNodeId) : null;
}

export function findNodeForTrackId(trackId, options) {
  const preferFile = options?.preferFile === true;
  let match = null;
  walkNodes(workspace.children, (node) => {
    if (match) return;
    if (node._trackId === trackId || node._trackIds?.includes(trackId)) {
      match = node;
    }
  });
  if (!match) return null;
  if (!preferFile) return match;
  const parent = findParentOf(workspace.children, match.id);
  return parent?.type === 'file' ? parent : match;
}

export function rebuildTree() {
  const tracks = _deps.getTracks();
  const waypoints = _deps.getWaypoints();
  const saved = loadWorkspace();
  workspace = saved?.children
    ? restoreWorkspace(saved, tracks, waypoints)
    : buildWorkspaceFromTracks(tracks, waypoints);

  walkNodes(workspace.children, n => {
    if (n.children > 1) treeState.expandedNodeIds.add(n.id);
  });
}

function restoreWorkspace(savedWorkspace, tracks, waypoints) {
  const trackIds = new Set(tracks.map(track => track.id));
  const waypointIds = new Set(waypoints.map(wp => wp.id));
  const referencedTrackIds = new Set();
  const referencedWaypointIds = new Set();

  function cloneSavedNode(node) {
    const clone = { ...node };
    if (node.children) clone.children = [];

    if (node._trackId) {
      if (!trackIds.has(node._trackId)) return null;
      referencedTrackIds.add(node._trackId);
    }
    if (node._trackIds?.length) {
      clone._trackIds = node._trackIds.filter(id => trackIds.has(id));
      clone._trackIds.forEach(id => referencedTrackIds.add(id));
      if (!clone._trackIds.length && node.type === 'track') return null;
    }
    if (node._waypointId) {
      if (!waypointIds.has(node._waypointId)) return null;
      referencedWaypointIds.add(node._waypointId);
    }

    if (node.children?.length) {
      for (const child of node.children) {
        const clonedChild = cloneSavedNode(child);
        if (clonedChild) clone.children.push(clonedChild);
      }
    }

    if ((clone.type === 'file' || clone.type === 'folder') && clone.children && clone.children.length === 0) {
      return clone;
    }
    return clone;
  }

  const restored = createWorkspaceModel();
  for (const child of savedWorkspace.children || []) {
    const cloned = cloneSavedNode(child);
    if (cloned) restored.children.push(cloned);
  }

  const orphanTracks = tracks.filter(track => !referencedTrackIds.has(track.id));
  const orphanWaypoints = waypoints.filter(wp => !referencedWaypointIds.has(wp.id));
  if (orphanTracks.length || orphanWaypoints.length) {
    const orphanWs = buildWorkspaceFromTracks(orphanTracks, orphanWaypoints);
    restored.children.push(...orphanWs.children);
  }

  return restored;
}

function buildWorkspaceFromTracks(tracks, waypoints) {
  const ws = createWorkspaceModel();
  const groupMap = new Map();
  for (const t of tracks) {
    if ((t.sourceKind || 'track') === 'route') {
      const fileNode = createFileNode(t.name, { desc: t.desc || '' });
      fileNode.children.push(createRouteNode(t.name, {
        desc: t.desc || '', cmt: t.cmt || '', rteType: t.rteType || '',
        _trackId: t.id,
      }));
      ws.children.push(fileNode);
      continue;
    }
    if (t.groupId) {
      if (!groupMap.has(t.groupId)) {
        const fileNode = createFileNode(t.groupName || t.name);
        const trackNode = createTrackNode(t.groupName || t.name, {
          desc: t.desc || '', cmt: t.cmt || '', trkType: t.trkType || '',
          _trackIds: [],
        });
        fileNode.children.push(trackNode);
        ws.children.push(fileNode);
        groupMap.set(t.groupId, { fileNode, trackNode });
      }
      const { trackNode } = groupMap.get(t.groupId);
      trackNode.children.push(createSegmentNode({ _trackId: t.id }));
      trackNode._trackIds.push(t.id);
    } else {
      const fileNode = createFileNode(t.name, { desc: t.desc || '' });
      fileNode.children.push(createTrackNode(t.name, {
        desc: t.desc || '', cmt: t.cmt || '', trkType: t.trkType || '',
        _trackIds: [t.id],
      }));
      ws.children.push(fileNode);
    }
  }
  for (const wp of waypoints) {
    ws.children.push(createWaypointNode(wp.name, {
      desc: wp.desc, cmt: wp.comment, sym: wp.sym,
      coords: wp.coords, _waypointId: wp.id,
    }));
  }
  return ws;
}

function ensureWorkspaceMenuButton() {
  _workspaceMenuBtn = document.getElementById('active-actions-btn');
}

function collectDescendantTrackIds(node) {
  const ids = [];
  if (node._trackId) ids.push(node._trackId);
  if (node._trackIds) ids.push(...node._trackIds);
  if (node.children) {
    walkNodes(node.children, n => {
      if (n._trackId) ids.push(n._trackId);
      if (n._trackIds) ids.push(...n._trackIds);
    });
  }
  return ids;
}

function getVisibleRows() {
  return _trackListEl ? [..._trackListEl.querySelectorAll('.tree-row')] : [];
}

function getSingleDescendantTrackId(node) {
  const trackIds = collectDescendantTrackIds(node);
  return trackIds.length === 1 ? trackIds[0] : null;
}

function selectSingleNode(nodeId) {
  treeState.selectedNodeId = nodeId;
  treeState.selectedNodeIds.clear();
  if (nodeId) treeState.selectedNodeIds.add(nodeId);
}

function handleTreeKeydown(e) {
  const rows = getVisibleRows();
  if (!rows.length) return;
  const currentIdx = rows.findIndex(r => r.dataset.nodeId === treeState.selectedNodeId);

  if (e.key === 'ArrowDown') {
    e.preventDefault();
    const nextIdx = currentIdx < rows.length - 1 ? currentIdx + 1 : 0;
    rows[nextIdx].click();
    rows[nextIdx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    const prevIdx = currentIdx > 0 ? currentIdx - 1 : rows.length - 1;
    rows[prevIdx].click();
    rows[prevIdx].scrollIntoView({ block: 'nearest' });
  } else if (e.key === 'ArrowRight') {
    e.preventDefault();
    if (treeState.selectedNodeId) {
      const node = findNodeById(workspace.children, treeState.selectedNodeId);
      if (node?.children?.length && !treeState.expandedNodeIds.has(node.id)) {
        treeState.expandedNodeIds.add(node.id);
        renderGpxTree();
      }
    }
  } else if (e.key === 'ArrowLeft') {
    e.preventDefault();
    if (treeState.selectedNodeId) {
      const node = findNodeById(workspace.children, treeState.selectedNodeId);
      if (node?.children?.length && treeState.expandedNodeIds.has(node.id)) {
        treeState.expandedNodeIds.delete(node.id);
        renderGpxTree();
      } else {
        // Move to parent
        const parent = findParentOf(workspace.children, treeState.selectedNodeId);
        if (parent) {
          selectSingleNode(parent.id);
          const trackIds = collectDescendantTrackIds(parent);
          const firstId = parent._trackId || parent._trackIds?.[0];
          if (firstId) _deps.setActiveTrack(firstId);
          if (trackIds.length) _deps.fitToTrackIds(trackIds);
          syncTreeSelection();
          const parentRow = _trackListEl.querySelector(`.tree-row[data-node-id="${parent.id}"]`);
          if (parentRow) parentRow.scrollIntoView({ block: 'nearest' });
        }
      }
    }
  } else if (e.key === 'Backspace' || e.key === 'Delete') {
    e.preventDefault();
    if (treeState.selectedNodeId) {
      const node = findNodeById(workspace.children, treeState.selectedNodeId);
      if (node && node.type !== 'segment') {
        deleteNode(node);
      }
    }
  } else if (e.key === 'Enter') {
    e.preventDefault();
    if (treeState.selectedNodeId) {
      openInfoEditor(treeState.selectedNodeId);
    }
  }
}

let _renderRafId = 0;

function renderGpxTreeImmediate() {
  _renderRafId = 0;
  if (!_trackListEl) return;
  _trackListEl.innerHTML = '';
  renderNodeList(workspace.children, _trackListEl, 0);
  requestAnimationFrame(() => {
    const activeRow = _trackListEl.querySelector('.tree-row.active');
    if (activeRow) activeRow.scrollIntoView({ block: 'nearest' });
  });
}

export function renderGpxTree() {
  if (_renderRafId) return;  // already scheduled
  _renderRafId = requestAnimationFrame(renderGpxTreeImmediate);
}

export function syncTreeSelection() {
  const items = _trackListEl?.querySelectorAll('.tree-row');
  if (!items) return;
  // Collect descendant IDs of all selected nodes for child-selected highlighting
  const childIds = new Set();
  for (const selId of treeState.selectedNodeIds) {
    const selNode = findNodeById(workspace.children, selId);
    if (selNode?.children) {
      walkNodes(selNode.children, n => childIds.add(n.id));
    }
  }
  items.forEach(row => {
    const nodeId = row.dataset.nodeId;
    row.classList.toggle('selected', treeState.selectedNodeIds.has(nodeId));
    row.classList.toggle('child-selected', childIds.has(nodeId));
  });
}

export function openNodeContextMenu(nodeId, x, y) {
  const node = findNodeById(workspace.children, nodeId);
  if (!node) return;

  treeState.contextMenu = { nodeId, x, y };
  _contextMenuEl.innerHTML = '';

  const items = getContextMenuItems(node);
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-separator';
      _contextMenuEl.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-item';
    btn.textContent = item.label;
    if (item.disabled) btn.disabled = true;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      item.action();
    });
    _contextMenuEl.appendChild(btn);
  }

  // Position
  _contextMenuEl.style.left = x + 'px';
  _contextMenuEl.style.top = y + 'px';
  _contextMenuEl.classList.add('visible');

  // Adjust if off-screen
  requestAnimationFrame(() => {
    const rect = _contextMenuEl.getBoundingClientRect();
    if (rect.right > window.innerWidth) {
      _contextMenuEl.style.left = Math.max(0, x - rect.width) + 'px';
    }
    if (rect.bottom > window.innerHeight) {
      _contextMenuEl.style.top = Math.max(0, y - rect.height) + 'px';
    }
  });
}

export function openCurrentContextMenu(x, y) {
  const nodeId = treeState.selectedNodeId || findNodeForTrackId(_deps.getActiveTrackId?.())?.id || null;
  if (nodeId) openNodeContextMenu(nodeId, x, y);
  else openWorkspaceContextMenu(x, y);
}

function openWorkspaceContextMenu(x, y) {
  treeState.contextMenu = { nodeId: null, x, y };
  _contextMenuEl.innerHTML = '';
  const items = getWorkspaceContextMenuItems();
  for (const item of items) {
    if (item.separator) {
      const sep = document.createElement('div');
      sep.className = 'ctx-separator';
      _contextMenuEl.appendChild(sep);
      continue;
    }
    const btn = document.createElement('button');
    btn.className = 'ctx-item';
    btn.textContent = item.label;
    if (item.disabled) btn.disabled = true;
    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      closeContextMenu();
      item.action();
    });
    _contextMenuEl.appendChild(btn);
  }
  _contextMenuEl.style.left = x + 'px';
  _contextMenuEl.style.top = y + 'px';
  _contextMenuEl.classList.add('visible');
}

export function openInfoEditor(nodeId) {
  const node = findNodeById(workspace.children, nodeId);
  if (!node) return;
  treeState.infoEditor = { nodeId };
  renderInfoEditor(node);
}

export function closeInfoEditor() {
  treeState.infoEditor = null;
  _infoOverlayEl.classList.remove('visible');
  _infoOverlayEl.innerHTML = '';
}

// ---- Context menu helpers ----

function closeContextMenu() {
  treeState.contextMenu = null;
  _contextMenuEl.classList.remove('visible');
}

function getContextMenuItems(node) {
  const items = [];

  // Info (all except segment)
  if (node.type !== 'segment') {
    items.push({ label: 'ℹ Info…', action: () => openInfoEditor(node.id) });
  }

  // Type-specific actions
  if (node.type === 'track' || node.type === 'segment' || node.type === 'route') {
    const nodeTrackId = node._trackId || (node._trackIds?.[0]);
    if (nodeTrackId) {
      items.push({ separator: true });
      items.push({
        label: '✎ Edit',
        action: () => _deps.enterEditForTrack(nodeTrackId),
      });
      items.push({
        label: '📈 Profile',
        action: () => _deps.showProfileForTrack(nodeTrackId),
      });
      items.push({
        label: '🔎 Zoom to',
        action: () => _deps.fitToTrackById(nodeTrackId),
      });
      if (node.type === 'route') {
        items.push({
          label: '⇢ Convert to track',
          action: () => _deps.convertRouteById?.(nodeTrackId, { replace: false }),
        });
        items.push({
          label: '⇢ Convert and replace',
          action: () => _deps.convertRouteById?.(nodeTrackId, { replace: true }),
        });
      } else {
        items.push({
          label: '≈ Simplify…',
          action: () => _deps.simplifyTrackById?.(nodeTrackId),
        });
        items.push({
          label: '＋ Add intermediate points',
          action: () => _deps.densifyTrackById?.(nodeTrackId),
        });
        items.push({
          label: '✂ Split',
          action: () => _deps.splitTrackById?.(nodeTrackId),
        });
      }
    }
  }

  if (node.type === 'file') {
    items.push({ separator: true });
    items.push({
      label: '＋ New file',
      action: () => addSiblingFile(node),
    });
    items.push({
      label: '＋ New track',
      action: () => addTrackToFile(node),
    });
    items.push({
      label: '⤓ Export GPX',
      action: () => exportNodeGPX(node),
    });

    const trks = node.children?.filter(c => c.type === 'track' || c.type === 'route') || [];
    let trackIdsForFile = [];
    let totalSegments = 0;
    trks.forEach(t => { 
       if (t._trackIds) {
          trackIdsForFile.push(...t._trackIds);
          totalSegments += t._trackIds.length;
       }
       if (t._trackId) {
          trackIdsForFile.push(t._trackId);
          totalSegments += 1;
       }
    });

    if (trks.length > 0) {
      items.push({ separator: true });
      items.push({ label: `— Tracks (${trks.length}) ${totalSegments > trks.length ? ` / Segments (${totalSegments})` : ''} —`, action: () => {}, disabled: true });
      
      if (trks.length === 1 && trackIdsForFile.length === 1) {
         const nodeTrackId = trackIdsForFile[0];
         items.push({ label: '✎ Edit', action: () => _deps.enterEditForTrack(nodeTrackId) });
         items.push({ label: '📈 Profile', action: () => _deps.showProfileForTrack(nodeTrackId) });
         items.push({ label: '🔎 Zoom to', action: () => _deps.fitToTrackById(nodeTrackId) });
         const isRoute = trks[0].type === 'route';
         if (isRoute) {
            items.push({ label: '⇢ Convert to track', action: () => _deps.convertRouteById?.(nodeTrackId, { replace: false }) });
            items.push({ label: '⇢ Convert and replace', action: () => _deps.convertRouteById?.(nodeTrackId, { replace: true }) });
         } else {
            items.push({ label: '≈ Simplify…', action: () => _deps.simplifyTrackById?.(nodeTrackId) });
            items.push({ label: '＋ Add intermediate points', action: () => _deps.densifyTrackById?.(nodeTrackId) });
            items.push({ label: '✂ Split', action: () => _deps.splitTrackById?.(nodeTrackId) });
         }
      } else {
         items.push({
           label: '🔎 Zoom to all',
           action: () => {
             if (trackIdsForFile.length > 0) {
                _deps.fitToTrackIds(trackIdsForFile);
             }
           }
         });
      }
    }
  }

  if (node.type === 'folder') {
    items.push({ separator: true });
    items.push({
      label: '＋ New file',
      action: () => addFileToFolder(node),
    });
  }

  if (node.type === 'track') {
    items.push({ separator: true });
    items.push({
      label: '＋ New segment',
      action: () => addSegmentToTrack(node),
    });
    if ((node._trackIds || []).length > 1) {
      items.push({
        label: '⇄ Merge segments into one',
        action: () => _deps.mergeTrackNodeByIds?.(node._trackIds || [], { mode: 'single-segment', name: node.name || 'Track' }),
      });
    }
    items.push({
      label: '⤓ Export GPX',
      action: () => exportNodeGPX(node),
    });
  }

  if (node.type === 'route') {
    items.push({ separator: true });
    items.push({
      label: '⤓ Export GPX',
      action: () => exportNodeGPX(node),
    });
  }

  items.push({ separator: true });
  items.push({ label: '⧉ Duplicate', disabled: !canDuplicateNode(node), action: () => duplicateNode(node) });
  items.push({ label: '📋 Copy', disabled: !canCopyNode(node), action: () => copyNode(node) });
  items.push({ label: '✂ Cut', disabled: !canCutNode(node), action: () => cutNode(node) });
  items.push({ label: '📥 Paste', disabled: !canPasteInto(node), action: () => pasteInto(node) });

  if (node.type === 'file' || node.type === 'folder') {
    items.push({ separator: true });
    items.push({
      label: '🔎 Zoom to all',
      action: () => {
        const ids = collectTrackIds(node);
        if (ids.length) _deps.fitToTrackIds(ids);
      },
    });
  }

  // Delete
  if (node.type !== 'segment') {
    items.push({ separator: true });
    items.push({
      label: '🗑 Delete',
      action: () => deleteNode(node),
    });
  }

  return items;
}

function collectTrackIds(node) {
  const ids = [];
  if (node._trackId) ids.push(node._trackId);
  if (node._trackIds) ids.push(...node._trackIds);
  if (node.children) {
    for (const c of node.children) ids.push(...collectTrackIds(c));
  }
  return ids;
}

function findParentCollection(nodes, id) {
  for (const node of nodes) {
    if (node.children?.some(child => child.id === id)) return node.children;
    if (node.children) {
      const found = findParentCollection(node.children, id);
      if (found) return found;
    }
  }
  return nodes;
}

function getWorkspaceContextMenuItems() {
  return [
    { label: '＋ New file', action: () => createRootFile() },
    { separator: true },
    { label: '📥 Paste', disabled: !canPasteIntoWorkspace(), action: () => pasteIntoWorkspace() },
  ];
}

function createRootFile() {
  const fileNode = createFileNode(nextFileName());
  workspace.children.push(fileNode);
  treeState.expandedNodeIds.add(fileNode.id);
  selectSingleNode(fileNode.id);
  scheduleWorkspaceSave();
  renderGpxTree();
  openInfoEditor(fileNode.id);
}

function addSiblingFile(node) {
  const collection = findParentCollection(workspace.children, node.id);
  const insertIndex = collection.findIndex(item => item.id === node.id);
  const fileNode = createFileNode(nextFileName());
  collection.splice(insertIndex + 1, 0, fileNode);
  treeState.expandedNodeIds.add(fileNode.id);
  selectSingleNode(fileNode.id);
  scheduleWorkspaceSave();
  renderGpxTree();
  openInfoEditor(fileNode.id);
}

function addFileToFolder(folderNode) {
  const fileNode = createFileNode(nextFileName());
  folderNode.children ||= [];
  folderNode.children.push(fileNode);
  treeState.expandedNodeIds.add(folderNode.id);
  treeState.expandedNodeIds.add(fileNode.id);
  selectSingleNode(fileNode.id);
  scheduleWorkspaceSave();
  renderGpxTree();
  openInfoEditor(fileNode.id);
}

function nextFileName() {
  const existing = new Set();
  walkNodes(workspace.children, (node) => {
    if (node.type === 'file' && node.name) existing.add(node.name);
  });
  let index = 1;
  while (existing.has(`Outing ${index}.gpx`)) index++;
  return `Outing ${index}.gpx`;
}

function canDuplicateNode(node) {
  return ['file', 'track', 'segment', 'waypoint'].includes(node.type);
}

function canCopyNode(node) {
  return ['file', 'track', 'segment', 'waypoint'].includes(node.type);
}

function canCutNode(node) {
  return ['file', 'track', 'segment', 'waypoint'].includes(node.type);
}

function canPasteInto(node) {
  if (!_clipboard) return false;
  if (node.type === 'file') return ['file', 'track', 'segment', 'waypoint'].includes(_clipboard.kind);
  if (node.type === 'folder') return ['file', 'track', 'waypoint'].includes(_clipboard.kind);
  if (node.type === 'track') return _clipboard.kind === 'segment';
  return false;
}

function canPasteIntoWorkspace() {
  return Boolean(_clipboard && _clipboard.kind === 'file');
}

function duplicateNode(node) {
  const payload = snapshotNodePayload(node);
  if (!payload) return;
  pastePayloadNearNode(node, payload, false, true);
}

function copyNode(node) {
  const payload = snapshotNodePayload(node);
  if (!payload) return;
  _clipboard = { mode: 'copy', sourceNodeId: node.id, kind: payload.kind, payload };
}

function cutNode(node) {
  const payload = snapshotNodePayload(node);
  if (!payload) return;
  _clipboard = { mode: 'cut', sourceNodeId: node.id, kind: payload.kind, payload };
}

function pasteInto(node) {
  if (!_clipboard) return;
  pastePayloadNearNode(node, _clipboard.payload, _clipboard.mode === 'cut', false);
}

function pasteIntoWorkspace() {
  if (!_clipboard || _clipboard.kind !== 'file') return;
  const inserted = materializeFilePayload(_clipboard.payload, workspace.children);
  if (!inserted) return;
  if (_clipboard.mode === 'cut') {
    removeOriginalClipboardSource(inserted.id);
    return;
  }
  afterMutationSelectAndRender(inserted.id);
}

function removeOriginalClipboardSource(selectNodeId = null) {
  if (!_clipboard?.sourceNodeId) return;
  const sourceNode = findNodeById(workspace.children, _clipboard.sourceNodeId);
  if (sourceNode) removeNodeAndData(sourceNode, false);
  _clipboard = null;
  afterMutationSelectAndRender(selectNodeId);
}

function pastePayloadNearNode(targetNode, payload, shouldRemoveSource, asDuplicate) {
  let inserted = null;
  if (targetNode.type === 'folder') treeState.expandedNodeIds.add(targetNode.id);
  if (targetNode.type === 'file') {
    if (payload.kind === 'file') {
      const collection = findParentCollection(workspace.children, targetNode.id);
      const insertIndex = collection.findIndex(item => item.id === targetNode.id);
      inserted = materializeFilePayload(payload, collection, insertIndex + 1, asDuplicate);
    } else if (payload.kind === 'track') {
      inserted = materializeTrackPayloadIntoFile(payload, targetNode, asDuplicate);
    } else if (payload.kind === 'segment') {
      inserted = materializeSegmentPayloadIntoFile(payload, targetNode, asDuplicate);
    } else if (payload.kind === 'waypoint') {
      inserted = materializeWaypointPayload(payload, targetNode.children ||= [], asDuplicate);
    }
  } else if (targetNode.type === 'folder') {
    if (payload.kind === 'file') inserted = materializeFilePayload(payload, targetNode.children ||= [], undefined, asDuplicate);
    if (payload.kind === 'track') inserted = materializeTrackPayloadIntoContainer(payload, targetNode.children ||= [], asDuplicate);
    if (payload.kind === 'waypoint') inserted = materializeWaypointPayload(payload, targetNode.children ||= [], asDuplicate);
  } else if (targetNode.type === 'track' && payload.kind === 'segment') {
    inserted = materializeSegmentPayloadIntoTrack(payload, targetNode, asDuplicate);
  }
  if (!inserted) return;
  if (shouldRemoveSource) removeOriginalClipboardSource(inserted.id);
  else afterMutationSelectAndRender(inserted.id);
}

function afterMutationSelectAndRender(nodeId) {
  selectSingleNode(nodeId);
  scheduleWorkspaceSave();
  renderGpxTree();
}

function snapshotTrack(track) {
  return {
    name: track.name,
    coords: track.coords.map(coord => coord.slice()),
    color: track.color,
    segmentLabel: track.segmentLabel || '',
  };
}

function snapshotWaypoint(node) {
  const waypoint = node._waypointId ? _deps.findWaypointById?.(node._waypointId) : null;
  const source = waypoint || node;
  return {
    name: source.name || 'Waypoint',
    coords: source.coords ? source.coords.slice() : null,
    sym: source.sym || '',
    desc: source.desc || '',
    comment: source.comment || source.cmt || '',
    wptType: source.wptType || '',
  };
}

function snapshotNodePayload(node) {
  if (node.type === 'segment') {
    const track = node._trackId ? _deps.findTrack(node._trackId) : null;
    if (!track) return null;
    return { kind: 'segment', segment: snapshotTrack(track) };
  }
  if (node.type === 'track') {
    const segments = (node._trackIds || []).map(id => _deps.findTrack(id)).filter(Boolean).map(snapshotTrack);
    return {
      kind: 'track',
      name: node.name || 'Track',
      desc: node.desc || '',
      cmt: node.cmt || '',
      trkType: node.trkType || '',
      segments,
    };
  }
  if (node.type === 'file') {
    return {
      kind: 'file',
      name: node.name || nextFileName(),
      desc: node.desc || '',
      children: (node.children || []).map(child => snapshotNodePayload(child)).filter(Boolean),
    };
  }
  if (node.type === 'waypoint') {
    return { kind: 'waypoint', waypoint: snapshotWaypoint(node) };
  }
  return null;
}

function cloneName(name, suffix = 'copy') {
  return `${name || 'Item'} ${suffix}`;
}

function materializeFilePayload(payload, collection, insertIndex, asDuplicate) {
  const fileNode = createFileNode(asDuplicate ? cloneName(payload.name) : payload.name, { desc: payload.desc || '' });
  if (insertIndex == null || insertIndex < 0 || insertIndex > collection.length) collection.push(fileNode);
  else collection.splice(insertIndex, 0, fileNode);
  for (const child of payload.children || []) {
    if (child.kind === 'track') materializeTrackPayloadIntoFile(child, fileNode, asDuplicate);
    if (child.kind === 'waypoint') materializeWaypointPayload(child, fileNode.children ||= [], asDuplicate);
  }
  return fileNode;
}

function materializeTrackPayloadIntoContainer(payload, collection, asDuplicate) {
  const fileNode = createFileNode(nextFileName());
  collection.push(fileNode);
  treeState.expandedNodeIds.add(fileNode.id);
  return materializeTrackPayloadIntoFile(payload, fileNode, asDuplicate);
}

function materializeTrackPayloadIntoFile(payload, fileNode, asDuplicate) {
  const trackName = asDuplicate ? cloneName(payload.name) : payload.name;
  const trackNode = createTrackNode(trackName, {
    desc: payload.desc || '',
    cmt: payload.cmt || '',
    trkType: payload.trkType || '',
    _trackIds: [],
  });
  fileNode.children ||= [];
  fileNode.children.push(trackNode);
  treeState.expandedNodeIds.add(fileNode.id);
  if ((payload.segments || []).length > 1) {
    const groupId = `grp-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const groupName = trackName;
    (payload.segments || []).forEach((segment, index) => {
      const created = _deps.createTrackWithoutTree?.(trackName, segment.coords.map(coord => coord.slice()), {
        color: segment.color,
        groupId,
        groupName,
        segmentLabel: segment.segmentLabel || `Segment ${index + 1}`,
      });
      if (created) trackNode._trackIds.push(created.id);
    });
  } else {
    const segment = payload.segments?.[0];
    const created = _deps.createTrackWithoutTree?.(trackName, (segment?.coords || []).map(coord => coord.slice()), {
      color: segment?.color,
    });
    if (created) trackNode._trackIds.push(created.id);
  }
  return trackNode;
}

function materializeSegmentPayloadIntoTrack(payload, trackNode, asDuplicate) {
  const grouping = _deps.ensureTrackGrouping?.([...(trackNode._trackIds || [])], trackNode.name || 'Track');
  if (!grouping?.groupId) return null;
  const segment = payload.segment;
  const created = _deps.createTrackWithoutTree?.(trackNode.name || 'Track', (segment.coords || []).map(coord => coord.slice()), {
    color: segment.color,
    groupId: grouping.groupId,
    groupName: grouping.groupName,
    segmentLabel: asDuplicate ? cloneName(segment.segmentLabel || `Segment ${grouping.segmentCount + 1}`) : (segment.segmentLabel || `Segment ${grouping.segmentCount + 1}`),
  });
  if (!created) return null;
  rebuildTree();
  const selectedNode = findNodeForTrackId(created.id);
  if (selectedNode) {
    treeState.expandedNodeIds.add(selectedNode.id);
    const parent = findParentOf(workspace.children, selectedNode.id);
    if (parent) treeState.expandedNodeIds.add(parent.id);
  }
  return selectedNode;
}

function materializeSegmentPayloadIntoFile(payload, fileNode, asDuplicate) {
  const trackPayload = {
    kind: 'track',
    name: asDuplicate ? cloneName(payload.segment.name || 'Track') : (payload.segment.name || 'Track'),
    desc: '',
    cmt: '',
    trkType: '',
    segments: [payload.segment],
  };
  return materializeTrackPayloadIntoFile(trackPayload, fileNode, false);
}

function materializeWaypointPayload(payload, collection, asDuplicate) {
  const waypoint = payload.waypoint;
  const created = _deps.createWaypoint?.({
    name: asDuplicate ? cloneName(waypoint.name || 'Waypoint') : (waypoint.name || 'Waypoint'),
    coords: waypoint.coords ? waypoint.coords.slice() : null,
    sym: waypoint.sym || '',
    desc: waypoint.desc || '',
    comment: waypoint.comment || '',
  });
  if (!created) return null;
  const waypointNode = createWaypointNode(created.name, {
    coords: created.coords,
    sym: created.sym,
    desc: created.desc,
    cmt: created.comment,
    wptType: waypoint.wptType || '',
    _waypointId: created.id,
  });
  collection.push(waypointNode);
  return waypointNode;
}

function removeNodeAndData(node, shouldRender = true) {
  const trackIds = collectTrackIds(node);
  for (const id of trackIds) _deps.deleteTrackById(id);
  if (node._waypointId) _deps.deleteWaypointById?.(node._waypointId);
  removeNodeFromTree(workspace.children, node.id);
  if (shouldRender) {
    scheduleWorkspaceSave();
    renderGpxTree();
  }
}

function deleteNode(node) {
  const ids = collectTrackIds(node);
  const name = node.name || node.type;
  if (!confirm(`Delete "${name}"${ids.length > 1 ? ` (${ids.length} tracks)` : ''}?`)) return;
  removeNodeAndData(node, true);
}

function removeNodeFromTree(nodes, id) {
  for (let i = 0; i < nodes.length; i++) {
    if (nodes[i].id === id) { nodes.splice(i, 1); return true; }
    if (nodes[i].children && removeNodeFromTree(nodes[i].children, id)) return true;
  }
  return false;
}

function addTrackToFile(fileNode) {
  const trackName = _deps.suggestTrackNameForFile?.(fileNode) || 'Track';
  const track = _deps.createTrackWithoutTree?.(trackName, [], {});
  if (!track) return;

  const trackNode = createTrackNode(trackName, { _trackIds: [track.id] });
  fileNode.children ||= [];
  fileNode.children.push(trackNode);
  treeState.expandedNodeIds.add(fileNode.id);
  selectSingleNode(trackNode.id);
  scheduleWorkspaceSave();
  renderGpxTree();
  _deps.enterEditForTrack?.(track.id);
}

function addSegmentToTrack(trackNode) {
  const existingIds = [...(trackNode._trackIds || [])];
  if (!existingIds.length) return;

  const grouping = _deps.ensureTrackGrouping?.(existingIds, trackNode.name || 'Track');
  if (!grouping?.groupId) return;

  const segmentLabel = `Segment ${grouping.segmentCount + 1}`;
  const track = _deps.createTrackWithoutTree?.(trackNode.name || 'Track', [], {
    groupId: grouping.groupId,
    groupName: grouping.groupName,
    segmentLabel,
  });
  if (!track) return;

  rebuildTree();
  const selectedNode = findNodeForTrackId(track.id);
  if (selectedNode) {
    selectSingleNode(selectedNode.id);
    treeState.expandedNodeIds.add(selectedNode.id);
    const parent = findParentOf(workspace.children, selectedNode.id);
    if (parent) treeState.expandedNodeIds.add(parent.id);
  }
  scheduleWorkspaceSave();
  renderGpxTree();
  _deps.enterEditForTrack?.(track.id);
}

// ---- Info editor ----

const INFO_FIELDS = {
  folder: ['name'],
  file: ['name', 'desc'],
  track: ['name', 'desc', 'cmt', 'trkType'],
  route: ['name', 'desc', 'cmt', 'rteType'],
  waypoint: ['name', 'desc', 'cmt', 'sym', 'wptType'],
};

const FIELD_LABELS = {
  name: 'Name',
  desc: 'Description',
  cmt: 'Comment',
  trkType: 'Type',
  rteType: 'Type',
  wptType: 'Type',
  sym: 'Symbol',
};

function renderInfoEditor(node) {
  const fields = INFO_FIELDS[node.type] || ['name'];
  _infoOverlayEl.innerHTML = '';

  const panel = document.createElement('div');
  panel.className = 'info-editor-panel';

  const title = document.createElement('h3');
  title.textContent = `${NODE_ICONS[node.type] || ''} ${node.type.charAt(0).toUpperCase() + node.type.slice(1)} Info`;
  panel.appendChild(title);

  const inputs = {};
  for (const field of fields) {
    const row = document.createElement('div');
    row.className = 'info-field-row';
    const label = document.createElement('label');
    label.textContent = FIELD_LABELS[field] || field;
    label.setAttribute('for', `info-${field}`);
    row.appendChild(label);

    if (field === 'desc' || field === 'cmt') {
      const textarea = document.createElement('textarea');
      textarea.id = `info-${field}`;
      textarea.value = node[field] || '';
      textarea.rows = 3;
      row.appendChild(textarea);
      inputs[field] = textarea;
    } else {
      const input = document.createElement('input');
      input.id = `info-${field}`;
      input.type = 'text';
      input.value = node[field] || '';
      row.appendChild(input);
      inputs[field] = input;
    }
    panel.appendChild(row);
  }

  const btnRow = document.createElement('div');
  btnRow.className = 'info-btn-row';

  const saveBtn = document.createElement('button');
  saveBtn.className = 'info-save-btn';
  saveBtn.textContent = 'Save';
  saveBtn.addEventListener('click', () => {
    applyInfoEdits(node, inputs);
    closeInfoEditor();
  });
  btnRow.appendChild(saveBtn);

  const cancelBtn = document.createElement('button');
  cancelBtn.className = 'info-cancel-btn';
  cancelBtn.textContent = 'Cancel';
  cancelBtn.addEventListener('click', () => closeInfoEditor());
  btnRow.appendChild(cancelBtn);

  panel.appendChild(btnRow);
  _infoOverlayEl.appendChild(panel);
  _infoOverlayEl.classList.add('visible');

  // Focus first input
  const firstInput = panel.querySelector('input, textarea');
  if (firstInput) {
    firstInput.focus();
    if (firstInput.tagName === 'INPUT') firstInput.select();
  }

  // Esc to close
  const handleKeydown = (e) => {
    if (e.key === 'Escape') {
      closeInfoEditor();
      document.removeEventListener('keydown', handleKeydown);
    }
    if (e.key === 'Enter' && !e.shiftKey && e.target.tagName !== 'TEXTAREA') {
      e.preventDefault();
      applyInfoEdits(node, inputs);
      closeInfoEditor();
      document.removeEventListener('keydown', handleKeydown);
    }
    e.stopPropagation();
  };
  document.addEventListener('keydown', handleKeydown);
}

function applyInfoEdits(node, inputs) {
  let nameChanged = false;
  for (const [field, el] of Object.entries(inputs)) {
    const val = el.value.trim();
    if (field === 'name' && val && val !== node.name) {
      nameChanged = true;
      node.name = val;
      // Sync back to track data
      syncNameToTrack(node, val);
      if (node.type === 'file') {
        const singleTrackId = getSingleDescendantTrackId(node);
        if (singleTrackId) {
          const childTrackNode = findNodeForTrackId(singleTrackId);
          if (childTrackNode) childTrackNode.name = val;
        }
      }
    } else {
      node[field] = val;
    }
  }
  syncInfoToTrack(node);
  scheduleWorkspaceSave();
  if (nameChanged) _deps.renderTrackList();
  renderGpxTree();
}

function syncNameToTrack(node, name) {
  if (node._trackId) {
    _deps.renameTrackById(node._trackId, name);
  }
  if (node._trackIds?.length) {
    // Rename the group/file
    for (const id of node._trackIds) {
      _deps.renameGroupByTrackId(id, name);
    }
  }
  if (node.type === 'file') {
    const singleTrackId = getSingleDescendantTrackId(node);
    if (singleTrackId) _deps.renameTrackById(singleTrackId, name);
  }
}

function syncInfoToTrack(node) {
  if (node._waypointId) {
    _deps.updateWaypointById?.(node._waypointId, {
      name: node.name || '',
      desc: node.desc || '',
      comment: node.cmt || '',
      sym: node.sym || '',
      wptType: node.wptType || '',
      coords: node.coords ? node.coords.slice() : null,
    });
  }
}

// ---- Tree rendering ----

function renderNodeList(nodes, container, depth) {
  for (const node of nodes) {
    const row = document.createElement('div');
    row.className = 'tree-row';
    row.dataset.nodeId = node.id;
    row.style.paddingLeft = (8 + depth * 16) + 'px';

    // Determine if this node maps to the active track
    const activeTrackId = _deps.getActiveTrackId?.();
    const isActive = (node._trackId === activeTrackId) ||
      (node._trackIds?.includes(activeTrackId));
    if (isActive) row.classList.add('active');

    if (treeState.selectedNodeIds.has(node.id)) row.classList.add('selected');

    // Disclosure toggle
    const hasChildren = node.children?.length > 0;
    const expanded = treeState.expandedNodeIds.has(node.id);

    if (hasChildren) {
      const toggle = document.createElement('span');
      toggle.className = 'tree-toggle';
      toggle.textContent = expanded ? '⏷' : '⏵';
      if (node.type === 'file') {
         const trks = node.children.filter(c => c.type === 'track' || c.type === 'route');
         if (trks.length <= 1) {
            toggle.style.opacity = '0.3';
         } else {
            toggle.style.fontWeight = 'bold';
         }
      }
      toggle.addEventListener('click', (e) => {
        e.stopPropagation();
        if (expanded) treeState.expandedNodeIds.delete(node.id);
        else treeState.expandedNodeIds.add(node.id);
        renderGpxTree();
      });
      row.appendChild(toggle);
    } else {
      const spacer = document.createElement('span');
      spacer.className = 'tree-toggle-spacer';
      spacer.textContent = ' ';
      row.appendChild(spacer);
    }

    // Icon
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.textContent = NODE_ICONS[node.type] || '';
    row.appendChild(icon);

    // Name + stats — use middle-ellipsis: split name into start/end spans
    const nameEl = document.createElement('span');
    nameEl.className = 'tree-name';

    function setNameWithMiddleEllipsis(el, text) {
      el.title = text;
      const TAIL_CHARS = 12; // show this many chars from the end
      if (text.length > 40) {
        const startSpan = document.createElement('span');
        startSpan.className = 'tree-name-start';
        startSpan.textContent = text.slice(0, text.length - TAIL_CHARS);
        const endSpan = document.createElement('span');
        endSpan.className = 'tree-name-end';
        endSpan.textContent = text.slice(-TAIL_CHARS);
        el.appendChild(startSpan);
        el.appendChild(endSpan);
      } else {
        const startSpan = document.createElement('span');
        startSpan.className = 'tree-name-start';
        startSpan.textContent = text;
        el.appendChild(startSpan);
      }
    }

    if (node.type === 'segment') {
      const segTrack = node._trackId ? _deps.findTrack(node._trackId) : null;
      setNameWithMiddleEllipsis(nameEl, segTrack?.segmentLabel || 'Segment');
      appendStatsSpan(nameEl, segTrack);
    } else if (node.type === 'waypoint') {
      setNameWithMiddleEllipsis(nameEl, node.name || 'Waypoint');
    } else if (node.type === 'track') {
      setNameWithMiddleEllipsis(nameEl, node.name || 'Track');
      // Aggregate stats for multi-segment tracks
      if (node._trackIds?.length > 1) {
        appendAggregateStats(nameEl, node._trackIds);
      } else if (node._trackIds?.length === 1) {
        const t = _deps.findTrack(node._trackIds[0]);
        appendStatsSpan(nameEl, t);
      }
    } else {
      setNameWithMiddleEllipsis(nameEl, node.name || node.type);
      if (node.type === 'file') {
         const trks = node.children?.filter(c => c.type === 'track') || [];
         if (trks.length > 0) {
            const allIds = [];
            trks.forEach(t => { if (t._trackIds) allIds.push(...t._trackIds); });
            if (allIds.length > 0) appendAggregateStats(nameEl, allIds);
         }
         if (trks.length > 1) {
            const fileSp = document.createElement('span');
            fileSp.style.opacity = '0.6';
            fileSp.style.marginLeft = '6px';
            fileSp.style.fontSize = '0.9em';
            fileSp.textContent = '(' + trks.length + ' tracks)';
            nameEl.appendChild(fileSp);
         }
      }
    }
    row.appendChild(nameEl);

    // Kebab menu button
    if (node.type !== 'segment') {
      const kebab = document.createElement('button');
      kebab.className = 'tree-kebab';
      kebab.textContent = '⋮';
      kebab.title = 'Actions';
      kebab.addEventListener('click', (e) => {
        e.stopPropagation();
        const rect = kebab.getBoundingClientRect();
        openNodeContextMenu(node.id, rect.left, rect.bottom + 2);
      });
      row.appendChild(kebab);
    }

    // Click to select/activate
    row.addEventListener('click', (e) => {
      if (e.target.classList.contains('tree-kebab') || e.target.classList.contains('tree-toggle')) return;

      if (e.shiftKey && treeState.selectedNodeId) {
        // Shift+click: range select from primary to this node
        const rows = getVisibleRows();
        const primaryIdx = rows.findIndex(r => r.dataset.nodeId === treeState.selectedNodeId);
        const clickIdx = rows.findIndex(r => r.dataset.nodeId === node.id);
        if (primaryIdx >= 0 && clickIdx >= 0) {
          const lo = Math.min(primaryIdx, clickIdx);
          const hi = Math.max(primaryIdx, clickIdx);
          treeState.selectedNodeIds.clear();
          for (let i = lo; i <= hi; i++) treeState.selectedNodeIds.add(rows[i].dataset.nodeId);
          treeState.selectedNodeIds.add(treeState.selectedNodeId);
        }
      } else if (e.ctrlKey || e.metaKey) {
        // Ctrl/Cmd+click: toggle this node in multi-select
        if (treeState.selectedNodeIds.has(node.id)) {
          treeState.selectedNodeIds.delete(node.id);
          if (treeState.selectedNodeId === node.id) {
            treeState.selectedNodeId = treeState.selectedNodeIds.size
              ? [...treeState.selectedNodeIds][treeState.selectedNodeIds.size - 1]
              : null;
          }
        } else {
          treeState.selectedNodeIds.add(node.id);
          treeState.selectedNodeId = node.id;
        }
      } else {
        // Normal click: single select
        treeState.selectedNodeId = node.id;
        treeState.selectedNodeIds.clear();
        treeState.selectedNodeIds.add(node.id);
      }

      // Activate the track for the primary selection
      const primaryId = node._trackId || node._trackIds?.[0] || collectDescendantTrackIds(node)[0];
      if (primaryId) _deps.setActiveTrack(primaryId);
      // Fit map to all tracks across all selected nodes
      const allTrackIds = [];
      for (const nid of treeState.selectedNodeIds) {
        const n = findNodeById(workspace.children, nid);
        if (n) allTrackIds.push(...collectDescendantTrackIds(n));
      }
      if (allTrackIds.length) _deps.fitToTrackIds(allTrackIds);
      syncTreeSelection();
    });

    row.addEventListener('auxclick', (e) => { // middle-click:
      if (e.button !== 1) return;
      if (e.target.classList.contains('tree-kebab') || e.target.classList.contains('tree-toggle')) return;
      if (node.type === 'segment') return;
      e.preventDefault();
      e.stopPropagation();
      deleteNode(node);
    });

    // Right-click context menu
    row.addEventListener('contextmenu', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openNodeContextMenu(node.id, e.clientX, e.clientY);
    });

    // Long-press for mobile context menu
    let longPressTimer = null;
    row.addEventListener('touchstart', (e) => {
      longPressTimer = setTimeout(() => {
        longPressTimer = null;
        const touch = e.touches[0];
        openNodeContextMenu(node.id, touch.clientX, touch.clientY);
      }, 600);
    }, { passive: true });
    row.addEventListener('touchend', () => { if (longPressTimer) clearTimeout(longPressTimer); });
    row.addEventListener('touchmove', () => { if (longPressTimer) clearTimeout(longPressTimer); });

    container.appendChild(row);

    // Render children
    if (hasChildren && expanded) {
      renderNodeList(node.children, container, depth + 1);
    }
  }
}

function appendStatsSpan(nameEl, track) {
  if (!track) return;
  const stats = _deps.trackStats(track);
  if (stats) {
    const sp = document.createElement('span');
    sp.className = 'tree-stats';
    sp.textContent = ` ${stats.dist.toFixed(1)} km · ↑${Math.round(stats.gain)} m · ↓${Math.round(stats.loss)} m`;
    nameEl.appendChild(sp);
  }
}

function appendAggregateStats(nameEl, segTrackIds) {
  let totalDist = 0, totalGain = 0, totalLoss = 0;
  for (const id of segTrackIds) {
    const t = _deps.findTrack(id);
    if (!t) continue;
    const s = _deps.trackStats(t);
    if (s) { totalDist += s.dist; totalGain += s.gain; totalLoss += s.loss; }
  }
  if (totalDist > 0) {
    const sp = document.createElement('span');
    sp.className = 'tree-stats';
    sp.textContent = ` ${totalDist.toFixed(1)} km · ↑${Math.round(totalGain)} m · ↓${Math.round(totalLoss)} m`;
    nameEl.appendChild(sp);
  }
}

function scheduleWorkspaceSave() {
  saveWorkspace(workspace);
  if (_scheduleSave) _scheduleSave();
}

// ---- Hooks for tracks.js to call ----

export function onTrackCreated(track) {
  if ((track.sourceKind || 'track') === 'route') {
    const fileNode = createFileNode(track.name, { desc: track.desc || '' });
    const routeNode = createRouteNode(track.name, {
      desc: track.desc || '',
      cmt: track.cmt || '',
      rteType: track.rteType || '',
      _trackId: track.id,
    });
    fileNode.children.push(routeNode);
    workspace.children.push(fileNode);
    treeState.expandedNodeIds.add(fileNode.id);
    scheduleWorkspaceSave();
    renderGpxTree();
    return;
  }
  // Single track — add a file + track node
  const fileNode = createFileNode(track.name, { desc: track.desc || '' });
  const trackNode = createTrackNode(track.name, {
    desc: track.desc || '',
    cmt: track.cmt || '',
    trkType: track.trkType || '',
    _trackIds: [track.id],
  });
  fileNode.children.push(trackNode);
  workspace.children.push(fileNode);
  treeState.expandedNodeIds.add(fileNode.id);
  treeState.expandedNodeIds.add(trackNode.id);
  scheduleWorkspaceSave();
  renderGpxTree();
}

export function onTrackDeleted(trackId) {
  // Remove nodes that reference this track
  removeNodesForTrack(workspace.children, trackId);
  scheduleWorkspaceSave();
  renderGpxTree();
}

function removeNodesForTrack(nodes, trackId) {
  for (let i = nodes.length - 1; i >= 0; i--) {
    const node = nodes[i];
    if (node._trackId === trackId) { nodes.splice(i, 1); continue; }
    if (node._trackIds) {
      const idx = node._trackIds.indexOf(trackId);
      if (idx >= 0) node._trackIds.splice(idx, 1);
      if (node._trackIds.length === 0 && node.type === 'track') {
        nodes.splice(i, 1); continue;
      }
    }
    if (node.children) {
      removeNodesForTrack(node.children, trackId);
      // Remove empty file/folder nodes
      if ((node.type === 'file' || node.type === 'folder') && node.children.length === 0) {
        nodes.splice(i, 1);
      }
    }
  }
}

export function onFileBatchImported(fileName, createdTracks, importedWaypoints) {
  const fileNode = createFileNode(fileName);
  const groupMap = new Map();

  for (const t of createdTracks) {
    if ((t.sourceKind || 'track') === 'route') {
      const routeNode = createRouteNode(t.name, {
        desc: t.desc || '', cmt: t.cmt || '', rteType: t.rteType || '',
        _trackId: t.id,
      });
      fileNode.children.push(routeNode);
      continue;
    }
    if (t.groupId) {
      if (!groupMap.has(t.groupId)) {
        const trackNode = createTrackNode(t.groupName || t.name, {
          desc: t.desc || '', cmt: t.cmt || '', trkType: t.trkType || '',
          _trackIds: [],
        });
        fileNode.children.push(trackNode);
        groupMap.set(t.groupId, trackNode);
      }
      const trackNode = groupMap.get(t.groupId);
      trackNode._trackIds.push(t.id);
      trackNode.children.push(createSegmentNode({ _trackId: t.id }));
    } else {
      const trackNode = createTrackNode(t.name, {
        desc: t.desc || '', cmt: t.cmt || '', trkType: t.trkType || '',
        _trackIds: [t.id],
      });
      fileNode.children.push(trackNode);
    }
  }

  workspace.children.push(fileNode);
  treeState.expandedNodeIds.add(fileNode.id);
  walkNodes(fileNode.children, n => {
    if (n.children?.length) treeState.expandedNodeIds.add(n.id);
  });

  const waypoints = _deps.getWaypoints();
  for (const wp of importedWaypoints || []) {
    const persisted = waypoints.find(w => w.name === wp.name && w.coords?.[0] === wp.coords?.[0]);
    if (persisted) {
      fileNode.children.push(createWaypointNode(wp.name, {
        desc: wp.desc, cmt: wp.comment, sym: wp.sym,
        coords: wp.coords, _waypointId: persisted.id,
      }));
    }
  }

  scheduleWorkspaceSave();
  renderGpxTree();
}
