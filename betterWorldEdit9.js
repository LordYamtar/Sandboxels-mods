"use strict";
// betterWorldEdit.js
// Built on top of worldEdit.js — extends with multi-slot clipboard,
// per-slot editing tools, click-to-confirm paste, portal autofill,
// and a floating toolbar panel. No worldEdit category is created.

// ─────────────────────────────────────────────
//  CONSTANTS  (kept from worldEdit.js)
// ─────────────────────────────────────────────
const w_accentColor = "#7cff62";
const w_style = {
    strokeWidth: 1,
    selectFill: "#57b64530",
    selectStroke: w_accentColor,
    selectDash: true,
    pasteFill: "#00FFFF40",
    pasteStroke: "#00FFFF",
    pastePixelColor: "#00FFFF44"
};

// ─────────────────────────────────────────────
//  GLOBAL STATE
// ─────────────────────────────────────────────
let worldEditElements = {};
let pastePreviewCanvas;

// Original worldEdit state
let w_state = {
    firstSelectionPos: { x: 0, y: 0 },
    selection: null,
    clipboard: null,          // always mirrors active slot's data for compatibility
    lastNonWorldEditElement: "unknown"
};

// Multi-slot clipboard  [{name, data}]
let bwe_slots = [];
let bwe_activeSlotIndex = -1;  // which slot is loaded into w_state.clipboard

// Click-to-confirm paste state
let bwe_pasteAnchored = false;      // preview is anchored (waiting for confirm click)
let bwe_anchorPos = { x: 0, y: 0 }; // pixel-grid position of anchor

// Autofill state
let bwe_autofillSlots = [];         // generated slots from autofill
let bwe_autofillIndex = 0;          // next index to hand to user

// betterSettings integration (optional)
let w_settingsTab, w_deselectOnResetSetting;
dependOn("betterSettings.js", () => {
    w_settingsTab = new SettingsTab("WorldEdit");
    w_deselectOnResetSetting = new Setting("Deselect on reset", "deselectOnReset", settingType.BOOLEAN, false, true);
    w_settingsTab.registerSettings("Selection", w_deselectOnResetSetting);
    settingsManager.registerTab(w_settingsTab);
}, true);

// ─────────────────────────────────────────────
//  CLASSES  (kept from worldEdit.js)
// ─────────────────────────────────────────────
class Rect {
    constructor(x, y, w, h) { this.x = x; this.y = y; this.w = w; this.h = h; }
    static fromCorners(start, end) { return new Rect(start.x, start.y, end.x - start.x, end.y - start.y); }
    static fromCornersXYXY(x, y, x2, y2) { return new Rect(x, y, x2 - x, y2 - y); }
    static fromGrid(grid, origin = { x: 0, y: 0 }) { return new Rect(origin.x, origin.y, grid[0].length, grid.length); }
    get area() { return this.w * this.h; }
    get x2() { return this.x + this.w; }
    get y2() { return this.y + this.h; }
    set x2(val) { this.w = val - this.x; }
    set y2(val) { this.h = val - this.y; }
    copy() { return new Rect(this.x, this.y, this.w, this.h); }
    normalized() { return Rect.fromCornersXYXY(Math.min(this.x, this.x2), Math.min(this.y, this.y2), Math.max(this.x, this.x2), Math.max(this.y, this.y2)); }
}

// ─────────────────────────────────────────────
//  UTILITY FUNCTIONS  (kept from worldEdit.js)
// ─────────────────────────────────────────────
function reverseString(str) { return [...str].reverse().join(""); }
function isPointInWorld(point) { return point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height; }
function limitPointToWorld(point) { return { x: Math.max(0, Math.min(point.x, width)), y: Math.max(0, Math.min(point.y, height)) }; }

function mousePosToWorldPos(pos) {
    const rect = canvas.getBoundingClientRect();
    let x = pos.x - rect.left;
    let y = pos.y - rect.top;
    // Use rect.width/height (not clientWidth/clientHeight) so zoom.js CSS
    // scale transforms are accounted for correctly.
    x = Math.floor((x / rect.width) * (width + 1));
    y = Math.floor((y / rect.height) * (height + 1));
    return { x, y };
}

// Returns current cursor position in world-grid coords, respecting mmm_locked (mobile mod)
function bwe_getCursorWorldPos() {
    if (window.mmm_locked && window.mmm_cursor) {
        return mousePosToWorldPos(window.mmm_cursor);
    }
    return mousePos;  // mousePos is already in grid coords in Sandboxels
}

// ─────────────────────────────────────────────
//  PASTE PREVIEW CANVAS
// ─────────────────────────────────────────────
function updatePastePreviewCanvas() {
    const clipboard = w_state.clipboard;
    if (!clipboard) return;
    const clipboardRect = Rect.fromGrid(clipboard);
    pastePreviewCanvas = new OffscreenCanvas(clipboardRect.w, clipboardRect.h);
    const ctx = pastePreviewCanvas.getContext("2d");
    const imageData = ctx.createImageData(clipboardRect.w, clipboardRect.h);
    const buffer = new Uint32Array(imageData.data.buffer);
    buffer.fill(0x00000000);
    const pixelColorBinary = parseInt(reverseString(w_style.pastePixelColor.slice(1)), 16);
    for (let y = 0; y < clipboardRect.h; y++) {
        for (let x = 0; x < clipboardRect.w; x++) {
            if (clipboard[y][x]) buffer[y * clipboardRect.w + x] = pixelColorBinary;
        }
    }
    ctx.putImageData(imageData, 0, 0);
}

