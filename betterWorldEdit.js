"use strict";
// ================================================================
//  betterWorldEdit.js — Sandboxels Mod
//  Version: 1.0.0
//
//  A complete drop-in replacement for worldEdit.js.
//  Adds a multi-slot clipboard: name, copy, paste, add/remove
//  slots, and export/import of all slots to/from a JSON file.
//
//  COMPATIBLE WITH:
//    zoom.js               — keybinds avoid w/a/s/d
//    mobileMouse1.js       — uses same pointer-event pattern
//    portal-channel-manager3.js — no shared globals
//    grouping-manager.js   — no shared globals
//
//  HOW TO USE:
//    1. Load this mod instead of (or without) worldEdit.js.
//    2. Open the "betterWorldEdit" category (press B or tap it).
//    3. Use Select to draw a selection rectangle.
//    4. Tap CopyTo{N}. to name and store it in slot N.
//    5. Tap Paste{N}.[name] then click the canvas to place it.
//    6. add+1slot / removeLastSlot change the number of slots.
//    7. Export saves all slots to bwe_slots.json.
//    8. Import loads a previously exported file.
//
//  SAVE COMPATIBILITY:
//    Slot data is stored in localStorage under "bwe_multiSlots".
//    It is separate from the game save; removing the mod does not
//    corrupt the canvas or any game file.
// ================================================================

