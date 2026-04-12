// ============================================================
//  PORTAL CHANNEL MANAGER — Sandboxels Mod  v1.1
//  Load via the in-game Mod Manager.
//  Fix in v1.1:
//   - Toggle button repositioned to left-centre of screen
//     (avoids browser chrome and game toolbar on mobile)
//   - UI initialises immediately; scanner waits for game data
//   - Broader variable-name detection for different Sandboxels builds
// ============================================================

(function () {
  'use strict';

  const PCM_KEY = '__portalManager';

  // ── State ──────────────────────────────────────────────────
  const state = {
    labels:       {},
    folders:      [],
    flashChannel: null,
    flashOn:      false,
    flashTimer:   null,
    panelVisible: false,
    sortBy:       'number',
  };

  // ── Sandboxels API helpers ─────────────────────────────────
  // Tries several known variable names used across Sandboxels versions.
  const G = {
    cells:  () => window.cells  || window.grid   || window.pixels || [],
    width:  () => window.width  || window.cols   || window.gridWidth  || 0,
    height: () => window.height || window.rows   || window.gridHeight || 0,
    canvas: () =>
      document.getElementById('canvas') ||
      document.getElementById('gameCanvas') ||
      document.querySelector('canvas'),
  };

  function gameReady() {
    const c = G.cells();
    return Array.isArray(c) && c.length > 0;
  }

  // ── Portal Scanner ─────────────────────────────────────────
  function scanPortals() {
    const result = {};
    if (!gameReady()) return result;
    const cells = G.cells();
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c) continue;
      if (c.element !== 'portal_in' && c.element !== 'portal_out') continue;
      const ch = c.channel !== undefined ? Number(c.channel) : 0;
      if (!result[ch]) result[ch] = { ins: [], outs: [] };
      if (c.element === 'portal_in') result[ch].ins.push(i);
      else                           result[ch].outs.push(i);
    }
    return result;
  }

  function channelStatus(data) {
    if (data.ins.length > 0 && data.outs.length > 0) return 'complete';
    if (data.ins.length > 0)                         return 'orphan_in';
    if (data.outs.length > 0)                        return 'orphan_out';
    return 'empty';
  }

  // ── Save / Load Hooks ──────────────────────────────────────
  function installSaveHooks() {
    const origStringify = JSON.stringify;
    JSON.stringify = function (value, replacer, space) {
      if (value && typeof value === 'object' && Array.isArray(value.cells)) {
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
        if (state.panelVisible) refreshPanel();
      }
      return result;
    };
  }

  // ── Overlay Canvas (flashing highlight) ───────────────────
  let overlayEl = null;

  function getOverlay() {
    if (overlayEl) return overlayEl;
    const gc = G.canvas();
    if (!gc) return null;
    overlayEl = document.createElement('canvas');
    overlayEl.id = 'pcm-overlay';
    overlayEl.style.cssText = 'position:absolute;pointer-events:none;z-index:60;';
    function sync() {
      const r = gc.getBoundingClientRect();
      overlayEl.style.left   = (r.left + window.scrollX) + 'px';
      overlayEl.style.top    = (r.top  + window.scrollY) + 'px';
      overlayEl.width  = gc.width;
      overlayEl.height = gc.height;
    }
    sync();
    window.addEventListener('resize', sync);
    document.body.appendChild(overlayEl);
    return overlayEl;
  }

  function paintFlash(visible) {
    const ov = getOverlay();
    if (!ov) return;
    const ctx = ov.getContext('2d');
    ctx.clearRect(0, 0, ov.width, ov.height);
    if (!visible || state.flashChannel === null || !gameReady()) return;
    const cells = G.cells();
    const w = G.width(), h = G.height();
    if (!w || !h) return;
    const cw = ov.width / w, ch = ov.height / h;
    for (let i = 0; i < cells.length; i++) {
      const c = cells[i];
      if (!c || c.channel !== state.flashChannel) continue;
      if (c.element !== 'portal_in' && c.element !== 'portal_out') continue;
      ctx.fillStyle = c.element === 'portal_in'
        ? 'rgba(255,220,0,0.88)'
        : 'rgba(0,220,255,0.88)';
      ctx.fillRect((i % w) * cw, Math.floor(i / w) * ch, cw, ch);
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
    state.flashTimer = null; state.flashChannel = null; state.flashOn = false;
    const ov = getOverlay();
    if (ov) ov.getContext('2d').clearRect(0, 0, ov.width, ov.height);
  }

  // ── Status Bar ────────────────────────────────────────────
  let statusBar = null, statusTimeout = null;

  function buildStatusBar() {
    statusBar = document.createElement('div');
    statusBar.id = 'pcm-statusbar';
    statusBar.style.cssText = [
      'position:fixed', 'bottom:0', 'left:0', 'right:0',
      'background:rgba(10,10,22,0.94)', 'color:#a8c4ff',
      'font-family:monospace', 'font-size:13px',
      'padding:5px 14px', 'z-index:10000',
      'display:none', 'pointer-events:none',
      'border-top:1px solid #334',
    ].join(';');
    document.body.appendChild(statusBar);
  }

  function showStatusBar(ch) {
    if (!statusBar) return;
    clearTimeout(statusTimeout);
    const name = labelName(ch);
    const portals = scanPortals();
    let warn = '';
    if (portals[ch]) {
      const s = channelStatus(portals[ch]);
      if (s === 'orphan_in')  warn = '  ⚠ No portal_out';
      if (s === 'orphan_out') warn = '  ⚠ No portal_in';
    }
    statusBar.innerHTML =
      `<span style="color:#6699ff">⬡ Ch.${ch}</span>` +
      `<span style="color:#778899"> │ </span>` +
      `<span>${name || '—'}</span>` +
      `<span style="color:#ff9944">${warn}</span>`;
    statusBar.style.display = 'block';
    statusTimeout = setTimeout(() => { statusBar.style.display = 'none'; }, 3500);
  }

  // ── Canvas Touch Inspector ────────────────────────────────
  function setupCanvasInspector() {
    const gc = G.canvas();
    if (!gc) return;
    function inspect(cx, cy) {
      if (!gameReady()) return;
      const rect = gc.getBoundingClientRect();
      const w = G.width(), h = G.height();
      if (!w || !h) return;
      const gx = Math.floor((cx - rect.left) / rect.width  * w);
      const gy = Math.floor((cy - rect.top)  / rect.height * h);
      if (gx < 0 || gy < 0 || gx >= w || gy >= h) return;
      const cell = G.cells()[gx + gy * w];
      if (cell && (cell.element === 'portal_in' || cell.element === 'portal_out')) {
        showStatusBar(cell.channel !== undefined ? Number(cell.channel) : 0);
      }
    }
    gc.addEventListener('touchstart', e => {
      if (e.touches[0]) inspect(e.touches[0].clientX, e.touches[0].clientY);
    }, { passive: true });
    gc.addEventListener('mousemove', e => inspect(e.clientX, e.clientY));
  }

  // ── Panel ─────────────────────────────────────────────────
  let panelEl = null;

  function buildPanelSkeleton() {
    if (panelEl) panelEl.remove();
    panelEl = document.createElement('div');
    panelEl.id = 'pcm-panel';
    panelEl.style.cssText = [
      'position:fixed',
      'top:60px', 'left:8px',
      'width:290px', 'max-height:70vh',
      'background:rgba(10,10,22,0.97)', 'color:#b8ccff',
      'font-family:monospace', 'font-size:13px',
      'border:1px solid #334488', 'border-radius:7px',
      'z-index:9998', 'display:flex', 'flex-direction:column',
      'box-shadow:0 6px 28px rgba(0,0,80,0.55)',
      'user-select:none',
    ].join(';');

    const titleBar = mkEl('div', [
      'background:#111128', 'padding:8px 10px',
      'border-bottom:1px solid #334',
      'border-radius:7px 7px 0 0',
      'display:flex', 'align-items:center',
      'justify-content:space-between', 'cursor:move',
    ]);
    titleBar.innerHTML = '<span style="font-weight:bold;color:#7788ff;font-size:14px">⬡ Portal Manager</span>';

    const closeBtn = mkEl('button', ['background:none','border:none','color:#7788aa','font-size:16px','cursor:pointer','padding:0 2px']);
    closeBtn.textContent = '✕';
    closeBtn.onclick = () => { panelEl.style.display = 'none'; state.panelVisible = false; };
    titleBar.appendChild(closeBtn);

    const toolbar = mkEl('div', [
      'display:flex','flex-wrap:wrap','gap:5px',
      'padding:6px 8px','border-bottom:1px solid #223','background:#0e0e20',
    ]);
    const sortSel = document.createElement('select');
    sortSel.style.cssText = 'background:#181830;color:#aabbff;border:1px solid #336;border-radius:4px;font-size:11px;padding:2px 4px;flex:1;';
    [['number','Sort: Channel #'],['name','Sort: Name'],['status','Sort: Status']].forEach(([v,t]) => {
      const o = document.createElement('option'); o.value = v; o.textContent = t; sortSel.appendChild(o);
    });
    sortSel.value = state.sortBy;
    sortSel.onchange = () => { state.sortBy = sortSel.value; refreshPanel(); };

    const scanBtn   = mkBtn('⟳ Scan',       refreshPanel);
    const folderBtn = mkBtn('📁 New Folder', createFolder);
    toolbar.append(sortSel, scanBtn, folderBtn);

    const list = mkEl('div', ['overflow-y:auto','flex:1','padding:2px 0']);
    list.id = 'pcm-list';

    panelEl.append(titleBar, toolbar, list);
    document.body.appendChild(panelEl);
    makeDraggable(panelEl, titleBar);
  }

  function refreshPanel() {
    if (!panelEl) buildPanelSkeleton();
    stopFlash();
    const list = document.getElementById('pcm-list');
    if (!list) return;
    list.innerHTML = '';

    if (!gameReady()) {
      const msg = mkEl('div', ['padding:16px','color:#445566','text-align:center']);
      msg.textContent = 'Game not ready yet. Place some pixels first, then tap Scan.';
      list.appendChild(msg);
      return;
    }

    const portals = scanPortals();
    let channels  = Object.keys(portals).map(Number);

    if (state.sortBy === 'number') channels.sort((a,b) => a - b);
    else if (state.sortBy === 'name') channels.sort((a,b) => labelName(a).localeCompare(labelName(b)));
    else {
      const ord = { orphan_in:0, orphan_out:1, complete:2 };
      channels.sort((a,b) => (ord[channelStatus(portals[a])]||0) - (ord[channelStatus(portals[b])]||0));
    }

    if (channels.length === 0) {
      const msg = mkEl('div', ['padding:16px','color:#445566','text-align:center']);
      msg.textContent = 'No portal pixels found on canvas.';
      list.appendChild(msg);
      return;
    }

    const byFolder = {}, noFolder = [];
    channels.forEach(ch => {
      const lbl = state.labels[ch];
      const fid = lbl && lbl.folder;
      if (fid) (byFolder[fid] = byFolder[fid] || []).push(ch);
      else noFolder.push(ch);
    });

    state.folders.forEach(folder => list.appendChild(renderFolder(folder, byFolder[folder.id] || [], portals)));
    noFolder.forEach(ch => list.appendChild(renderRow(ch, portals[ch])));
  }

  function renderFolder(folder, channels, portals) {
    const wrap = mkEl('div', ['border-bottom:1px solid #1a1a30']);
    const hasOrphan = channels.some(ch => {
      const s = channelStatus(portals[ch] || { ins:[], outs:[] });
      return s === 'orphan_in' || s === 'orphan_out';
    });
    const header = mkEl('div', ['display:flex','align-items:center','gap:6px','padding:6px 8px','background:#0d0d1e','cursor:pointer','color:#8899cc']);
    header.innerHTML =
      `<span>📁 ${escHtml(folder.name)}</span>` +
      `<span style="color:#445566;font-size:11px">(${channels.length})</span>` +
      (hasOrphan ? '<span style="color:#ff9944" title="Orphan channels inside"> ⚠</span>' : '');

    let pressTimer;
    header.addEventListener('touchstart',  () => { pressTimer = setTimeout(() => editFolder(folder), 600); }, { passive:true });
    header.addEventListener('touchend',    () => clearTimeout(pressTimer));
    header.addEventListener('touchcancel', () => clearTimeout(pressTimer));
    header.addEventListener('contextmenu', e => { e.preventDefault(); editFolder(folder); });

    const body = mkEl('div', ['padding-left:10px']);
    let open = true;
    header.onclick = () => { open = !open; body.style.display = open ? '' : 'none'; };
    channels.forEach(ch => body.appendChild(renderRow(ch, portals[ch] || { ins:[], outs:[] })));
    wrap.append(header, body);
    return wrap;
  }

  function renderRow(ch, data) {
    const status = channelStatus(data);
    const ss = {
      complete:   { color:'#44ff88', icon:'✓', tip:`Complete — ${data.ins.length}× in, ${data.outs.length}× out` },
      orphan_in:  { color:'#ffaa00', icon:'⚠', tip:'Orphan: portal_in with no portal_out' },
      orphan_out: { color:'#ff6600', icon:'⚠', tip:'Orphan: portal_out with no portal_in' },
      empty:      { color:'#445566', icon:'?', tip:'Unknown' },
    }[status];

    const row = mkEl('div', ['display:flex','align-items:center','gap:6px','padding:5px 8px','border-bottom:1px solid #111120','transition:background 0.1s']);
    row.onmouseenter = () => { row.style.background = '#16162e'; };
    row.onmouseleave = () => { row.style.background = ''; };

    const dot = mkEl('span', []);
    dot.textContent = ss.icon; dot.title = ss.tip;
    dot.style.color = ss.color; dot.style.minWidth = '12px';

    const chLbl = mkEl('span', ['color:#6677ff','font-weight:bold','min-width:42px']);
    chLbl.textContent = `Ch.${ch}`;

    const nameEl = mkEl('span', ['flex:1','overflow:hidden','text-overflow:ellipsis','white-space:nowrap','color:#99aacc','cursor:pointer']);
    nameEl.textContent = labelName(ch) || '—';
    nameEl.title = 'Tap to rename';
    nameEl.onclick = e => {
      e.stopPropagation();
      const v = prompt(`Label for Channel ${ch}:`, labelName(ch));
      if (v === null) return;
      if (!state.labels[ch]) state.labels[ch] = {};
      state.labels[ch].name = v.trim();
      refreshPanel();
    };

    const isFlashing = state.flashChannel === ch;
    const flashBtn = mkIconBtn(isFlashing ? '◉' : '◎', isFlashing ? '#ffdd44' : '#556688');
    flashBtn.title = isFlashing ? 'Stop highlighting' : 'Highlight on canvas';
    flashBtn.onclick = e => {
      e.stopPropagation();
      if (state.flashChannel === ch) stopFlash();
      else startFlash(ch);
      refreshPanel();
    };

    const folderBtn = mkIconBtn('📂', '');
    folderBtn.title = 'Assign to folder';
    folderBtn.onclick = e => { e.stopPropagation(); assignFolder(ch); };

    row.append(dot, chLbl, nameEl, flashBtn, folderBtn);
    return row;
  }

  // ── Folder actions ─────────────────────────────────────────
  function createFolder() {
    const name = prompt('New folder name:');
    if (!name || !name.trim()) return;
    state.folders.push({ id: 'f' + Date.now(), name: name.trim() });
    refreshPanel();
  }

  function editFolder(folder) {
    const action = prompt(`Folder: "${folder.name}"\n\nType  rename  or  delete:`);
    if (!action) return;
    if (action.trim() === 'rename') {
      const n = prompt('New name:', folder.name);
      if (n && n.trim()) { folder.name = n.trim(); refreshPanel(); }
    } else if (action.trim() === 'delete') {
      state.folders = state.folders.filter(f => f.id !== folder.id);
      Object.keys(state.labels).forEach(k => {
        if (state.labels[k] && state.labels[k].folder === folder.id)
          delete state.labels[k].folder;
      });
      refreshPanel();
    }
  }

  function assignFolder(ch) {
    if (state.folders.length === 0) { alert('No folders yet. Tap "📁 New Folder" first.'); return; }
    const opts = state.folders.map((f,i) => `${i+1}  ${f.name}`).join('\n');
    const input = prompt(`Assign Ch.${ch} to folder:\n\n${opts}\n\n0 = remove from folder`);
    if (input === null) return;
    if (input.trim() === '0') {
      if (state.labels[ch]) delete state.labels[ch].folder;
    } else {
      const idx = parseInt(input,10) - 1;
      if (!state.folders[idx]) return;
      if (!state.labels[ch]) state.labels[ch] = {};
      state.labels[ch].folder = state.folders[idx].id;
    }
    refreshPanel();
  }

  // ── Channel selection monitor ──────────────────────────────
  function setupSelectionMonitor() {
    let lastElem = null;
    setInterval(() => {
      const cur = window.currentElement;
      if (cur === lastElem) return;
      lastElem = cur;
      if (cur === 'portal_in' || cur === 'portal_out') openPanel();
    }, 300);

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
    new MutationObserver(hookInputs).observe(document.body, { childList:true, subtree:true });
  }

  function checkChannelWarning(ch) {
    const portals = scanPortals();
    const data    = portals[ch];
    if (!data || channelStatus(data) !== 'complete') return;
    const name = labelName(ch) ? ` ("${labelName(ch)}")` : '';
    confirm(
      `⚠ Channel ${ch}${name} is already in use.\n` +
      `${data.ins.length}× portal_in, ${data.outs.length}× portal_out.\n\n` +
      `Adding more portals here may break your logic. Continue?`
    );
  }

  // ── Toggle Button ──────────────────────────────────────────
  // Vertical tab on the LEFT edge of the screen, centred vertically.
  // This position avoids the browser address bar (top) and the
  // Sandboxels toolbar (bottom) on all tested mobile layouts.
  function addToggleButton() {
    const btn = document.createElement('button');
    btn.id = 'pcm-toggle';
    btn.textContent = '⬡';
    btn.title = 'Portal Channel Manager';
    btn.style.cssText = [
      'position:fixed',
      'left:0',
      'top:50%',
      'transform:translateY(-50%)',
      'background:#111128',
      'color:#7788ff',
      'border:1px solid #334488',
      'border-left:none',
      'border-radius:0 6px 6px 0',
      'padding:14px 7px',
      'font-size:18px',
      'line-height:1',
      'cursor:pointer',
      'z-index:9999',
      'box-shadow:3px 0 12px rgba(0,0,80,0.5)',
    ].join(';');
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
    refreshPanel();
  }

  // ── Drag-to-move ───────────────────────────────────────────
  function makeDraggable(panel, handle) {
    let sx, sy, ol, ot;
    function onMove(e) {
      const cx = e.touches ? e.touches[0].clientX : e.clientX;
      const cy = e.touches ? e.touches[0].clientY : e.clientY;
      panel.style.left = (ol + cx - sx) + 'px';
      panel.style.top  = (ot + cy - sy) + 'px';
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
      sx = cx; sy = cy; ol = r.left; ot = r.top;
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup',   onEnd);
      document.addEventListener('touchmove', onMove, { passive:true });
      document.addEventListener('touchend',  onEnd);
    }
    handle.addEventListener('mousedown',  onStart);
    handle.addEventListener('touchstart', onStart, { passive:true });
  }

  // ── DOM helpers ────────────────────────────────────────────
  function mkEl(tag, styles) {
    const e = document.createElement(tag);
    if (styles && styles.length) e.style.cssText = styles.join(';') + ';';
    return e;
  }
  function mkBtn(text, onclick) {
    const b = mkEl('button', ['background:#181830','border:1px solid #336','color:#99aaff','border-radius:4px','cursor:pointer','font-size:11px','padding:3px 7px']);
    b.textContent = text; b.onclick = onclick; return b;
  }
  function mkIconBtn(icon, color) {
    const b = mkEl('button', ['background:none','border:none','cursor:pointer','font-size:15px','padding:0 2px']);
    b.textContent = icon; if (color) b.style.color = color; return b;
  }
  function escHtml(s) {
    return String(s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
  }
  function labelName(ch) {
    return (state.labels[ch] && state.labels[ch].name) || '';
  }

  // ── Init ───────────────────────────────────────────────────
  // The button and status bar are created immediately on script load,
  // with no dependency on game variables being present yet.
  function init() {
    installSaveHooks();
    buildStatusBar();
    addToggleButton();
    buildPanelSkeleton();
    panelEl.style.display = 'none';

    function tryCanvasSetup() {
      if (G.canvas()) setupCanvasInspector();
      else setTimeout(tryCanvasSetup, 600);
    }
    tryCanvasSetup();
    setupSelectionMonitor();

    console.log('[PCM] Portal Channel Manager v1.1 loaded.');
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();
