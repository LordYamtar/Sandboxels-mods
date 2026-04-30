"use strict";
// betterWorldEdit.js – multi‑slot clipboard, click‑to‑confirm paste, portal autofill
// Replaces and extends worldEdit.js

(function() {

    // ------- Original worldEdit adapted constants and state -------
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

    // Multi‑slot clipboard
    let bwe_clipboardSlots = [];          // { name, data }  data = 2D array of pixel objects (or null)
    let bwe_activePasteSlot = null;       // index of slot currently being pasted, or null
    let bwe_pasteAnchor = null;           // {x,y} world coords of anchored preview; null = floating

    // Portal autofill state
    let bwe_autoFillState = null;         // { baseIndex, dMap, count }

    // Original worldEdit selection state (kept as in original)
    let w_state = {
        firstSelectionPos: {x:0,y:0},
        selection: null,
        clipboard: null,                  // now unused – all data in slots
        lastNonWorldEditElement: "unknown"
    };

    // Prevent automatic category creation; we’ll define elements directly.
    // We use the original worldEdit elements but with modifications.
    let worldEditElements = {};

    // Original render functions (will be registered via renderPostPixel)
    function renderSelection(ctx) {
        const selection = w_state.selection;
        if (!selection) return;
        const isSelecting = (mouseIsDown &&
            (mouseType !== "middle" && mouseType !== "right") &&
            currentElement === "w_select");
        ctx.globalAlpha = 1.0;
        // Fill
        if (!isSelecting) {
            ctx.fillStyle = w_style.selectFill;
            ctx.fillRect(selection.x * pixelSize, selection.y * pixelSize,
                         selection.w * pixelSize, selection.h * pixelSize);
        }
        // Dash if big enough
        if (w_style.selectDash && selection.w >= 2 && selection.h >= 2)
            ctx.setLineDash([pixelSize, pixelSize]);
        ctx.strokeStyle = w_style.selectStroke;
        ctx.lineWidth = w_style.strokeWidth;
        ctx.strokeRect(selection.x * pixelSize, selection.y * pixelSize,
                       selection.w * pixelSize, selection.h * pixelSize);
        ctx.setLineDash([]);
    }

    function renderPastePreview(ctx) {
        if (currentElement !== "w_paste") return;
        if (bwe_activePasteSlot === null) return;
        const slot = bwe_clipboardSlots[bwe_activePasteSlot];
        if (!slot) return;
        const data = slot.data;
        if (!data) return;
        const anchor = bwe_pasteAnchor || getCursorPos();
        const w = data[0].length;
        const h = data.length;
        // Fill
        ctx.fillStyle = w_style.pasteFill;
        ctx.fillRect(anchor.x * pixelSize, anchor.y * pixelSize, w * pixelSize, h * pixelSize);
        // Stroke
        ctx.strokeStyle = w_style.pasteStroke;
        ctx.lineWidth = w_style.strokeWidth;
        ctx.strokeRect(anchor.x * pixelSize, anchor.y * pixelSize, w * pixelSize, h * pixelSize);
        // Draw pixel preview (simple dot pattern)
        const pixelColorBinary = parseInt(
            w_style.pastePixelColor.slice(1).split("").reverse().join(""), 16);
        const imageData = ctx.createImageData(w, h);
        const buffer = new Uint32Array(imageData.data.buffer);
        buffer.fill(0x00000000);
        for (let y = 0; y < h; y++) {
            for (let x = 0; x < w; x++) {
                if (data[y][x]) buffer[y * w + x] = pixelColorBinary;
            }
        }
        ctx.putImageData(imageData, anchor.x * pixelSize, anchor.y * pixelSize);
    }

    // Register these later
    renderPostPixel(renderSelection);
    renderPostPixel(renderPastePreview);

    // ------- Helper: current cursor position -------
    function getCursorPos() {
        if (window.mmm_locked) return { x: mmm_cursor.x, y: mmm_cursor.y };
        return { x: mousePos.x, y: mousePos.y };
    }

    // ------- Snapshot a selection to a 2D array -------
    function snapshotSelection() {
        const sel = w_state.selection;
        if (!sel) return null;
        const w = sel.w, h = sel.h;
        const data = [];
        for (let dy = 0; dy < h; dy++) {
            const row = [];
            for (let dx = 0; dx < w; dx++) {
                const px = sel.x + dx;
                const py = sel.y + dy;
                const pixel = pixelMap[px]?.[py];
                if (pixel && !pixel.del) {
                    const copy = {};
                    for (const key in pixel) {
                        if (key !== "x" && key !== "y" && key !== "del") copy[key] = pixel[key];
                    }
                    copy.element = pixel.element;
                    row.push(copy);
                } else {
                    row.push(null);
                }
            }
            data.push(row);
        }
        return data;
    }

    // ------- Clipboard slot management -------
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
        [bwe_clipboardSlots[index-1], bwe_clipboardSlots[index]] =
            [bwe_clipboardSlots[index], bwe_clipboardSlots[index-1]];
        if (bwe_activePasteSlot === index) bwe_activePasteSlot = index-1;
        else if (bwe_activePasteSlot === index-1) bwe_activePasteSlot = index;
        refreshSlotList();
    }

    function moveSlotDown(index) {
        if (index >= bwe_clipboardSlots.length-1) return;
        [bwe_clipboardSlots[index], bwe_clipboardSlots[index+1]] =
            [bwe_clipboardSlots[index+1], bwe_clipboardSlots[index]];
        if (bwe_activePasteSlot === index) bwe_activePasteSlot = index+1;
        else if (bwe_activePasteSlot === index+1) bwe_activePasteSlot = index;
        refreshSlotList();
    }

    // Transformations (rotate, flip)
    function rotateSlotData(data) {
        const h = data.length, w = data[0].length;
        const newData = [];
        for (let x = 0; x < w; x++) {
            const row = [];
            for (let y = 0; y < h; y++) row.push(data[y][w-1-x]);
            newData.push(row);
        }
        return newData;
    }

    function flipH(data) { return data.map(r => r.slice().reverse()); }
    function flipV(data) { return data.slice().reverse(); }

    // ------- Click‑to‑confirm paste (modified w_paste) -------
    function startPasteMode(slotIndex) {
        bwe_activePasteSlot = slotIndex;
        bwe_pasteAnchor = null;               // floating preview
        selectElement("w_paste");              // activate the paste tool
    }

    worldEditElements.w_paste = {
        onPointerDown: function(e) {
            if (showingMenu) return;
            if (!isPointInWorld(getCursorPos())) return;
            if (e.button !== 0) return;
            if (bwe_activePasteSlot === null) return;

            const cur = getCursorPos();
            if (bwe_pasteAnchor === null) {
                // first click – anchor the preview
                bwe_pasteAnchor = { x: cur.x, y: cur.y };
            } else {
                const dx = Math.abs(cur.x - bwe_pasteAnchor.x);
                const dy = Math.abs(cur.y - bwe_pasteAnchor.y);
                if (dx <= 1 && dy <= 1) {
                    // within 1 tile → confirm paste at anchor
                    executePaste(bwe_pasteAnchor.x, bwe_pasteAnchor.y);
                    bwe_pasteAnchor = null;    // ready for next paste
                } else {
                    // far away → reposition anchor
                    bwe_pasteAnchor = { x: cur.x, y: cur.y };
                }
            }
        },
        shouldStaySelected: true
    };

    function executePaste(anchorX, anchorY) {
        const slot = bwe_clipboardSlots[bwe_activePasteSlot];
        if (!slot) return;
        const data = slot.data;
        const h = data.length, w = data[0].length;
        for (let dy = 0; dy < h; dy++) {
            for (let dx = 0; dx < w; dx++) {
                const pixelData = data[dy][dx];
                if (!pixelData) continue;
                const worldX = anchorX + dx, worldY = anchorY + dy;
                if (worldX < 0 || worldX > width || worldY < 0 || worldY > height) continue;
                if (pixelMap[worldX]?.[worldY]) continue;  // do not overwrite
                const newPixel = new Pixel(worldX, worldY, pixelData.element);
                for (const key in pixelData) {
                    if (key !== "element" && key !== "x" && key !== "y") newPixel[key] = pixelData[key];
                }
                pixelMap[worldX][worldY] = newPixel;
                currentPixels.push(newPixel);
            }
        }
        logMessage(`Pasted slot "${slot.name}"`);
    }

    // Original helpers reused
    function isPointInWorld(point) {
        return point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height;
    }

    // ------- Selection tools (original w_select, etc.) -------
    worldEditElements.w_deselect = {
        onSelect: function() {
            w_state.selection = null;
            logMessage("Deselected area.");
        }
    };

    worldEditElements.w_select_all = {
        onSelect: function() {
            w_state.selection = new Rect(0, 0, width+1, height+1);
            logMessage("Selected everything.");
        }
    };

    worldEditElements.w_select = {
        onPointerDown: function(e) {
            if (showingMenu) return;
            const pos = mousePosToWorldPos({x:e.clientX, y:e.clientY});
            if (!isPointInWorld(pos)) return;
            if (e.button !== 0) return;
            w_state.firstSelectionPos = pos;
        },
        onPointerMoveAnywhere: function(e) {
            if (!mouseIsDown) return;
            if (showingMenu) return;
            if (e.button !== 0) return;
            if (currentElement !== "w_select") return;
            const pos = mousePosToWorldPos({x:e.clientX, y:e.clientY});
            const rect = Rect.fromCorners(w_state.firstSelectionPos, limitPointToWorld(pos)).normalized();
            rect.x2 += 1;
            rect.y2 += 1;
            w_state.selection = rect;
        },
        shouldStaySelected: true
    };

    // These functions mirror original
    function mousePosToWorldPos(pos) {
        const rect = canvas.getBoundingClientRect();
        let x = pos.x - rect.left;
        let y = pos.y - rect.top;
        x = Math.floor((x / canvas.clientWidth) * (width+1));
        y = Math.floor((y / canvas.clientHeight) * (height+1));
        return {x, y};
    }

    function limitPointToWorld(point) {
        return { x: Math.max(0, Math.min(point.x, width)), y: Math.max(0, Math.min(point.y, height)) };
    }

    // Original Rect class
    class Rect {
        constructor(x,y,w,h) { this.x=x; this.y=y; this.w=w; this.h=h; }
        static fromCorners(start, end) { return new Rect(start.x,start.y,end.x-start.x,end.y-start.y); }
        static fromCornersXYXY(x,y,x2,y2) { return new Rect(x,y,x2-x,y2-y); }
        get x2() { return this.x+this.w; } set x2(val) { this.w = val-this.x; }
        get y2() { return this.y+this.h; } set y2(val) { this.h = val-this.y; }
        normalized() { return Rect.fromCornersXYXY(Math.min(this.x,this.x2), Math.min(this.y,this.y2), Math.max(this.x,this.x2), Math.max(this.y,this.y2)); }
    }

    // Copy/Cut/Delete/Fill (modified to work with multi‑slot)
    worldEditElements.w_copy = {
        onSelect: function() {
            const sel = w_state.selection;
            if (!sel) { logMessage("Error: Nothing selected."); return; }
            const data = snapshotSelection();
            if (data) {
                addSlot("Slot "+(bwe_clipboardSlots.length+1), data);
                logMessage(`Copied ${sel.w}x${sel.h} pixels to new slot.`);
            }
        }
    };

    worldEditElements.w_cut = {
        onSelect: function() {
            const sel = w_state.selection;
            if (!sel) { logMessage("Error: Nothing selected."); return; }
            const data = snapshotSelection();
            if (data) {
                // delete pixels in selection
                for (let y=sel.y; y<sel.y2; y++)
                    for (let x=sel.x; x<sel.x2; x++)
                        if (pixelMap[x]?.[y]) deletePixel(x,y);
                addSlot("Slot "+(bwe_clipboardSlots.length+1), data);
                w_state.selection = null;
                logMessage(`Cut ${sel.w}x${sel.h} pixels to new slot.`);
            }
        }
    };

    worldEditElements.w_delete = {
        onSelect: function() {
            const sel = w_state.selection;
            if (!sel) { logMessage("Error: Nothing selected."); return; }
            for (let y=sel.y; y<sel.y2; y++)
                for (let x=sel.x; x<sel.x2; x++)
                    if (pixelMap[x]?.[y]) deletePixel(x,y);
            w_state.selection = null;
            logMessage("Deleted selection.");
        }
    };

    worldEditElements.w_fill = {
        onSelect: function() {
            const sel = w_state.selection;
            const fillElement = w_state.lastNonWorldEditElement;
            if (!sel) { logMessage("Error: Nothing selected."); return; }
            for (let y=sel.y; y<sel.y2; y++) {
                for (let x=sel.x; x<sel.x2; x++) {
                    if (pixelMap[x]?.[y]) continue;
                    const placed = currentPixels.push(new Pixel(x,y,fillElement));
                    if (!placed) continue;
                    if (currentPixels.length > maxPixelCount || !fillElement) {
                        currentPixels[currentPixels.length-1].del = true;
                    } else if (elements[fillElement] && elements[fillElement].onPlace) {
                        elements[fillElement].onPlace(currentPixels[currentPixels.length-1]);
                    }
                }
            }
            logMessage(`Filled selection with ${fillElement}.`);
        }
    };

    // ------- Portal autofill -------
    function portalAutofill() {
        if (bwe_clipboardSlots.length < 2) { logMessage("Need at least 2 slots."); return; }
        const names = bwe_clipboardSlots.map((s,i)=>`${i}: ${s.name}`);
        promptChoose("Select base slot:", names, (c1) => {
            const idx1 = names.indexOf(c1);
            promptChoose("Select pattern step slot:", names, (c2) => {
                const idx2 = names.indexOf(c2);
                if (idx1===idx2 || idx1<0 || idx2<0) return;
                const dMap = computePortalDiff(bwe_clipboardSlots[idx1].data, bwe_clipboardSlots[idx2].data);
                if (!dMap) { logMessage("Slots must be identical except for portal channels."); return; }
                bwe_autoFillState = {
                    baseIndex: idx1,
                    dMap,
                    count: 1
                };
                document.getElementById('bwe-autofill-next-btn').style.display = 'inline';
                logMessage("Autofill ready. Click '+ Autofill Next' to paste next iteration.");
            });
        });
    }

    function computePortalDiff(data1, data2) {
        if (data1.length !== data2.length) return null;
        const h = data1.length, w = data1[0].length;
        if (data2[0].length !== w) return null;
        const dMap = [];
        for (let y=0; y<h; y++) {
            const row = [];
            for (let x=0; x<w; x++) {
                const p1 = data1[y][x], p2 = data2[y][x];
                if (p1 && p2 && p1.element===p2.element &&
                    (p1.element==='portal_in' || p1.element==='portal_out') &&
                    typeof p1.channel==='number' && typeof p2.channel==='number' && p1.channel!==p2.channel) {
                    row.push(p2.channel - p1.channel);
                } else {
                    row.push(NaN);
                }
            }
            dMap.push(row);
        }
        return dMap;
    }

    function handleAutofillNext() {
        if (!bwe_autoFillState) return;
        const { baseIndex, dMap, count } = bwe_autoFillState;
        const base = bwe_clipboardSlots[baseIndex].data;
        const newData = JSON.parse(JSON.stringify(base));
        const h = newData.length, w = newData[0].length;
        for (let y=0; y<h; y++) {
            for (let x=0; x<w; x++) {
                const d = dMap[y][x];
                if (!isNaN(d)) {
                    const pixel = newData[y][x];
                    if (pixel) pixel.channel = (pixel.channel||0) + d * count;
                }
            }
        }
        bwe_autoFillState.count++;
        // add as temporary slot and activate paste
        const tempSlot = { name: `autofill-${count-1}`, data: newData };
        bwe_clipboardSlots.push(tempSlot);
        startPasteMode(bwe_clipboardSlots.length-1);
    }

    // ------- Export / Import -------
    function exportSlots() {
        const obj = bwe_clipboardSlots.map(s=>({name:s.name, data:s.data}));
        const json = JSON.stringify(obj);
        const blob = new Blob([json], {type:'application/json'});
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = 'betterworldedit_clipboard.json';
        a.click();
        URL.revokeObjectURL(a.href);
    }

    function importSlots() {
        const input = document.createElement('input');
        input.type = 'file'; input.accept = '.json';
        input.onchange = e => {
            const file = e.target.files[0];
            const reader = new FileReader();
            reader.onload = ev => {
                try {
                    const arr = JSON.parse(ev.target.result);
                    arr.forEach(s => { if (s.name && Array.isArray(s.data)) addSlot(s.name, s.data); });
                    logMessage(`Imported ${arr.length} slots.`);
                } catch { logMessage('Invalid clipboard file.'); }
            };
            reader.readAsText(file);
        };
        input.click();
    }

    // ------- UI Panel -------
    let panelBuilt = false;
    function buildUI() {
        if (panelBuilt) return;
        const style = document.createElement('style');
        style.textContent = `#bwe-panel {
            position:fixed; bottom:10px; left:50%; transform:translateX(-50%);
            background:rgba(20,20,20,0.92); border:2px solid #7cff62; border-radius:12px;
            padding:12px; z-index:10000; display:none; flex-direction:column; gap:8px;
            max-width:90vw; max-height:50vh; overflow-y:auto; font-family:sans-serif; color:#eee;
        }
        #bwe-panel button {
            background:#333; border:1px solid #7cff62; color:#7cff62; padding:4px 10px;
            border-radius:5px; cursor:pointer; white-space:nowrap;
        }
        #bwe-panel button:hover { background:#444; }
        .bwe-slot-row { display:flex; align-items:center; gap:5px; margin:4px 0; border-bottom:1px solid #444; padding-bottom:4px; }
        .bwe-slot-name { flex:1; min-width:80px; }
        .bwe-tool-btns { display:none; }
        .bwe-slot-row[data-expanded="true"] .bwe-tool-btns { display:flex; gap:3px; }
        .bwe-selected-slot { background:#0a3a0a; }
        `;
        document.head.appendChild(style);

        const panel = document.createElement('div');
        panel.id = 'bwe-panel';

        // Quick actions row
        const actions = document.createElement('div');
        actions.style.display='flex'; actions.style.gap='5px';
        const btnSelect = document.createElement('button'); btnSelect.textContent='Select'; btnSelect.onclick=()=>{
            // Force cursor to 1 pixel (optional)
            if (window.mouseSize) mouseSize=1; selectElement('w_select');
        };
        const btnDeselect = doc('button'); btnDeselect.textContent='Deselect'; btnDeselect.onclick=()=>{
            elements.w_deselect?.onSelect(); selectElement(w_state.lastNonWorldEditElement);
        };
        const btnCopy = doc('button'); btnCopy.textContent='Copy to New Slot'; btnCopy.onclick=()=>elements.w_copy.onSelect();
        const btnCut = doc('button'); btnCut.textContent='Cut to New Slot'; btnCut.onclick=()=>elements.w_cut.onSelect();
        const btnDelete = doc('button'); btnDelete.textContent='Delete'; btnDelete.onclick=()=>elements.w_delete.onSelect();
        const btnFill = doc('button'); btnFill.textContent='Fill'; btnFill.onclick=()=>elements.w_fill.onSelect();
        actions.append(btnSelect, btnDeselect, btnCopy, btnCut, btnDelete, btnFill);
        panel.appendChild(actions);

        // Paste status (read-only)
        const pasteStatus = document.createElement('div');
        pasteStatus.id = 'bwe-paste-status'; pasteStatus.style.fontSize='0.9em';
        panel.appendChild(pasteStatus);

        // Slot list container
        const slotList = document.createElement('div'); slotList.id = 'bwe-slot-list'; panel.appendChild(slotList);

        // Export/Import
        const eiRow = document.createElement('div');
        eiRow.style.display='flex'; eiRow.style.gap='5px';
        const btnExp = doc('button'); btnExp.textContent='Export Slots'; btnExp.onclick=exportSlots;
        const btnImp = doc('button'); btnImp.textContent='Import Slots'; btnImp.onclick=importSlots;
        eiRow.append(btnExp, btnImp); panel.appendChild(eiRow);

        // Portal Autofill
        const afRow = document.createElement('div');
        const btnAF = doc('button'); btnAF.textContent='Autofill Portals'; btnAF.onclick=portalAutofill;
        const btnAFNext = doc('button'); btnAFNext.id = 'bwe-autofill-next-btn';
        btnAFNext.textContent='+ Autofill Next'; btnAFNext.style.display='none'; btnAFNext.onclick=handleAutofillNext;
        afRow.append(btnAF, btnAFNext); panel.appendChild(afRow);

        document.body.appendChild(panel);

        // Toolbar button
        const toolbar = document.getElementById('toolControls');
        if (toolbar) {
            const editBtn = document.createElement('button');
            editBtn.className = 'controlButton';
            editBtn.textContent = '🛠️ Edit';
            editBtn.onclick = ()=>{
                panel.style.display = panel.style.display==='flex' ? 'none' : 'flex';
            };
            toolbar.appendChild(editBtn);
        }

        panelBuilt = true;
        refreshSlotList();
    }

    function doc(tag) { return document.createElement(tag); }

    function refreshSlotList() {
        const list = document.getElementById('bwe-slot-list');
        if (!list) return;
        list.innerHTML = '';
        bwe_clipboardSlots.forEach((slot, idx) => {
            const row = doc('div'); row.className='bwe-slot-row';
            if (bwe_activePasteSlot===idx) row.classList.add('bwe-selected-slot');

            const nameSpan = doc('span'); nameSpan.className='bwe-slot-name'; nameSpan.textContent=slot.name;
            nameSpan.ondblclick=()=>{ nameSpan.contentEditable='true'; nameSpan.focus(); };
            nameSpan.onblur=()=>{
                nameSpan.contentEditable='false'; const newName = nameSpan.textContent.trim();
                if (newName && newName!==slot.name) renameSlot(idx, newName);
            };

            const btnPaste = doc('button'); btnPaste.textContent='Paste'; btnPaste.onclick=()=>startPasteMode(idx);
            const btnRename = doc('button'); btnRename.textContent='✏️'; btnRename.onclick=()=>{ nameSpan.contentEditable='true'; nameSpan.focus(); };
            const btnDup = doc('button'); btnDup.textContent='🔁'; btnDup.onclick=()=>duplicateSlot(idx);
            const btnDel = doc('button'); btnDel.textContent='❌'; btnDel.onclick=()=>removeSlot(idx);
            const btnUp = doc('button'); btnUp.textContent='▲'; btnUp.onclick=()=>moveSlotUp(idx);
            const btnDown = doc('button'); btnDown.textContent='▼'; btnDown.onclick=()=>moveSlotDown(idx);

            // Expand edit tools
            const expandBtn = doc('button'); expandBtn.textContent='⚒️'; expandBtn.onclick=()=>{
                row.dataset.expanded = row.dataset.expanded==='true' ? 'false' : 'true';
            };
            const toolsDiv = doc('div'); toolsDiv.className='bwe-tool-btns';
            const rotBtn = doc('button'); rotBtn.textContent='↻'; rotBtn.onclick=()=>{
                bwe_clipboardSlots[idx].data = rotateSlotData(bwe_clipboardSlots[idx].data); refreshSlotList();
            };
            const flipHBtn = doc('button'); flipHBtn.textContent='⇔'; flipHBtn.onclick=()=>{
                bwe_clipboardSlots[idx].data = flipH(bwe_clipboardSlots[idx].data); refreshSlotList();
            };
            const flipVBtn = doc('button'); flipVBtn.textContent='⇕'; flipVBtn.onclick=()=>{
                bwe_clipboardSlots[idx].data = flipV(bwe_clipboardSlots[idx].data); refreshSlotList();
            };
            toolsDiv.append(rotBtn, flipHBtn, flipVBtn);

            row.append(nameSpan, btnPaste, btnRename, btnDup, btnDel, btnUp, btnDown, expandBtn, toolsDiv);
            list.appendChild(row);
        });

        // Update paste status text
        const status = document.getElementById('bwe-paste-status');
        if (status) {
            if (bwe_activePasteSlot===null) status.textContent = "No paste slot active.";
            else {
                const slot = bwe_clipboardSlots[bwe_activePasteSlot];
                status.textContent = `Pasting: ${slot.name} (${slot.data[0].length}x${slot.data.length})`;
            }
        }
    }

    // ------- Keep track of last non‑world‑edit element -------
    let originalSelectElement = selectElement;
    selectElement = function(element) {
        if (!worldEditElements[element] && element !== "unknown") {
            w_state.lastNonWorldEditElement = element;
        }
        originalSelectElement(element);
    };

    // ------- Add worldEdit elements without creating a category -------
    function addWorldEditElements(elems) {
        for (const name in elems) {
            elements[name] = elems[name];
            // Hide them from element list; no category button will be created.
            elements[name].hidden = true;
            elements[name].category = null; // prevent automatic UI
        }
    }
    addWorldEditElements(worldEditElements);

    // ------- Register pointer listeners for selection -------
    runAfterReset(() => {
        gameCanvas.addEventListener("pointerdown", (e) => {
            if (elements[currentElement]?.onPointerDown) elements[currentElement].onPointerDown(e);
        });
        gameCanvas.addEventListener("pointermove", (e) => {
            if (elements[currentElement]?.onPointerMoveAnywhere) elements[currentElement].onPointerMoveAnywhere(e);
        });
    });

    // ------- Desktop keybinds matching original -------
    keybinds.s = () => { selectElement("w_select"); };
    keybinds.d = () => { elements.w_deselect?.onSelect(); selectElement(w_state.lastNonWorldEditElement); };
    keybinds.a = () => { elements.w_select_all?.onSelect(); };
    keybinds.c = () => { elements.w_copy?.onSelect(); };
    keybinds.v = () => { if (bwe_activePasteSlot !== null) startPasteMode(bwe_activePasteSlot); }; // quick re‑activate last paste
    keybinds.x = () => { elements.w_cut?.onSelect(); };
    keybinds.Delete = () => { elements.w_delete?.onSelect(); };
    keybinds.g = () => { elements.w_fill?.onSelect(); };

    // ------- Initialisation -------
    runAfterLoad(() => {
        buildUI();
        w_state.lastNonWorldEditElement = currentElement; // in case it's not set
        // Ensure paste preview updates status when anchored
        setInterval(updatePasteUI, 200);
    });

    function updatePasteUI() {
        // (optional) Could refresh paste button text etc.
    }

    console.log("[BetterWorldEdit] Loaded successfully.");
})();