// ─────────────────────────────────────────────
//  RENDER HOOKS  (kept from worldEdit.js)
// ─────────────────────────────────────────────
function renderSelection(ctx) {
    const selection = w_state.selection;
    if (!selection) return;
    const isSelecting = (mouseIsDown &&
        (mouseType !== "middle" && mouseType !== "right") &&
        currentElement === "w_select");
    ctx.globalAlpha = 1.0;
    if (!isSelecting) {
        ctx.fillStyle = w_style.selectFill;
        ctx.fillRect(selection.x * pixelSize, selection.y * pixelSize, selection.w * pixelSize, selection.h * pixelSize);
    }
    if (w_style.selectDash && selection.w >= 2 && selection.h >= 2) ctx.setLineDash([pixelSize, pixelSize]);
    ctx.strokeStyle = w_style.selectStroke;
    ctx.lineWidth = w_style.strokeWidth;
    ctx.strokeRect(selection.x * pixelSize, selection.y * pixelSize, selection.w * pixelSize, selection.h * pixelSize);
    ctx.setLineDash([]);
}

function renderPastePreview(ctx) {
    if (currentElement !== "w_paste") return;
    const clipboard = w_state.clipboard;
    if (!clipboard) return;

    // If anchored, draw at anchor; else follow cursor
    const origin = bwe_pasteAnchored ? bwe_anchorPos : bwe_getCursorWorldPos();
    const clipboardRect = Rect.fromGrid(clipboard, origin);
    ctx.globalAlpha = 1.0;
    ctx.fillStyle = w_style.pasteFill;
    ctx.fillRect(clipboardRect.x * pixelSize, clipboardRect.y * pixelSize, clipboardRect.w * pixelSize, clipboardRect.h * pixelSize);
    ctx.strokeStyle = w_style.pasteStroke;
    ctx.lineWidth = w_style.strokeWidth;
    ctx.strokeRect(clipboardRect.x * pixelSize, clipboardRect.y * pixelSize, clipboardRect.w * pixelSize, clipboardRect.h * pixelSize);
    if (pastePreviewCanvas) ctx.drawImage(pastePreviewCanvas, origin.x * pixelSize, origin.y * pixelSize, clipboardRect.w * pixelSize, clipboardRect.h * pixelSize);

    // Draw confirm-ring indicator when anchored
    if (bwe_pasteAnchored) {
        ctx.strokeStyle = "#FFFF00";
        ctx.lineWidth = 2;
        ctx.setLineDash([pixelSize / 2, pixelSize / 2]);
        const pad = pixelSize;
        ctx.strokeRect(
            (clipboardRect.x - 1) * pixelSize - pad,
            (clipboardRect.y - 1) * pixelSize - pad,
            (clipboardRect.w + 2) * pixelSize + pad * 2,
            (clipboardRect.h + 2) * pixelSize + pad * 2
        );
        ctx.setLineDash([]);
    }
}

// ─────────────────────────────────────────────
//  COPY / CUT HELPERS
// ─────────────────────────────────────────────
function bwe_copySelection(doDelete) {
    const selection = w_state.selection;
    if (!selection) { logMessage("Error: Nothing is selected."); return null; }
    const data = [];
    for (let y = selection.y; y < selection.y2; y++) {
        const row = [];
        for (let x = selection.x; x < selection.x2; x++) {
            row.push(structuredClone(pixelMap[x][y]));
            if (doDelete) {
                const pixel = pixelMap[x][y];
                const idx = currentPixels.indexOf(pixel);
                if (idx !== -1) currentPixels.splice(idx, 1);
                if (pixel) delete pixelMap[x][y];
            }
        }
        data.push(row);
    }
    return data;
}

function bwe_addSlot(name, data) {
    bwe_slots.push({ name, data });
    bwe_renderPanel();
}

function bwe_loadSlotToClipboard(index) {
    if (index < 0 || index >= bwe_slots.length) return;
    bwe_activeSlotIndex = index;
    w_state.clipboard = structuredClone(bwe_slots[index].data);
    updatePastePreviewCanvas();
}

// ─────────────────────────────────────────────
//  PASTE EXECUTION
// ─────────────────────────────────────────────
function bwe_executePaste(origin) {
    const clipboard = w_state.clipboard;
    if (!clipboard) { logMessage("Error: Nothing in clipboard."); return; }
    for (let y = 0; y < clipboard.length; y++) {
        for (let x = 0; x < clipboard[0].length; x++) {
            const clipboardPixel = clipboard[y][x];
            const dest = { x: origin.x + x, y: origin.y + y };
            if (!isPointInWorld(dest)) continue;
            if (pixelMap[dest.x][dest.y]) continue;
            if (!clipboardPixel) continue;
            const newPixel = structuredClone(clipboardPixel);
            Object.assign(newPixel, dest);
            pixelMap[dest.x][dest.y] = newPixel;
            currentPixels.push(newPixel);
        }
    }
    const area = Rect.fromGrid(clipboard).area;
    logMessage(`Pasted ${clipboard[0].length}x${clipboard.length}=${area} pixel area.`);
    bwe_pasteAnchored = false;
}

