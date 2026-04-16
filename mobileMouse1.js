"use strict";
// ================================================================
//  MOBILE MOUSE MOD — Sandboxels Mod
//  Version 1.0  (filename: mobileMouse1.js)
//
//  Adds a "🔒 Lock" button to the game toolbar.
//  When Placing Lock is active:
//    · Touching / dragging on the canvas moves a virtual magenta
//      crosshair cursor WITHOUT placing any elements.
//    · A large "Place" button appears at the top-right of the screen.
//    · Tapping Place places the current element / applies the current
//      tool at the cursor's grid position.
//    · Holding Place while dragging the cursor places continuously
//      (multitouch: one finger drags, another holds Place).
//
//  DESIGN CONTRACT
//  ───────────────
//  · window.mmm_locked  is kept in sync at all times.
//    grouping-manager.js relies on the event-blocking behaviour this
//    flag controls, exactly as documented in that mod's source:
//      "MMM locked  → MMM blocks the touch; GM selection receives nothing."
//      "MMM unlocked → GM intercepts when selection mode is active."
//  · Canvas listeners are registered with capture:true as early as
//    possible so they fire before every other mod's listeners.
//  · zoom.js: mmmToPixel() always delegates to the game's own
//    getMousePos(), which zoom.js replaces with a transform-aware
//    version.  Coordinates are therefore correct at any zoom level.
//  · worldEdit.js / portal-channel-manager3.js: no shared globals,
//    no shared keybinds, no shared DOM IDs.
//  · grouping-manager.js: see window.mmm_locked contract above.
//
//  REMOVING THIS MOD
//  ─────────────────
//  The mod adds no new elements and writes nothing to the save file.
//  Removing it leaves the canvas exactly as-is.
// ================================================================

