// ================================================================
//  MOBILE MOUSE MOD (MMM) — Sandboxels Mod
//  Version 1.0
//
//  Adds a "Lock Placer" mode for mobile touch screens.
//  When active, the placement cursor is frozen in place and
//  four directional buttons + a Place button allow precise,
//  single-pixel element placement without finger obstruction.
//
//  COMPATIBLE WITH: zoom.js, worldEdit.js, portal-channel-manager3.js
//
//  HOW TO INSTALL:
//  Host this file and paste its URL into the Mods panel in Sandboxels.
//
//  HOW TO USE:
//  1. Tap "🔓 Lock Placer" — the cursor freezes at its current position.
//  2. Use ↑ ↓ ← → to move the locked cursor one pixel at a time.
//  3. Tap "▶ Place" to place the selected element at the locked position.
//  4. Tap "🔒 Locked" again to unlock and return to normal behaviour.
// ================================================================

(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────────────────
    //  STATE
    // ────────────────────────────────────────────────────────────────────────────

    let mmm_locked = false;
    let mmm_x = 0;   // locked cursor position in game-space pixels
    let mmm_y = 0;

    // Holds the "real" getMousePos — either the game's original or zoom.js's
    // replacement. Updated by our property-descriptor setter whenever any mod
    // (including zoom.js) writes to window.getMousePos.
    let _realGetMousePos = window.getMousePos || function () { return { x: 0, y: 0 }; };


    // ────────────────────────────────────────────────────────────────────────────
    //  INTERCEPT window.getMousePos  (load-order independent)
    //
    //  By using Object.defineProperty we convert window.getMousePos from a plain
    //  data property into an accessor.  Any future assignment — including
    //  zoom.js's `window.getMousePos = …` inside runAfterLoad — will call our
    //  setter, so we always wrap the most up-to-date version regardless of which
    //  mod loads first.
    // ────────────────────────────────────────────────────────────────────────────

    Object.defineProperty(window, 'getMousePos', {
        configurable: true,
        enumerable:   true,

        get() {
            return function (cvs, evt) {
                if (mmm_locked) {
                    // Return locked position; ignore where the finger actually is.
                    return { x: mmm_x, y: mmm_y };
                }
                // Delegate to the real function and track position so that
                // when the user activates the lock, it starts from here.
                const pos = _realGetMousePos(cvs, evt);
                mmm_x = pos.x;
                mmm_y = pos.y;
                return pos;
            };
        },

        set(fn) {
            // zoom.js (or anything else) wrote a new implementation — store it.
            _realGetMousePos = fn;
        }
    });


    // ────────────────────────────────────────────────────────────────────────────
    //  CANVAS TOUCH BLOCKER
    //
    //  Installed with capture:true so our listener runs before the game's own
    //  listeners.  stopImmediatePropagation() prevents the game's touchstart /
    //  touchmove handlers from firing at all, so a stray finger on the canvas
    //  cannot accidentally trigger placement while locked.
    //
    //  WorldEdit's w_select tool is excluded — WorldEdit reads screen coordinates
    //  via its own helper and must continue receiving touch events for selection
    //  dragging.
    // ────────────────────────────────────────────────────────────────────────────

    function installTouchBlocker() {
        const gameCanvas = document.getElementById('game');
        if (!gameCanvas) {
            console.warn('[MMM] Could not find #game canvas — touch blocker not installed.');
            return;
        }

        function shouldBlock() {
            if (!mmm_locked) return false;
            // Let WorldEdit handle its own canvas touches.
            if (typeof currentElement !== 'undefined' && currentElement === 'w_select') return false;
            return true;
        }

        ['touchstart', 'touchmove'].forEach(function (type) {
            gameCanvas.addEventListener(type, function (e) {
                if (shouldBlock()) {
                    e.stopImmediatePropagation();
                    e.preventDefault();
                }
            }, { capture: true, passive: false });
        });
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  LOCK TOGGLE
    // ────────────────────────────────────────────────────────────────────────────

    function toggleLock() {
        mmm_locked = !mmm_locked;

        const toggle = document.getElementById('mmm-toggle');
        const panel  = document.getElementById('mmm-panel');
        if (!toggle || !panel) return;

        if (mmm_locked) {
            // Sync the game's own cursor variables to the locked position so the
            // cursor overlay renders correctly and the first Place press does not
            // accidentally draw a line from a distant previous position.
            if (typeof mousePos  !== 'undefined') { mousePos  = { x: mmm_x, y: mmm_y }; }
            if (typeof lastPos   !== 'undefined') { lastPos   = { x: mmm_x, y: mmm_y }; }

            toggle.textContent = '🔒 Locked';
            toggle.classList.add('mmm-active');
            panel.classList.add('mmm-visible');
        } else {
            toggle.textContent = '🔓 Lock Placer';
            toggle.classList.remove('mmm-active');
            panel.classList.remove('mmm-visible');
        }

        updateCoords();
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  MOVE PLACER
    //
    //  Shifts the locked cursor by (dx, dy) game pixels and immediately updates
    //  the game's global mousePos so the cursor square renders at the new
    //  position on the next frame — no synthetic event required.
    // ────────────────────────────────────────────────────────────────────────────

    function movePlacer(dx, dy) {
        if (!mmm_locked) return;

        const maxW = (typeof width  !== 'undefined') ? width  : 200;
        const maxH = (typeof height !== 'undefined') ? height : 200;

        mmm_x = Math.max(0, Math.min(maxW, mmm_x + dx));
        mmm_y = Math.max(0, Math.min(maxH, mmm_y + dy));

        // Keep game cursor in sync.
        if (typeof mousePos !== 'undefined') { mousePos = { x: mmm_x, y: mmm_y }; }
        if (typeof lastPos  !== 'undefined') { lastPos  = { x: mmm_x, y: mmm_y }; }

        updateCoords();
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  PLACE ELEMENT
    //
    //  Simulates a single brief left-click at the locked position.
    //  Because getMousePos is wrapped, the game reads mmm_x / mmm_y regardless
    //  of the synthetic event's clientX / clientY values.
    //
    //  The game listens for mousedown on #game and mouseup on window (line 20444
    //  and 20454 in extracted.js), so we dispatch to both accordingly.
    // ────────────────────────────────────────────────────────────────────────────

    function placeElement() {
        if (!mmm_locked) return;
        // WorldEdit selection: don't interfere.
        if (typeof currentElement !== 'undefined' && currentElement === 'w_select') return;

        const gameCanvas = document.getElementById('game');
        if (!gameCanvas) return;

        const rect = gameCanvas.getBoundingClientRect();
        // We use the canvas centre as clientX/Y — getMousePos overrides this anyway.
        const cx = rect.left + rect.width  / 2;
        const cy = rect.top  + rect.height / 2;

        const commonOpts = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };

        gameCanvas.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, commonOpts)));

        setTimeout(function () {
            // mouseup must reach window (where the game registered its listener).
            // Dispatching on gameCanvas with bubbles:true propagates it there.
            gameCanvas.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0 }, commonOpts)));
        }, 30);
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  COORDINATE DISPLAY
    // ────────────────────────────────────────────────────────────────────────────

    function updateCoords() {
        const el = document.getElementById('mmm-coords');
        if (el) el.textContent = 'x:' + mmm_x + '  y:' + mmm_y;
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  BUILD UI
    // ────────────────────────────────────────────────────────────────────────────

    function buildUI() {
        const canvasDiv = document.getElementById('canvasDiv');
        if (!canvasDiv) {
            console.warn('[MMM] #canvasDiv not found — UI not built.');
            return;
        }

        // ── Styles ──────────────────────────────────────────────────────────────
        const style = document.createElement('style');
        style.textContent = [
            '#mmm-container {',
            '    position: absolute;',
            '    bottom: 5px;',
            '    left: 5px;',
            '    z-index: 1000;',
            '    display: flex;',
            '    flex-direction: column;',
            '    align-items: center;',
            '    gap: 3px;',
            '    -webkit-user-select: none;',
            '    user-select: none;',
            '}',

            '#mmm-toggle {',
            '    background: #111;',
            '    color: #ccc;',
            '    border: 2px solid #555;',
            '    padding: 5px 12px;',
            '    font-size: 13px;',
            '    font-family: monospace;',
            '    cursor: pointer;',
            '    touch-action: manipulation;',
            '    white-space: nowrap;',
            '}',
            '#mmm-toggle.mmm-active {',
            '    background: #0a3;',
            '    border-color: #0f0;',
            '    color: #0f0;',
            '}',

            '#mmm-panel {',
            '    display: none;',
            '    flex-direction: column;',
            '    align-items: center;',
            '    gap: 3px;',
            '}',
            '#mmm-panel.mmm-visible {',
            '    display: flex;',
            '}',

            '#mmm-coords {',
            '    font-size: 11px;',
            '    color: #aaa;',
            '    font-family: monospace;',
            '    letter-spacing: 1px;',
            '}',

            '#mmm-dpad {',
            '    display: grid;',
            '    grid-template-columns: repeat(3, 44px);',
            '    grid-template-rows: repeat(3, 44px);',
            '    gap: 2px;',
            '}',

            '.mmm-dir-btn {',
            '    background: #111;',
            '    color: #fff;',
            '    border: 2px solid #555;',
            '    font-size: 22px;',
            '    cursor: pointer;',
            '    touch-action: manipulation;',
            '    display: flex;',
            '    align-items: center;',
            '    justify-content: center;',
            '    -webkit-tap-highlight-color: transparent;',
            '}',
            '.mmm-dir-btn:active { background: #333; }',

            '#mmm-place {',
            '    width: 136px;',
            '    height: 36px;',
            '    background: #003366;',
            '    border: 2px solid #06f;',
            '    color: #8af;',
            '    font-size: 14px;',
            '    font-family: monospace;',
            '    cursor: pointer;',
            '    touch-action: manipulation;',
            '    -webkit-tap-highlight-color: transparent;',
            '}',
            '#mmm-place:active { background: #004488; }',
        ].join('\n');
        document.head.appendChild(style);

        // ── Container ───────────────────────────────────────────────────────────
        const container = document.createElement('div');
        container.id = 'mmm-container';

        // ── Toggle button ───────────────────────────────────────────────────────
        const toggle = document.createElement('button');
        toggle.id = 'mmm-toggle';
        toggle.textContent = '🔓 Lock Placer';
        toggle.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            toggleLock();
        });
        container.appendChild(toggle);

        // ── Collapsible panel ───────────────────────────────────────────────────
        const panel = document.createElement('div');
        panel.id = 'mmm-panel';

        // Coordinate display
        const coords = document.createElement('div');
        coords.id = 'mmm-coords';
        coords.textContent = 'x:0  y:0';
        panel.appendChild(coords);

        // D-pad
        const dpad = document.createElement('div');
        dpad.id = 'mmm-dpad';

        function dirBtn(label, col, row, dx, dy) {
            const btn = document.createElement('button');
            btn.className = 'mmm-dir-btn';
            btn.textContent = label;
            btn.style.gridColumn = String(col);
            btn.style.gridRow    = String(row);
            btn.addEventListener('pointerdown', function (e) {
                e.preventDefault();
                e.stopPropagation();
                movePlacer(dx, dy);
            });
            return btn;
        }

        //  Grid layout:   col 1  col 2  col 3
        //  row 1:                 ↑
        //  row 2:          ←             →
        //  row 3:                 ↓
        dpad.appendChild(dirBtn('↑', 2, 1,  0, -1));
        dpad.appendChild(dirBtn('←', 1, 2, -1,  0));
        dpad.appendChild(dirBtn('↓', 2, 3,  0,  1));
        dpad.appendChild(dirBtn('→', 3, 2,  1,  0));

        panel.appendChild(dpad);

        // Place button
        const placeBtn = document.createElement('button');
        placeBtn.id = 'mmm-place';
        placeBtn.textContent = '▶ Place';
        placeBtn.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            placeElement();
        });
        panel.appendChild(placeBtn);

        container.appendChild(panel);
        canvasDiv.appendChild(container);
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  INIT  — runs after Sandboxels has fully loaded
    // ────────────────────────────────────────────────────────────────────────────

    runAfterLoad(function () {
        buildUI();
        installTouchBlocker();
    });

})();