// ─────────────────────────────────────────────
//  SLOT TRANSFORM TOOLS
// ─────────────────────────────────────────────
function bwe_rotateSlot90(index) {
    const slot = bwe_slots[index];
    if (!slot) return;
    const data = slot.data;
    const rows = data.length, cols = data[0].length;
    const rotated = [];
    for (let c = 0; c < cols; c++) {
        const newRow = [];
        for (let r = rows - 1; r >= 0; r--) {
            newRow.push(structuredClone(data[r][c]));
        }
        rotated.push(newRow);
    }
    bwe_slots[index].data = rotated;
    if (bwe_activeSlotIndex === index) bwe_loadSlotToClipboard(index);
    logMessage(`Slot "${slot.name}" rotated 90°.`);
    bwe_renderPanel();
}

function bwe_flipSlotH(index) {
    const slot = bwe_slots[index];
    if (!slot) return;
    bwe_slots[index].data = slot.data.map(row => [...row].reverse());
    if (bwe_activeSlotIndex === index) bwe_loadSlotToClipboard(index);
    logMessage(`Slot "${slot.name}" flipped horizontally.`);
    bwe_renderPanel();
}

function bwe_flipSlotV(index) {
    const slot = bwe_slots[index];
    if (!slot) return;
    bwe_slots[index].data = [...slot.data].reverse();
    if (bwe_activeSlotIndex === index) bwe_loadSlotToClipboard(index);
    logMessage(`Slot "${slot.name}" flipped vertically.`);
    bwe_renderPanel();
}

function bwe_moveSlot(index, direction) {
    const target = index + direction;
    if (target < 0 || target >= bwe_slots.length) return;
    [bwe_slots[index], bwe_slots[target]] = [bwe_slots[target], bwe_slots[index]];
    if (bwe_activeSlotIndex === index) bwe_activeSlotIndex = target;
    else if (bwe_activeSlotIndex === target) bwe_activeSlotIndex = index;
    bwe_renderPanel();
}

// ─────────────────────────────────────────────
//  EXPORT / IMPORT
// ─────────────────────────────────────────────
function bwe_exportSlots() {
    const json = JSON.stringify(bwe_slots, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "bwe_clipboard.json";
    a.click();
}

function bwe_importSlots(file) {
    const reader = new FileReader();
    reader.onload = (e) => {
        try {
            const imported = JSON.parse(e.target.result);
            if (!Array.isArray(imported)) throw new Error("Bad format");
            imported.forEach(s => {
                if (s.name && s.data) bwe_slots.push({ name: String(s.name), data: s.data });
            });
            logMessage(`Imported ${imported.length} slots.`);
            bwe_renderPanel();
        } catch (err) {
            logMessage("Import failed: " + err.message);
        }
    };
    reader.readAsText(file);
}

// ─────────────────────────────────────────────
//  PORTAL AUTOFILL
// ─────────────────────────────────────────────

// Detect portal element name — Sandboxels stores it as 'portal' with channel property
function bwe_isPortal(pixel) {
    return pixel && pixel.element && pixel.element.toLowerCase().includes("portal");
}

// Compare two grids; return list of {y, x, channelA, channelB} where portals differ
function bwe_diffPortalChannels(dataA, dataB) {
    const diffs = [];
    const rows = Math.min(dataA.length, dataB.length);
    const cols = Math.min(dataA[0].length, dataB[0].length);
    for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
            const pA = dataA[y][x];
            const pB = dataB[y][x];
            if (bwe_isPortal(pA) && bwe_isPortal(pB)) {
                const chA = pA.channel !== undefined ? pA.channel : pA.chan;
                const chB = pB.channel !== undefined ? pB.channel : pB.chan;
                if (chA !== chB) diffs.push({ y, x, channelA: chA, channelB: chB });
            }
        }
    }
    return diffs;
}

// Infer numeric series step (like Excel fill)
function bwe_inferStep(a, b) {
    // For numbers return difference; for dates or other patterns default to diff
    if (typeof a === "number" && typeof b === "number") return b - a;
    return null;
}

function bwe_autofillPortals(idxA, idxB, count) {
    const slotA = bwe_slots[idxA];
    const slotB = bwe_slots[idxB];
    if (!slotA || !slotB) { logMessage("Autofill: invalid slot selection."); return; }

    const diffs = bwe_diffPortalChannels(slotA.data, slotB.data);
    if (diffs.length === 0) { logMessage("Autofill: no differing portal channels found."); return; }

    // Compute per-portal steps
    const steps = diffs.map(d => ({
        ...d,
        step: bwe_inferStep(d.channelA, d.channelB)
    }));

    bwe_autofillSlots = [];
    bwe_autofillIndex = 0;

    // Generate `count` new iterations starting from slotB values + step
    for (let i = 1; i <= count; i++) {
        const newData = structuredClone(slotB.data);
        for (const s of steps) {
            if (s.step === null) continue;
            const pixel = newData[s.y][s.x];
            if (!pixel) continue;
            const baseVal = s.channelB;
            const newVal = baseVal + s.step * i;
            if (pixel.channel !== undefined) pixel.channel = newVal;
            else if (pixel.chan !== undefined) pixel.chan = newVal;
        }
        const label = `Autofill #${i}`;
        bwe_autofillSlots.push({ name: label, data: newData });
    }
    logMessage(`Autofill: generated ${count} iterations.`);
    bwe_renderPanel();
}

// ─────────────────────────────────────────────
//  WORLDEDIT ELEMENT HANDLERS  (from worldEdit.js, unchanged logic)
// ─────────────────────────────────────────────
function modifySelectElement() {
    const originalSelectElement = selectElement;
    selectElement = (element) => {
        if (!worldEditElements.hasOwnProperty(element))
            w_state.lastNonWorldEditElement = element;
        originalSelectElement(element);
    };
}