(function () {
    'use strict';

    // ────────────────────────────────────────────────────────────────
    //  STATE
    // ────────────────────────────────────────────────────────────────

    /** Is Placing Lock currently active? Exposed globally for sibling mods. */
    var mmm_locked = false;
    window.mmm_locked = false;

    /** Is the Place button currently being held down? */
    var mmm_placeBtnHeld = false;

    /** Virtual cursor position in pixel-grid coordinates. */
    var mmm_cursor = { x: 0, y: 0 };


    // ────────────────────────────────────────────────────────────────
    //  COORDINATE CONVERSION
    //
    //  Always delegates to the game's own getMousePos() so that
    //  zoom.js's transform-aware override is picked up automatically.
    //  The fake event object has no .touches property, so both the
    //  vanilla and zoom.js versions skip the touch branch and use
    //  .clientX / .clientY directly.
    // ────────────────────────────────────────────────────────────────

    function mmmToPixel(clientX, clientY) {
        var cvs = (typeof canvas !== 'undefined') ? canvas
                : document.getElementById('game');
        if (!cvs) return { x: 0, y: 0 };
        return getMousePos(cvs, { clientX: clientX, clientY: clientY });
    }


    // ────────────────────────────────────────────────────────────────
    //  PLACE ACTION
    //
    //  Calls mouse1Action() at the virtual cursor position without any
    //  real pointer event going through the game's normal handlers.
    //  mouseType must be 'left' for the call to behave as a left-click.
    //  Setting lastPos == cursor position makes lineCoords() return a
    //  single-point list (no unintended line-draw artefacts).
    // ────────────────────────────────────────────────────────────────

    function mmmDoPlace() {
        if (!mmm_locked) return;
        var x = mmm_cursor.x;
        var y = mmm_cursor.y;

        var savedType   = (typeof mouseType    !== 'undefined') ? mouseType    : null;
        var savedIsDown = (typeof mouseIsDown  !== 'undefined') ? mouseIsDown  : false;
        var savedLast   = (typeof lastPos      !== 'undefined') ? lastPos      : { x: x, y: y };

        mouseType   = 'left';
        mouseIsDown = false;       // prevent accidental drag-place state
        lastPos     = { x: x, y: y };

        mouse1Action(null, x, y);

        // Restore game state so nothing is left in an inconsistent state
        mouseType   = savedType;
        mouseIsDown = savedIsDown;
        lastPos     = savedLast;
    }


    // ────────────────────────────────────────────────────────────────
    //  CANVAS EVENT INTERCEPTORS
    //
    //  All listeners use { capture: true, passive: false } so they:
    //    1. Fire during the capture phase, before the game's bubble
    //       listeners (mousedown, touchstart on the canvas).
    //    2. Fire before grouping-manager.js's listeners, which are
    //       registered after this mod loads.
    //    3. Can call preventDefault() to suppress default behaviour.
    //
    //  When mmm_locked is false every handler returns immediately, so
    //  the game and all other mods behave exactly as if this mod were
    //  not installed.
    // ────────────────────────────────────────────────────────────────

    function mmmOnPointerDown(e) {
        if (!mmm_locked) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        var pos = mmmToPixel(e.clientX, e.clientY);
        mmm_cursor.x = pos.x;
        mmm_cursor.y = pos.y;
        mousePos     = { x: pos.x, y: pos.y };
    }

    function mmmOnPointerMove(e) {
        if (!mmm_locked) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        var pos = mmmToPixel(e.clientX, e.clientY);
        mmm_cursor.x = pos.x;
        mmm_cursor.y = pos.y;
        mousePos     = { x: pos.x, y: pos.y };
        // Continuous placement while Place button is held by another finger
        if (mmm_placeBtnHeld) mmmDoPlace();
    }

    function mmmOnPointerUp(e) {
        if (!mmm_locked) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        mouseIsDown = false;
    }

    // Touch event interceptors (the game registers touchstart / touchmove /
    // touchend directly on the canvas in addition to pointer events).
    function mmmOnTouchStart(e) {
        if (!mmm_locked) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        if (e.touches.length > 0) {
            var t   = e.touches[0];
            var pos = mmmToPixel(t.clientX, t.clientY);
            mmm_cursor.x = pos.x;
            mmm_cursor.y = pos.y;
            mousePos     = { x: pos.x, y: pos.y };
        }
        mouseIsDown = false;
    }

    function mmmOnTouchMove(e) {
        if (!mmm_locked) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        // Use the first touch for the cursor (other touches may be on Place btn)
        if (e.touches.length > 0) {
            var t   = e.touches[0];
            var pos = mmmToPixel(t.clientX, t.clientY);
            mmm_cursor.x = pos.x;
            mmm_cursor.y = pos.y;
            mousePos     = { x: pos.x, y: pos.y };
            if (mmm_placeBtnHeld) mmmDoPlace();
        }
    }

    function mmmOnTouchEnd(e) {
        if (!mmm_locked) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        mouseIsDown = false;
    }

    // Also intercept mousedown (fired on desktop, and sometimes by browsers
    // after a touch sequence completes).
    function mmmOnMouseDown(e) {
        if (!mmm_locked) return;
        e.stopImmediatePropagation();
        e.preventDefault();
        var pos = mmmToPixel(e.clientX, e.clientY);
        mmm_cursor.x = pos.x;
        mmm_cursor.y = pos.y;
        mousePos     = { x: pos.x, y: pos.y };
    }

    function installCanvasListeners() {
        var cvs = (typeof gameCanvas !== 'undefined') ? gameCanvas
                : document.getElementById('game');
        if (!cvs) { setTimeout(installCanvasListeners, 200); return; }

        var cap = { capture: true, passive: false };

        cvs.addEventListener('pointerdown',  mmmOnPointerDown,  cap);
        cvs.addEventListener('pointermove',  mmmOnPointerMove,  cap);
        cvs.addEventListener('pointerup',    mmmOnPointerUp,    cap);
        cvs.addEventListener('pointercancel',mmmOnPointerUp,    cap);
        cvs.addEventListener('mousedown',    mmmOnMouseDown,    cap);
        cvs.addEventListener('touchstart',   mmmOnTouchStart,   cap);
        cvs.addEventListener('touchmove',    mmmOnTouchMove,    cap);
        cvs.addEventListener('touchend',     mmmOnTouchEnd,     cap);
        cvs.addEventListener('touchcancel',  mmmOnTouchEnd,     cap);
    }


    // ────────────────────────────────────────────────────────────────
    //  RENDER HOOK
    //
    //  Draws a magenta crosshair at the virtual cursor when locked.
    //  Registered via renderPostPixel() so it renders on top of all
    //  game pixels and other post-pixel overlays (worldEdit selections,
    //  portal-channel-manager overlays, etc.).
    //
    //  The cursor box mirrors the game's own cursor-box calculation
    //  (see drawCursor() in the base game) scaled by mouseSize.
    // ────────────────────────────────────────────────────────────────

    function mmmRenderCursor(ctx) {
        if (!mmm_locked) return;

        var ps   = (typeof pixelSize  !== 'undefined') ? pixelSize  : 6;
        var size = (typeof mouseSize  !== 'undefined') ? mouseSize  : 5;
        var x    = mmm_cursor.x;
        var y    = mmm_cursor.y;

        // Replicate game cursor box maths
        var off = size / 2;
        var mn  = Math.trunc(off);
        var mx  = mn - (off % 1 ? 0 : 1);
        var bx  = (x - mn) * ps;
        var by  = (y - mn) * ps;
        var bw  = (mx + mn + 1) * ps;

        ctx.save();

        // Outer dashed selection rectangle
        ctx.globalAlpha = 0.9;
        ctx.strokeStyle = '#ff00ff';
        ctx.lineWidth   = 2;
        ctx.setLineDash([ps, ps]);
        ctx.strokeRect(bx, by, bw, bw);
        ctx.setLineDash([]);

        // Centre pixel highlight
        ctx.fillStyle   = 'rgba(255, 0, 255, 0.30)';
        ctx.fillRect(x * ps, y * ps, ps, ps);

        // Crosshair arms (4 pixels out from the centre pixel)
        var cx  = (x + 0.5) * ps;
        var cy  = (y + 0.5) * ps;
        var arm = ps * 4;
        ctx.strokeStyle = 'rgba(255, 0, 255, 0.70)';
        ctx.lineWidth   = 1;
        ctx.beginPath();
        ctx.moveTo(cx - arm, cy);  ctx.lineTo(cx + arm, cy);
        ctx.moveTo(cx,  cy - arm); ctx.lineTo(cx,  cy + arm);
        ctx.stroke();

        ctx.restore();
    }


    // ────────────────────────────────────────────────────────────────
    //  TOGGLE LOCK
    // ────────────────────────────────────────────────────────────────

    function mmmToggleLock() {
        mmm_locked        = !mmm_locked;
        window.mmm_locked = mmm_locked;

        var lockBtn  = document.getElementById('mmm-lock-btn');
        var placeBtn = document.getElementById('mmm-place-btn');

        if (mmm_locked) {
            if (lockBtn)  lockBtn.setAttribute('on', 'true');
            if (placeBtn) placeBtn.style.display = 'flex';

            // Seed the cursor at the game's last known mouse position
            if (typeof mousePos !== 'undefined') {
                mmm_cursor.x = mousePos.x;
                mmm_cursor.y = mousePos.y;
            }

            // Ensure the game is not left thinking a button is held
            mouseIsDown = false;
            if (typeof mouseType !== 'undefined') mouseType = null;

        } else {
            if (lockBtn)  lockBtn.setAttribute('on', 'false');
            if (placeBtn) placeBtn.style.display = 'none';

            mmm_placeBtnHeld = false;
            mouseIsDown      = false;
        }
    }


    // ────────────────────────────────────────────────────────────────
    //  BUILD UI
    // ────────────────────────────────────────────────────────────────

    function buildUI() {

        // ── Styles ───────────────────────────────────────────────────
        var style = document.createElement('style');
        style.textContent = '\n' + [

            /* Lock button — active (on) state */
            '#mmm-lock-btn[on="true"] {',
            '    background:   #2a002a !important;',
            '    border-color: #ff00ff !important;',
            '    color:        #ff00ff !important;',
            '    box-shadow:   0 0 8px rgba(255,0,255,0.45);',
            '}',

            /* Place button — base */
            '#mmm-place-btn {',
            '    position: fixed;',
            '    top:   5px;',
            '    right: 5px;',
            '    z-index: 10001;',
            '    display: none;',          /* shown only when locked */
            '    align-items: center;',
            '    justify-content: center;',
            '    min-width:  72px;',
            '    min-height: 44px;',
            '    padding: 8px 16px;',
            '    background:   #1a001a;',
            '    color:        #ff00ff;',
            '    border:       2px solid #ff00ff;',
            '    border-radius: 8px;',
            '    font-size:    17px;',
            '    font-weight:  bold;',
            '    font-family:  sans-serif;',
            '    cursor: pointer;',
            '    touch-action: manipulation;',
            '    -webkit-tap-highlight-color: transparent;',
            '    user-select: none;',
            '    -webkit-user-select: none;',
            '    box-shadow: 0 2px 16px rgba(255,0,255,0.55);',
            '}',

            /* Place button — held / active state */
            '#mmm-place-btn.mmm-placing {',
            '    background:  #3a003a;',
            '    box-shadow:  0 0 24px rgba(255,0,255,0.85);',
            '}',

        ].join('\n');

        document.head.appendChild(style);

        // ── Lock toggle button in the game toolbar ───────────────────
        //  The game's toolbar is #toolControls (contains Pause, Reset,
        //  Replace, Elem, Edit, etc.).  We append to the end so this
        //  mod's button appears after all vanilla and mod buttons.
        var toolbar = document.getElementById('toolControls');
        if (toolbar) {
            var lockBtn       = document.createElement('button');
            lockBtn.id        = 'mmm-lock-btn';
            lockBtn.className = 'controlButton';
            lockBtn.title     = 'Toggle Placing Lock — drag cursor freely, then press Place';
            lockBtn.setAttribute('on', 'false');
            lockBtn.textContent = '🔒 Lock';

            lockBtn.addEventListener('click', function () {
                mmmToggleLock();
                // Return focus to the canvas so keybinds keep working
                var cvs = document.getElementById('game');
                if (cvs) cvs.focus();
            });

            toolbar.appendChild(lockBtn);
        }

        // ── Floating Place button ────────────────────────────────────
        //  Fixed top-right (above portal-channel-manager's 📡 button
        //  which sits at top:48px;right:5px).  Large touch target.
        //  Uses pointer events for reliable multitouch on mobile.
        var placeBtn = document.createElement('button');
        placeBtn.id  = 'mmm-place-btn';
        placeBtn.textContent = 'Place';
        placeBtn.title = 'Place element at cursor position (hold for continuous)';

        placeBtn.addEventListener('pointerdown', function (e) {
            e.preventDefault();
            e.stopPropagation();
            mmm_placeBtnHeld = true;
            placeBtn.classList.add('mmm-placing');
            mmmDoPlace();   // single place on initial press
        });

        function releasePlaceBtn() {
            mmm_placeBtnHeld = false;
            placeBtn.classList.remove('mmm-placing');
        }

        placeBtn.addEventListener('pointerup',     function (e) { e.preventDefault(); releasePlaceBtn(); });
        placeBtn.addEventListener('pointerleave',  function (e) { releasePlaceBtn(); });
        placeBtn.addEventListener('pointercancel', function (e) { releasePlaceBtn(); });

        // Stop any touch/pointer on the Place button from bleeding
        // through to the canvas underneath.
        placeBtn.addEventListener('touchstart', function (e) { e.stopPropagation(); });
        placeBtn.addEventListener('touchend',   function (e) { e.stopPropagation(); });

        document.body.appendChild(placeBtn);
    }


    // ────────────────────────────────────────────────────────────────
    //  RESET HOOK
    //  Automatically release the lock when the canvas is cleared so
    //  the user is never stuck in lock mode after a Reset.
    // ────────────────────────────────────────────────────────────────

    function hookReset() {
        if (typeof runAfterReset !== 'function') {
            setTimeout(hookReset, 200);
            return;
        }
        runAfterReset(function () {
            if (!mmm_locked) return;
            mmm_locked        = false;
            window.mmm_locked = false;
            mmm_placeBtnHeld  = false;

            var lockBtn  = document.getElementById('mmm-lock-btn');
            var placeBtn = document.getElementById('mmm-place-btn');
            if (lockBtn)  lockBtn.setAttribute('on', 'false');
            if (placeBtn) { placeBtn.style.display = 'none'; placeBtn.classList.remove('mmm-placing'); }
        });
    }


    // ────────────────────────────────────────────────────────────────
    //  INIT
    //  Polls until the game's core globals (renderPostPixel,
    //  mouse1Action, mousePos, the toolbar DOM element) are all ready,
    //  then wires everything up in one shot.
    // ────────────────────────────────────────────────────────────────

    function init() {
        if (
            typeof renderPostPixel === 'undefined' ||
            typeof mouse1Action    === 'undefined' ||
            typeof mousePos        === 'undefined' ||
            typeof lastPos         === 'undefined' ||
            !document.getElementById('toolControls')
        ) {
            setTimeout(init, 200);
            return;
        }

        // Register render hook first so the cursor draws above all other
        // renderPostPixel hooks registered by mods that load after us.
        renderPostPixel(mmmRenderCursor);

        // Build DOM (toolbar button + Place button)
        buildUI();

        // Attach canvas interceptors with capture:true.
        // This must happen BEFORE grouping-manager.js attaches its own
        // capture listener (which happens during that mod's init).
        installCanvasListeners();

        // Seed the virtual cursor at the canvas centre.
        mmm_cursor.x = (typeof width  !== 'undefined') ? Math.round(width  / 2) : 0;
        mmm_cursor.y = (typeof height !== 'undefined') ? Math.round(height / 2) : 0;

        // Attach to the reset hook.
        hookReset();

        console.log('[MMM] Mobile Mouse Mod v1.0 loaded.');
    }

    // Start polling immediately so canvas listeners are registered as
    // early as possible, giving us capture priority over later mods.
    init();

}());
