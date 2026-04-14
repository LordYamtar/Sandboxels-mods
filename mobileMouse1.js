// ================================================================
//  MOBILE MOUSE MOD (MMM) — Sandboxels Mod
//  Version 1.1
//
//  Adds a "Lock Placer" mode for mobile touch screens.
//  When active, the placement cursor is frozen in place and
//  four directional buttons + a Place button allow precise,
//  single-pixel element placement without finger obstruction.
//
//  COMPATIBLE WITH: zoom.js, worldEdit.js, portal-channel-manager3.js
//
//  HOW TO USE:
//  1. Tap "Lock Placer" — the cursor freezes at its current position.
//  2. Use the arrow buttons to move the locked cursor one pixel at a time.
//  3. Tap "Place" to place the selected element at the locked position.
//  4. Tap "Locked" again to return to normal behaviour.
// ================================================================

(function () {
    'use strict';


    // ────────────────────────────────────────────────────────────────────────────
    //  STATE
    // ────────────────────────────────────────────────────────────────────────────

    var mmm_locked = false;
    var mmm_x = 0;
    var mmm_y = 0;

    // Holds whatever getMousePos was before we wrapped it.
    var _realGetMousePos = window.getMousePos || function () { return { x: 0, y: 0 }; };


    // ────────────────────────────────────────────────────────────────────────────
    //  WRAPPER FUNCTION
    //
    //  Replaces the game's getMousePos.
    //  When locked  → always returns the frozen coordinates.
    //  When unlocked → delegates to the real function and records the result
    //                  so the lock always starts from the last cursor position.
    // ────────────────────────────────────────────────────────────────────────────

    function mmmGetMousePos(cvs, evt) {
        if (mmm_locked) {
            return { x: mmm_x, y: mmm_y };
        }
        var pos = _realGetMousePos(cvs, evt);
        mmm_x = pos.x;
        mmm_y = pos.y;
        return pos;
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  ASSIGNMENT-BASED RE-WRAP
    //
    //  Used when Object.defineProperty is not available.
    //  Re-wraps window.getMousePos if another mod has replaced it since the
    //  last check.
    // ────────────────────────────────────────────────────────────────────────────

    function applyWrapper() {
        if (window.getMousePos !== mmmGetMousePos) {
            _realGetMousePos = window.getMousePos || _realGetMousePos;
            window.getMousePos = mmmGetMousePos;
        }
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  INTERCEPT window.getMousePos
    //
    //  Strategy A — Object.defineProperty:
    //    Turns the property into an accessor so any future write (e.g. zoom.js)
    //    goes through our setter.  Load-order independent; no polling needed.
    //    Fails with TypeError when the game declares getMousePos as a top-level
    //    function (browsers mark such properties configurable:false).
    //
    //  Strategy B — Assignment + polling (automatic fallback):
    //    Sets window.getMousePos = mmmGetMousePos directly, then re-applies at
    //    500 ms, 1 500 ms, and every 2 000 ms to survive zoom.js overwriting it.
    // ────────────────────────────────────────────────────────────────────────────

    try {
        Object.defineProperty(window, 'getMousePos', {
            configurable: true,
            enumerable:   true,
            get: function () { return mmmGetMousePos; },
            set: function (fn) { _realGetMousePos = fn; }
        });
    } catch (err) {
        applyWrapper();
        setTimeout(applyWrapper, 500);
        setTimeout(applyWrapper, 1500);
        setInterval(applyWrapper, 2000);
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  CANVAS TOUCH BLOCKER
    //
    //  Registered with capture:true so it fires before the game's listeners.
    //  stopImmediatePropagation() prevents touchstart / touchmove from reaching
    //  the game while locked, so stray finger contact does nothing.
    //  WorldEdit's w_select tool is excluded to preserve selection-drag logic.
    // ────────────────────────────────────────────────────────────────────────────

    function installTouchBlocker() {
        var gameCanvas = document.getElementById('game');
        if (!gameCanvas) {
            console.warn('[MMM] #game canvas not found — touch blocker not installed.');
            return;
        }

        function shouldBlock() {
            if (!mmm_locked) { return false; }
            if (typeof currentElement !== 'undefined' && currentElement === 'w_select') { return false; }
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

        var toggle = document.getElementById('mmm-toggle');
        var panel  = document.getElementById('mmm-panel');
        if (!toggle || !panel) { return; }

        if (mmm_locked) {
            // Sync the game's own cursor globals so the cursor overlay renders at
            // the locked position and the first Place press draws no stray line.
            if (typeof mousePos !== 'undefined') { mousePos = { x: mmm_x, y: mmm_y }; }
            if (typeof lastPos  !== 'undefined') { lastPos  = { x: mmm_x, y: mmm_y }; }
            toggle.textContent = '\uD83D\uDD12 Locked';
            toggle.classList.add('mmm-active');
            panel.classList.add('mmm-visible');
        } else {
            toggle.textContent = '\uD83D\uDD13 Lock Placer';
            toggle.classList.remove('mmm-active');
            panel.classList.remove('mmm-visible');
        }

        updateCoords();
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  MOVE PLACER
    // ────────────────────────────────────────────────────────────────────────────

    function movePlacer(dx, dy) {
        if (!mmm_locked) { return; }
        var maxW = (typeof width  !== 'undefined') ? width  : 200;
        var maxH = (typeof height !== 'undefined') ? height : 200;
        mmm_x = Math.max(0, Math.min(maxW, mmm_x + dx));
        mmm_y = Math.max(0, Math.min(maxH, mmm_y + dy));
        // Write directly to the game's globals so the cursor square redraws
        // at the new position on the very next frame without any event dispatch.
        if (typeof mousePos !== 'undefined') { mousePos = { x: mmm_x, y: mmm_y }; }
        if (typeof lastPos  !== 'undefined') { lastPos  = { x: mmm_x, y: mmm_y }; }
        updateCoords();
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  PLACE ELEMENT
    //
    //  Dispatches a synthetic mousedown → mouseup on #game.
    //  Because mmmGetMousePos is active, the game reads mmm_x / mmm_y
    //  regardless of the event's clientX / clientY.
    //  bubbles:true ensures the mouseup propagates to window, where the game
    //  registered its mouseUp handler.
    // ────────────────────────────────────────────────────────────────────────────

    function placeElement() {
        if (!mmm_locked) { return; }
        if (typeof currentElement !== 'undefined' && currentElement === 'w_select') { return; }

        var gameCanvas = document.getElementById('game');
        if (!gameCanvas) { return; }

        var rect = gameCanvas.getBoundingClientRect();
        var cx   = rect.left + rect.width  / 2;
        var cy   = rect.top  + rect.height / 2;
        var base = { bubbles: true, cancelable: true, clientX: cx, clientY: cy, button: 0 };

        gameCanvas.dispatchEvent(new MouseEvent('mousedown', Object.assign({ buttons: 1 }, base)));
        setTimeout(function () {
            gameCanvas.dispatchEvent(new MouseEvent('mouseup', Object.assign({ buttons: 0 }, base)));
        }, 30);
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  COORDINATE DISPLAY
    // ────────────────────────────────────────────────────────────────────────────

    function updateCoords() {
        var el = document.getElementById('mmm-coords');
        if (el) { el.textContent = 'x:' + mmm_x + '  y:' + mmm_y; }
    }


    // ────────────────────────────────────────────────────────────────────────────
    //  BUILD UI
    // ────────────────────────────────────────────────────────────────────────────

    function buildUI() {
        if (document.getElementById('mmm-container')) { return; } // already built

        var canvasDiv = document.getElementById('canvasDiv');
        if (!canvasDiv) { return; }

        // ── Styles ──────────────────────────────────────────────────────────────
        var style = document.createElement('style');
        style.textContent = [
            '#mmm-container {',
            '    position: absolute;',
            '    bottom: 5px;',
            '    left: 5px;',
            '    z-index: 9999;',
            '    display: flex;',
            '    flex-direction: column;',
            '    align-items: center;',
            '    gap: 3px;',
            '    pointer-events: all;',
            '    -webkit-user-select: none;',
            '    user-select: none;',
            '}',
            '#mmm-toggle {',
            '    background: #111;',
            '    color: #ccc;',
            '    border: 2px solid #555;',
            '    padding: 6px 14px;',
            '    font-size: 13px;',
            '    font-family: monospace;',
            '    cursor: pointer;',
            '    touch-action: manipulation;',
            '    white-space: nowrap;',
            '    -webkit-tap-highlight-color: transparent;',
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
            '#mmm-panel.mmm-visible { display: flex; }',
            '#mmm-coords {',
            '    font-size: 11px;',
            '    color: #aaa;',
            '    font-family: monospace;',
            '    letter-spacing: 1px;',
            '}',
            '#mmm-dpad {',
            '    display: grid;',
            '    grid-template-columns: repeat(3, 46px);',
            '    grid-template-rows: repeat(3, 46px);',
            '    gap: 2px;',
            '}',
            '.mmm-dir {',
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
            '.mmm-dir:active { background: #333; }',
            '#mmm-place {',
            '    width: 140px;',
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
        var container = document.createElement('div');
        container.id = 'mmm-container';

        // ── Toggle button ───────────────────────────────────────────────────────
        var toggle = document.createElement('button');
        toggle.id = 'mmm-toggle';
        toggle.textContent = '\uD83D\uDD13 Lock Placer';
        toggle.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            toggleLock();
        });
        container.appendChild(toggle);

        // ── Panel ───────────────────────────────────────────────────────────────
        var panel = document.createElement('div');
        panel.id = 'mmm-panel';

        var coords = document.createElement('div');
        coords.id = 'mmm-coords';
        coords.textContent = 'x:0  y:0';
        panel.appendChild(coords);

        var dpad = document.createElement('div');
        dpad.id = 'mmm-dpad';

        function makeDir(label, col, row, dx, dy) {
            var btn = document.createElement('button');
            btn.className = 'mmm-dir';
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

        dpad.appendChild(makeDir('\u2191', 2, 1,  0, -1));   // ↑
        dpad.appendChild(makeDir('\u2190', 1, 2, -1,  0));   // ←
        dpad.appendChild(makeDir('\u2193', 2, 3,  0,  1));   // ↓
        dpad.appendChild(makeDir('\u2192', 3, 2,  1,  0));   // →
        panel.appendChild(dpad);

        var placeBtn = document.createElement('button');
        placeBtn.id = 'mmm-place';
        placeBtn.textContent = '\u25B6 Place';
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
    //  INIT
    //
    //  Polls every 100 ms until #canvasDiv is present, then builds the UI.
    //  Robust against runAfterLoadList having been flushed before this script ran.
    // ────────────────────────────────────────────────────────────────────────────

    (function waitForCanvas() {
        if (document.getElementById('canvasDiv')) {
            buildUI();
            installTouchBlocker();
        } else {
            setTimeout(waitForCanvas, 100);
        }
    }());

}());
