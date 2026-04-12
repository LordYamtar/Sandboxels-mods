// ================================================================
//  PORTAL CHANNEL MANAGER — Sandboxels Mod
//  Version 1.0
//
//  For builders who use portal_in / portal_out to create complex
//  logic systems. Adds a management panel for labelling, organising,
//  and inspecting portal channels without affecting the save file
//  in a way that breaks loading without the mod.
//
//  HOW TO INSTALL:
//  1. Host this file somewhere (e.g. GitHub raw, your own server).
//  2. In Sandboxels, open Mods and paste the URL to this file.
//  3. A 📡 button will appear near the top-right of the screen.
//
//  SAVE COMPATIBILITY:
//  Your labels are saved inside the save file under the key "pcm".
//  If the mod is NOT installed, that field is simply ignored — the
//  save loads perfectly normally. Zero side effects.
// ================================================================

(function () {
    'use strict';

    // ----------------------------------------------------------------
    // STATE
    // ----------------------------------------------------------------
    // pcmData structure: { [channelNumber]: { label: string, folder: string } }
    let pcmData = {};

    // Orphan-flash state (runs on canvas until the panel is opened)
    let orphanFlashTimer = null;
    let orphanFlashState = false;
    let orphanChannels   = new Set();

    // Per-channel highlight timer
    let highlightTimer = null;

    // ----------------------------------------------------------------
    // CANVAS COORDINATE HELPER
    // Falls back gracefully if canvasCoord is unavailable.
    // ----------------------------------------------------------------
    function pcmCoord(n) {
        if (typeof canvasCoord !== 'undefined') return canvasCoord(n);
        if (typeof pixelSize  !== 'undefined') return n * pixelSize;
        return n * 6;
    }
    function pcmPixelSize() {
        return (typeof pixelSize !== 'undefined') ? pixelSize : 6;
    }

    // ----------------------------------------------------------------
    // SCAN: read all portal pixels from pixelMap
    // ----------------------------------------------------------------
    function scanPortals() {
        let ins = {}, outs = {};
        if (typeof pixelMap === 'undefined') return { ins, outs, all: new Set() };

        for (let x = 0; x < pixelMap.length; x++) {
            if (!pixelMap[x]) continue;
            for (let y = 0; y < pixelMap[x].length; y++) {
                let p = pixelMap[x][y];
                if (!p || !p.element || !elements[p.element]) continue;
                let ch = parseInt(p.channel) || 0;
                let el = elements[p.element];
                if (el.id === elements.portal_in.id)  ins[ch]  = (ins[ch]  || 0) + 1;
                if (el.id === elements.portal_out.id) outs[ch] = (outs[ch] || 0) + 1;
            }
        }
        let all = new Set([...Object.keys(ins), ...Object.keys(outs)].map(Number));
        return { ins, outs, all };
    }

    function getStatus(ch, ins, outs) {
        let hi = !!ins[ch], ho = !!outs[ch];
        if (hi && ho) return 'ok';
        if (hi)       return 'no_out';
        if (ho)       return 'no_in';
        return 'empty';
    }

    function getAllOrphanChannels() {
        let { ins, outs, all } = scanPortals();
        let result = new Set();
        for (let ch of all) {
            if (getStatus(ch, ins, outs) !== 'ok') result.add(ch);
        }
        return result;
    }

    // Returns all portal pixels belonging to a specific channel number.
    function getPortalsForChannel(ch) {
        let result = [];
        if (typeof pixelMap === 'undefined') return result;
        for (let x = 0; x < pixelMap.length; x++) {
            if (!pixelMap[x]) continue;
            for (let y = 0; y < pixelMap[x].length; y++) {
                let p = pixelMap[x][y];
                if (!p || !p.element || !elements[p.element]) continue;
                let pCh = parseInt(p.channel) || 0;
                if (pCh !== ch) continue;
                let el = elements[p.element];
                if (el.id === elements.portal_in.id || el.id === elements.portal_out.id) result.push(p);
            }
        }
        return result;
    }

    // ----------------------------------------------------------------
    // CANVAS OVERLAY (non-destructive flash layer)
    // ----------------------------------------------------------------
    function getOrCreateOverlay() {
        let gameCanvas = document.querySelector('canvas');
        if (!gameCanvas) return null;

        let overlay = document.getElementById('pcm-overlay');
        if (!overlay) {
            overlay = document.createElement('canvas');
            overlay.id = 'pcm-overlay';
            overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:1000;';
            document.body.appendChild(overlay);
        }

        // Sync dimensions with game canvas every call (handles resize)
        let rect = gameCanvas.getBoundingClientRect();
        overlay.width        = gameCanvas.width;
        overlay.height       = gameCanvas.height;
        overlay.style.left   = rect.left + 'px';
        overlay.style.top    = rect.top  + 'px';
        overlay.style.width  = rect.width  + 'px';
        overlay.style.height = rect.height + 'px';

        return overlay;
    }

    function clearOverlay() {
        let o = document.getElementById('pcm-overlay');
        if (o) o.getContext('2d').clearRect(0, 0, o.width, o.height);
    }

    function paintOverlayPixels(ctx, pixels, color) {
        let ps = pcmPixelSize();
        ctx.fillStyle = color;
        for (let p of pixels) {
            if (!p || p.del) continue;
            ctx.fillRect(pcmCoord(p.x), pcmCoord(p.y), ps, ps);
        }
    }

    // ----------------------------------------------------------------
    // ORPHAN FLASH — runs continuously until the panel is opened
    // (re-starts when the panel is closed)
    // ----------------------------------------------------------------
    function startOrphanFlash() {
        stopOrphanFlash();
        orphanFlashTimer = setInterval(function () {
            orphanChannels = getAllOrphanChannels();

            if (orphanChannels.size === 0) {
                clearOverlay();
                // Clear any orphan row highlights in the panel
                document.querySelectorAll('.pcm-ch-row').forEach(function (r) {
                    r.style.background = '';
                });
                return;
            }

            orphanFlashState = !orphanFlashState;

            // Flash on canvas
            let overlay = getOrCreateOverlay();
            if (overlay) {
                let ctx = overlay.getContext('2d');
                ctx.clearRect(0, 0, overlay.width, overlay.height);
                if (orphanFlashState) {
                    for (let ch of orphanChannels) {
                        let pixels = getPortalsForChannel(ch);
                        paintOverlayPixels(ctx, pixels, 'rgba(255, 50, 50, 0.72)');
                    }
                }
            }

            // Flash list rows if panel is open
            document.querySelectorAll('.pcm-ch-row').forEach(function (row) {
                let ch = parseInt(row.dataset.ch);
                if (orphanChannels.has(ch)) {
                    row.style.background = orphanFlashState ? 'rgba(255,50,50,0.18)' : '';
                }
            });
        }, 650);
    }

    function stopOrphanFlash() {
        if (orphanFlashTimer) { clearInterval(orphanFlashTimer); orphanFlashTimer = null; }
        clearOverlay();
        document.querySelectorAll('.pcm-ch-row').forEach(function (r) { r.style.background = ''; });
    }

    // ----------------------------------------------------------------
    // HIGHLIGHT A SPECIFIC CHANNEL (flash on canvas, then fade out)
    // ----------------------------------------------------------------
    function flashChannelOnCanvas(ch) {
        let portals  = getPortalsForChannel(ch);
        let inPixels = portals.filter(function (p) { return elements[p.element].id === elements.portal_in.id; });
        let outPixels= portals.filter(function (p) { return elements[p.element].id === elements.portal_out.id; });

        if (!portals.length) {
            logMessage('[PCM] No portals on canvas for channel ' + ch + '.');
            return;
        }

        if (highlightTimer) clearInterval(highlightTimer);

        // Alternate between: colours showing in/out distinction, then white flash, then off
        let step = 0;
        let steps = [
            { in: 'rgba(255,154,0,0.85)',  out: 'rgba(0,162,255,0.85)' },
            { in: 'rgba(255,255,255,0.9)', out: 'rgba(255,255,255,0.9)' },
            { in: 'rgba(255,154,0,0.85)',  out: 'rgba(0,162,255,0.85)' },
            { in: 'rgba(255,255,255,0.9)', out: 'rgba(255,255,255,0.9)' },
            { in: 'rgba(255,154,0,0.85)',  out: 'rgba(0,162,255,0.85)' },
            { in: 'rgba(255,255,255,0.9)', out: 'rgba(255,255,255,0.9)' },
            { in: 'rgba(255,154,0,0.85)',  out: 'rgba(0,162,255,0.85)' },
            null // clear
        ];

        highlightTimer = setInterval(function () {
            let s = steps[step];
            let overlay = getOrCreateOverlay();
            if (!overlay) { clearInterval(highlightTimer); return; }
            let ctx = overlay.getContext('2d');
            ctx.clearRect(0, 0, overlay.width, overlay.height);

            if (s) {
                paintOverlayPixels(ctx, inPixels,  s.in);
                paintOverlayPixels(ctx, outPixels, s.out);
            }

            step++;
            if (step >= steps.length) {
                clearInterval(highlightTimer);
                clearOverlay();
                // If the panel is closed, restart orphan flash
                if (!document.getElementById('pcm-panel')) startOrphanFlash();
            }
        }, 230);
    }

    // ----------------------------------------------------------------
    // HOVER STATUS BAR
    // Shows channel info at the bottom of the screen whenever the
    // cursor/finger is over a portal pixel.
    // ----------------------------------------------------------------
    function setupHoverBar() {
        let bar = document.createElement('div');
        bar.id = 'pcm-hoverbar';
        bar.style.cssText = [
            'position:fixed;bottom:0;left:0;right:0;z-index:9995;',
            'background:rgba(6,6,22,0.94);color:#eee;',
            'font-family:monospace;font-size:13px;line-height:1.5;',
            'padding:5px 14px;border-top:2px solid #ff9a00;',
            'display:none;pointer-events:none;'
        ].join('');
        document.body.appendChild(bar);

        setInterval(function () {
            if (typeof mousePos === 'undefined' || typeof getPixel === 'undefined') return;
            let pixel;
            try { pixel = getPixel(mousePos.x, mousePos.y); } catch (e) { return; }

            if (!pixel || !pixel.element || !elements[pixel.element]) {
                bar.style.display = 'none';
                return;
            }

            let el    = elements[pixel.element];
            let isIn  = el.id === elements.portal_in.id;
            let isOut = el.id === elements.portal_out.id;
            if (!isIn && !isOut) { bar.style.display = 'none'; return; }

            let ch         = parseInt(pixel.channel) || 0;
            let type       = isIn ? 'IN ▶' : '◀ OUT';
            let typeColor  = isIn ? '#ff9a00' : '#00a2ff';
            let lbl        = (pcmData[ch] && pcmData[ch].label)  ? pcmData[ch].label  : '<i style="color:#555">no label</i>';
            let fld        = (pcmData[ch] && pcmData[ch].folder) ? '&nbsp;|&nbsp;📁 ' + pcmData[ch].folder : '';

            bar.style.display = 'block';
            bar.innerHTML = (
                'Portal <b style="color:' + typeColor + '">' + type + '</b>' +
                '&nbsp;|&nbsp;Channel <b style="color:#ff9a00">' + ch + '</b>' +
                '&nbsp;|&nbsp;' + lbl + fld
            );
        }, 150);
    }

    // ----------------------------------------------------------------
    // SAVE / LOAD PATCHING
    // Embeds pcmData inside the save JSON under the key "pcm".
    // When the mod is not installed, loadSave simply ignores "pcm".
    // ----------------------------------------------------------------
    function patchSaveLoad() {
        var origGen = window.generateSave;
        window.generateSave = function () {
            var save = origGen.apply(this, arguments);
            // Only write the key if there is actual data to save
            if (Object.keys(pcmData).length > 0) {
                save.pcm = { channelData: JSON.parse(JSON.stringify(pcmData)) };
            }
            return save;
        };

        var origLoad = window.loadSave;
        window.loadSave = function (saveJSON) {
            // Read our data back (or reset to empty if mod wasn't active when saving)
            pcmData = (saveJSON && saveJSON.pcm && saveJSON.pcm.channelData) || {};
            var result = origLoad.apply(this, arguments);
            // Refresh the panel list after the canvas has had time to populate
            setTimeout(function () {
                if (document.getElementById('pcm-panel')) renderList();
            }, 900);
            return result;
        };
    }

    // ----------------------------------------------------------------
    // PORTAL SHIFT-SELECT OVERRIDE
    // Replaces the plain number prompt with a list of existing channels,
    // including labels and a warning if the chosen channel is already
    // fully linked (both IN and OUT present).
    // ----------------------------------------------------------------
    function patchPortalSelect() {
        function buildPicker(typeName) {
            return function () {
                var scan = scanPortals();
                var ins = scan.ins, outs = scan.outs, all = scan.all;
                var channels = Array.from(all).sort(function (a, b) { return a - b; });

                var msg = 'Type a channel number to use.\n';
                if (channels.length > 0) {
                    msg += '\nExisting channels on canvas:\n';
                    for (var i = 0; i < channels.length; i++) {
                        var ch  = channels[i];
                        var st  = getStatus(ch, ins, outs);
                        var ico = st === 'ok' ? '✓' : '⚠';
                        var stl = st === 'ok' ? 'linked' : st === 'no_out' ? 'no OUT' : 'no IN';
                        var lbl = (pcmData[ch] && pcmData[ch].label)  ? '  →  ' + pcmData[ch].label  : '';
                        var fld = (pcmData[ch] && pcmData[ch].folder) ? ' [' + pcmData[ch].folder + ']' : '';
                        msg += '  ' + ico + ' Ch ' + ch + '  (' + stl + ')' + lbl + fld + '\n';
                    }
                } else {
                    msg += '(No portals on canvas yet)\n';
                }

                promptInput(msg, function (r) {
                    if (r === '' || r === null) return;
                    var ch = parseInt(r);
                    if (isNaN(ch)) { logMessage('[PCM] Invalid channel number.'); return; }

                    var scan2 = scanPortals();
                    var st = getStatus(ch, scan2.ins, scan2.outs);

                    if (st === 'ok') {
                        // Warn: channel already has both IN and OUT
                        promptConfirm(
                            'Channel ' + ch + ' already has both a portal_in AND a portal_out.\n\n' +
                            'Adding more portals on the same channel can cause unexpected routing behaviour.\n\n' +
                            'Continue anyway?',
                            function (ok) { if (ok) currentElementProp = { channel: ch }; },
                            'Channel ' + ch + ' is already in use'
                        );
                    } else {
                        currentElementProp = { channel: ch };
                    }
                }, typeName + ' — Channel Picker');
            };
        }

        elements.portal_in.onShiftSelect  = buildPicker('Portal IN');
        elements.portal_out.onShiftSelect = buildPicker('Portal OUT');
    }

    // ----------------------------------------------------------------
    // PANEL UI
    // ----------------------------------------------------------------
    function createToggleButton() {
        var btn = document.createElement('button');
        btn.id        = 'pcm-toggle-btn';
        btn.innerHTML = '📡';
        btn.title     = 'Portal Channel Manager';
        btn.style.cssText = [
            'position:fixed;top:48px;right:5px;z-index:10000;',
            'background:#0f3460;color:#fff;',
            'border:2px solid #ff9a00;border-radius:6px;',
            'padding:5px 10px;cursor:pointer;font-size:15px;',
            'touch-action:manipulation;',
            'box-shadow:0 2px 10px rgba(0,0,0,0.55);'
        ].join('');
        btn.addEventListener('click', togglePanel);
        document.body.appendChild(btn);
    }

    function togglePanel() {
        var existing = document.getElementById('pcm-panel');
        if (existing) {
            existing.remove();
            // Restart canvas orphan flash when panel is closed
            startOrphanFlash();
        } else {
            openPanel();
        }
    }

    function openPanel() {
        // Stop canvas orphan flash — user has opened the panel
        stopOrphanFlash();

        var panel = document.createElement('div');
        panel.id = 'pcm-panel';
        panel.style.cssText = [
            'position:fixed;top:48px;right:5px;width:315px;max-height:78vh;',
            'background:#11112b;border:2px solid #ff9a00;border-radius:9px;',
            'z-index:9999;font-family:monospace;color:#eee;',
            'display:flex;flex-direction:column;overflow:hidden;',
            'box-shadow:0 8px 32px rgba(0,0,0,0.7);'
        ].join('');

        // ---- Header ----
        var header = document.createElement('div');
        header.id = 'pcm-drag-handle';
        header.style.cssText = [
            'background:#0f3460;padding:8px 12px;',
            'display:flex;justify-content:space-between;align-items:center;',
            'border-bottom:1px solid #ff9a00;cursor:move;user-select:none;',
            '-webkit-user-select:none;'
        ].join('');
        header.innerHTML = (
            '<span style="font-size:13px;letter-spacing:0.4px;">📡 Portal Channel Manager</span>' +
            '<button id="pcm-close-btn" style="background:none;border:none;color:#bbb;cursor:pointer;' +
            'font-size:20px;line-height:1;padding:0 4px;touch-action:manipulation;" title="Close">×</button>'
        );
        panel.appendChild(header);

        // ---- Toolbar ----
        var toolbar = document.createElement('div');
        toolbar.style.cssText = [
            'padding:6px 8px;display:flex;gap:5px;flex-wrap:wrap;',
            'border-bottom:1px solid #1e1e38;background:#0a0a1e;'
        ].join('');
        toolbar.innerHTML = (
            '<select id="pcm-sort-sel" style="background:#1a1a32;color:#eee;border:1px solid #404055;' +
            'border-radius:4px;padding:4px 5px;font-size:11px;flex:1;min-width:0;touch-action:manipulation;">' +
            '<option value="num">↕ Channel #</option>' +
            '<option value="label">↕ Label A–Z</option>' +
            '<option value="folder">↕ Folder</option>' +
            '<option value="status">↕ Status</option>' +
            '</select>' +
            '<button id="pcm-scan-btn" title="Re-scan canvas" style="background:#0f3460;color:#eee;border:1px solid #404055;' +
            'border-radius:4px;padding:4px 9px;cursor:pointer;font-size:11px;touch-action:manipulation;">🔄 Scan</button>' +
            '<button id="pcm-add-btn" title="Manually add a channel label" style="background:#0f3460;color:#eee;border:1px solid #404055;' +
            'border-radius:4px;padding:4px 9px;cursor:pointer;font-size:11px;touch-action:manipulation;">+ Label</button>'
        );
        panel.appendChild(toolbar);

        // ---- Channel List ----
        var listEl = document.createElement('div');
        listEl.id = 'pcm-list';
        listEl.style.cssText = 'overflow-y:auto;flex:1;';
        panel.appendChild(listEl);

        // ---- Footer ----
        var footer = document.createElement('div');
        footer.id = 'pcm-footer';
        footer.style.cssText = [
            'padding:4px 10px;background:#080818;',
            'border-top:1px solid #1e1e38;font-size:11px;color:#777;min-height:22px;'
        ].join('');
        panel.appendChild(footer);

        document.body.appendChild(panel);

        // Events
        document.getElementById('pcm-close-btn').addEventListener('click', function () {
            panel.remove();
            startOrphanFlash();
        });
        document.getElementById('pcm-scan-btn').addEventListener('click', renderList);
        document.getElementById('pcm-sort-sel').addEventListener('change', renderList);
        document.getElementById('pcm-add-btn').addEventListener('click', manualAddChannel);

        // ---- Drag support (mouse + touch) ----
        var dragging = false, dX = 0, dY = 0;
        header.addEventListener('mousedown', function (e) {
            dragging = true;
            var r = panel.getBoundingClientRect();
            dX = e.clientX - r.left; dY = e.clientY - r.top;
            panel.style.right = 'auto';
            e.preventDefault();
        });
        header.addEventListener('touchstart', function (e) {
            var t = e.touches[0];
            dragging = true;
            var r = panel.getBoundingClientRect();
            dX = t.clientX - r.left; dY = t.clientY - r.top;
            panel.style.right = 'auto';
        }, { passive: true });
        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            panel.style.left = (e.clientX - dX) + 'px';
            panel.style.top  = (e.clientY - dY) + 'px';
        });
        document.addEventListener('touchmove', function (e) {
            if (!dragging) return;
            var t = e.touches[0];
            panel.style.left = (t.clientX - dX) + 'px';
            panel.style.top  = (t.clientY - dY) + 'px';
        }, { passive: true });
        document.addEventListener('mouseup',  function () { dragging = false; });
        document.addEventListener('touchend', function () { dragging = false; });

        renderList();
    }

    // Rebuilds the channel list inside the panel.
    function renderList() {
        var listEl = document.getElementById('pcm-list');
        if (!listEl) return;
        listEl.innerHTML = '';

        var scan = scanPortals();
        var ins = scan.ins, outs = scan.outs, all = scan.all;
        var sortSel = document.getElementById('pcm-sort-sel');
        var sortMode = sortSel ? sortSel.value : 'num';

        // Collect channels: those on canvas + any manually labelled ones
        var channelSet = new Set(all);
        for (var k in pcmData) {
            if (pcmData[k] && (pcmData[k].label || pcmData[k].folder)) {
                channelSet.add(Number(k));
            }
        }
        var channels = Array.from(channelSet);

        channels.sort(function (a, b) {
            if (sortMode === 'num') return a - b;
            if (sortMode === 'label') {
                var la = (pcmData[a] || {}).label || '';
                var lb = (pcmData[b] || {}).label || '';
                return la.localeCompare(lb) || a - b;
            }
            if (sortMode === 'folder') {
                var fa = (pcmData[a] || {}).folder || '';
                var fb = (pcmData[b] || {}).folder || '';
                return fa.localeCompare(fb) || a - b;
            }
            if (sortMode === 'status') {
                var order = { ok: 0, no_out: 1, no_in: 2, empty: 3 };
                return (order[getStatus(a, ins, outs)] || 0) - (order[getStatus(b, ins, outs)] || 0) || a - b;
            }
            return a - b;
        });

        if (channels.length === 0) {
            listEl.innerHTML = '<div style="padding:20px 14px;color:#555;text-align:center;font-size:12px;">' +
                'No portal channels found.<br>Place portal_in or portal_out pixels,<br>then press 🔄 Scan.</div>';
            updateFooter(0, 0);
            return;
        }

        var currentFolder = Symbol(); // sentinel — won't equal any string

        for (var i = 0; i < channels.length; i++) {
            var ch   = channels[i];
            var data = pcmData[ch] || {};
            var st   = getStatus(ch, ins, outs);
            var folder = data.folder || '';

            // Folder divider (only in folder sort mode)
            if (sortMode === 'folder' && folder !== currentFolder) {
                currentFolder = folder;
                var divider = document.createElement('div');
                divider.style.cssText = [
                    'padding:3px 10px;background:#191935;color:#7777aa;',
                    'font-size:10px;letter-spacing:0.5px;text-transform:uppercase;'
                ].join('');
                divider.textContent = folder ? ('📁 ' + folder) : '— No folder —';
                listEl.appendChild(divider);
            }

            var stColor = st === 'ok' ? '#00e676' : '#ff5252';
            var stIcon  = st === 'ok' ? '✓' : '⚠';
            var stTip   = st === 'ok'     ? 'Linked — both IN and OUT present'
                        : st === 'no_out' ? 'Missing OUT portal on this channel'
                        : st === 'no_in'  ? 'Missing IN portal on this channel'
                        : 'Not on canvas (manually added label)';

            var inCount  = ins[ch]  || 0;
            var outCount = outs[ch] || 0;

            var row = document.createElement('div');
            row.className    = 'pcm-ch-row';
            row.dataset.ch   = String(ch);
            row.style.cssText = [
                'padding:7px 10px;display:flex;align-items:center;gap:5px;',
                'border-bottom:1px solid #16162e;cursor:pointer;'
            ].join('');

            // Status icon
            var iconSpan = document.createElement('span');
            iconSpan.title = stTip;
            iconSpan.style.cssText = 'color:' + stColor + ';font-size:12px;min-width:13px;';
            iconSpan.textContent = stIcon;
            row.appendChild(iconSpan);

            // Channel number
            var chSpan = document.createElement('span');
            chSpan.style.cssText = 'color:#ff9a00;font-size:12px;min-width:44px;';
            chSpan.textContent = 'Ch ' + ch;
            row.appendChild(chSpan);

            // Label
            var lblSpan = document.createElement('span');
            lblSpan.style.cssText = 'flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            if (data.label) {
                lblSpan.style.color = '#cccccc';
                lblSpan.textContent = data.label;
            } else {
                lblSpan.style.color = '#383858';
                lblSpan.textContent = 'no label';
            }
            row.appendChild(lblSpan);

            // Folder badge (shown when NOT in folder-sort mode)
            if (data.folder && sortMode !== 'folder') {
                var fldBadge = document.createElement('span');
                fldBadge.style.cssText = 'font-size:10px;color:#5566aa;background:#181830;padding:1px 4px;border-radius:3px;';
                fldBadge.textContent = '📁' + data.folder;
                row.appendChild(fldBadge);
            }

            // IN/OUT count
            var countSpan = document.createElement('span');
            countSpan.title = inCount + ' IN portal(s), ' + outCount + ' OUT portal(s)';
            countSpan.style.cssText = 'font-size:10px;color:#444466;';
            countSpan.textContent = inCount + '→' + outCount;
            row.appendChild(countSpan);

            // Edit button
            var editBtn = document.createElement('button');
            editBtn.title = 'Edit label and folder';
            editBtn.style.cssText = [
                'background:none;border:1px solid #303050;color:#777799;',
                'border-radius:3px;cursor:pointer;font-size:11px;',
                'padding:2px 6px;touch-action:manipulation;flex-shrink:0;'
            ].join('');
            editBtn.innerHTML = '✏️';
            (function (capturedCh) {
                editBtn.addEventListener('click', function (e) { e.stopPropagation(); editChannel(capturedCh); });
            }(ch));
            row.appendChild(editBtn);

            // Highlight button
            var hlBtn = document.createElement('button');
            hlBtn.title = 'Flash this channel on canvas';
            hlBtn.style.cssText = [
                'background:none;border:1px solid #303050;color:#777799;',
                'border-radius:3px;cursor:pointer;font-size:11px;',
                'padding:2px 6px;touch-action:manipulation;flex-shrink:0;'
            ].join('');
            hlBtn.innerHTML = '🔍';
            (function (capturedCh) {
                hlBtn.addEventListener('click', function (e) { e.stopPropagation(); flashChannelOnCanvas(capturedCh); });
                row.addEventListener('click', function () { flashChannelOnCanvas(capturedCh); });
            }(ch));
            row.appendChild(hlBtn);

            row.addEventListener('mouseenter', function () { this.style.background = '#1c1c3a'; });
            row.addEventListener('mouseleave', function () {
                // Only clear if not currently in orphan-flash state
                if (!orphanChannels.has(parseInt(this.dataset.ch))) this.style.background = '';
            });

            listEl.appendChild(row);
        }

        var orphanCount = channels.filter(function (ch) {
            return all.has(ch) && getStatus(ch, ins, outs) !== 'ok';
        }).length;
        updateFooter(channels.length, orphanCount);
    }

    function updateFooter(total, orphans) {
        var f = document.getElementById('pcm-footer');
        if (!f) return;
        var orphanText = orphans > 0
            ? '<span style="color:#ff5252">⚠ ' + orphans + ' missing link' + (orphans !== 1 ? 's' : '') + '</span>'
            : '<span style="color:#00e676">✓ All channels linked</span>';
        f.innerHTML = total + ' channel' + (total !== 1 ? 's' : '') + ' &nbsp;|&nbsp; ' + orphanText;
    }

    // Opens the promptInput dialog to edit a channel's label and folder.
    function editChannel(ch) {
        var data = pcmData[ch] || {};
        var existingFolders = [];
        for (var k in pcmData) {
            if (pcmData[k] && pcmData[k].folder) existingFolders.push(pcmData[k].folder);
        }
        existingFolders = existingFolders.filter(function (v, i, a) { return a.indexOf(v) === i; });
        var folderHint = existingFolders.length ? '\nExisting folders: ' + existingFolders.join(', ') : '';

        promptInput(
            'Label for Channel ' + ch + ':\n(current: ' + (data.label || 'none') + ')',
            function (label) {
                if (label === null) return;
                if (!pcmData[ch]) pcmData[ch] = { label: '', folder: '' };
                pcmData[ch].label = label.trim();

                promptInput(
                    'Folder for Channel ' + ch + ':' + folderHint + '\n(leave empty to remove from any folder)',
                    function (folder) {
                        if (folder === null) return;
                        pcmData[ch].folder = folder.trim();
                        renderList();
                    },
                    'Assign Folder — Channel ' + ch
                );
            },
            'Edit Label — Channel ' + ch
        );
    }

    // Lets the user pre-label a channel that doesn't exist on canvas yet.
    function manualAddChannel() {
        promptInput(
            'Enter a channel number to manually add a label for.\n' +
            '(Useful for planning channels before placing any portals.)',
            function (r) {
                if (r === null || r === '') return;
                var ch = parseInt(r);
                if (isNaN(ch)) { logMessage('[PCM] Invalid channel number.'); return; }
                if (!pcmData[ch]) pcmData[ch] = { label: '', folder: '' };
                editChannel(ch);
            },
            'Manually Add Channel Label'
        );
    }

    // ----------------------------------------------------------------
    // INIT — waits for the game to finish loading
    // ----------------------------------------------------------------
    function init() {
        if (
            typeof elements    === 'undefined' ||
            typeof promptInput === 'undefined' ||
            !elements.portal_in
        ) {
            setTimeout(init, 400);
            return;
        }

        patchSaveLoad();
        patchPortalSelect();
        setupHoverBar();
        createToggleButton();
        startOrphanFlash();

        console.log('[PCM] Portal Channel Manager v1.0 loaded successfully.');
    }

    init();

})();
