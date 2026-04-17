// ================================================================
//  GROUPING MANAGER — Sandboxels Mod
//  Version 1.1
//
//  Adds a touch-friendly selection interface for assigning pixels
//  to groups using the vanilla _r property and currentRelations.
//
//  When this mod is removed the canvas looks exactly as it did
//  before: no new elements, no new save keys, no UI left behind.
//
//  COMPATIBLE WITH: zoom.js · worldEdit.js
//                   portal-channel-manager3.js · mobileMouse1.js
//
//  SAVE COMPATIBILITY:
//  Groups are stored using vanilla _r values.
//  Custom names  → currentRelations[id].gmName
//  Flash colours → currentRelations[id].gmFlashColor
//  Both are GM-namespaced properties vanilla silently ignores on load,
//  so saves open cleanly without this mod installed.
// ================================================================

(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────
    //  STATE
    // ────────────────────────────────────────────────────────────────

    var gm = {
        active:         false,     // Is selection mode on?
        inspectMode:    false,     // Long-press-to-inspect mode
        colorGroups:    false,     // Draw group colour overlays
        selectedPixels: new Set(), // "x,y" coordinate-string keys
    };

    // Selection history for undo / redo.
    // Each entry is a plain Array snapshot of gm.selectedPixels.
    var gm_history = [];
    var gm_histIdx = -1;

    // Long-press detection (for the inspector).
    var gm_lpTimer  = null;
    var gm_lpStartX = 0;
    var gm_lpStartY = 0;
    var GM_LP_MS    = 600;  // milliseconds to trigger long-press
    var GM_LP_SLOP  = 14;   // pixels — cancel if the finger drifts this far

    // ── Flash system ─────────────────────────────────────────────────
    // Map of groupId (number) → hex colour string for groups that are
    // currently flashing. Independent of the Colors toggle.
    var gm_flashGroups   = new Map();
    var gm_flashVisible  = true;   // current blink phase (on/off)
    var gm_flashInterval = null;   // setInterval handle, null = stopped

    var GM_FLASH_DEFAULT = '#ff4040'; // default flash colour
    var GM_FLASH_MS      = 500;       // blink period in ms


    // ────────────────────────────────────────────────────────────────
    //  COORDINATE HELPERS
    // ────────────────────────────────────────────────────────────────

    function gmPixelSize() {
        return (typeof pixelSize !== 'undefined') ? pixelSize : 6;
    }

    /**
     * Convert a pointer client position into pixel-grid coordinates.
     * Mirrors the approach used by worldEdit.js so zoom.js is handled
     * correctly (the game canvas may be scaled via CSS).
     */
    function gmClientToPixel(clientX, clientY) {
        // Prefer the named global `canvas`; fall back to the DOM element.
        var cvs = (typeof canvas !== 'undefined') ? canvas
                : document.getElementById('game');
        if (!cvs) return null;

        var rect = cvs.getBoundingClientRect();
        var w    = (typeof width  !== 'undefined') ? width  : 200;
        var h    = (typeof height !== 'undefined') ? height : 200;

        var px = Math.floor(((clientX - rect.left) / rect.width)  * (w + 1));
        var py = Math.floor(((clientY - rect.top)  / rect.height) * (h + 1));

        if (px < 0 || px > w || py < 0 || py > h) return null;
        return { x: px, y: py };
    }

    /** Return the live pixel object at (x, y) or null. */
    function gmPixelAt(x, y) {
        if (typeof pixelMap === 'undefined') return null;
        return (pixelMap[x] && pixelMap[x][y]) ? pixelMap[x][y] : null;
    }


    // ────────────────────────────────────────────────────────────────
    //  HISTORY — UNDO / REDO
    // ────────────────────────────────────────────────────────────────

    /** Snapshot the current selection before a change. Call this FIRST. */
    function gmPushHistory() {
        // Discard any redo states ahead of the cursor.
        gm_history.splice(gm_histIdx + 1);
        gm_history.push(Array.from(gm.selectedPixels));
        gm_histIdx = gm_history.length - 1;

        // Hard cap at 50 entries to avoid unbounded memory growth.
        if (gm_history.length > 50) {
            gm_history.shift();
            gm_histIdx = gm_history.length - 1;
        }
        gmSyncPanelButtons();
    }

    function gmUndo() {
        if (gm_histIdx <= 0) return;
        gm_histIdx--;
        gm.selectedPixels = new Set(gm_history[gm_histIdx]);
        gmUpdateCount();
        gmSyncPanelButtons();
    }

    function gmRedo() {
        if (gm_histIdx >= gm_history.length - 1) return;
        gm_histIdx++;
        gm.selectedPixels = new Set(gm_history[gm_histIdx]);
        gmUpdateCount();
        gmSyncPanelButtons();
    }


    // ────────────────────────────────────────────────────────────────
    //  SELECTION LOGIC
    // ────────────────────────────────────────────────────────────────

    /** Add or remove a pixel from the selection. */
    function gmTogglePixel(x, y) {
        var key = x + ',' + y;
        gmPushHistory();
        if (gm.selectedPixels.has(key)) {
            gm.selectedPixels.delete(key);
        } else {
            // Only allow selecting pixels that actually exist.
            if (gmPixelAt(x, y)) {
                gm.selectedPixels.add(key);
            }
        }
        gmUpdateCount();
    }

    /** Clear the entire selection (with undo support). */
    function gmClearSelection() {
        if (gm.selectedPixels.size === 0) return;
        gmPushHistory();
        gm.selectedPixels.clear();
        gmUpdateCount();
    }


    // ────────────────────────────────────────────────────────────────
    //  GROUP HELPERS
    // ────────────────────────────────────────────────────────────────

    /** Find the next unused _r ID by scanning both currentRelations and currentPixels. */
    function gmNextGroupId() {
        var max = 0;

        if (typeof currentRelations !== 'undefined') {
            Object.keys(currentRelations).forEach(function (k) {
                var n = parseInt(k, 10);
                if (!isNaN(n) && n > max) max = n;
            });
        }
        if (typeof currentPixels !== 'undefined') {
            currentPixels.forEach(function (p) {
                if (p._r !== undefined && p._r > max) max = p._r;
            });
        }
        return max + 1;
    }

    /** Count live pixels that belong to a given group ID. */
    function gmCountGroupMembers(groupId) {
        var n = 0;
        if (typeof currentPixels !== 'undefined') {
            currentPixels.forEach(function (p) {
                if (!p.del && p._r === groupId) n++;
            });
        }
        return n;
    }


    // ────────────────────────────────────────────────────────────────
    //  GROUP CREATION
    // ────────────────────────────────────────────────────────────────

    function gmCreateGroup() {
        if (gm.selectedPixels.size === 0) {
            if (typeof logMessage !== 'undefined') {
                logMessage('[GM] No pixels selected — nothing to group.');
            }
            return;
        }

        var newId = gmNextGroupId();
        var count = 0;

        gm.selectedPixels.forEach(function (key) {
            var parts = key.split(',');
            var pixel = gmPixelAt(parseInt(parts[0], 10), parseInt(parts[1], 10));
            if (pixel) {
                pixel._r = newId;
                count++;
            }
        });

        if (typeof logMessage !== 'undefined') {
            logMessage('[GM] Created group #' + newId + ' (' + count + ' pixels).');
        }

        // Clear selection and exit selection mode after grouping.
        gmExitSelectionMode();
    }


    // ────────────────────────────────────────────────────────────────
    //  SELECTION MODE TOGGLE
    // ────────────────────────────────────────────────────────────────

    function gmEnterSelectionMode() {
        gm.active = true;

        // Reset history for this fresh selection session.
        gm_history = [];
        gm_histIdx = -1;
        gm.selectedPixels.clear();
        gmPushHistory(); // initial empty state at index 0

        var btn = document.getElementById('gm-toggle');
        if (btn) { btn.textContent = '✅ Select ON'; btn.classList.add('gm-btn-active'); }

        var panel = document.getElementById('gm-panel');
        if (panel) panel.style.display = 'grid';

        // Restore colour-groups button active state if colours are still on.
        var colBtn = document.getElementById('gm-color-btn');
        if (colBtn) {
            if (gm.colorGroups) colBtn.classList.add('gm-btn-active');
            else                colBtn.classList.remove('gm-btn-active');
        }

        gmUpdateCount();
        gmSyncPanelButtons();
    }

    function gmExitSelectionMode() {
        gm.active      = false;
        gm.inspectMode = false;
        gm.selectedPixels.clear();

        var btn = document.getElementById('gm-toggle');
        if (btn) { btn.textContent = '📐 Groups'; btn.classList.remove('gm-btn-active'); }

        var panel = document.getElementById('gm-panel');
        if (panel) panel.style.display = 'none';

        var inspBtn = document.getElementById('gm-inspect-btn');
        if (inspBtn) inspBtn.classList.remove('gm-btn-active');

        gmHidePopup();
    }

    function gmToggleSelectionMode() {
        if (gm.active) gmExitSelectionMode();
        else           gmEnterSelectionMode();
    }


    // ────────────────────────────────────────────────────────────────
    //  INSPECTOR POPUP
    // ────────────────────────────────────────────────────────────────

    function gmShowInspector(x, y) {
        var pixel = gmPixelAt(x, y);
        if (!pixel || pixel._r === undefined) {
            if (typeof logMessage !== 'undefined') {
                logMessage('[GM] Tapped pixel has no group.');
            }
            return;
        }

        var gid   = pixel._r;
        var count = gmCountGroupMembers(gid);

        // Read stored name.
        var name = 'Unnamed';
        if (typeof currentRelations !== 'undefined' &&
            currentRelations[gid]  !== undefined &&
            currentRelations[gid].gmName) {
            name = currentRelations[gid].gmName;
        }

        // Read stored flash colour (default red).
        var flashColor = GM_FLASH_DEFAULT;
        if (typeof currentRelations !== 'undefined' &&
            currentRelations[gid]  !== undefined &&
            currentRelations[gid].gmFlashColor) {
            flashColor = currentRelations[gid].gmFlashColor;
        }

        // Populate the popup.
        var el;
        el = document.getElementById('gm-popup-gid');
        if (el) el.textContent = 'Group ID: #' + gid;

        el = document.getElementById('gm-popup-count');
        if (el) el.textContent = 'Pixels: ' + count;

        el = document.getElementById('gm-popup-name');
        if (el) el.textContent = 'Name: ' + name;

        // Sync colour picker value.
        el = document.getElementById('gm-popup-colorpicker');
        if (el) el.value = flashColor;

        // Sync flash toggle button label.
        var flashBtn = document.getElementById('gm-popup-flashbtn');
        if (flashBtn) {
            var isFlashing = gm_flashGroups.has(gid);
            flashBtn.textContent = isFlashing ? '🔦 Stop Flash' : '🔦 Flash';
            flashBtn.classList.toggle('gm-btn-active', isFlashing);
        }

        var popup = document.getElementById('gm-popup');
        if (popup) {
            popup.dataset.gid = String(gid);
            popup.style.display = 'flex';
        }

        // Toggle flash for this group: inspecting same group = stop/start.
        gmToggleGroupFlash(gid);

        // Re-sync button now that toggle has run.
        if (flashBtn) {
            var isNowFlashing = gm_flashGroups.has(gid);
            flashBtn.textContent = isNowFlashing ? '🔦 Stop Flash' : '🔦 Flash';
            flashBtn.classList.toggle('gm-btn-active', isNowFlashing);
        }
    }

    function gmHidePopup() {
        var popup = document.getElementById('gm-popup');
        if (popup) popup.style.display = 'none';
    }

    function gmRenameGroup() {
        var popup = document.getElementById('gm-popup');
        if (!popup) return;
        var gid = parseInt(popup.dataset.gid, 10);
        if (isNaN(gid)) return;

        // Get the current name to show as placeholder.
        var current = '';
        if (typeof currentRelations !== 'undefined' &&
            currentRelations[gid]  !== undefined) {
            current = currentRelations[gid].gmName || '';
        }

        // Use Sandboxels' own prompt if available (keeps visual consistency).
        // Otherwise fall back to the native browser prompt.
        function applyName(val) {
            if (val === null || val === undefined) return;
            var trimmed = String(val).trim();

            // Ensure currentRelations exists before writing.
            if (typeof currentRelations === 'undefined') window.currentRelations = {};
            if (!currentRelations[gid]) currentRelations[gid] = {};
            currentRelations[gid].gmName = trimmed;

            var nameEl = document.getElementById('gm-popup-name');
            if (nameEl) nameEl.textContent = 'Name: ' + (trimmed || 'Unnamed');
        }

        if (typeof promptInput === 'function') {
            promptInput('Name for group #' + gid + ':', applyName, current);
        } else {
            var val = window.prompt('Name for group #' + gid + ':', current);
            applyName(val);
        }
    }


    // ────────────────────────────────────────────────────────────────
    //  GROUP COLOUR OVERLAY
    // ────────────────────────────────────────────────────────────────

    /**
     * Deterministic, perceptually-spread fully-opaque colour for the
     * static colour overlay. Golden-angle trick keeps adjacent IDs visually
     * distinct. Alpha is 1.0 (fully opaque) as requested.
     */
    function gmGroupColor(groupId) {
        var h = (groupId * 137) % 360;
        return 'hsl(' + h + ',70%,55%)';
    }


    // ────────────────────────────────────────────────────────────────
    //  FLASH HELPERS
    // ────────────────────────────────────────────────────────────────

    /** Ensure the blink interval is running (start it if not). */
    function gmStartFlashInterval() {
        if (gm_flashInterval !== null) return;
        gm_flashInterval = setInterval(function () {
            gm_flashVisible = !gm_flashVisible;
        }, GM_FLASH_MS);
    }

    /** Stop the blink interval when no groups are flashing. */
    function gmStopFlashInterval() {
        if (gm_flashInterval === null) return;
        clearInterval(gm_flashInterval);
        gm_flashInterval = null;
        gm_flashVisible  = true; // reset so groups are shown next frame
    }

    /**
     * Toggle flashing for a group.
     * If the group is already flashing → stop it.
     * If it is not flashing → start flashing with its stored colour.
     * Inspecting the same group again is the off-switch.
     */
    function gmToggleGroupFlash(gid) {
        if (gm_flashGroups.has(gid)) {
            gm_flashGroups.delete(gid);
            if (gm_flashGroups.size === 0) gmStopFlashInterval();
        } else {
            // Look up stored flash colour; fall back to default.
            var color = GM_FLASH_DEFAULT;
            if (typeof currentRelations !== 'undefined' &&
                currentRelations[gid] &&
                currentRelations[gid].gmFlashColor) {
                color = currentRelations[gid].gmFlashColor;
            }
            gm_flashGroups.set(gid, color);
            gmStartFlashInterval();
        }
    }

    /** Persist a flash colour change while the group is already flashing. */
    function gmUpdateFlashColor(gid, color) {
        if (gm_flashGroups.has(gid)) {
            gm_flashGroups.set(gid, color);
        }
        // Also persist to currentRelations so it survives save/load.
        if (typeof currentRelations === 'undefined') window.currentRelations = {};
        if (!currentRelations[gid]) currentRelations[gid] = {};
        currentRelations[gid].gmFlashColor = color;
    }


    // ────────────────────────────────────────────────────────────────
    //  RENDER HOOK  — registered via renderPostPixel()
    //
    //  Called every frame with the game's 2D canvas context.
    //  Coordinates: pixel-grid × pixelSize = canvas px, exactly as
    //  worldEdit.js does it (works with zoom.js transforms).
    // ────────────────────────────────────────────────────────────────

    function gmRenderAll(ctx) {
        var ps = gmPixelSize();

        // ── Group colour overlay (static + flash) ─────────────────
        var hasColorGroups = gm.colorGroups && typeof currentPixels !== 'undefined';
        var hasFlash       = gm_flashGroups.size > 0 && typeof currentPixels !== 'undefined';

        if (hasColorGroups || hasFlash) {
            // Bucket pixels by group ID in a single pass.
            var buckets = {};
            currentPixels.forEach(function (p) {
                if (p.del || p._r === undefined) return;
                if (!buckets[p._r]) buckets[p._r] = [];
                buckets[p._r].push(p);
            });

            Object.keys(buckets).forEach(function (idStr) {
                var id     = parseInt(idStr, 10);
                var pixels = buckets[id];

                var isFlashing = gm_flashGroups.has(id);

                if (isFlashing) {
                    // Flashing group: draw with its custom flash colour, but only
                    // during the "visible" phase of the blink cycle.
                    if (gm_flashVisible) {
                        ctx.fillStyle = gm_flashGroups.get(id);
                        pixels.forEach(function (p) {
                            ctx.fillRect(p.x * ps, p.y * ps, ps, ps);
                        });
                    }
                    // Skip the static overlay for this group even if Colors is on,
                    // so the flash colour is the sole indicator while flashing.
                } else if (hasColorGroups) {
                    // Static fully-opaque overlay (non-flashing groups).
                    ctx.fillStyle = gmGroupColor(id);
                    pixels.forEach(function (p) {
                        ctx.fillRect(p.x * ps, p.y * ps, ps, ps);
                    });
                }
            });
        }

        // ── Selection highlight ───────────────────────────────────
        if (gm.active && gm.selectedPixels.size > 0) {
            // Semi-transparent white fill.
            ctx.fillStyle = 'rgba(255,255,255,0.35)';
            gm.selectedPixels.forEach(function (key) {
                var p = key.split(',');
                ctx.fillRect(parseInt(p[0], 10) * ps, parseInt(p[1], 10) * ps, ps, ps);
            });
            // Crisp white border over each selected cell.
            ctx.strokeStyle = 'rgba(255,255,255,0.95)';
            ctx.lineWidth   = 1;
            gm.selectedPixels.forEach(function (key) {
                var p = key.split(',');
                ctx.strokeRect(
                    parseInt(p[0], 10) * ps + 0.5,
                    parseInt(p[1], 10) * ps + 0.5,
                    ps - 1, ps - 1
                );
            });
        }
    }


    // ────────────────────────────────────────────────────────────────
    //  CANVAS EVENT LISTENERS
    // ────────────────────────────────────────────────────────────────

    function gmOnPointerDown(e) {
        // Only intercept primary pointer (left click / first touch).
        if (e.button !== 0 && e.pointerType !== 'touch') return;

        // Nothing to do when both modes are off.
        if (!gm.active) return;

        var pos = gmClientToPixel(e.clientX, e.clientY);
        if (!pos) return;

        // Prevent the game from drawing at this tap location.
        e.stopImmediatePropagation();
        e.preventDefault();

        if (gm.inspectMode) {
            // Begin long-press detection.
            gm_lpStartX = e.clientX;
            gm_lpStartY = e.clientY;
            gm_lpTimer  = setTimeout(function () {
                gm_lpTimer = null;
                gmShowInspector(pos.x, pos.y);
            }, GM_LP_MS);
        } else {
            // Immediate toggle.
            gmTogglePixel(pos.x, pos.y);
        }
    }

    function gmOnPointerMove(e) {
        if (!gm_lpTimer) return;
        var dx = e.clientX - gm_lpStartX;
        var dy = e.clientY - gm_lpStartY;
        if (dx * dx + dy * dy > GM_LP_SLOP * GM_LP_SLOP) {
            clearTimeout(gm_lpTimer);
            gm_lpTimer = null;
        }
    }

    function gmOnPointerUp() {
        if (gm_lpTimer) {
            clearTimeout(gm_lpTimer);
            gm_lpTimer = null;
        }
    }

    /**
     * Attach listeners to the game canvas with capture:true so they fire
     * before the game's own handlers.
     *
     * Compatibility note — mobileMouse1.js also uses capture:true but
     * registers its listener earlier.  MMM's handler only fires when
     * mmm_locked is true, so the two modes can coexist:
     *   · MMM locked  → MMM blocks the touch; GM selection receives nothing.
     *   · MMM unlocked → GM intercepts when selection mode is active.
     */
    function installCanvasListeners() {
        var cvs = (typeof gameCanvas !== 'undefined') ? gameCanvas
                : document.getElementById('game');
        if (!cvs) { setTimeout(installCanvasListeners, 200); return; }

        // ── Primary selection listener (pointerdown, capture) ──────
        cvs.addEventListener('pointerdown', gmOnPointerDown, { capture: true, passive: false });
        cvs.addEventListener('pointermove', gmOnPointerMove, { capture: false });
        cvs.addEventListener('pointerup',   gmOnPointerUp,   { capture: false });

        // ── Accidental-placement blockers ──────────────────────────
        // The game registers its own mousedown and touchstart handlers.
        // Capturing them here and calling stopImmediatePropagation()
        // whenever selection mode is active prevents any element from
        // being placed or erased during a selection tap.
        function gmBlockIfActive(e) {
            if (!gm.active) return;
            // Let panel / popup button clicks still reach their targets;
            // only block canvas-originated events.
            if (e.target !== cvs) return;
            e.stopImmediatePropagation();
            e.preventDefault();
        }

        cvs.addEventListener('mousedown',   gmBlockIfActive, { capture: true, passive: false });
        cvs.addEventListener('touchstart',  gmBlockIfActive, { capture: true, passive: false });
        cvs.addEventListener('touchmove',   gmBlockIfActive, { capture: true, passive: false });
    }


    // ────────────────────────────────────────────────────────────────
    //  UI — HELPERS
    // ────────────────────────────────────────────────────────────────

    function gmUpdateCount() {
        var el = document.getElementById('gm-count');
        if (el) el.textContent = gm.selectedPixels.size + ' pixel' +
                                 (gm.selectedPixels.size !== 1 ? 's' : '') + ' selected';
    }

    function gmSyncPanelButtons() {
        var u = document.getElementById('gm-undo-btn');
        var r = document.getElementById('gm-redo-btn');
        if (u) u.disabled = (gm_histIdx <= 0);
        if (r) r.disabled = (gm_histIdx >= gm_history.length - 1);
    }

    /**
     * Find the game's main toolbar so the toggle button can sit
     * alongside Pause, Reset, etc.
     */
    function gmFindToolbar() {
        var ids = ['toolControls', 'gameButtons', 'controlsDiv', 'buttonBar'];
        for (var i = 0; i < ids.length; i++) {
            var el = document.getElementById(ids[i]);
            if (el) return el;
        }
        // Fall back: use the pause button's parent element.
        var pb = document.getElementById('pauseButton');
        if (pb && pb.parentElement) return pb.parentElement;
        return null;
    }


    // ────────────────────────────────────────────────────────────────
    //  UI — BUILD
    // ────────────────────────────────────────────────────────────────

    function buildUI() {
        if (document.getElementById('gm-container')) return; // guard

        // ── Styles ───────────────────────────────────────────────
        var style = document.createElement('style');
        style.id  = 'gm-style';
        style.textContent = [
            /* Shared button appearance — dark game-theme aesthetic */
            '.gm-btn {',
            '    background:#111;color:#ccc;border:2px solid #555;',
            '    padding:6px 9px;font-size:10px;font-family:monospace;',
            '    cursor:pointer;touch-action:manipulation;white-space:nowrap;',
            '    -webkit-tap-highlight-color:transparent;min-height:32px;',
            '    border-radius:3px;line-height:1;',
            '}',
            '.gm-btn:active  { background:#2a2a2a; }',
            '.gm-btn:disabled { opacity:0.35;cursor:default; }',
            /* Active/on state (green accent, matching MMM style) */
            '.gm-btn-active.gm-btn-active {',
            '    background:#0a3 !important;border-color:#0f0 !important;',
            '    color:#0f0 !important;',
            '}',

            /* ── Floating selection panel — 2-column grid ── */
            '#gm-panel {',
            '    position:fixed;',
            '    bottom:10px;left:50%;transform:translateX(-50%);',
            '    z-index:9998;',
            '    display:none;',
            '    grid-template-columns:1fr 1fr;',
            '    gap:5px;padding:8px 10px;',
            '    background:rgba(8,8,8,0.93);border:2px solid #444;',
            '    border-radius:8px;max-width:min(96vw,320px);width:260px;',
            '    box-sizing:border-box;pointer-events:all;',
            '    user-select:none;-webkit-user-select:none;',
            '}',
            /* Count label spans both columns */
            '#gm-count {',
            '    grid-column:1 / -1;text-align:center;font-size:10px;',
            '    color:#888;font-family:monospace;margin-bottom:2px;',
            '}',

            /* ── Inspector popup ── */
            '#gm-popup {',
            '    position:fixed;top:50%;left:50%;',
            '    transform:translate(-50%,-50%);',
            '    z-index:10000;',
            '    background:#1a1a1a;border:2px solid #666;',
            '    border-radius:10px;padding:18px 18px 14px;',
            '    min-width:240px;max-width:90vw;',
            '    display:none;flex-direction:column;gap:10px;',
            '    font-family:monospace;color:#ccc;font-size:13px;',
            '    box-shadow:0 6px 30px rgba(0,0,0,0.85);',
            '    pointer-events:all;',
            '}',
            '#gm-popup-header {',
            '    font-size:15px;font-weight:bold;color:#fff;',
            '    border-bottom:1px solid #444;padding-bottom:9px;',
            '    padding-right:24px;',
            '}',
            '#gm-popup-close {',
            '    position:absolute;top:10px;right:12px;',
            '    background:none;border:none;color:#888;',
            '    font-size:20px;cursor:pointer;',
            '    padding:2px 6px;touch-action:manipulation;',
            '    -webkit-tap-highlight-color:transparent;',
            '}',
            '#gm-popup-close:active { color:#fff; }',
            '#gm-popup-colorrow {',
            '    display:flex;align-items:center;gap:8px;',
            '}',
            '#gm-popup-colorpicker {',
            '    width:40px;height:30px;padding:0;border:2px solid #555;',
            '    border-radius:3px;cursor:pointer;background:none;',
            '    touch-action:manipulation;',
            '}',
            '#gm-popup-actions { display:flex;gap:8px;flex-wrap:wrap;margin-top:4px; }',
        ].join('\n');
        document.head.appendChild(style);

        // ── Invisible wrapper so we can later check "already built" ─
        var container = document.createElement('div');
        container.id  = 'gm-container';
        container.style.display = 'none';
        document.body.appendChild(container);

        // ── Main toolbar toggle button ───────────────────────────
        var toggleBtn = document.createElement('button');
        toggleBtn.id          = 'gm-toggle';
        toggleBtn.className   = 'gm-btn';
        toggleBtn.textContent = '📐 Groups';
        toggleBtn.title       = 'Grouping Manager — toggle selection mode';
        toggleBtn.addEventListener('pointerdown', function (e) {
            e.preventDefault(); e.stopPropagation();
            gmToggleSelectionMode();
        });

        var toolbar = gmFindToolbar();
        if (toolbar) {
            toolbar.appendChild(toggleBtn);
        } else {
            // Fallback: absolute-position inside the canvas wrapper.
            var canvasDiv = document.getElementById('canvasDiv');
            if (canvasDiv) {
                toggleBtn.style.cssText +=
                    'position:absolute;top:5px;left:50%;' +
                    'transform:translateX(-50%);z-index:9997;';
                canvasDiv.appendChild(toggleBtn);
            } else {
                document.body.appendChild(toggleBtn);
            }
        }

        // ── Floating selection panel ─────────────────────────────
        var panel = document.createElement('div');
        panel.id  = 'gm-panel';

        // Pixel count label
        var countEl = document.createElement('div');
        countEl.id  = 'gm-count';
        countEl.textContent = '0 pixels selected';
        panel.appendChild(countEl);

        // Helper — create a labelled panel button.
        function mkBtn(id, label, title, onClick) {
            var b       = document.createElement('button');
            b.id        = id;
            b.className = 'gm-btn';
            b.textContent = label;
            b.title     = title;
            b.addEventListener('pointerdown', function (e) {
                e.preventDefault(); e.stopPropagation();
                onClick(b);
            });
            return b;
        }

        // [↩ Undo]
        var undoBtn = mkBtn('gm-undo-btn', '↩ Undo', 'Undo last selection change', function () {
            gmUndo();
        });
        undoBtn.disabled = true;
        panel.appendChild(undoBtn);

        // [↪ Redo]
        var redoBtn = mkBtn('gm-redo-btn', '↪ Redo', 'Redo selection change', function () {
            gmRedo();
        });
        redoBtn.disabled = true;
        panel.appendChild(redoBtn);

        // [✖ Clear]
        panel.appendChild(mkBtn('gm-clear-btn', '✖ Clear', 'Clear the current selection', function () {
            gmClearSelection();
        }));

        // [🔗 Group]
        panel.appendChild(mkBtn('gm-group-btn', '🔗 Group', 'Assign all selected pixels to a new group', function () {
            gmCreateGroup();
        }));

        // [🔍 Inspect]  — toggle: long-press reveals group info popup
        panel.appendChild(mkBtn('gm-inspect-btn', '🔍 Inspect',
            'Toggle: long-press any pixel to inspect its group', function (btn) {
            gm.inspectMode = !gm.inspectMode;
            btn.classList.toggle('gm-btn-active', gm.inspectMode);
        }));

        // [🎨 Colors]  — toggle: colour-code every existing group
        panel.appendChild(mkBtn('gm-color-btn', '🎨 Colors',
            'Toggle semi-transparent group colour overlays', function (btn) {
            gm.colorGroups = !gm.colorGroups;
            btn.classList.toggle('gm-btn-active', gm.colorGroups);
        }));

        // [✕ Exit]  — close selection mode (also available via main toggle)
        panel.appendChild(mkBtn('gm-exit-btn', '✕ Exit', 'Exit selection mode', function () {
            gmExitSelectionMode();
        }));

        document.body.appendChild(panel);

        // ── Inspector popup ──────────────────────────────────────
        var popup = document.createElement('div');
        popup.id  = 'gm-popup';

        // X close button (top-right corner)
        var closeBtn = document.createElement('button');
        closeBtn.id  = 'gm-popup-close';
        closeBtn.textContent = '✕';
        closeBtn.title = 'Close';
        closeBtn.addEventListener('pointerdown', function (e) {
            e.preventDefault(); e.stopPropagation();
            gmHidePopup();
        });
        popup.appendChild(closeBtn);

        // Header
        var hdr = document.createElement('div');
        hdr.id  = 'gm-popup-header';
        hdr.textContent = 'Group Inspector';
        popup.appendChild(hdr);

        // Info rows — populated dynamically in gmShowInspector()
        ['gm-popup-gid', 'gm-popup-count', 'gm-popup-name'].forEach(function (id) {
            var el = document.createElement('div');
            el.id  = id;
            popup.appendChild(el);
        });

        // ── Flash colour row ─────────────────────────────────────
        var colorRow   = document.createElement('div');
        colorRow.id    = 'gm-popup-colorrow';

        var colorLabel = document.createElement('span');
        colorLabel.textContent = 'Flash colour:';
        colorRow.appendChild(colorLabel);

        var colorPicker = document.createElement('input');
        colorPicker.id   = 'gm-popup-colorpicker';
        colorPicker.type = 'color';
        colorPicker.value = GM_FLASH_DEFAULT;
        colorPicker.title = 'Choose flash colour for this group';
        colorPicker.addEventListener('input', function () {
            var pop = document.getElementById('gm-popup');
            if (!pop) return;
            var gid = parseInt(pop.dataset.gid, 10);
            if (!isNaN(gid)) gmUpdateFlashColor(gid, colorPicker.value);
        });
        // Prevent picker interactions from leaking to the canvas.
        colorPicker.addEventListener('pointerdown', function (e) { e.stopPropagation(); });
        colorRow.appendChild(colorPicker);
        popup.appendChild(colorRow);

        // Action buttons
        var actions = document.createElement('div');
        actions.id  = 'gm-popup-actions';

        // [🔦 Flash] — toggle flash for the inspected group.
        var flashBtn = document.createElement('button');
        flashBtn.id          = 'gm-popup-flashbtn';
        flashBtn.className   = 'gm-btn';
        flashBtn.textContent = '🔦 Flash';
        flashBtn.title       = 'Toggle blinking overlay for this group';
        flashBtn.addEventListener('pointerdown', function (e) {
            e.preventDefault(); e.stopPropagation();
            var pop = document.getElementById('gm-popup');
            if (!pop) return;
            var gid = parseInt(pop.dataset.gid, 10);
            if (isNaN(gid)) return;
            // Sync colour picker value into relations before toggling.
            var cp = document.getElementById('gm-popup-colorpicker');
            if (cp) gmUpdateFlashColor(gid, cp.value);
            gmToggleGroupFlash(gid);
            var isNowFlashing = gm_flashGroups.has(gid);
            flashBtn.textContent = isNowFlashing ? '🔦 Stop Flash' : '🔦 Flash';
            flashBtn.classList.toggle('gm-btn-active', isNowFlashing);
        });
        actions.appendChild(flashBtn);

        var renameBtn = document.createElement('button');
        renameBtn.className   = 'gm-btn';
        renameBtn.textContent = '✏️ Rename';
        renameBtn.title       = 'Assign a custom name to this group';
        renameBtn.addEventListener('pointerdown', function (e) {
            e.preventDefault(); e.stopPropagation();
            gmRenameGroup();
        });
        actions.appendChild(renameBtn);

        var closeBtn2 = document.createElement('button');
        closeBtn2.className   = 'gm-btn';
        closeBtn2.textContent = 'Close';
        closeBtn2.addEventListener('pointerdown', function (e) {
            e.preventDefault(); e.stopPropagation();
            gmHidePopup();
        });
        actions.appendChild(closeBtn2);

        popup.appendChild(actions);

        // Prevent taps inside the popup from bubbling to the canvas.
        popup.addEventListener('pointerdown', function (e) { e.stopPropagation(); });

        document.body.appendChild(popup);
    }


    // ────────────────────────────────────────────────────────────────
    //  INIT  — poll until the game's core globals are ready, then wire
    //  everything up in one shot.
    // ────────────────────────────────────────────────────────────────

    (function waitForGame() {
        if (
            typeof renderPostPixel !== 'undefined' &&
            typeof currentPixels   !== 'undefined' &&
            document.getElementById('canvasDiv')
        ) {
            // Register our render hook into the game's render pipeline.
            renderPostPixel(gmRenderAll);

            // Build the DOM and attach canvas listeners.
            buildUI();
            installCanvasListeners();

            console.log('[GM] Grouping Manager v1.1 ready.');
        } else {
            setTimeout(waitForGame, 200);
        }
    }());

}());