function addWorldEditElements(elementsToAdd) {
    for (const elementName in elementsToAdd) {
        const element = elementsToAdd[elementName];
        elements[elementName] = element;
        element.category ?? (element.category = "worldEdit");
        element.color ?? (element.color = w_accentColor);
        element.tool ?? (element.tool = () => null);
        element.maxSize ?? (element.maxSize = 1);
        if (!element.shouldStaySelected) {
            const originalOnSelect = element.onSelect;
            element.rawOnSelect = originalOnSelect;
            element.onSelect = function (...args) {
                originalOnSelect(...args);
                selectElement(w_state.lastNonWorldEditElement);
            };
        }
    }
}

// Elements
worldEditElements.w_deselect = {
    onSelect: function () {
        w_state.selection = null;
        if (pixelTicks != 0) logMessage("Deselected area.");
    }
};
worldEditElements.w_select_all = {
    onSelect: function () {
        w_state.selection = new Rect(0, 0, width + 1, height + 1);
        logMessage("Selected everything.");
    }
};
worldEditElements.w_select = {
    onPointerDown: function (e) {
        const pos = mousePosToWorldPos({ x: e.clientX, y: e.clientY });
        if (showingMenu) return;
        if (!isPointInWorld(pos)) return;
        if (e.button === 1 || e.button === 2) return;
        w_state.firstSelectionPos = pos;
    },
    onPointerMoveAnywhere: function (e) {
        const pos = mousePosToWorldPos({ x: e.clientX, y: e.clientY });
        if (!mouseIsDown) return;
        if (showingMenu) return;
        if (e.button === 1 || e.button === 2) return;
        if (currentElement !== "w_select") return;
        const rect = Rect.fromCorners(w_state.firstSelectionPos, limitPointToWorld(pos)).normalized();
        rect.x2 += 1;
        rect.y2 += 1;
        w_state.selection = rect;
    },
    shouldStaySelected: true
};

worldEditElements.w_copy = {
    onSelect: function () {
        const data = bwe_copySelection(false);
        if (!data) return;
        w_state.clipboard = data;
        updatePastePreviewCanvas();
        logMessage(`Copied ${w_state.selection.w}x${w_state.selection.h}=${w_state.selection.area} pixel area.`);
    }
};

// w_paste uses click-to-confirm logic.
// onPointerDown: store pending position only, preview keeps following cursor.
// onPointerUp:   do anchor / confirm / reposition.
let bwe_pendingAnchorPos = null;
worldEditElements.w_paste = {
    onPointerDown: function (e) {
        if (showingMenu) return;
        if (e.button === 1 || e.button === 2) return;
        const clipboard = w_state.clipboard;
        if (!clipboard) { logMessage("Error: Nothing in clipboard."); return; }
        const rawPos = mousePosToWorldPos({ x: e.clientX, y: e.clientY });
        if (!isPointInWorld(rawPos)) return;
        // Store where the press started; don't anchor yet.
        bwe_pendingAnchorPos = { ...rawPos };
    },
    onPointerUp: function (e) {
        if (showingMenu) return;
        if (e.button === 1 || e.button === 2) return;
        const clipboard = w_state.clipboard;
        if (!clipboard) return;
        if (!bwe_pendingAnchorPos) return;
        const rawPos = mousePosToWorldPos({ x: e.clientX, y: e.clientY });
        if (!isPointInWorld(rawPos)) { bwe_pendingAnchorPos = null; return; }

        if (!bwe_pasteAnchored) {
            // First release: anchor at the release position.
            bwe_pasteAnchored = true;
            bwe_anchorPos = { ...rawPos };
        } else {
            // Already anchored: confirm if within 1 tile, else reposition.
            const dx = Math.abs(rawPos.x - bwe_anchorPos.x);
            const dy = Math.abs(rawPos.y - bwe_anchorPos.y);
            if (dx <= 1 && dy <= 1) {
                bwe_executePaste(bwe_anchorPos);
            } else {
                bwe_anchorPos = { ...rawPos };
            }
        }
        bwe_pendingAnchorPos = null;
    },
    shouldStaySelected: true
};

worldEditElements.w_cut = {
    onSelect: function () {
        const data = bwe_copySelection(true);
        if (!data) return;
        w_state.clipboard = data;
        updatePastePreviewCanvas();
        logMessage(`Cut ${w_state.selection.w}x${w_state.selection.h}=${w_state.selection.area} pixel area.`);
    }
};
worldEditElements.w_delete = {
    onSelect: function () {
        const selection = w_state.selection;
        if (!selection) { logMessage("Error: Nothing is selected."); return; }
        for (let y = selection.y; y < selection.y2; y++) {
            for (let x = selection.x; x < selection.x2; x++) {
                const pixel = pixelMap[x][y];
                const idx = currentPixels.indexOf(pixel);
                if (idx !== -1) currentPixels.splice(idx, 1);
                if (pixel) delete pixelMap[x][y];
            }
        }
        logMessage(`Deleted ${selection.w}x${selection.h}=${selection.area} pixel area.`);
    }
};
worldEditElements.w_fill = {
    onSelect: function () {
        const selection = w_state.selection;
        const fillElement = w_state.lastNonWorldEditElement;
        if (!selection) { logMessage("Error: Nothing is selected."); return; }
        for (let y = selection.y; y < selection.y2; y++) {
            for (let x = selection.x; x < selection.x2; x++) {
                if (pixelMap[x][y]) continue;
                const placed = currentPixels.push(new Pixel(x, y, fillElement));
                if (!placed) continue;
                if (currentPixels.length > maxPixelCount || !fillElement) {
                    currentPixels[currentPixels.length - 1].del = true;
                } else if (elements[fillElement] && elements[fillElement].onPlace !== undefined) {
                    elements[fillElement].onPlace(currentPixels[currentPixels.length - 1]);
                }
            }
        }
        logMessage(`Filled in ${selection.w}x${selection.h}=${selection.area} pixel area.`);
    }
};

