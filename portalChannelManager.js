// ============================================================
//  PORTAL CHANNEL MANAGER — Sandboxels Mod
//  Version 1.0
//  Load this file via the in-game Mod Manager.
//  Features:
//   1. Channel Inspector panel with live canvas scan
//   2. Labels/notes that travel with save files
//   3. Missing-link detector (orphan channels)
//   4. Status bar shows channel info on touch/hover
//   5. Panel auto-opens when portal element is selected
//   6. Channel folders for organisation
//   7. Warning when selecting an already-used channel
// ============================================================

(function () {
  'use strict';

  const PCM_KEY = '__portalManager'; // injected into save JSON

  // ── State ─────────────────────────────────────────────────
  const state = {
    labels: {},        // { "5": { name: "string", folder: "folderId" } }
    folders: [],       // [{ id: "f123", name: "CPU Signals" }]
    flashChannel: null,
    flashOn: false,
    flashTimer: null,
    panelVisible: false,
    sortBy: 'number',  // 'number' | 'name' | 'status'
  };

  // ── Sandboxels API helpers ─────────────────────────────────
  const G = {
    cells:   () => window.cells   || [],
    width:   () => window.width   || 0,
    height:  () => window.height  || 0,
    canvas:  () => document.getElementById('canvas') || document.querySelector('canvas'),
  };

  // ── Portal Scanner ─────────────────────────────────────────
  // Returns { channelNum: { ins: [cellIndex…], outs: [cellIndex…] } }
  function scanPortals() {
    const result = {};
    const cells  = G.cells();
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c || (c.element !== 'portal_in' && c.element !== 'portal_out')) continue;
      const ch = c.channel !== undefined ? Number(c.channel) : 0;
      if (!result[ch]) result[ch] = { ins: [], outs: [] };
      if (c.element === 'portal_in')  result[ch].ins.push(i);
      else                            result[ch].outs.push(i);
    }
    return result;
  }

  function channelStatus(data) {
    // data: { ins, outs }
    if (data.ins.length > 0 && data.outs.length > 0) return 'complete';
    if (data.ins.length > 0)                          return 'orphan_in';
    if (data.outs.length > 0)                         return 'orphan_out';
    return 'empty';
  }

  // ── Save / Load Hooks ──────────────────────────────────────
  // We intercept JSON.stringify so that whenever Sandboxels serialises a
  // save object (identified by having a `cells` array), we attach our data.
  // On JSON.parse we extract it back. The game ignores the unknown key.
  function installSaveHooks() {
    const origStringify = JSON.stringify;
    JSON.stringify = function (value, replacer, space) {
      if (value && typeof value === 'object' && Array.isArray(value.cells)) {
        // Looks like a Sandboxels save — inject our data (non-destructively)
        const copy = Object.assign({}, value);
        copy[PCM_KEY] = { labels: state.labels, folders: state.folders };
        return origStringify.call(JSON, copy, replacer, space);
      }
      return origStringify.call(JSON, value, replacer, space);
    };

    const origParse = JSON.parse;
    JSON.parse = function (text, reviver) {
      let result;
      try { result = origParse.call(JSON, text, reviver); } catch (e) { throw e; }
      if (result && result[PCM_KEY]) {
        const d = result[PCM_KEY];
        if (d.labels  && typeof d.labels  === 'object') state.labels  = d.labels;
        if (d.folders && Array.isArray(d.folders))       state.folders = d.folders;
        // Refresh panel if it is already open
        if (state.panelVisible) refreshPanel();
      }
      return result;
    };
  }

  // ── Overlay Canvas (flashing highlight) ───────────────────
  let overlay = null;

  function getOverlay() {
    if (overlay) return overlay;
    const gc = G.canvas();
    if (!gc) return null;

    overlay = document.createElement('canvas');
    overlay.id = 'pcm-overlay';
    overlay.style.cssText = [
      'position:absolute',
      'pointer-events:none',
      'z-index:60',
    ].join(';');

    function syncSize() {
      const r = gc.getBoundingClientRect();
      overlay.style.left  = (r.left + window.scrollX) + 'px';
      overlay.style.top   = (r.top  + window.scrollY) + 'px';
      overlay.width  = gc.width;
      overlay.height = gc.height;
    }
    syncSize();
    window.addEventListener('resize', syncSize);
    document.body.appendChild(overlay);
    return overlay;
  }

  function paintFlash(visible) {
    const ov = getOverlay();
    if (!ov) return;
    const ctx = ov.getContext('2d');
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (!visible || state.flashChannel === null) return;

    const cells = G.cells();
    const w     = G.width();
    const h     = G.height();
    if (!w || !h) return;

    const cw = ov.width  / w;
    const ch = ov.height / h;

    // Yellow flash for portal_in, cyan flash for portal_out — distinct colours
    // so you can immediately tell which type you are looking at.
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c) continue;
      if (c.channel !== state.flashChannel) continue;
      if (c.element !== 'portal_in' && c.element !== 'portal_out') continue;

      ctx.fillStyle = c.element === 'portal_in'
        ? 'rgba(255, 220, 0, 0.88)'   // gold  → portal_in
        : 'rgba(0,  220, 255, 0.88)'; // cyan  → portal_out

      const px = (i % w) * cw;
      const py = Math.floor(i / w) * ch;
      ctx.fillRect(px, py, cw, ch);
    }
  }

  function startFlash(ch) {
    stopFlash();
    state.flashChannel = ch;
    state.flashTimer = setInterval(() => {
      state.flashOn = !state.flashOn;
      paintFlash(state.flashOn);
    }, 380);
  }

  function stopFlash() {
    if (state.flashTimer) clearInterval(state.flashTimer);
    state.flashTimer   = null;
    state.flashChannel = null;
    state.flashOn      = false;
    const ov = getOverlay();
    if (ov) ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  }

  // ── Status Bar (Feature 4) ─────────────────────────────────
  let statusBar     = null;
  let statusTimeout = null;

  function buildStatusBar() {
    statusBar = document.createElement('div');
    statusBar.id = 'pcm-statusbar';
    statusBar.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0',
      'background:rgba(10,10,22,0.94)',
      'color:#a8c4ff',
      'font-family:monospace', 'font-size:13px',
      'padding:5px 14px',
      'z-index:10000',
      'display:none',
      'pointer-events:none',
      'border-top:1px solid #334',
      'letter-spacing:0.03em',
    ].join(';');
    document.body.appendChild(statusBar);
  }

  function showStatusBar(channel) {
    if (!statusBar) return;
    clearTimeout(statusTimeout);
    const lbl    = state.labels[channel];
    const name   = lbl && lbl.name ? lbl.name : '—';
    const status = (() => {
      const portals = scanPortals();
      if (!portals[channel]) return '';
      const s = channelStatus(portals[channel]);
      if (s === 'orphan_in')  return '  ⚠ No portal_out';
      if (s === 'orphan_out') return '  ⚠ No portal_in';
      return '';
    })();
    statusBar.innerHTML =
      `<span style="color:#6699ff">⬡ Ch.${channel}</span>` +
      `<span style="color:#778899"> │ </span>` +
      `<span>${name}</span>` +
      `<span style="color:#ff9944">${status}</span>`;
    statusBar.style.display = 'block';
    statusTimeout = setTimeout(() => { statusBar.style.display = 'none'; }, 3500);
  }

  // ── Canvas Touch / Hover Handler (Feature 4) ──────────────
  function setupCanvasInspector() {
    const gc = G.canvas();
    if (!gc) return;

    function inspect(clientX, clientY) {
      const rect = gc.getBoundingClientRect();
      const w = G.width(), h = G.height();
      if (!w || !h) return;
      const cx = Math.floor((clientX - rect.left) / rect.width  * w);
      const cy = Math.floor((clientY - rect.top)  / rect.height * h);
      if (cx < 0 || cy < 0 || cx >= w || cy >= h) return;
      const idx  = cx + cy * w;
      const cell = G.cells()[idx];
      if (cell && (cell.element === 'portal_in' || cell.element === 'portal_out')) {
        showStatusBar(cell.channel !== undefined ? Number(cell.channel) : 0);
      }
    }

    gc.addEventListener('touchstart', e => {
      const t = e.touches[0];
      if (t) inspect(t.clientX, t.clientY);
    }, { passive: true });

    gc.addEventListener('mousemove', e => inspect(e.clientX, e.clientY));
  }

  // ── Panel UI ───────────────────────────────────────────────
  let panelEl = null;

  function buildPanelSkeleton() {
    if (panelEl) panelEl.remove();

    panelEl = document.createElement('div');
    panelEl.id = 'pcm-panel';
    panelEl.style.cssText = [
      'position:fixed', 'top:52px', 'right:12px',
      'width:290px', 'max-height:78vh',
      'background:rgba(10,10,22,0.97)',
      'color:#b8ccff',
      'font-family:monospace', 'font-size:13px',
      'border:1px solid #334488',
      'border-radius:7px',
      'z-index:9998',
      'display:flex', 'flex-direction:column',
      'box-shadow:0 6px 28px rgba(0,0,80,0.55)',
      'user-select:none',
    ].join(';');

    // ── Title bar ──
    const titleBar = el('div', [
      'background:#111128', 'padding:8px 10px',
      'border-bottom:1px solid #334',
      'border-radius:7px 7px 0 0',
      'display:flex', 'align-items:center',
      'justify-content:space-between',
      'cursor:move',
    ]);
    titleBar.innerHTML = '<span style="font-weight:bold;color:#7788ff;font-size:14px">⬡ Portal Manager</span>';

    const closeBtn = el('button', [
      'background:none', 'border:none', 'color:#7788aa',
      'font-size:16px', 'cursor:pointer', 'padding:0 2px',
    ]);
    closeBtn.textContent = '✕';
    closeBtn.title = 'Close panel';
    closeBtn.onclick = () => {
      panelEl.style.display = 'none';
      state.panelVisible = false;
    };
    titleBar.appendChild(closeBtn);

    // ── Toolbar ──
    const toolbar = el('div', [
      'display:flex', 'flex-wrap:wrap', 'gap:5px',
      'padding:6px 8px', 'border-bottom:1px solid #223',
      'background:#0e0e20',
    ]);

    const sortSel = document.createElement('select');
    sortSel.style.cssText = [
      'background:#181830', 'color:#aabb ff', 'border:1px solid #336',
      'border-radius:4px', 'font-size:11px', 'padding:2px 4px', 'flex:1',
    ].join(';');
    [['number','Sort: Channel #'],['name','Sort: Name'],['status','Sort: Status']]
      .forEach(([v, t]) => {
        const o = document.createElement('option');
        o.value = v; o.textContent = t;
        sortSel.appendChild(o);
      });
    sortSel.value = state.sortBy;
    sortSel.onchange = () => { state.sortBy = sortSel.value; refreshPanel(); };

    const scanBtn   = makeBtn('⟳ Scan',       refreshPanel);
    const folderBtn = makeBtn('📁 New Folder', createFolder);

    toolbar.append(sortSel, scanBtn, folderBtn);

    // ── List ──
    const list = el('div', [
      'overflow-y:auto', 'flex:1', 'padding:2px 0',
    ]);
    list.id = 'pcm-list';

    panelEl.append(titleBar, toolbar, list);
    document.body.appendChild(panelEl);

    makeDraggable(panelEl, titleBar);
    return panelEl;
  }

  function refreshPanel() {
    if (!panelEl) buildPanelSkeleton();
    stopFlash(); // Reopening/refreshing panel clears any active flash

    const portals = scanPortals();
    const list    = document.getElementById('pcm-list');
    if (!list) return;
    list.innerHTML = '';

    // Gather and sort channel numbers
    let channels = Object.keys(portals).map(Number);
    if (state.sortBy === 'number') {
      channels.sort((a, b) => a - b);
    } else if (state.sortBy === 'name') {
      channels.sort((a, b) => {
        const na = labelName(a), nb = labelName(b);
        return na.localeCompare(nb);
      });
    } else {
      // status: orphans first, then complete
      const ord = { orphan_in: 0, orphan_out: 1, complete: 2 };
      channels.sort((a, b) => (ord[channelStatus(portals[a])] || 0) - (ord[channelStatus(portals[b])] || 0));
    }

    if (channels.length === 0) {
      const msg = el('div', ['padding:18px', 'color:#445566', 'text-align:center']);
      msg.textContent = 'No portal pixels found on canvas.';
      list.appendChild(msg);
      return;
    }

    // Build folder → channels map
    const byFolder  = {};
    const noFolder  = [];
    channels.forEach(ch => {
      const lbl = state.labels[ch];
      const fid = lbl && lbl.folder;
      if (fid) { (byFolder[fid] = byFolder[fid] || []).push(ch); }
      else      { noFolder.push(ch); }
    });

    // Render each folder
    state.folders.forEach(folder => {
      const fChannels = byFolder[folder.id] || [];
      list.appendChild(renderFolder(folder, fChannels, portals));
    });

    // Render unfoldered channels
    noFolder.forEach(ch => list.appendChild(renderRow(ch, portals[ch])));
  }

  function renderFolder(folder, channels, portals) {
    const wrap = el('div', ['border-bottom:1px solid #1a1a30']);

    const header = el('div', [
      'display:flex', 'align-items:center', 'gap:6px',
      'padding:6px 8px', 'background:#0d0d1e',
      'cursor:pointer', 'color:#8899cc',
    ]);

    // Orphan warning for folder
    const hasOrphan = channels.some(ch => {
      const s = channelStatus(portals[ch] || { ins: [], outs: [] });
      return s === 'orphan_in' || s === 'orphan_out';
    });
    header.innerHTML =
      `<span>📁 ${escHtml(folder.name)}</span>` +
      `<span style="color:#445566;font-size:11px">(${channels.length})</span>` +
      (hasOrphan ? '<span style="color:#ff9944" title="Contains orphan channels"> ⚠</span>' : '');

    // Rename / delete on long-press or right-click
    let pressTimer;
    const startPress = () => { pressTimer = setTimeout(() => editFolder(folder), 600); };
    const endPress   = () => clearTimeout(pressTimer);
    header.addEventListener('touchstart',  startPress,  { passive: true });
    header.addEventListener('touchend',    endPress);
    header.addEventListener('touchcancel', endPress);
    header.addEventListener('contextmenu', e => { e.preventDefault(); editFolder(folder); });

    const body = el('div', ['padding-left:10px']);
    let open = true;
    header.onclick = () => { open = !open; body.style.display = open ? '' : 'none'; };

    channels.forEach(ch => body.appendChild(renderRow(ch, portals[ch] || { ins: [], outs: [] })));
    wrap.append(header, body);
    return wrap;
  }

  function renderRow(ch, portalData) {
    const status  = channelStatus(portalData);
    const name    = labelName(ch);

    const statusStyle = {
      complete:   { color: '#44ff88', icon: '✓', tip: `Complete — ${portalData.ins.length}× in, ${portalData.outs.length}× out` },
      orphan_in:  { color: '#ffaa00', icon: '⚠', tip: 'Orphan: has portal_in but no portal_out' },
      orphan_out: { color: '#ff6600', icon: '⚠', tip: 'Orphan: has portal_out but no portal_in' },
      empty:      { color: '#445566', icon: '?', tip: 'Unknown' },
    }[status];

    const row = el('div', [
      'display:flex', 'align-items:center', 'gap:6px',
      'padding:5px 8px', 'cursor:default',
      'border-bottom:1px solid #111120',
      'transition:background 0.1s',
    ]);
    row.onmouseenter = () => { row.style.background = '#16162e'; };
    row.onmouseleave = () => { row.style.background = ''; };

    // Status dot
    const dot = el('span', []);
    dot.textContent = statusStyle.icon;
    dot.title = statusStyle.tip;
    dot.style.color = statusStyle.color;
    dot.style.minWidth = '12px';

    // Channel number
    const chLabel = el('span', ['color:#6677ff', 'font-weight:bold', 'min-width:42px']);
    chLabel.textContent = `Ch.${ch}`;

    // Name label (tap to edit)
    const nameEl = el('span', ['flex:1', 'overflow:hidden', 'text-overflow:ellipsis', 'white-space:nowrap', 'color:#99aacc']);
    nameEl.textContent = name || '—';
    nameEl.title = 'Tap to rename';
    nameEl.style.cursor = 'pointer';
    nameEl.onclick = (e) => {
      e.stopPropagation();
      const v = prompt(`Label for Channel ${ch}:`, name);
      if (v === null) return;
      if (!state.labels[ch]) state.labels[ch] = {};
      state.labels[ch].name = v.trim();
      refreshPanel();
    };

    // Flash toggle button
    const isFlashing = state.flashChannel === ch;
    const flashBtn = makeIconBtn(isFlashing ? '◉' : '◎', isFlashing ? '#ffdd44' : '#556688');
    flashBtn.title = isFlashing ? 'Stop highlighting' : 'Highlight on canvas';
    flashBtn.onclick = (e) => {
      e.stopPropagation();
      if (state.flashChannel === ch) stopFlash();
      else startFlash(ch);
      refreshPanel(); // update button appearance
    };

    // Move to folder button
    const folderBtn = makeIconBtn('📂', '');
    folderBtn.title = 'Assign to folder';
    folderBtn.onclick = (e) => {
      e.stopPropagation();
      assignFolder(ch);
    };

    row.append(dot, chLabel, nameEl, flashBtn, folderBtn);
    return row;
  }

  // ── Folder management ──────────────────────────────────────
  function createFolder() {
    const name = prompt('New folder name:');
    if (!name || !name.trim()) return;
    state.folders.push({ id: 'f' + Date.now(), name: name.trim() });
    refreshPanel();
  }

  function editFolder(folder) {
    const action = prompt(
      `Folder: "${folder.name}"\n\nType  rename  or  delete:`,
    );
    if (!action) return;
    if (action.trim() === 'rename') {
      const n = prompt('New name:', folder.name);
      if (n && n.trim()) { folder.name = n.trim(); refreshPanel(); }
    } else if (action.trim() === 'delete') {
      state.folders = state.folders.filter(f => f.id !== folder.id);
      // Un-assign channels from this folder
      Object.keys(state.labels).forEach(ch => {
        if (state.labels[ch] && state.labels[ch].folder === folder.id) {
          delete state.labels[ch].folder;
        }
      });
      refreshPanel();
    }
  }

  function assignFolder(ch) {
    if (state.folders.length === 0) {
      alert('No folders yet. Tap "📁 New Folder" to create one first.');
      return;
    }
    const opts = state.folders.map((f, i) => `${i + 1}  ${f.name}`).join('\n');
    const input = prompt(`Assign Ch.${ch} to a folder:\n\n${opts}\n\n(0 = remove from folder)`, '');
    if (input === null) return;
    if (input === '0') {
      if (state.labels[ch]) delete state.labels[ch].folder;
    } else {
      const idx = parseInt(input, 10) - 1;
      if (!state.folders[idx]) return;
      if (!state.labels[ch]) state.labels[ch] = {};
      state.labels[ch].folder = state.folders[idx].id;
    }
    refreshPanel();
  }

  // ── Channel selection warning (Features 5 & 7) ────────────
  function setupSelectionMonitor() {
    let lastElement = null;

    // Poll for element changes (avoids needing internal event access)
    setInterval(() => {
      const cur = window.currentElement;
      if (cur === lastElement) return;
      lastElement = cur;
      if (cur === 'portal_in' || cur === 'portal_out') {
        openPanel();
      }
    }, 300);

    // Hook channel-number inputs in the game UI
    function hookInputs() {
      document.querySelectorAll('input[type="number"]').forEach(input => {
        if (input.dataset.pcmHooked) return;
        input.dataset.pcmHooked = '1';
        input.addEventListener('change', () => {
          const ch = parseInt(input.value, 10);
          if (!isNaN(ch)) checkChannelWarning(ch);
        });
      });
    }
    hookInputs();
    // Also catch dynamically added inputs
    new MutationObserver(hookInputs).observe(document.body, { childList: true, subtree: true });
  }

  function checkChannelWarning(ch) {
    const portals = scanPortals();
    const data    = portals[ch];
    if (!data || channelStatus(data) !== 'complete') return;
    const name = labelName(ch) ? ` ("${labelName(ch)}")` : '';
    confirm(
      `⚠ Channel ${ch}${name} is already in use.\n\n` +
      `It has ${data.ins.length} portal_in and ${data.outs.length} portal_out pixels.\n\n` +
      `Adding more portals to this channel may cause unexpected logic behaviour.\n\nContinue?`
    );
    // We cannot block the game action, but the prompt forces the user to acknowledge.
  }

  // ── Toggle button ──────────────────────────────────────────
  function addToggleButton() {
    const btn = el('button', [
      'position:fixed', 'top:10px', 'right:12px',
      'background:#111128', 'color:#7788ff',
      'border:1px solid #334488', 'border-radius:5px',
      'padding:5px 11px', 'font-family:monospace', 'font-size:13px',
      'cursor:pointer', 'z-index:9997',
      'box-shadow:0 2px 10px rgba(0,0,80,0.45)',
    ]);
    btn.textContent = '⬡ PCM';
    btn.title = 'Open Portal Channel Manager';
    btn.id = 'pcm-toggle';
    btn.onclick = () => {
      if (state.panelVisible) {
        panelEl.style.display = 'none';
        state.panelVisible = false;
        stopFlash();
      } else {
        openPanel();
      }
    };
    document.body.appendChild(btn);
  }

  function openPanel() {
    if (!panelEl) buildPanelSkeleton();
    panelEl.style.display = 'flex';
    state.panelVisible = true;
    refreshPanel(); // refreshPanel calls stopFlash internally
  }

  // ── Small DOM helpers ──────────────────────────────────────
  function el(tag, styles) {
    const e = document.createElement(tag);
    if (styles && styles.length) e.style.cssText = styles.join(';') + ';';
    return e;
  }

  function makeBtn(text, onclick) {
    const b = el('button', [
      'background:#181830', 'border:1px solid #336', 'color:#99aaff',
      'border-radius:4px', 'cursor:pointer', 'font-size:11px', 'padding:3px 7px',
    ]);
    b.textContent = text;
    b.onclick = onclick;
    return b;
  }

  function makeIconBtn(icon, color) {
    const b = el('button', [
      'background:none', 'border:none', 'cursor:pointer',
      'font-size:15px', 'padding:0 2px',
    ]);
    b.textContent = icon;
    if (color) b.style.color = color;
    return b;
  }

  function escHtml(str) {
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function labelName(ch) {
    return (state.labels[ch] && state.labels[ch].name) || '';
  }

  // ── Drag-to-move panel ─────────────────────────────────────
  function makeDraggable(panel, handle) {
    let startX, startY, origLeft, origTop;

    function onMove(e) {
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const cy = e.touches ? e.touches[0].clientY : e.clientY;
      panel.style.left  = (origLeft + cx - startX) + 'px';
      panel.style.top   = (origTop  + cy - startY) + 'px';
      panel.style.right = 'auto';
    }
    function onEnd() {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup',   onEnd);
      document.removeEventListener('touchmove', onMove);
      document.removeEventListener('touchend',  onEnd);
    }
    function onStart(e) {
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const cy = e.touches ? e.touches[0].clientY : e.clientY;
      const r  = panel.getBoundingClientRect();
      startX = cx; startY = cy;
      origLeft = r.left; origTop = r.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onEnd);
      document.addEventListener('touchmove', onMove, { passive: true });
      document.addEventListener('touchend',  onEnd);
    }

    handle.addEventListener('mousedown',  onStart);
    handle.addEventListener('touchstart', onStart, { passive: true });
  }

  // ── Initialisation ─────────────────────────────────────────
  function init() {
    installSaveHooks();
    buildStatusBar();
    setupCanvasInspector();
    buildPanelSkeleton();
    panelEl.style.display = 'none'; // hidden on start
    addToggleButton();
    setupSelectionMonitor();

    console.log('[PCM] Portal Channel Manager v1.0 loaded successfully.');
  }

  // Wait until Sandboxels has initialised its globals
  function waitForGame() {
    if (typeof window.cells !== 'undefined' || typeof window.elements !== 'undefined') {
      init();
    } else {
      setTimeout(waitForGame, 500);
    }
  }

  if (document.readyState === 'complete') {
    waitForGame();
  } else {
    window.addEventListener('load', waitForGame);
  }

})();
