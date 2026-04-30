"use strict";

/* 
betterWorldEdit.js
Extends worldEdit.js with:
- Toolbar button UI
- Multi-slot clipboard
- Slot editing tools
- Click-to-confirm paste
- Portal autofill system
*/

// Ensure worldEdit is loaded first
dependOn("worldEdit.js", () => {

//// =========================
//// STATE
//// =========================

let bwe = {
    slots: [],
    selectedSlot: null,
    pasteAnchor: null,
    autofill: {
        baseA: null,
        baseB: null,
        step: 0,
        sequence: []
    }
};

//// =========================
//// UI BUTTON (TOP BAR)
//// =========================

function addEditButton() {
    const bar = document.getElementById("toolControls");
    if (!bar) return;

    const btn = document.createElement("button");
    btn.className = "controlButton";
    btn.innerText = "🛠️ Edit";
    btn.onclick = togglePanel;

    bar.appendChild(btn);
}

//// =========================
//// PANEL
//// =========================

let panel;

function togglePanel() {
    if (panel) {
        panel.remove();
        panel = null;
        return;
    }

    panel = document.createElement("div");
    panel.style.position = "fixed";
    panel.style.bottom = "10px";
    panel.style.left = "50%";
    panel.style.transform = "translateX(-50%)";
    panel.style.background = "rgba(20,20,20,0.9)";
    panel.style.border = "2px solid #7cff62";
    panel.style.borderRadius = "12px";
    panel.style.padding = "10px";
    panel.style.zIndex = 9999;
    panel.style.maxHeight = "40vh";
    panel.style.overflowY = "auto";

    document.body.appendChild(panel);

    renderPanel();
}

function renderPanel() {
    if (!panel) return;
    panel.innerHTML = "";

    // ==== BASIC ACTIONS ====
    panel.appendChild(makeBtn("Select", () => selectElement("w_select")));
    panel.appendChild(makeBtn("Deselect", () => elements.w_deselect.rawOnSelect()));
    panel.appendChild(makeBtn("Delete", () => elements.w_delete.rawOnSelect()));

    panel.appendChild(document.createElement("hr"));

    panel.appendChild(makeBtn("Copy → New Slot", copyToSlot));
    panel.appendChild(makeBtn("Cut → New Slot", cutToSlot));

    panel.appendChild(document.createElement("hr"));

    // ==== SLOTS ====
    bwe.slots.forEach((slot, i) => {
        const div = document.createElement("div");
        div.style.border = "1px solid #444";
        div.style.margin = "4px";
        div.style.padding = "4px";

        const title = document.createElement("span");
        title.innerText = slot.name;
        title.style.cursor = "pointer";
        title.onclick = () => {
            bwe.selectedSlot = slot;
            w_state.clipboard = slot.data;
            updatePastePreviewCanvas();
        };

        div.appendChild(title);

        div.appendChild(makeBtn("✏️", () => renameSlot(i)));
        div.appendChild(makeBtn("⧉", () => duplicateSlot(i)));
        div.appendChild(makeBtn("🗑️", () => deleteSlot(i)));

        // reorder
        div.appendChild(makeBtn("▲", () => moveSlot(i, -1)));
        div.appendChild(makeBtn("▼", () => moveSlot(i, 1)));

        // edit tools
        div.appendChild(makeBtn("⚒️", () => openEditTools(i)));

        panel.appendChild(div);
    });

    panel.appendChild(document.createElement("hr"));

    panel.appendChild(makeBtn("Export Slots", exportSlots));
    panel.appendChild(makeBtn("Import Slots", importSlots));

    panel.appendChild(document.createElement("hr"));

    panel.appendChild(makeBtn("Autofill Portals", startAutofill));
    panel.appendChild(makeBtn("+ Autofill Next", autofillNext));
}

function makeBtn(text, fn) {
    const b = document.createElement("button");
    b.innerText = text;
    b.onclick = fn;
    b.style.margin = "2px";
    return b;
}

//// =========================
//// SLOT SYSTEM
//// =========================

function copyToSlot() {
    if (!w_state.selection) return;

    const rect = w_state.selection.normalized();
    const data = [];

    for (let y = rect.y; y < rect.y2; y++) {
        let row = [];
        for (let x = rect.x; x < rect.x2; x++) {
            row.push(pixelMap[x][y]?.element || null);
        }
        data.push(row);
    }

    bwe.slots.push({
        name: "Slot " + (bwe.slots.length + 1),
        data
    });

    renderPanel();
}

function cutToSlot() {
    copyToSlot();
    elements.w_delete.rawOnSelect();
}

function deleteSlot(i) {
    bwe.slots.splice(i, 1);
    renderPanel();
}

function renameSlot(i) {
    const n = prompt("New name:", bwe.slots[i].name);
    if (n) bwe.slots[i].name = n;
    renderPanel();
}

function duplicateSlot(i) {
    const s = JSON.parse(JSON.stringify(bwe.slots[i]));
    s.name += " Copy";
    bwe.slots.push(s);
    renderPanel();
}

function moveSlot(i, dir) {
    const j = i + dir;
    if (j < 0 || j >= bwe.slots.length) return;
    [bwe.slots[i], bwe.slots[j]] = [bwe.slots[j], bwe.slots[i]];
    renderPanel();
}

//// =========================
//// SLOT EDIT TOOLS
//// =========================

function openEditTools(i) {
    const slot = bwe.slots[i];

    const action = prompt("rotate / flipH / flipV");

    if (action === "rotate") {
        slot.data = rotate(slot.data);
    }
    if (action === "flipH") {
        slot.data = slot.data.map(r => r.reverse());
    }
    if (action === "flipV") {
        slot.data.reverse();
    }

    renderPanel();
}

function rotate(grid) {
    return grid[0].map((_, i) => grid.map(r => r[i]).reverse());
}

//// =========================
//// EXPORT / IMPORT
//// =========================

function exportSlots() {
    const blob = new Blob([JSON.stringify(bwe.slots)], {type:"application/json"});
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = "slots.json";
    a.click();
}

function importSlots() {
    const inp = document.createElement("input");
    inp.type = "file";
    inp.onchange = e => {
        const file = e.target.files[0];
        const reader = new FileReader();
        reader.onload = () => {
            bwe.slots = JSON.parse(reader.result);
            renderPanel();
        };
        reader.readAsText(file);
    };
    inp.click();
}

//// =========================
//// CLICK-TO-CONFIRM PASTE
//// =========================

function getMouseWorld() {
    if (window.mmm_locked) return window.mmm_cursor;
    return getMousePos();
}

document.addEventListener("mousedown", () => {
    if (!bwe.selectedSlot) return;
    if (currentElement !== "w_paste") return;

    const pos = getMouseWorld();

    if (!bwe.pasteAnchor) {
        bwe.pasteAnchor = pos;
        return;
    }

    const dx = Math.abs(pos.x - bwe.pasteAnchor.x);
    const dy = Math.abs(pos.y - bwe.pasteAnchor.y);

    if (dx <= 1 && dy <= 1) {
        pasteSlotAt(bwe.selectedSlot, bwe.pasteAnchor);
        bwe.pasteAnchor = null;
    } else {
        bwe.pasteAnchor = pos;
    }
});

function pasteSlotAt(slot, pos) {
    const data = slot.data;

    for (let y = 0; y < data.length; y++) {
        for (let x = 0; x < data[0].length; x++) {
            const el = data[y][x];
            if (!el) continue;
            createPixel(el, pos.x + x, pos.y + y);
        }
    }
}

//// =========================
//// PORTAL AUTOFILL
//// =========================

function startAutofill() {
    if (bwe.slots.length < 2) return;

    bwe.autofill.baseA = bwe.slots[0];
    bwe.autofill.baseB = bwe.slots[1];
    bwe.autofill.step = 0;

    // simple numeric diff detection
    bwe.autofill.sequence = [bwe.autofill.baseA, bwe.autofill.baseB];
}

function autofillNext() {
    const seq = bwe.autofill.sequence;
    if (seq.length < 2) return;

    const a = seq[seq.length - 2];
    const b = seq[seq.length - 1];

    const next = JSON.parse(JSON.stringify(b));

    // naive portal increment logic
    for (let y = 0; y < next.data.length; y++) {
        for (let x = 0; x < next.data[0].length; x++) {
            let val = next.data[y][x];
            if (typeof val === "string" && val.includes("portal")) {
                next.data[y][x] = val + "_next";
            }
        }
    }

    seq.push(next);
    bwe.selectedSlot = next;
    w_state.clipboard = next.data;
    updatePastePreviewCanvas();
}

//// =========================
//// INIT
//// =========================

addEditButton();

});