// ─────────────────────────────────────────────
//  KEYBINDS  (kept from worldEdit.js, w keybind removed since no category)
// ─────────────────────────────────────────────
function addWorldEditKeybinds() {
    keybinds.d = () => { elements.w_deselect.rawOnSelect(); };
    keybinds.a = () => { elements.w_select_all.rawOnSelect(); };
    keybinds.s = () => { selectElement("w_select"); };
    keybinds.c = () => { elements.w_copy.rawOnSelect(); };
    keybinds.v = () => { selectElement("w_paste"); };
    keybinds.x = () => { elements.w_cut.rawOnSelect(); };
    keybinds.Delete = () => { elements.w_delete.rawOnSelect(); };
    keybinds.g = () => { elements.w_fill.rawOnSelect(); };
    // Cancel anchor with Escape
    keybinds.Escape = () => { bwe_pasteAnchored = false; };
}

// ─────────────────────────────────────────────
//  FLOATING PANEL UI
// ─────────────────────────────────────────────
let bwe_panel = null;
let bwe_expandedSlotTools = new Set(); // indices whose tool subpanel is open
let bwe_autofillPanelOpen = false;
let bwe_panelCollapsed = false;        // true = header-only strip at bottom
// Instructions shown only on first-ever open (persisted in localStorage)
let bwe_hasShownInstructions = localStorage.getItem("bwe_instructions_seen") === "1";

const bwe_css = `
#bwe-btn {
    background: #1a1a1a;
    color: #7cff62;
    border: 1.5px solid #7cff62;
    border-radius: 5px;
    padding: 3px 10px;
    font-size: 13px;
    cursor: pointer;
    margin: 0 2px;
    vertical-align: middle;
    font-family: monospace;
    transition: background 0.15s;
}
#bwe-btn:hover { background: #2a3a2a; }
#bwe-panel {
    position: fixed;
    bottom: 0;
    left: 50%;
    transform: translateX(-50%);
    width: min(98vw, 480px);
    max-height: 60vh;
    overflow-y: auto;
    background: rgba(16,18,16,0.97);
    border: 2px solid #7cff62;
    border-bottom: none;
    border-radius: 12px 12px 0 0;
    padding: 10px 10px 14px 10px;
    z-index: 99999;
    font-family: monospace;
    color: #d8ffd8;
    box-shadow: 0 -4px 32px #00ff6633;
    display: none;
}
/* Collapsed: strip at very bottom, body hidden via JS */
#bwe-panel.bwe-collapsed {
    max-height: none;
    overflow: hidden;
    padding: 5px 10px;
    border-radius: 8px 8px 0 0;
}
#bwe-panel h3 {
    margin: 0 0 8px 0;
    font-size: 14px;
    color: #7cff62;
    border-bottom: 1px solid #3a5a3a;
    padding-bottom: 4px;
    display: flex;
    align-items: center;
    justify-content: space-between;
}
#bwe-panel.bwe-collapsed h3 {
    margin: 0;
    border-bottom: none;
    padding-bottom: 0;
}
#bwe-collapse-btn {
    background: none;
    border: 1px solid #4a7a4a;
    border-radius: 4px;
    color: #7cff62;
    font-size: 11px;
    padding: 1px 6px;
    cursor: pointer;
    font-family: monospace;
    flex-shrink: 0;
}
#bwe-collapse-btn:hover { background: #2a4a2a; }
.bwe-row {
    display: flex;
    flex-wrap: wrap;
    gap: 5px;
    margin-bottom: 6px;
}
.bwe-slot {
    background: #181f18;
    border: 1px solid #3a5a3a;
    border-radius: 6px;
    padding: 5px 7px;
    margin-bottom: 5px;
}
.bwe-slot.active { border-color: #7cff62; background: #1a2e1a; }
.bwe-slot-name {
    font-weight: bold;
    font-size: 12px;
    color: #a8ffaa;
    margin-right: 6px;
}
.bwe-btn {
    background: #1e2e1e;
    color: #7cff62;
    border: 1px solid #4a7a4a;
    border-radius: 4px;
    padding: 2px 7px;
    font-size: 11px;
    cursor: pointer;
    margin: 1px;
    font-family: monospace;
}
.bwe-btn:hover { background: #2a4a2a; }
.bwe-btn.danger { color: #ff6262; border-color: #7a2a2a; }
.bwe-btn.active-slot { background: #2a5a2a; color: #fff; }
.bwe-tools-row {
    display: flex;
    flex-wrap: wrap;
    gap: 3px;
    margin-top: 4px;
    padding-top: 4px;
    border-top: 1px dashed #3a5a3a;
}
.bwe-section { margin-bottom: 10px; }
.bwe-label { font-size: 11px; color: #78a878; margin-bottom: 3px; }
.bwe-autofill-panel { background: #101810; border: 1px solid #3a5a3a; border-radius: 6px; padding: 7px; margin-top: 6px; }
.bwe-autofill-panel select { background: #1a2a1a; color: #a8ffaa; border: 1px solid #4a7a4a; border-radius: 3px; padding: 2px 4px; font-family: monospace; font-size: 11px; margin: 2px; }
.bwe-autofill-panel input[type=number] { background: #1a2a1a; color: #a8ffaa; border: 1px solid #4a7a4a; border-radius: 3px; width: 50px; padding: 2px 4px; font-family: monospace; font-size: 11px; }
.bwe-next-btn { background: #1a3a2a; color: #62ffbb; border: 1.5px solid #62ffbb; border-radius: 5px; padding: 4px 14px; font-size: 13px; cursor: pointer; font-family: monospace; margin-top: 5px; }
.bwe-next-btn:hover { background: #2a5a3a; }
.bwe-body { }
`;

