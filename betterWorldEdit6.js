"use strict";

(function() {
    // ==========================================
    // STATE & CONFIG
    // ==========================================
    let bwe_slots = [];
    let bwe_activeSlotIndex = -1;
    let bwe_panelVisible = false;
    let bwe_selection = null; // {x, y, w, h}
    let bwe_firstPos = null;
    let bwe_pasteAnchor = null; // For click-to-confirm
    let bwe_autofillState = null; // For portal logic

    const ACCENT = "#7cff62";

    // ==========================================
    // COORDINATE HELPERS
    // ==========================================
    function getCursor() {
        // Compatibility: Mobile Mouse Mod & Zoom.js
        if (window.mmm_locked && typeof mmm_cursor !== 'undefined') {
            return { x: mmm_cursor.x, y: mmm_cursor.y };
        }
        return { x: mousePos.x, y: mousePos.y };
    }

    // ==========================================
    // UI CORE
    // ==========================================
    function setupUI() {
        const toolbar = document.getElementById('toolControls');
        if (!toolbar) return;

        // Toolbar Button
        const btn = document.createElement('button');
        btn.id = "bwe_toggle_btn";
        btn.innerText = "🛠️ Edit";
        btn.style.backgroundColor = "#444";
        btn.onclick = togglePanel;
        toolbar.appendChild(btn);

        // Panel
        const panel = document.createElement('div');
        panel.id = "bwe-panel";
        panel.style = `
            position: fixed; bottom: 10px; left: 50%; transform: translateX(-50%);
            width: 90%; max-width: 500px; max-height: 40vh; overflow-y: auto;
            background: rgba(20, 20, 20, 0.9); border: 2px solid ${ACCENT};
            border-radius: 12px; padding: 10px; z-index: 9999; display: none;
            color: white; font-family: sans-serif;
        `;
        document.body.appendChild(panel);
        refreshPanel();
    }

    function togglePanel() {
        bwe_panelVisible = !bwe_panelVisible;
        document.getElementById('bwe-panel').style.display = bwe_panelVisible ? 'block' : 'none';
        if (!bwe_panelVisible) {
            bwe_activeSlotIndex = -1;
            bwe_selection = null;
        }
    }

    // ==========================================
    // SLOT OPERATIONS
    // ==========================================
    function copySelection(isCut = false) {
        if (!bwe_selection) {
            logMessage("Select an area first!");
            return;
        }
        const data = [];
        for (let y = 0; y < bwe_selection.h; y++) {
            data[y] = [];
            for (let x = 0; x < bwe_selection.w; x++) {
                const worldX = bwe_selection.x + x;
                const worldY = bwe_selection.y + y;
                if (!outOfBounds(worldX, worldY)) {
                    const p = pixelMap[worldX][worldY];
                    data[y][x] = p ? JSON.parse(JSON.stringify(p)) : null;
                    if (isCut) deletePixel(worldX, worldY);
                } else {
                    data[y][x] = null;
                }
            }
        }
        const name = prompt("Slot Name:", "New Slot " + (bwe_slots.length + 1)) || "Unnamed";
        bwe_slots.push({ name, data, w: bwe_selection.w, h: bwe_selection.h });
        bwe_selection = null;
        refreshPanel();
    }

    function transformActive(type) {
        if (bwe_activeSlotIndex === -1) return;
        let slot = bwe_slots[bwe_activeSlotIndex];
        let newData = [];

        if (type === 'rotate') {
            for (let x = 0; x < slot.w; x++) {
                newData[x] = [];
                for (let y = 0; y < slot.h; y++) {
                    newData[x][slot.h - 1 - y] = slot.data[y][x];
                }
            }
            [slot.w, slot.h] = [slot.h, slot.w];
        } else if (type === 'flipH') {
            newData = slot.data.map(row => [...row].reverse());
        } else if (type === 'flipV') {
            newData = [...slot.data].reverse();
        }
        slot.data = newData;
        refreshPanel();
    }

    // ==========================================
    // PORTAL AUTOFILL LOGIC
    // ==========================================
    function runAutofill() {
        const idx1 = parseInt(prompt("Index of First Slot (0-based):"));
        const idx2 = parseInt(prompt("Index of Second Slot (0-based):"));
        if (isNaN(idx1) || isNaN(idx2) || !bwe_slots[idx1] || !bwe_slots[idx2]) return;

        const s1 = bwe_slots[idx1];
        const s2 = bwe_slots[idx2];

        // Identify channel difference from first found portal
        let diff = 0;
        let found = false;
        for (let y = 0; y < s1.h; y++) {
            for (let x = 0; x < s1.w; x++) {
                const p1 = s1.data[y][x];
                const p2 = s2.data[y][x];
                if (p1 && p2 && p1.channel !== undefined && p2.channel !== undefined) {
                    diff = p2.channel - p1.channel;
                    found = true;
                    break;
                }
            }
            if (found) break;
        }

        if (!found) {
            logMessage("No portals with channels found to compare.");
            return;
        }

        // Generate the 3rd iteration
        const nextData = JSON.parse(JSON.stringify(s2.data));
        for (let y = 0; y < s2.h; y++) {
            for (let x = 0; x < s2.w; x++) {
                if (nextData[y][x] && nextData[y][x].channel !== undefined) {
                    nextData[y][x].channel += diff;
                }
            }
        }

        const nextSlot = { name: s2.name + " (Next)", data: nextData, w: s2.w, h: s2.h };
        bwe_slots.push(nextSlot);
        bwe_activeSlotIndex = bwe_slots.length - 1;
        
        bwe_autofillState = { diff, lastSlot: nextSlot };
        refreshPanel();
        logMessage(`Autofill generated with offset: ${diff}`);
    }

    // ==========================================
    // RENDERING & INTERACTION
    // ==========================================
    function handlePasteConfirm(x, y) {
        if (!bwe_pasteAnchor) {
            bwe_pasteAnchor = { x, y };
            return;
        }

        const dx = Math.abs(x - bwe_pasteAnchor.x);
        const dy = Math.abs(y - bwe_pasteAnchor.y);

        if (dx <= 1 && dy <= 1) {
            // Confirm Paste
            const slot = bwe_slots[bwe_activeSlotIndex];
            for (let sy = 0; sy < slot.h; sy++) {
                for (let sx = 0; sx < slot.w; sx++) {
                    const p = slot.data[sy][sx];
                    if (p) {
                        const wx = bwe_pasteAnchor.x + sx;
                        const wy = bwe_pasteAnchor.y + sy;
                        if (!outOfBounds(wx, wy)) {
                            createPixel(p.element, wx, wy);
                            Object.assign(pixelMap[wx][wy], p);
                        }
                    }
                }
            }
            bwe_pasteAnchor = null;
            // If in Autofill sequence, prepare next
            if (bwe_autofillState) {
                // Logic to auto-increment can go here
            }
        } else {
            // Reposition
            bwe_pasteAnchor = { x, y };
        }
    }

    // Hook into game canvas
    window.addEventListener('pointerdown', (e) => {
        if (!bwe_panelVisible) return;
        const cursor = getCursor();

        if (bwe_activeSlotIndex !== -1) {
            handlePasteConfirm(cursor.x, cursor.y);
        } else {
            // Selection logic
            if (!bwe_firstPos) {
                bwe_firstPos = { ...cursor };
            } else {
                const x = Math.min(bwe_firstPos.x, cursor.x);
                const y = Math.min(bwe_firstPos.y, cursor.y);
                const w = Math.abs(bwe_firstPos.x - cursor.x) + 1;
                const h = Math.abs(bwe_firstPos.y - cursor.y) + 1;
                bwe_selection = { x, y, w, h };
                bwe_firstPos = null;
            }
        }
    }, true);

    function bweRender(ctx) {
        if (!bwe_panelVisible) return;
        const cursor = getCursor();

        // Draw Selection
        if (bwe_selection) {
            ctx.strokeStyle = ACCENT;
            ctx.strokeRect(bwe_selection.x * pixelSize, bwe_selection.y * pixelSize, bwe_selection.w * pixelSize, bwe_selection.h * pixelSize);
        }

        // Draw Paste Preview
        if (bwe_activeSlotIndex !== -1) {
            const slot = bwe_slots[bwe_activeSlotIndex];
            const px = bwe_pasteAnchor ? bwe_pasteAnchor.x : cursor.x;
            const py = bwe_pasteAnchor ? bwe_pasteAnchor.y : cursor.y;
            
            ctx.globalAlpha = 0.5;
            ctx.fillStyle = bwe_pasteAnchor ? "#00FF00" : "#00FFFF";
            ctx.fillRect(px * pixelSize, py * pixelSize, slot.w * pixelSize, slot.h * pixelSize);
            ctx.globalAlpha = 1.0;
        }
    }

    renderPostPixel(bweRender); // Register hook

    // ==========================================
    // UI REFRESH
    // ==========================================
    function refreshPanel() {
        const p = document.getElementById('bwe-panel');
        if (!p) return;
        p.innerHTML = `
            <div style="font-weight:bold; margin-bottom:10px; display:flex; justify-content:space-between">
                <span>betterWorldEdit</span>
                <span style="cursor:pointer" onclick="this.parentElement.parentElement.style.display='none'">✖</span>
            </div>
            <div style="margin-bottom:10px;">
                <button onclick="bwe_copySelection()">Select Mode</button>
                <button onclick="bwe_doCopy()">Copy</button>
                <button onclick="bwe_doCut()">Cut</button>
                <button onclick="bwe_runAutofill()">Autofill Portals</button>
            </div>
            <div id="bwe-slots-list"></div>
        `;

        const list = p.querySelector('#bwe-slots-list');
        bwe_slots.forEach((slot, i) => {
            const item = document.createElement('div');
            item.style = `padding:5px; border-bottom:1px solid #444; display:flex; align-items:center; gap:5px; background:${bwe_activeSlotIndex === i ? '#333' : 'transparent'}`;
            item.innerHTML = `
                <span style="flex-grow:1; cursor:pointer" onclick="bwe_selectSlot(${i})">${slot.name} (${slot.w}x${slot.h})</span>
                <button onclick="bwe_transform(${i}, 'rotate')">⚒️</button>
                <button onclick="bwe_moveSlot(${i}, -1)">▲</button>
                <button onclick="bwe_moveSlot(${i}, 1)">▼</button>
                <button onclick="bwe_deleteSlot(${i})" style="color:red">X</button>
            `;
            list.appendChild(item);
        });
    }

    // Expose globals for UI buttons
    window.bwe_copySelection = () => { bwe_activeSlotIndex = -1; bwe_selection = null; logMessage("Click two points to select area."); };
    window.bwe_doCopy = () => copySelection(false);
    window.bwe_doCut = () => copySelection(true);
    window.bwe_selectSlot = (i) => { bwe_activeSlotIndex = i; bwe_pasteAnchor = null; refreshPanel(); };
    window.bwe_transform = (i, type) => { bwe_activeSlotIndex = i; transformActive(type); };
    window.bwe_deleteSlot = (i) => { bwe_slots.splice(i, 1); bwe_activeSlotIndex = -1; refreshPanel(); };
    window.bwe_moveSlot = (i, dir) => {
        if (i + dir < 0 || i + dir >= bwe_slots.length) return;
        const temp = bwe_slots[i];
        bwe_slots[i] = bwe_slots[i + dir];
        bwe_slots[i + dir] = temp;
        refreshPanel();
    };
    window.bwe_runAutofill = runAutofill;

    setupUI();
    console.log("betterWorldEdit.js loaded: Professional editing tools active.");
})();