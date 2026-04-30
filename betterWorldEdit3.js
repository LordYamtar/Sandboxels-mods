"use strict";
// betterWorldEdit.js
// Replaces and extends worldEdit.js with multi-slot clipboard, portal autofill, etc.

(function() {

    // ==================================================
    //  STATE
    // ==================================================
    let bwe_selection = null;           // {x1, y1, x2, y2} normalized
    let bwe_selecting = false;         // mouse drag in progress
    let bwe_clipboardSlots = [];       // [{name, data}]  data: 2D array of pixel objects (or null)
    let bwe_activePasteSlot = null;    // index into bwe_clipboardSlots or null
    let bwe_pasteAnchor = null;        // {x, y} in world grid
    let bwe_autoFillState = null;      // { baseSlotIndex, dMap, count, baseData } for "+ Autofill Next"
    let bwe_panelVisible = false;

    // ==================================================
    //  HELPER: get current cursor position (world grid coords)
    // ==================================================
    function getCursorPos() {
        if (window.mmm_locked) {
            return { x: mmm_cursor.x, y: mmm_cursor.y };
        }
        return { x: mousePos.x, y: mousePos.y };
    }

    // ==================================================
    //  HELPER: pixel data snapshot from selection
    // ==================================================
    function snapshotSelection() {
        if (!bwe_selection) return null;
        const { x1, y1, x2, y2 } = bwe_selection;
        const w = x2 - x1 + 1;
        const h = y2 - y1 + 1;
        const data = [];
        for (let dy = 0; dy < h; dy++) {
            const row = [];
            for (let dx = 0; dx < w; dx++) {
                const px = x1 + dx;
                const py = y1 + dy;
                const pixel = pixelMap[px]?.[py];
                if (pixel && !pixel.del) {
                    const clone = {};
                    for (const key in pixel) {
                        if (key !== 'x' && key !== 'y' && key !== 'del') {
                            clone[key] = pixel[key];
                        }
                    }
                    clone.element = pixel.element;
                    row.push(clone);
                } else {
                    row.push(null);
                }
            }
            data.push(row);
        }
        return data;
    }

    // ==================================================
    //  CLIPBOARD SLOT MANAGEMENT
    // ==================================================
    function addSlot(name, data) {
        bwe_clipboardSlots.push({ name, data });
        refreshSlotList();
    }

    function removeSlot(index) {
        bwe_clipboardSlots.splice(index, 1);
        if (bwe_activePasteSlot === index) bwe_activePasteSlot = null;
        else if (bwe_activePasteSlot > index) bwe_activePasteSlot--;
        refreshSlotList();
    }

    function renameSlot(index, newName) {
        bwe_clipboardSlots[index].name = newName;
        refreshSlotList();
    }

    function duplicateSlot(index) {
        const slot = bwe_clipboardSlots[index];
        addSlot(slot.name + " (copy)", JSON.parse(JSON.stringify(slot.data)));
    }

    function moveSlotUp(index) {
        if (index <= 0) return;
        [bwe_clipboardSlots[index - 1], bwe_clipboardSlots[index]] = [bwe_clipboardSlots[index], bwe_clipboardSlots[index - 1]];
        if (bwe_activePasteSlot === index) bwe_activePasteSlot--;
        else if (bwe_activePasteSlot === index - 1) bwe_activePasteSlot++;
        refreshSlotList();
    }

    function moveSlotDown(index) {
        if (index >= bwe_clipboardSlots.length - 1) return;
        [bwe_clipboardSlots[index], bwe_clipboardSlots[index + 1]] = [bwe_clipboardSlots[index + 1], bwe_clipboardSlots[index]];
        if (bwe_activePasteSlot === index) bwe_activePasteSlot++;
        else if (bwe_activePasteSlot === index + 1) bwe_activePasteSlot--;
        refreshSlotList();
    }

    // ==================================================
    //  SLOT DATA TRANSFORMATIONS (Rotate, Flip)
    // ==================================================
    function rotateSlotData(data) {
        const h = data.length;
        const w = h > 0 ? data[0].length : 0;
        const newData = [];
        for (let x = 0; x < w; x++) {
            const newRow = [];
            for (let y = 0; y < h; y++) {
                newRow.push(data[y][w - 1 - x]);
            }
            newData.push(newRow);
        }
        return newData;
    }

    function flipHorizontally(data) {
        return data.map(row => row.slice().reverse());
    }

    function flipVertically(data) {
        return data.slice().reverse();
    }

    // ==================================================
    //  PASTE LOGIC (click-to-confirm)
    // ==================================================
    function startPaste(slotIndex) {
        bwe_activePasteSlot = slotIndex;
        bwe_pasteAnchor = null;
        updatePasteButtonState();
    }

    function updatePasteButtonState() {
        const btn = document.getElementById('bwe-paste-btn');
        if (!btn) return;
        if (bwe_activePasteSlot === null) {
            btn.textContent = '📌 Paste';
            btn.title = 'Select a slot to paste';
        } else if (bwe_pasteAnchor === null) {
            btn.textContent = '📌 Set Anchor';
            btn.title = 'Click to set paste anchor';
        } else {
            const cursor = getCursorPos();
            const dx = Math.abs(cursor.x - bwe_pasteAnchor.x);
            const dy = Math.abs(cursor.y - bwe_pasteAnchor.y);
            btn.textContent = (dx <= 1 && dy <= 1) ? '✔ Confirm Paste' : '📌 Reposition';
            btn.title = 'Click to confirm / reposition';
        }
    }

    function handlePasteAction() {
        if (bwe_activePasteSlot === null) return;
        const cursor = getCursorPos();
        if (bwe_pasteAnchor === null) {
            bwe_pasteAnchor = { x: cursor.x, y: cursor.y };
        } else {
            const dx = Math.abs(cursor.x - bwe_pasteAnchor.x);
            const dy = Math.abs(cursor.y - bwe_pasteAnchor.y);
            if (dx <= 1 && dy <= 1) {
                performPaste(bwe_pasteAnchor.x, bwe_pasteAnchor.y);
                bwe_activePasteSlot = null;
                bwe_pasteAnchor = null;
            } else {
                bwe_pasteAnchor = { x: cursor.x, y: cursor.y };
            }
        }
        updatePasteButtonState();
    }

    function performPaste(anchorX, anchorY) {
        if (bwe_activePasteSlot === null) return;
        const data = bwe_clipboardSlots[bwe_activePasteSlot].data;
        const h = data.length;
        const w = h > 0 ? data[0].length : 0;
        for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++) {
                const pixelData = data[dy][dx];
                if (!pixelData) continue;
                const worldX = anchorX + dx;
                const worldY = anchorY + dy;
                if (worldX < 0 || worldX > width || worldY < 0 || worldY > height) continue;
                if (pixelMap[worldX]?.[worldY]) continue; // don't overwrite
                const newPixel = new Pixel(worldX, worldY, pixelData.element);
                // copy properties
                for (const key in pixelData) {
                    if (key !== 'element' && key !== 'x' && key !== 'y') {
                        newPixel[key] = pixelData[key];
                    }
                }
                pixelMap[worldX][worldY] = newPixel;
                currentPixels.push(newPixel);
            }
        }
        logMessage(`Pasted slot "${bwe_clipboardSlots[bwe_activePasteSlot].name}"`);
    }

    // ==================================================
    //  SELECTION TOOL
    // ==================================================
    function startSelection() {
        bwe_selecting = true;
        bwe_selection = null;
        // cancel any current tool
        if (currentElement !== 'unknown') selectElement('unknown');
    }

    function updateSelection(startX, startY, endX, endY) {
        const x1 = Math.min(startX, endX);
        const y1 = Math.min(startY, endY);
        const x2 = Math.max(startX, endX);
        const y2 = Math.max(startY, endY);
        bwe_selection = { x1, y1, x2, y2 };
    }

    function endSelection() {
        bwe_selecting = false;
    }

    // ==================================================
    //  PORTAL AUTOFILL
    // ==================================================
    function detectPortalDiff(slot1Data, slot2Data) {
        const h = slot1Data.length;
        const w = h > 0 ? slot1Data[0].length : 0;
        if (slot2Data.length !== h || (h > 0 && slot2Data[0].length !== w)) return null;
        const dMap = [];
        for (let y = 0; y < h; y++) {
            const row = [];
            for (let x = 0; x < w; x++) {
                const p1 = slot1Data[y][x];
                const p2 = slot2Data[y][x];
                if (p1 && p2 && p1.element === p2.element &&
                    (p1.element === 'portal_in' || p1.element === 'portal_out') &&
                    typeof p1.channel === 'number' && typeof p2.channel === 'number' &&
                    p1.channel !== p2.channel) {
                    row.push(p2.channel - p1.channel);
                } else {
                    row.push(NaN);
                }
            }
            dMap.push(row);
        }
        return dMap;
    }

    function generateAutofillSlot(slotIndex, dMap, iteration) {
        const baseData = bwe_clipboardSlots[slotIndex].data;
        const newData = JSON.parse(JSON.stringify(baseData));
        const h = newData.length;
        const w = h > 0 ? newData[0].length : 0;
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                const d = dMap[y]?.[x];
                if (!isNaN(d)) {
                    const pixel = newData[y][x];
                    if (pixel) {
                        pixel.channel = (pixel.channel || 0) + d * iteration;
                    }
                }
            }
        }
        return newData;
    }

    function startPortalAutofill() {
        if (bwe_clipboardSlots.length < 2) {
            logMessage("Need at least 2 clipboard slots for autofill.");
            return;
        }
        const slotNames = bwe_clipboardSlots.map((s, i) => `${i}: ${s.name}`);
        promptChoose("Select the first slot (base):", slotNames, (choice1) => {
            const idx1 = slotNames.indexOf(choice1);
            if (idx1 < 0) return;
            promptChoose("Select the second slot (pattern step):", slotNames, (choice2) => {
                const idx2 = slotNames.indexOf(choice2);
                if (idx2 < 0 || idx1 === idx2) return;
                const dMap = detectPortalDiff(bwe_clipboardSlots[idx1].data, bwe_clipboardSlots[idx2].data);
                if (!dMap) {
                    logMessage("Slots must have identical dimensions and portal pixels.");
                    return;
                }
                bwe_autoFillState = {
                    baseSlotIndex: idx1,
                    dMap,
                    count: 1, // next iteration to generate
                };
                document.getElementById('bwe-autofill-next-btn').style.display = 'inline-block';
                logMessage("Portal autofill ready. Use '+ Autofill Next' to paste next iteration.");
            });
        });
    }

    function handleAutofillNext() {
        if (!bwe_autoFillState) return;
        const { baseSlotIndex, dMap, count } = bwe_autoFillState;
        const newData = generateAutofillSlot(baseSlotIndex, dMap, count);
        bwe_autoFillState.count++;
        // set active paste with this new data (temporary slot not added to clipboard)
        const tempName = `autofill-${count - 1}`;
        const tempSlot = { name: tempName, data: newData };
        bwe_clipboardSlots.push(tempSlot);
        const slotIndex = bwe_clipboardSlots.length - 1;
        bwe_activePasteSlot = slotIndex;
        bwe_pasteAnchor = null;
        updatePasteButtonState();
        // schedule removal after paste? We'll keep it in clipboard for now; user can delete.
    }

    // ==================================================
    //  EXPORT / IMPORT SLOTS
    // ==================================================
    function exportSlots() {
        const exportData = bwe_clipboardSlots.map(s => ({ name: s.name, data: s.data }));
        const json = JSON.stringify(exportData);
        const blob = new Blob([json], { type: 'application/json' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = 'betterworldedit_clipboard.json';
        a.click();
        URL.revokeObjectURL(url);
    }

    function importSlots() {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.addEventListener('change', (e) => {
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = (ev) => {
                try {
                    const imported = JSON.parse(ev.target.result);
                    if (!Array.isArray(imported)) throw new Error('Invalid format');
                    imported.forEach(item => {
                        if (item.name && Array.isArray(item.data)) {
                            addSlot(item.name, item.data);
                        }
                    });
                    logMessage(`Imported ${imported.length} slots.`);
                } catch (err) {
                    logMessage('Failed to import slots.');
                }
            };
            reader.readAsText(file);
        });
        input.click();
    }

    // ==================================================
    //  RENDER HOOK: selection & paste preview
    // ==================================================
    function renderHook(ctx) {
        // Draw selection rectangle
        if (bwe_selection && !bwe_selecting) {
            const { x1, y1, x2, y2 } = bwe_selection;
            ctx.save();
            ctx.strokeStyle = '#7cff62';
            ctx.lineWidth = 2;
            ctx.setLineDash([pixelSize, pixelSize]);
            ctx.strokeRect(x1 * pixelSize, y1 * pixelSize,
                (x2 - x1 + 1) * pixelSize, (y2 - y1 + 1) * pixelSize);
            ctx.restore();
        }
        // Draw paste preview (if slot active and not consuming)
        if (bwe_activePasteSlot !== null) {
            const cursor = bwe_pasteAnchor || getCursorPos();
            const data = bwe_clipboardSlots[bwe_activePasteSlot].data;
            const h = data.length;
            const w = h > 0 ? data[0].length : 0;
            ctx.save();
            ctx.fillStyle = 'rgba(0, 255, 255, 0.2)';
            ctx.fillRect(cursor.x * pixelSize, cursor.y * pixelSize, w * pixelSize, h * pixelSize);
            ctx.strokeStyle = '#00ffff';
            ctx.lineWidth = 2;
            ctx.setLineDash([pixelSize, pixelSize]);
            ctx.strokeRect(cursor.x * pixelSize, cursor.y * pixelSize, w * pixelSize, h * pixelSize);
            ctx.restore();
        }
    }

    // ==================================================
    //  MOUSE / POINTER HANDLERS FOR SELECTION
    // ==================================================
    let selStartPos = null;
    function onPointerDown(e) {
        if (!bwe_selecting) return;
        if (e.button !== 0 && e.type !== 'touchstart') return;
        const canvas = document.getElementById('game');
        const pos = getMousePos(canvas, e);
        selStartPos = { x: pos.x, y: pos.y };
        // prevent default behavior while selecting
        e.preventDefault();
    }

    function onPointerMove(e) {
        if (!bwe_selecting || !selStartPos) return;
        const canvas = document.getElementById('game');
        const pos = getMousePos(canvas, e);
        updateSelection(selStartPos.x, selStartPos.y, pos.x, pos.y);
        e.preventDefault();
    }

    function onPointerUp(e) {
        if (!bwe_selecting) return;
        endSelection();
        selStartPos = null;
    }

    // ==================================================
    //  BUILD UI PANEL
    // ==================================================
    function buildUI() {
        // Styles
        const style = document.createElement('style');
        style.textContent = `
            #bwe-panel {
                position: fixed;
                bottom: 10px;
                left: 50%;
                transform: translateX(-50%);
                background: rgba(20, 20, 20, 0.92);
                border: 2px solid #7cff62;
                border-radius: 12px;
                padding: 12px;
                z-index: 10000;
                display: none;
                flex-direction: column;
                gap: 8px;
                max-width: 90vw;
                max-height: 50vh;
                overflow-y: auto;
                font-family: sans-serif;
                color: #eee;
            }
            #bwe-panel button {
                background: #333;
                border: 1px solid #7cff62;
                color: #7cff62;
                padding: 4px 10px;
                border-radius: 5px;
                cursor: pointer;
                white-space: nowrap;
            }
            #bwe-panel button:hover { background: #444; }
            #bwe-panel .bwe-slot-row {
                display: flex;
                align-items: center;
                gap: 5px;
                margin: 4px 0;
                border-bottom: 1px solid #444;
                padding-bottom: 4px;
            }
            #bwe-panel .bwe-slot-name {
                flex: 1;
                min-width: 80px;
            }
            #bwe-panel .bwe-tool-btns { display: none; }
            #bwe-panel .bwe-slot-row[data-expanded="true"] .bwe-tool-btns { display: flex; }
            .bwe-selected-slot { background: #0a3a0a; }
        `;
        document.head.appendChild(style);

        // Panel container
        const panel = document.createElement('div');
        panel.id = 'bwe-panel';
        // Quick actions row
        const quickRow = document.createElement('div');
        quickRow.style.display = 'flex'; quickRow.style.gap = '5px';
        const btnSelect = document.createElement('button'); btnSelect.textContent = 'Select'; btnSelect.onclick = () => { startSelection(); };
        const btnDeselect = document.createElement('button'); btnDeselect.textContent = 'Deselect'; btnDeselect.onclick = () => { bwe_selection = null; };
        const btnCopy = document.createElement('button'); btnCopy.textContent = 'Copy to New Slot'; btnCopy.onclick = () => {
            if (!bwe_selection) { logMessage("No selection."); return; }
            const data = snapshotSelection();
            if (data) addSlot('Slot ' + (bwe_clipboardSlots.length + 1), data);
        };
        const btnCut = document.createElement('button'); btnCut.textContent = 'Cut to New Slot'; btnCut.onclick = () => {
            if (!bwe_selection) { logMessage("No selection."); return; }
            const data = snapshotSelection();
            if (data) {
                const { x1, y1, x2, y2 } = bwe_selection;
                for (let y = y1; y <= y2; y++) {
                    for (let x = x1; x <= x2; x++) {
                        if (pixelMap[x]?.[y]) deletePixel(x, y);
                    }
                }
                addSlot('Slot ' + (bwe_clipboardSlots.length + 1), data);
                bwe_selection = null;
            }
        };
        const btnDelete = document.createElement('button'); btnDelete.textContent = 'Delete'; btnDelete.onclick = () => {
            if (!bwe_selection) return;
            const { x1, y1, x2, y2 } = bwe_selection;
            for (let y = y1; y <= y2; y++) {
                for (let x = x1; x <= x2; x++) {
                    if (pixelMap[x]?.[y]) deletePixel(x, y);
                }
            }
            bwe_selection = null;
        };
        quickRow.append(btnSelect, btnDeselect, btnCopy, btnCut, btnDelete);
        panel.appendChild(quickRow);

        // Paste button (click-to-confirm)
        const pasteBtn = document.createElement('button');
        pasteBtn.id = 'bwe-paste-btn';
        pasteBtn.textContent = '📌 Paste';
        pasteBtn.onclick = handlePasteAction;
        panel.appendChild(pasteBtn);

        // Slot list container
        const slotList = document.createElement('div');
        slotList.id = 'bwe-slot-list';
        panel.appendChild(slotList);

        // Export/Import
        const eiRow = document.createElement('div');
        eiRow.style.display = 'flex'; eiRow.style.gap = '5px';
        const btnExport = document.createElement('button'); btnExport.textContent = 'Export Slots'; btnExport.onclick = exportSlots;
        const btnImport = document.createElement('button'); btnImport.textContent = 'Import Slots'; btnImport.onclick = importSlots;
        eiRow.append(btnExport, btnImport);
        panel.appendChild(eiRow);

        // Portal Autofill
        const autofillRow = document.createElement('div');
        const btnAutofill = document.createElement('button'); btnAutofill.textContent = 'Autofill Portals'; btnAutofill.onclick = startPortalAutofill;
        const btnAutofillNext = document.createElement('button');
        btnAutofillNext.id = 'bwe-autofill-next-btn';
        btnAutofillNext.textContent = '+ Autofill Next';
        btnAutofillNext.style.display = 'none';
        btnAutofillNext.onclick = handleAutofillNext;
        autofillRow.append(btnAutofill, btnAutofillNext);
        panel.appendChild(autofillRow);

        document.body.appendChild(panel);

        // Toolbar button
        const toolbar = document.getElementById('toolControls');
        if (toolbar) {
            const editBtn = document.createElement('button');
            editBtn.className = 'controlButton';
            editBtn.textContent = '🛠️ Edit';
            editBtn.title = 'Better WorldEdit';
            editBtn.onclick = () => {
                bwe_panelVisible = !bwe_panelVisible;
                panel.style.display = bwe_panelVisible ? 'flex' : 'none';
            };
            toolbar.appendChild(editBtn);
        }

        // Refresh slot list initially
        refreshSlotList();
    }

    function refreshSlotList() {
        const list = document.getElementById('bwe-slot-list');
        if (!list) return;
        list.innerHTML = '';
        bwe_clipboardSlots.forEach((slot, index) => {
            const row = document.createElement('div');
            row.className = 'bwe-slot-row';
            if (bwe_activePasteSlot === index) row.classList.add('bwe-selected-slot');

            const nameSpan = document.createElement('span');
            nameSpan.className = 'bwe-slot-name';
            nameSpan.textContent = slot.name;
            nameSpan.contentEditable = 'false';
            nameSpan.ondblclick = () => {
                nameSpan.contentEditable = 'true';
                nameSpan.focus();
            };
            nameSpan.onblur = () => {
                nameSpan.contentEditable = 'false';
                if (nameSpan.textContent.trim() && nameSpan.textContent !== slot.name) {
                    renameSlot(index, nameSpan.textContent.trim());
                }
            };
            nameSpan.onkeydown = (e) => {
                if (e.key === 'Enter') { e.preventDefault(); nameSpan.blur(); }
            };

            const selectBtn = document.createElement('button');
            selectBtn.textContent = 'Paste';
            selectBtn.onclick = () => startPaste(index);

            const renameBtn = document.createElement('button');
            renameBtn.textContent = '✏️';
            renameBtn.onclick = () => { nameSpan.contentEditable = 'true'; nameSpan.focus(); };

            const dupBtn = document.createElement('button');
            dupBtn.textContent = '🔁';
            dupBtn.onclick = () => duplicateSlot(index);

            const delBtn = document.createElement('button');
            delBtn.textContent = '❌';
            delBtn.onclick = () => removeSlot(index);

            // Move up/down
            const upBtn = document.createElement('button'); upBtn.textContent = '▲'; upBtn.onclick = () => moveSlotUp(index);
            const downBtn = document.createElement('button'); downBtn.textContent = '▼'; downBtn.onclick = () => moveSlotDown(index);

            // Expand edit tools
            const toolsDiv = document.createElement('div');
            toolsDiv.className = 'bwe-tool-btns';
            const expandBtn = document.createElement('button');
            expandBtn.textContent = '⚒️';
            expandBtn.onclick = () => {
                const expanded = row.getAttribute('data-expanded') === 'true';
                row.setAttribute('data-expanded', expanded ? 'false' : 'true');
            };
            const rotateBtn = document.createElement('button'); rotateBtn.textContent = '↻'; rotateBtn.onclick = () => {
                bwe_clipboardSlots[index].data = rotateSlotData(bwe_clipboardSlots[index].data);
                refreshSlotList();
            };
            const flipHBtn = document.createElement('button'); flipHBtn.textContent = '⇔'; flipHBtn.onclick = () => {
                bwe_clipboardSlots[index].data = flipHorizontally(bwe_clipboardSlots[index].data);
                refreshSlotList();
            };
            const flipVBtn = document.createElement('button'); flipVBtn.textContent = '⇕'; flipVBtn.onclick = () => {
                bwe_clipboardSlots[index].data = flipVertically(bwe_clipboardSlots[index].data);
                refreshSlotList();
            };
            toolsDiv.append(rotateBtn, flipHBtn, flipVBtn);

            row.append(nameSpan, selectBtn, renameBtn, dupBtn, delBtn, upBtn, downBtn, expandBtn, toolsDiv);
            list.appendChild(row);
        });
        updatePasteButtonState();
    }

    // ==================================================
    //  EVENT LISTENERS FOR SELECTION
    // ==================================================
    function addSelectionListeners() {
        const canvas = document.getElementById('game');
        if (!canvas) return;
        canvas.addEventListener('pointerdown', onPointerDown);
        canvas.addEventListener('pointermove', onPointerMove);
        canvas.addEventListener('pointerup', onPointerUp);
        canvas.addEventListener('touchstart', onPointerDown, { passive: false });
        canvas.addEventListener('touchmove', onPointerMove, { passive: false });
        canvas.addEventListener('touchend', onPointerUp);
    }

    // ==================================================
    //  INITIALIZATION
    // ==================================================
    function init() {
        buildUI();
        addSelectionListeners();
        renderPostPixel(renderHook);
        // Mobile: keep paste button state updated on cursor move (if panel visible)
        setInterval(() => {
            if (bwe_panelVisible) updatePasteButtonState();
        }, 200);
        console.log('[BetterWorldEdit] Loaded');
    }

    if (typeof runAfterLoad !== 'undefined') {
        runAfterLoad(init);
    } else {
        window.addEventListener('load', init);
    }

})();