function bwe_injectStyles() {
    if (document.getElementById("bwe-styles")) return;
    const style = document.createElement("style");
    style.id = "bwe-styles";
    style.textContent = bwe_css;
    document.head.appendChild(style);
}

function bwe_createToolbarButton() {
    const btn = document.createElement("button");
    btn.id = "bwe-btn";
    btn.textContent = "🛠️ Edit";
    btn.title = "betterWorldEdit Panel";
    btn.addEventListener("click", bwe_togglePanel);
    // Insert into #toolControls (same bar as Pause / Reset)
    const toolControls = document.getElementById("toolControls");
    if (toolControls) {
        toolControls.appendChild(btn);
    } else {
        // Fallback: body top
        btn.style.position = "fixed";
        btn.style.top = "4px";
        btn.style.right = "4px";
        btn.style.zIndex = "99998";
        document.body.appendChild(btn);
    }
}

function bwe_togglePanel() {
    if (!bwe_panel) return;
    const visible = bwe_panel.style.display !== "none";
    if (visible) {
        bwe_panel.style.display = "none";
    } else {
        bwe_panel.style.display = "block";
        // Mark instructions as seen on first open
        if (!bwe_hasShownInstructions) {
            bwe_hasShownInstructions = true;
            localStorage.setItem("bwe_instructions_seen", "1");
        }
        bwe_renderPanel();
    }
}

// Toggle collapse: hides body, keeps header strip at bottom.
function bwe_toggleCollapse() {
    bwe_panelCollapsed = !bwe_panelCollapsed;
    bwe_applyCollapseState();
}

function bwe_applyCollapseState() {
    if (!bwe_panel) return;
    const body = document.getElementById("bwe-panel-body");
    const btn = document.getElementById("bwe-collapse-btn");
    if (bwe_panelCollapsed) {
        bwe_panel.classList.add("bwe-collapsed");
        if (body) body.style.display = "none";
        if (btn) btn.textContent = "▲ Show";
    } else {
        bwe_panel.classList.remove("bwe-collapsed");
        if (body) body.style.display = "";
        if (btn) btn.textContent = "▼";
    }
}

function bwe_createPanel() {
    bwe_panel = document.createElement("div");
    bwe_panel.id = "bwe-panel";
    document.body.appendChild(bwe_panel);
}