(function () {

    // ────────────────────────────────────────────────────────────
    //  CONSTANTS
    // ────────────────────────────────────────────────────────────

    var BWE_ACCENT       = "#7cff62";
    var BWE_SLOT_FILLED  = "#22cc44";
    var BWE_SLOT_EMPTY   = "#4a4a4a";
    var BWE_CATEGORY     = "betterWorldEdit";
    var BWE_LS_KEY       = "bwe_multiSlots";
    var BWE_MIN_SLOTS    = 1;
    var BWE_MAX_SLOTS    = 20;
    var BWE_DEFAULT_SLOTS = 2;

    var BWE_STYLE = {
        strokeWidth:     1,
        selectFill:      "#57b64530",
        selectStroke:    "#7cff62",
        selectDash:      true,
        pasteFill:       "#00FFFF40",
        pasteStroke:     "#00FFFF",
        pastePixelColor: "#00FFFF44"
    };


    // ────────────────────────────────────────────────────────────
    //  STATE
    // ────────────────────────────────────────────────────────────

    var bwe_slots = [];     // [{name:string, data:Array|null}]
    var bwe_ppc   = {};     // paste-preview OffscreenCanvases, keyed by slot index
    var bwe_state = {
        firstSelectionPos:  { x: 0, y: 0 },
        selection:          null,
        lastNonBweElement:  "unknown"
    };
    var bwe_modalCallback  = null;  // pending name-dialog callback
    var bwe_listenersAdded = false; // pointer-listener guard


    // ────────────────────────────────────────────────────────────
    //  BWERECT  (mirrors worldEdit's Rect class)
    // ────────────────────────────────────────────────────────────

    function BweRect(x, y, w, h) {
        this.x = x; this.y = y; this.w = w; this.h = h;
    }
    BweRect.fromCorners = function (s, e) {
        return new BweRect(s.x, s.y, e.x - s.x, e.y - s.y);
    };
    BweRect.fromCornersXYXY = function (x, y, x2, y2) {
        return new BweRect(x, y, x2 - x, y2 - y);
    };
    Object.defineProperties(BweRect.prototype, {
        area: { get: function () { return this.w * this.h; } },
        x2:   {
            get: function ()  { return this.x + this.w; },
            set: function (v) { this.w = v - this.x; }
        },
        y2:   {
            get: function ()  { return this.y + this.h; },
            set: function (v) { this.h = v - this.y; }
        }
    });
    BweRect.prototype.normalized = function () {
        return BweRect.fromCornersXYXY(
            Math.min(this.x, this.x2), Math.min(this.y, this.y2),
            Math.max(this.x, this.x2), Math.max(this.y, this.y2)
        );
    };


    // ────────────────────────────────────────────────────────────
    //  COORDINATE HELPERS
    // ────────────────────────────────────────────────────────────

    function bweInWorld(p) {
        return p.x >= 0 && p.x <= width && p.y >= 0 && p.y <= height;
    }
    function bweClamp(p) {
        return { x: Math.max(0, Math.min(p.x, width)), y: Math.max(0, Math.min(p.y, height)) };
    }
    // Converts a pointer client position to pixel-grid coordinates.
    // Uses getBoundingClientRect so zoom.js CSS scaling is handled correctly.
    function bweClientToWorld(cx, cy) {
        var r = canvas.getBoundingClientRect();
        return {
            x: Math.floor(((cx - r.left) / canvas.clientWidth)  * (width  + 1)),
            y: Math.floor(((cy - r.top)  / canvas.clientHeight) * (height + 1))
        };
    }
    // Reverse a hex string (needed for OffscreenCanvas buffer encoding)
    function bweRevHex(str) { return str.split("").reverse().join(""); }


    // ────────────────────────────────────────────────────────────
    //  KEY / NAME HELPERS
    // ────────────────────────────────────────────────────────────

    function bweCopyKey(idx)  { return "bwe_slot_copy_"  + (idx + 1); }
    function bwePasteKey(idx) { return "bwe_slot_paste_" + (idx + 1); }

    function bwePasteName(idx) {
        var s = bwe_slots[idx];
        if (s && s.data) return "Paste" + (idx + 1) + ".[" + s.name + "]";
        return "Paste" + (idx + 1) + ".[freeSlot]";
    }

    // True if the element key belongs to this mod (used to track lastNonBweElement)
    function bweIsOwnKey(key) {
        return (key in bwe_coreElements) ||
               (key in bwe_ctrlElements) ||
               /^bwe_slot_(?:copy|paste)_\d+$/.test(key);
    }


    // ────────────────────────────────────────────────────────────
    //  LOCAL STORAGE
    // ────────────────────────────────────────────────────────────

    function bweSave() {
        try {
            localStorage.setItem(BWE_LS_KEY, JSON.stringify(
                bwe_slots.map(function (s) { return { name: s.name, data: s.data }; })
            ));
        } catch (e) { console.warn("[BWE] localStorage write failed:", e); }
    }

    function bweLoadFromStorage() {
        try {
            var raw = localStorage.getItem(BWE_LS_KEY);
            if (!raw) return null;
            var arr = JSON.parse(raw);
            if (!Array.isArray(arr)) return null;
            return arr.map(function (s) {
                return { name: s.name || "Unnamed", data: s.data || null };
            });
        } catch (e) { return null; }
    }


    // ────────────────────────────────────────────────────────────
    //  PASTE-PREVIEW CANVAS
    // ────────────────────────────────────────────────────────────

    function bweRebuildPPC(idx) {
        var s = bwe_slots[idx];
        if (!s || !s.data) { delete bwe_ppc[idx]; return; }
        var cb = s.data, h = cb.length, w = cb[0].length;
        var oc  = new OffscreenCanvas(w, h);
        var ctx = oc.getContext("2d");
        var id  = ctx.createImageData(w, h);
        var buf = new Uint32Array(id.data.buffer);
        buf.fill(0);
        // Reverse the colour bytes to match OffscreenCanvas's ABGR layout
        var col = parseInt(bweRevHex(BWE_STYLE.pastePixelColor.slice(1)), 16);
        for (var y = 0; y < h; y++)
            for (var x = 0; x < w; x++)
                if (cb[y][x]) buf[y * w + x] = col;
        ctx.putImageData(id, 0, 0);
        bwe_ppc[idx] = oc;
    }


    // ────────────────────────────────────────────────────────────
    //  DOM BUTTON HELPERS
    // ────────────────────────────────────────────────────────────

    // Update the Paste button's label and colour after a slot is filled/cleared.
    function bweUpdatePasteBtn(idx) {
        var key = bwePasteKey(idx);
        var btn = document.getElementById("elementButton-" + key);
        var s   = bwe_slots[idx];
        if (!btn || !s) return;
        var nm = bwePasteName(idx);
        btn.innerText = nm;
        btn.style.background = s.data ? BWE_SLOT_FILLED : BWE_SLOT_EMPTY;
        if (elements[key]) {
            elements[key].name  = nm;
            elements[key].color = s.data ? BWE_SLOT_FILLED : BWE_SLOT_EMPTY;
        }
    }

    // Move the four control buttons (add/remove/export/import) to the end of the
    // category div so newly added slot buttons always appear before them.
    function bwePushCtrlsToEnd() {
        var cat = document.getElementById("category-" + BWE_CATEGORY);
        if (!cat) return;
        ["bwe_add_slot", "bwe_remove_slot", "bwe_export", "bwe_import"].forEach(function (k) {
            var b = document.getElementById("elementButton-" + k);
            if (b) cat.appendChild(b);
        });
    }

    // Create a DOM element button for a key already registered in `elements`.
    // Prefers the game's own createElementButton; falls back to a minimal version.
    function bweMakeButton(key) {
        if (typeof createElementButton === "function") {
            createElementButton(key);
            return;
        }
        // Fallback: minimal button that still calls selectElement correctly
        var el  = elements[key];
        var btn = document.createElement("button");
        btn.id        = "elementButton-" + key;
        btn.className = "elementButton";
        btn.innerText = el.name || key;
        btn.style.background = el.color || BWE_ACCENT;
        btn.setAttribute("element", key);
        btn.setAttribute("current", "false");
        btn.onclick = function () {
            var k = this.getAttribute("element");
            if (typeof currentElement !== "undefined" && currentElement === k)
                selectElement("unknown");
            else
                selectElement(k);
        };
        var cat = document.getElementById("category-" + BWE_CATEGORY);
        if (cat) cat.appendChild(btn);
    }


    // ────────────────────────────────────────────────────────────
    //  NAME DIALOG  (mobile-friendly floating modal)
    // ────────────────────────────────────────────────────────────

    function bweBuildModal() {
        if (document.getElementById("bwe-name-modal")) return;

        var overlay = document.createElement("div");
        overlay.id = "bwe-name-modal";
        overlay.style.cssText =
            "display:none;position:fixed;top:0;left:0;width:100%;height:100%;" +
            "background:rgba(0,0,0,0.78);z-index:99999;" +
            "align-items:center;justify-content:center;";

        var box = document.createElement("div");
        box.style.cssText =
            "background:#1c1c1c;border:2px solid " + BWE_ACCENT + ";" +
            "padding:20px 22px;min-width:270px;max-width:90vw;" +
            "font-family:monospace;color:#ddd;font-size:14px;" +
            "display:flex;flex-direction:column;gap:12px;";

        var lbl = document.createElement("div");
        lbl.id = "bwe-modal-lbl";
        lbl.textContent = "Name this copy:";

        var inp = document.createElement("input");
        inp.id = "bwe-modal-inp";
        inp.type = "text";
        inp.placeholder = "e.g. MainTower";
        inp.style.cssText =
            "background:#111;border:1px solid #666;color:#fff;" +
            "padding:7px 9px;font-size:14px;font-family:monospace;" +
            "width:100%;box-sizing:border-box;";

        var row = document.createElement("div");
        row.style.cssText = "display:flex;gap:8px;justify-content:flex-end;";

        var cancelBtn = document.createElement("button");
        cancelBtn.textContent = "Cancel";
        cancelBtn.style.cssText =
            "background:#1c1c1c;border:2px solid #555;color:#888;" +
            "padding:7px 14px;cursor:pointer;font-family:monospace;font-size:13px;" +
            "touch-action:manipulation;-webkit-tap-highlight-color:transparent;";

        var okBtn = document.createElement("button");
        okBtn.textContent = "OK";
        okBtn.style.cssText =
            "background:#0a3;border:2px solid " + BWE_ACCENT + ";color:" + BWE_ACCENT + ";" +
            "padding:7px 18px;cursor:pointer;font-family:monospace;font-size:13px;" +
            "touch-action:manipulation;-webkit-tap-highlight-color:transparent;";

        row.appendChild(cancelBtn);
        row.appendChild(okBtn);
        box.appendChild(lbl);
        box.appendChild(inp);
        box.appendChild(row);
        overlay.appendChild(box);
        document.body.appendChild(overlay);

        function confirm() {
            var val = document.getElementById("bwe-modal-inp").value.trim() || "Unnamed";
            overlay.style.display = "none";
            if (bwe_modalCallback) { bwe_modalCallback(val); bwe_modalCallback = null; }
        }
        function cancel() {
            overlay.style.display = "none";
            bwe_modalCallback = null;
            logMessage("[BWE] Copy cancelled.");
        }

        okBtn.addEventListener("pointerdown", function (e) {
            e.preventDefault(); e.stopPropagation(); confirm();
        });
        cancelBtn.addEventListener("pointerdown", function (e) {
            e.preventDefault(); e.stopPropagation(); cancel();
        });
        // Prevent game keybinds from firing while the user is typing
        inp.addEventListener("keydown", function (e) {
            e.stopPropagation();
            if (e.key === "Enter")  confirm();
            if (e.key === "Escape") cancel();
        });
        // Tap outside the box to cancel
        overlay.addEventListener("pointerdown", function (e) {
            if (e.target === overlay) cancel();
        });
    }

    function bweAskName(idx, cb) {
        bweBuildModal();
        var overlay = document.getElementById("bwe-name-modal");
        var lbl     = document.getElementById("bwe-modal-lbl");
        var inp     = document.getElementById("bwe-modal-inp");
        lbl.textContent = "Name for slot " + (idx + 1) + ":";
        inp.value = (bwe_slots[idx] && bwe_slots[idx].name !== "Unnamed")
            ? bwe_slots[idx].name : "";
        overlay.style.display = "flex";
        bwe_modalCallback = cb;
        setTimeout(function () { inp.focus(); }, 60);
    }


    // ────────────────────────────────────────────────────────────
    //  COPY  (selection → named slot)
    // ────────────────────────────────────────────────────────────

    function bweCopyToSlot(idx) {
        var sel = bwe_state.selection;
        if (!sel) { logMessage("[BWE] Error: Nothing is selected."); return; }
        bweAskName(idx, function (name) {
            var cb = [];
            for (var y = sel.y; y < sel.y2; y++) {
                var row = [];
                for (var x = sel.x; x < sel.x2; x++) {
                    row.push(structuredClone(pixelMap[x][y]));
                }
                cb.push(row);
            }
            bwe_slots[idx].name = name;
            bwe_slots[idx].data = cb;
            bweRebuildPPC(idx);
            bweUpdatePasteBtn(idx);
            bweSave();
            logMessage("[BWE] Slot " + (idx + 1) + " \u201c" + name + "\u201d saved ("
                + sel.w + "\u00d7" + sel.h + "=" + sel.area + " px).");
        });
    }


    // ────────────────────────────────────────────────────────────
    //  PASTE  (slot → canvas at mousePos)
    // ────────────────────────────────────────────────────────────

    function bwePasteSlot(idx) {
        var s = bwe_slots[idx];
        if (!s || !s.data) { logMessage("[BWE] Slot " + (idx + 1) + " is empty."); return; }
        var cb  = s.data;
        var org = mousePos;
        var placed = 0;
        for (var y = 0; y < cb.length; y++) {
            for (var x = 0; x < cb[0].length; x++) {
                var src  = cb[y][x];
                var dest = { x: org.x + x, y: org.y + y };
                if (!bweInWorld(dest) || pixelMap[dest.x][dest.y] || !src) continue;
                var np = structuredClone(src);
                Object.assign(np, dest);
                pixelMap[dest.x][dest.y] = np;
                currentPixels.push(np);
                placed++;
            }
        }
        logMessage("[BWE] Pasted slot " + (idx + 1) + " \u201c" + s.name + "\u201d ("
            + cb[0].length + "\u00d7" + cb.length + ", " + placed + " placed).");
    }


    // ────────────────────────────────────────────────────────────
    //  SLOT ELEMENT FACTORIES
    //  Returns elements[key] objects for one slot's Copy + Paste buttons.
    // ────────────────────────────────────────────────────────────

    function bweCreateSlotElements(idx) {
        // — Copy element —
        elements[bweCopyKey(idx)] = {
            name:     "CopyTo" + (idx + 1) + ".",
            category: BWE_CATEGORY,
            color:    BWE_ACCENT,
            tool:     function () { return null; },
            maxSize:  1,
            // onSelect is wrapped below via bweWrapAutoDeselect
            onSelect: (function (i) {
                return function () { bweCopyToSlot(i); };
            })(idx)
        };

        // — Paste element —
        var s = bwe_slots[idx];
        elements[bwePasteKey(idx)] = {
            name:              bwePasteName(idx),
            category:          BWE_CATEGORY,
            color:             (s && s.data) ? BWE_SLOT_FILLED : BWE_SLOT_EMPTY,
            tool:              function () { return null; },
            maxSize:           1,
            shouldStaySelected: true,
            onSelect: (function (i) {
                return function () {
                    if (!bwe_slots[i] || !bwe_slots[i].data) {
                        logMessage("[BWE] Slot " + (i + 1) + " is empty.");
                        selectElement(bwe_state.lastNonBweElement);
                    }
                };
            })(idx),
            onPointerDown: (function (i) {
                return function (e) {
                    if (showingMenu || e.button === 1 || e.button === 2) return;
                    if (!bweInWorld(mousePos)) return;
                    bwePasteSlot(i);
                };
            })(idx)
        };

        // Wrap the Copy element to auto-deselect after triggering
        bweWrapAutoDeselect(elements[bweCopyKey(idx)]);
    }


    // ────────────────────────────────────────────────────────────
    //  ADD / REMOVE SLOTS
    // ────────────────────────────────────────────────────────────

    function bweAddSlot() {
        if (bwe_slots.length >= BWE_MAX_SLOTS) {
            logMessage("[BWE] Maximum of " + BWE_MAX_SLOTS + " slots reached.");
            return;
        }
        var idx = bwe_slots.length;
        bwe_slots.push({ name: "Unnamed", data: null });
        bweSave();
        bweCreateSlotElements(idx);
        bweMakeButton(bweCopyKey(idx));
        bweMakeButton(bwePasteKey(idx));
        bwePushCtrlsToEnd();
        logMessage("[BWE] Added slot " + (idx + 1) + ". Total: " + bwe_slots.length + ".");
    }

    function bweRemoveLastSlot() {
        if (bwe_slots.length <= BWE_MIN_SLOTS) {
            logMessage("[BWE] Need at least " + BWE_MIN_SLOTS + " slot(s).");
            return;
        }
        var idx = bwe_slots.length - 1;
        var ck  = bweCopyKey(idx);
        var pk  = bwePasteKey(idx);
        // Deselect if the user is currently pasting from this slot
        if (currentElement === pk || currentElement === ck) {
            selectElement(bwe_state.lastNonBweElement);
        }
        bwe_slots.pop();
        bweSave();
        delete bwe_ppc[idx];
        var cb = document.getElementById("elementButton-" + ck);
        var pb = document.getElementById("elementButton-" + pk);
        if (cb) cb.remove();
        if (pb) pb.remove();
        delete elements[ck];
        delete elements[pk];
        logMessage("[BWE] Removed slot " + (idx + 1) + ". Total: " + bwe_slots.length + ".");
    }


    // ────────────────────────────────────────────────────────────
    //  EXPORT / IMPORT
    // ────────────────────────────────────────────────────────────

    function bweExport() {
        var payload = JSON.stringify(
            {
                version: 1,
                slots: bwe_slots.map(function (s) { return { name: s.name, data: s.data }; })
            },
            null, 2
        );
        var blob = new Blob([payload], { type: "application/json" });
        var url  = URL.createObjectURL(blob);
        var a    = document.createElement("a");
        a.href = url; a.download = "bwe_slots.json"; a.click();
        URL.revokeObjectURL(url);
        logMessage("[BWE] Exported " + bwe_slots.length + " slot(s) to bwe_slots.json.");
    }

    function bweImport() {
        var input = document.createElement("input");
        input.type = "file";
        input.accept = ".json";
        input.onchange = function (ev) {
            var file = ev.target.files[0];
            if (!file) return;
            var reader = new FileReader();
            reader.onload = function (e2) {
                try {
                    var parsed = JSON.parse(e2.target.result);
                    if (!parsed.slots || !Array.isArray(parsed.slots)) {
                        logMessage("[BWE] Import failed: bad file format.");
                        return;
                    }
                    // Remove all existing slot elements and DOM buttons
                    for (var i = bwe_slots.length - 1; i >= 0; i--) {
                        var ck2 = bweCopyKey(i);
                        var pk2 = bwePasteKey(i);
                        var cb2 = document.getElementById("elementButton-" + ck2);
                        var pb2 = document.getElementById("elementButton-" + pk2);
                        if (cb2) cb2.remove();
                        if (pb2) pb2.remove();
                        delete elements[ck2];
                        delete elements[pk2];
                        delete bwe_ppc[i];
                    }
                    bwe_slots = [];

                    // Add imported slots
                    parsed.slots.forEach(function (s) {
                        var i2 = bwe_slots.length;
                        bwe_slots.push({ name: s.name || "Unnamed", data: s.data || null });
                        bweCreateSlotElements(i2);
                        bweMakeButton(bweCopyKey(i2));
                        bweMakeButton(bwePasteKey(i2));
                        bweRebuildPPC(i2);
                        bweUpdatePasteBtn(i2);
                    });

                    // Ensure at least one slot exists
                    if (bwe_slots.length === 0) {
                        bwe_slots.push({ name: "Unnamed", data: null });
                        bweCreateSlotElements(0);
                        bweMakeButton(bweCopyKey(0));
                        bweMakeButton(bwePasteKey(0));
                    }

                    bweSave();
                    bwePushCtrlsToEnd();
                    logMessage("[BWE] Imported " + bwe_slots.length + " slot(s).");
                } catch (err) {
                    logMessage("[BWE] Import failed: " + err.message);
                }
            };
            reader.readAsText(file);
        };
        input.click();
    }


    // ────────────────────────────────────────────────────────────
    //  ELEMENT DEFINITIONS
    //  Split into two objects so the game's init loop adds them
    //  in the correct DOM order:
    //    1. bwe_coreElements  (Select / Cut / Delete / Fill / etc.)
    //    2. bwe_slots         (slot elements added in bweRegisterSlots)
    //    3. bwe_ctrlElements  (add+1slot / removeLastSlot / Export / Import)
    // ────────────────────────────────────────────────────────────

    var bwe_coreElements = {
        bwe_deselect: {
            name: "Deselect",
            onSelect: function () {
                bwe_state.selection = null;
                if (typeof pixelTicks !== "undefined" && pixelTicks !== 0)
                    logMessage("[BWE] Deselected.");
            }
        },
        bwe_select_all: {
            name: "SelectAll",
            onSelect: function () {
                bwe_state.selection = new BweRect(0, 0, width + 1, height + 1);
                logMessage("[BWE] Selected everything.");
            }
        },
        bwe_select: {
            name: "Select",
            shouldStaySelected: true,
            onPointerDown: function (e) {
                var pos = bweClientToWorld(e.clientX, e.clientY);
                if (showingMenu || !bweInWorld(pos) || e.button === 1 || e.button === 2) return;
                bwe_state.firstSelectionPos = pos;
            },
            onPointerMoveAnywhere: function (e) {
                if (!mouseIsDown || showingMenu || e.button === 1 || e.button === 2) return;
                if (currentElement !== "bwe_select") return;
                var pos  = bweClientToWorld(e.clientX, e.clientY);
                var rect = BweRect.fromCorners(
                    bwe_state.firstSelectionPos, bweClamp(pos)
                ).normalized();
                rect.x2 += 1;
                rect.y2 += 1;
                bwe_state.selection = rect;
            }
        },
        bwe_cut: {
            name: "Cut",
            onSelect: function () {
                var sel = bwe_state.selection;
                if (!sel) { logMessage("[BWE] Error: Nothing selected."); return; }
                for (var y = sel.y; y < sel.y2; y++) {
                    for (var x = sel.x; x < sel.x2; x++) {
                        var px = pixelMap[x][y];
                        var i  = currentPixels.indexOf(px);
                        if (i !== -1) currentPixels.splice(i, 1);
                        if (px) delete pixelMap[x][y];
                    }
                }
                logMessage("[BWE] Cut " + sel.w + "\u00d7" + sel.h + "=" + sel.area + " px.");
            }
        },
        bwe_delete: {
            name: "Delete",
            onSelect: function () {
                var sel = bwe_state.selection;
                if (!sel) { logMessage("[BWE] Error: Nothing selected."); return; }
                for (var y = sel.y; y < sel.y2; y++) {
                    for (var x = sel.x; x < sel.x2; x++) {
                        var px = pixelMap[x][y];
                        var i  = currentPixels.indexOf(px);
                        if (i !== -1) currentPixels.splice(i, 1);
                        if (px) delete pixelMap[x][y];
                    }
                }
                logMessage("[BWE] Deleted " + sel.w + "\u00d7" + sel.h + "=" + sel.area + " px.");
            }
        },
        bwe_fill: {
            name: "Fill",
            onSelect: function () {
                var sel  = bwe_state.selection;
                var fill = bwe_state.lastNonBweElement;
                if (!sel) { logMessage("[BWE] Error: Nothing selected."); return; }
                for (var y = sel.y; y < sel.y2; y++) {
                    for (var x = sel.x; x < sel.x2; x++) {
                        if (pixelMap[x][y]) continue;
                        currentPixels.push(new Pixel(x, y, fill));
                        if (currentPixels.length > maxPixelCount || !fill) {
                            currentPixels[currentPixels.length - 1].del = true;
                        } else if (elements[fill] && elements[fill].onPlace) {
                            elements[fill].onPlace(currentPixels[currentPixels.length - 1]);
                        }
                    }
                }
                logMessage("[BWE] Filled " + sel.w + "\u00d7" + sel.h + "=" + sel.area + " px.");
            }
        }
    };

    var bwe_ctrlElements = {
        bwe_add_slot: {
            name:  "add+1slot",
            color: "#2a5c2a",
            onSelect: function () { bweAddSlot(); }
        },
        bwe_remove_slot: {
            name:  "removeLastSlot",
            color: "#5c2a2a",
            onSelect: function () { bweRemoveLastSlot(); }
        },
        bwe_export: {
            name:  "Export",
            color: "#2a4a5c",
            onSelect: function () { bweExport(); }
        },
        bwe_import: {
            name:  "Import",
            color: "#2a4a5c",
            onSelect: function () { bweImport(); }
        }
    };


    // ────────────────────────────────────────────────────────────
    //  AUTO-DESELECT WRAPPER
    //  Wraps onSelect so the element jumps back to the last
    //  non-betterWorldEdit element automatically after triggering,
    //  matching the behaviour of worldEdit.js.
    // ────────────────────────────────────────────────────────────

    function bweWrapAutoDeselect(el) {
        if (el.shouldStaySelected) return; // paste buttons stay selected
        var orig = el.onSelect;
        el.rawOnSelect = orig;
        el.onSelect = function () {
            orig.apply(this, arguments);
            selectElement(bwe_state.lastNonBweElement);
        };
    }


    // ────────────────────────────────────────────────────────────
    //  ELEMENT REGISTRATION
    // ────────────────────────────────────────────────────────────

    function bweApplyDefaults(key, el) {
        el.category = el.category || BWE_CATEGORY;
        el.color    = el.color    || BWE_ACCENT;
        el.tool     = el.tool     || function () { return null; };
        if (el.maxSize === undefined) el.maxSize = 1;
    }

    // 1. Core elements (Deselect, SelectAll, Select, Cut, Delete, Fill)
    function bweRegisterCore() {
        for (var key in bwe_coreElements) {
            var el = bwe_coreElements[key];
            bweApplyDefaults(key, el);
            bweWrapAutoDeselect(el);
            elements[key] = el;
        }
    }

    // 2. Initial slot elements (game's init loop will create their buttons)
    function bweRegisterSlots() {
        for (var idx = 0; idx < bwe_slots.length; idx++) {
            bweCreateSlotElements(idx);
            bweRebuildPPC(idx);
        }
    }

    // 3. Control elements (add, remove, export, import) — registered LAST
    //    so the game creates their buttons after the slot buttons.
    function bweRegisterCtrls() {
        for (var key in bwe_ctrlElements) {
            var el = bwe_ctrlElements[key];
            bweApplyDefaults(key, el);
            bweWrapAutoDeselect(el);
            elements[key] = el;
        }
    }


    // ────────────────────────────────────────────────────────────
    //  selectElement WRAPPER
    //  Keeps bwe_state.lastNonBweElement up-to-date.
    // ────────────────────────────────────────────────────────────

    function bweWrapSelectElement() {
        var orig = selectElement;
        selectElement = function (el) {
            if (!bweIsOwnKey(el)) {
                bwe_state.lastNonBweElement = el;
            }
            orig(el);
        };
    }


    // ────────────────────────────────────────────────────────────
    //  RENDER HOOKS
    // ────────────────────────────────────────────────────────────

    function bweRenderSelection(ctx) {
        var sel = bwe_state.selection;
        if (!sel) return;
        var selecting = mouseIsDown &&
            mouseType !== "middle" && mouseType !== "right" &&
            currentElement === "bwe_select";
        ctx.globalAlpha = 1.0;
        if (!selecting) {
            ctx.fillStyle = BWE_STYLE.selectFill;
            ctx.fillRect(sel.x * pixelSize, sel.y * pixelSize,
                         sel.w * pixelSize, sel.h * pixelSize);
        }
        if (BWE_STYLE.selectDash && sel.w >= 2 && sel.h >= 2)
            ctx.setLineDash([pixelSize, pixelSize]);
        ctx.strokeStyle = BWE_STYLE.selectStroke;
        ctx.lineWidth   = BWE_STYLE.strokeWidth;
        ctx.strokeRect(sel.x * pixelSize, sel.y * pixelSize,
                       sel.w * pixelSize, sel.h * pixelSize);
        ctx.setLineDash([]);
    }

    function bweRenderPastePreview(ctx) {
        var ce = currentElement;
        if (!ce || ce.indexOf("bwe_slot_paste_") !== 0) return;
        var idx = parseInt(ce.replace("bwe_slot_paste_", ""), 10) - 1;
        var s   = bwe_slots[idx];
        if (!s || !s.data) return;
        var cb = s.data;
        var pw = cb[0].length * pixelSize;
        var ph = cb.length    * pixelSize;
        var px = mousePos.x   * pixelSize;
        var py = mousePos.y   * pixelSize;
        ctx.globalAlpha = 1.0;
        ctx.fillStyle   = BWE_STYLE.pasteFill;
        ctx.fillRect(px, py, pw, ph);
        ctx.strokeStyle = BWE_STYLE.pasteStroke;
        ctx.lineWidth   = BWE_STYLE.strokeWidth;
        ctx.strokeRect(px, py, pw, ph);
        var oc = bwe_ppc[idx];
        if (oc) ctx.drawImage(oc, px, py, pw, ph);
    }


    // ────────────────────────────────────────────────────────────
    //  POINTER EVENT LISTENERS
    //  Mirrors worldEdit.js exactly so mobileMouse1.js and zoom.js
    //  remain compatible (they interact with mousePos / getMousePos,
    //  not with these canvas listeners directly).
    // ────────────────────────────────────────────────────────────

    function bweAddListeners() {
        if (bwe_listenersAdded) return;
        gameCanvas.addEventListener("pointerdown", function (e) {
            var el = elements[currentElement];
            if (el && el.onPointerDown) el.onPointerDown(e);
        }, { passive: false });
        gameCanvas.addEventListener("pointermove", function (e) {
            var el = elements[currentElement];
            if (el && el.onPointerMove) el.onPointerMove(e);
        }, { passive: false });
        document.addEventListener("pointermove", function (e) {
            var el = elements[currentElement];
            if (el && el.onPointerMoveAnywhere) el.onPointerMoveAnywhere(e);
        });
        bwe_listenersAdded = true;
    }


    // ────────────────────────────────────────────────────────────
    //  KEYBINDS
    //  Deliberately avoids w / a / s / d (used by zoom.js in WASD
    //  pan mode) and c / f (screenshot / fullscreen in vanilla).
    // ────────────────────────────────────────────────────────────

    function bweAddKeybinds() {
        // b → open the betterWorldEdit category
        keybinds["b"] = function () { selectCategory(BWE_CATEGORY); };
        // n → quick deselect (safe: unused by zoom.js and vanilla)
        keybinds["n"] = function () {
            bwe_state.selection = null;
            logMessage("[BWE] Deselected.");
        };
    }


    // ────────────────────────────────────────────────────────────
    //  RESET HOOK
    // ────────────────────────────────────────────────────────────

    function bweOnReset() {
        bweAddListeners();
        // Rebuild paste-preview canvases (pixel data may have changed)
        for (var i = 0; i < bwe_slots.length; i++) bweRebuildPPC(i);
    }


    // ────────────────────────────────────────────────────────────
    //  INIT
    // ────────────────────────────────────────────────────────────

    // Load or initialise slot data
    var savedSlots = bweLoadFromStorage();
    if (savedSlots && savedSlots.length > 0) {
        bwe_slots = savedSlots;
    } else {
        for (var _si = 0; _si < BWE_DEFAULT_SLOTS; _si++) {
            bwe_slots.push({ name: "Unnamed", data: null });
        }
    }

    // Register all elements into the game's `elements` object.
    // Order matters: core → slots → controls ensures the DOM button
    // order is correct when the game's init loop runs at line ~20723.
    bweRegisterCore();
    bweRegisterSlots();
    bweRegisterCtrls();

    // Wrap selectElement to track lastNonBweElement
    bweWrapSelectElement();

    // Keybinds
    bweAddKeybinds();

    // Render hooks (selection overlay + paste preview)
    renderPostPixel(bweRenderSelection);
    renderPostPixel(bweRenderPastePreview);

    // After the game's init loop has created all buttons, push the
    // control buttons to the end of the category div (in case JS
    // object iteration order differed from expectation on some engines).
    runAfterLoad(function () {
        // The game's element button loop already ran at this point.
        // bwePushCtrlsToEnd is called via setTimeout to run after the
        // game's own post-load code (which may also append buttons).
        setTimeout(bwePushCtrlsToEnd, 0);
    });

    // Pointer listeners and PPC rebuild on every reset
    runAfterReset(bweOnReset);

    console.log("[BWE] betterWorldEdit v1.0.0 ready. Slots: " + bwe_slots.length + ".");

}());