// Main panel renderer
function bwe_renderPanel() {
    if (!bwe_panel) return;

    // ── Header (always visible, even when collapsed)
    let html = `<h3>🛠️ betterWorldEdit <button id="bwe-collapse-btn" onclick="bwe_toggleCollapse()">${bwe_panelCollapsed ? '▲ Show' : '▼'}</button></h3>`;

    // ── Body (hidden when collapsed)
    html += `<div id="bwe-panel-body">`;

    // ── Selection tools
    html += `<div class="bwe-section">
        <div class="bwe-label">Selection</div>
        <div class="bwe-row">
            <button class="bwe-btn" onclick="selectElement('w_select')">◻ Select</button>
            <button class="bwe-btn" onclick="elements.w_deselect.rawOnSelect()">✕ Deselect</button>
            <button class="bwe-btn" onclick="elements.w_select_all.rawOnSelect()">⬛ All</button>
            <button class="bwe-btn" onclick="elements.w_copy.rawOnSelect()">📋 Copy→New Slot</button>
            <button class="bwe-btn" onclick="elements.w_cut.rawOnSelect()">✂️ Cut→New Slot</button>
            <button class="bwe-btn danger" onclick="elements.w_delete.rawOnSelect()">🗑 Delete</button>
            <button class="bwe-btn" onclick="elements.w_fill.rawOnSelect()">🪣 Fill</button>
        </div>
    </div>`;

    // ── Paste active info
    // Instructional hint shown only on the very first panel open
    const pasteHint = !bwe_hasShownInstructions
        ? `<div class="bwe-label" style="font-size:10px;color:#888;">Release to anchor preview → release near same spot to confirm. Release far away to reposition.</div>`
        : "";
    html += `<div class="bwe-section">
        <div class="bwe-label">Paste Mode</div>
        <div class="bwe-row">
            <button class="bwe-btn ${currentElement === 'w_paste' ? 'active-slot' : ''}" onclick="selectElement('w_paste');bwe_pasteAnchored=false;">${currentElement === 'w_paste' ? '⏸ Pasting…' : '📌 Start Paste'}</button>
            <button class="bwe-btn" onclick="bwe_pasteAnchored=false;selectElement(w_state.lastNonWorldEditElement)">❌ Cancel Paste</button>
        </div>
        ${pasteHint}
    </div>`;

    // ── Clipboard slots
    html += `<div class="bwe-section">
        <div class="bwe-label" style="display:flex;justify-content:space-between;align-items:center;">
            <span>Clipboard Slots (${bwe_slots.length})</span>
            <span>
                <button class="bwe-btn" onclick="bwe_exportSlots()">⬇ Export</button>
                <button class="bwe-btn" onclick="document.getElementById('bwe-import-file').click()">⬆ Import</button>
                <input type="file" id="bwe-import-file" accept=".json" style="display:none" onchange="bwe_importSlots(this.files[0]);this.value=''">
            </span>
        </div>`;

    if (bwe_slots.length === 0) {
        html += `<div class="bwe-label" style="color:#555;margin-top:4px;">No slots yet. Use Copy or Cut to add one.</div>`;
    }

    for (let i = 0; i < bwe_slots.length; i++) {
        const slot = bwe_slots[i];
        const isActive = i === bwe_activeSlotIndex;
        const toolsOpen = bwe_expandedSlotTools.has(i);
        const w = slot.data[0] ? slot.data[0].length : 0;
        const h = slot.data.length;
        html += `<div class="bwe-slot ${isActive ? 'active' : ''}">
            <div style="display:flex;align-items:center;flex-wrap:wrap;gap:3px;">
                <span class="bwe-slot-name">${bwe_escapeHtml(slot.name)}</span>
                <span style="font-size:10px;color:#666;">${w}×${h}</span>
                <button class="bwe-btn ${isActive ? 'active-slot' : ''}" onclick="bwe_loadSlotToClipboard(${i});bwe_renderPanel();">📌 Load</button>
                <button class="bwe-btn" onclick="bwe_pasteSlot(${i})">📋 Paste</button>
                <button class="bwe-btn" onclick="bwe_renameSlot(${i})">✏️ Rename</button>
                <button class="bwe-btn" onclick="bwe_moveSlot(${i},-1)" ${i === 0 ? 'disabled' : ''}>▲</button>
                <button class="bwe-btn" onclick="bwe_moveSlot(${i},1)" ${i === bwe_slots.length - 1 ? 'disabled' : ''}>▼</button>
                <button class="bwe-btn" onclick="bwe_expandedSlotTools.has(${i})?bwe_expandedSlotTools.delete(${i}):bwe_expandedSlotTools.add(${i});bwe_renderPanel()">⚒️</button>
                <button class="bwe-btn danger" onclick="bwe_deleteSlot(${i})">🗑</button>
            </div>`;
        if (toolsOpen) {
            html += `<div class="bwe-tools-row">
                <span style="font-size:10px;color:#78a878;margin-right:4px;">Transform:</span>
                <button class="bwe-btn" onclick="bwe_rotateSlot90(${i})">↻ Rotate 90°</button>
                <button class="bwe-btn" onclick="bwe_flipSlotH(${i})">↔ Flip H</button>
                <button class="bwe-btn" onclick="bwe_flipSlotV(${i})">↕ Flip V</button>
            </div>`;
        }
        html += `</div>`;
    }
    html += `</div>`;

    // ── Autofill portals
    html += `<div class="bwe-section">
        <div class="bwe-label" style="display:flex;justify-content:space-between;align-items:center;">
            <span>🌀 Portal Autofill</span>
            <button class="bwe-btn" onclick="bwe_autofillPanelOpen=!bwe_autofillPanelOpen;bwe_renderPanel()">${bwe_autofillPanelOpen ? '▲ Hide' : '▼ Show'}</button>
        </div>`;

    if (bwe_autofillPanelOpen) {
        const slotOptions = bwe_slots.map((s, i) => `<option value="${i}">${bwe_escapeHtml(s.name)}</option>`).join("");
        html += `<div class="bwe-autofill-panel">
            <div class="bwe-label">Select 2 identical slots that differ only in portal channels:</div>
            <div style="margin:4px 0;">
                Slot A: <select id="bwe-af-a">${slotOptions}</select>
                Slot B: <select id="bwe-af-b">${slotOptions}</select>
            </div>
            <div style="margin:4px 0;">
                Generate: <input type="number" id="bwe-af-count" value="5" min="1" max="50"> iterations
            </div>
            <button class="bwe-btn" onclick="bwe_autofillPortals(parseInt(document.getElementById('bwe-af-a').value),parseInt(document.getElementById('bwe-af-b').value),parseInt(document.getElementById('bwe-af-count').value));bwe_renderPanel()">▶ Autofill</button>
        </div>`;
    }

    // Autofill result queue
    if (bwe_autofillSlots.length > 0) {
        const remaining = bwe_autofillSlots.length - bwe_autofillIndex;
        html += `<div style="margin-top:6px;">
            <span style="font-size:11px;color:#62ffbb;">${remaining} autofill iteration(s) ready.</span><br>
            <button class="bwe-next-btn" onclick="bwe_nextAutofill()">+ Autofill Next</button>
            <button class="bwe-btn danger" style="margin-left:6px;" onclick="bwe_autofillSlots=[];bwe_autofillIndex=0;bwe_renderPanel()">Clear Queue</button>
        </div>`;
    }
    html += `</div>`;

    // ── Footer — only shown on first open
    if (!bwe_hasShownInstructions) {
        html += `<div style="font-size:10px;color:#444;margin-top:4px;text-align:right;">betterWorldEdit.js — press Esc to cancel paste anchor</div>`;
    }

    // Close body wrapper
    html += `</div>`;

    bwe_panel.innerHTML = html;
    // Re-apply collapse state after re-render (innerHTML resets DOM)
    bwe_applyCollapseState();
}

// ─────────────────────────────────────────────
//  PANEL ACTIONS (called from innerHTML onclick)
// ─────────────────────────────────────────────
function bwe_escapeHtml(str) {
    return String(str).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function bwe_pasteSlot(index) {
    bwe_loadSlotToClipboard(index);
    bwe_pasteAnchored = false;
    selectElement("w_paste");
    bwe_renderPanel();
}

function bwe_deleteSlot(index) {
    bwe_slots.splice(index, 1);
    if (bwe_activeSlotIndex === index) {
        bwe_activeSlotIndex = -1;
        w_state.clipboard = null;
    } else if (bwe_activeSlotIndex > index) {
        bwe_activeSlotIndex--;
    }
    bwe_expandedSlotTools.delete(index);
    bwe_renderPanel();
    logMessage(`Deleted slot ${index}.`);
}

function bwe_renameSlot(index) {
    const slot = bwe_slots[index];
    if (!slot) return;
    const newName = prompt("Rename slot:", slot.name);
    if (newName !== null && newName.trim() !== "") {
        bwe_slots[index].name = newName.trim();
        bwe_renderPanel();
    }
}

function bwe_nextAutofill() {
    if (bwe_autofillIndex >= bwe_autofillSlots.length) {
        logMessage("Autofill: queue exhausted.");
        return;
    }
    const next = bwe_autofillSlots[bwe_autofillIndex];
    bwe_autofillIndex++;
    // Load directly into clipboard and start paste
    w_state.clipboard = structuredClone(next.data);
    updatePastePreviewCanvas();
    bwe_pasteAnchored = false;
    selectElement("w_paste");
    logMessage(`Autofill: loaded "${next.name}" — click canvas to paste.`);
    bwe_renderPanel();
}

// ─────────────────────────────────────────────
//  OVERRIDE copy/cut to create named slots
//  We wrap rawOnSelect so slot gets added automatically
// ─────────────────────────────────────────────
function bwe_wrapCopyCut() {
    const origCopy = worldEditElements.w_copy.rawOnSelect || worldEditElements.w_copy.onSelect;
    const origCut = worldEditElements.w_cut.rawOnSelect || worldEditElements.w_cut.onSelect;

    worldEditElements.w_copy.rawOnSelect = function () {
        const data = bwe_copySelection(false);
        if (!data) return;
        w_state.clipboard = data;
        updatePastePreviewCanvas();
        const sel = w_state.selection;
        const name = `Copy ${sel.w}×${sel.h} #${bwe_slots.length + 1}`;
        bwe_addSlot(name, structuredClone(data));
        bwe_activeSlotIndex = bwe_slots.length - 1;
        logMessage(`Copied to new slot "${name}".`);
    };
    worldEditElements.w_copy.onSelect = function () {
        worldEditElements.w_copy.rawOnSelect();
        selectElement(w_state.lastNonWorldEditElement);
    };

    worldEditElements.w_cut.rawOnSelect = function () {
        const data = bwe_copySelection(true);
        if (!data) return;
        w_state.clipboard = data;
        updatePastePreviewCanvas();
        const sel = w_state.selection;
        const name = `Cut ${sel.w}×${sel.h} #${bwe_slots.length + 1}`;
        bwe_addSlot(name, structuredClone(data));
        bwe_activeSlotIndex = bwe_slots.length - 1;
        logMessage(`Cut to new slot "${name}".`);
    };
    worldEditElements.w_cut.onSelect = function () {
        worldEditElements.w_cut.rawOnSelect();
        selectElement(w_state.lastNonWorldEditElement);
    };
}

// ─────────────────────────────────────────────
//  SETUP & HOOKS
// ─────────────────────────────────────────────
modifySelectElement();
addWorldEditElements(worldEditElements);
addWorldEditKeybinds();

runAfterReset(() => {
    if (w_deselectOnResetSetting && w_deselectOnResetSetting.value)
        w_state.selection = null;
});
runAfterReset(updatePastePreviewCanvas);

renderPostPixel(renderSelection);
renderPostPixel(renderPastePreview);

// Mobile pointer events (kept from worldEdit.js, extended with pointerup for paste confirm)
let addedCustomEventListeners = false;
runAfterReset(() => {
    if (addedCustomEventListeners) return;
    gameCanvas.addEventListener("pointerdown", (e) => {
        if (elements[currentElement] && elements[currentElement].onPointerDown)
            elements[currentElement].onPointerDown(e);
    }, { passive: false });
    gameCanvas.addEventListener("pointerup", (e) => {
        if (elements[currentElement] && elements[currentElement].onPointerUp)
            elements[currentElement].onPointerUp(e);
    }, { passive: false });
    gameCanvas.addEventListener("pointermove", (e) => {
        if (elements[currentElement] && elements[currentElement].onPointerMove)
            elements[currentElement].onPointerMove(e);
    }, { passive: false });
    document.addEventListener("pointermove", (e) => {
        if (elements[currentElement] && elements[currentElement].onPointerMoveAnywhere)
            elements[currentElement].onPointerMoveAnywhere(e);
    });
    addedCustomEventListeners = true;
});

// Cancel anchor when switching away from paste
const originalSelectElement2 = selectElement;
selectElement = (element) => {
    if (element !== "w_paste") bwe_pasteAnchored = false;
    originalSelectElement2(element);
};

// Inject UI after page loads
window.addEventListener("load", () => {
    bwe_injectStyles();
    bwe_createPanel();
    bwe_createToolbarButton();
    bwe_wrapCopyCut();
    bwe_renderPanel();
});
