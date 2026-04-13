// ================================================================
//  PORTAL CHANNEL MANAGER — Sandboxels Mod
//  Version 3.0
//
//  CHANGES FROM v2.0:
//  · Orphan flash completely removed. No automatic canvas flashing.
//  · 🔍 button now flashes that channel's portals red persistently
//    (both IN and OUT, same colour) until the user taps 📡.
//  · 📡 always clears any active flash.
//  · Per-row ⇄ Move button — asks for destination channel, moves
//    all portals, handles label and conflict logic.
//  · Folder assignment now uses a custom tap-friendly modal instead
//    of a text prompt. Shows existing folders as buttons.
//  · "+ Folder" toolbar button creates a new named empty folder.
//
//  HOW TO INSTALL:
//  Host this file publicly and paste its URL into the Mods panel
//  in Sandboxels. A 📡 button will appear near the top-right.
//
//  SAVE COMPATIBILITY:
//  All PCM data is written into the save file under the key "pcm".
//  If this mod is not installed, that key is silently ignored.
// ================================================================

(function () {
    'use strict';

    // ----------------------------------------------------------------
    //  STATE
    // ----------------------------------------------------------------

    // Current project's channel labels.
    // { [channelNumber]: { label: string, folder: string } }
    let pcmData = {};

    // Known folder names (includes folders with no channels assigned).
    // Stored as a plain array of unique strings.
    let pcmFolders = [];

    // Uploaded old project list. null = nothing uploaded.
    let pcmOldData = null;

    // Metadata from the uploaded file: { saveName, exportedAt }
    let pcmOldMeta = null;

    // Merged channel list. null = no merge performed yet.
    let pcmMergedData = null;

    // Active panel tab: 'current' | 'uploaded' | 'merged'
    let pcmActiveTab = 'current';

    // Persistent red highlight state (single channel at a time).
    let pcmFlashChannel = null;   // channel number being flashed, or null
    let pcmFlashTimer   = null;   // setInterval handle
    let pcmFlashState   = false;  // current on/off state


    // ----------------------------------------------------------------
    //  CANVAS COORDINATE HELPERS
    // ----------------------------------------------------------------

    function pcmCoord(n) {
        if (typeof canvasCoord !== 'undefined') return canvasCoord(n);
        if (typeof pixelSize   !== 'undefined') return n * pixelSize;
        return n * 6;
    }

    function pcmPixelSize() {
        return (typeof pixelSize !== 'undefined') ? pixelSize : 6;
    }


    // ----------------------------------------------------------------
    //  SAVE NAME HELPER
    // ----------------------------------------------------------------

    function getCurrentSaveName() {
        if (typeof currentSaveData !== 'undefined' && currentSaveData.name) {
            return currentSaveData.name;
        }
        return 'Untitled Save';
    }


    // ----------------------------------------------------------------
    //  PORTAL SCAN
    // ----------------------------------------------------------------

    function scanPortals() {
        const ins = {}, outs = {};
        if (typeof pixelMap === 'undefined') return { ins, outs, all: new Set() };

        for (let x = 0; x < pixelMap.length; x++) {
            if (!pixelMap[x]) continue;
            for (let y = 0; y < pixelMap[x].length; y++) {
                const p = pixelMap[x][y];
                if (!p || !p.element || !elements[p.element]) continue;
                const ch = parseInt(p.channel) || 0;
                const el = elements[p.element];
                if (el.id === elements.portal_in.id)  ins[ch]  = (ins[ch]  || 0) + 1;
                if (el.id === elements.portal_out.id) outs[ch] = (outs[ch] || 0) + 1;
            }
        }
        const all = new Set(
            [...Object.keys(ins), ...Object.keys(outs)].map(Number)
        );
        return { ins, outs, all };
    }

    function getStatus(ch, ins, outs) {
        const hi = !!ins[ch], ho = !!outs[ch];
        if (hi && ho) return 'ok';
        if (hi)       return 'no_out';
        if (ho)       return 'no_in';
        return 'empty';
    }

    function getPortalsForChannel(ch) {
        const result = [];
        if (typeof pixelMap === 'undefined') return result;
        for (let x = 0; x < pixelMap.length; x++) {
            if (!pixelMap[x]) continue;
            for (let y = 0; y < pixelMap[x].length; y++) {
                const p = pixelMap[x][y];
                if (!p || !p.element || !elements[p.element]) continue;
                if ((parseInt(p.channel) || 0) !== ch) continue;
                const el = elements[p.element];
                if (el.id === elements.portal_in.id || el.id === elements.portal_out.id) {
                    result.push(p);
                }
            }
        }
        return result;
    }


    // ----------------------------------------------------------------
    //  CANVAS OVERLAY
    // ----------------------------------------------------------------

    function getOrCreateOverlay() {
        const gameCanvas = document.querySelector('canvas');
        if (!gameCanvas) return null;

        let overlay = document.getElementById('pcm-overlay');
        if (!overlay) {
            overlay = document.createElement('canvas');
            overlay.id = 'pcm-overlay';
            overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:1000;';
            document.body.appendChild(overlay);
        }

        const rect = gameCanvas.getBoundingClientRect();
        overlay.width        = gameCanvas.width;
        overlay.height       = gameCanvas.height;
        overlay.style.left   = rect.left   + 'px';
        overlay.style.top    = rect.top    + 'px';
        overlay.style.width  = rect.width  + 'px';
        overlay.style.height = rect.height + 'px';

        return overlay;
    }

    function clearOverlay() {
        const o = document.getElementById('pcm-overlay');
        if (o) o.getContext('2d').clearRect(0, 0, o.width, o.height);
    }

    function paintOverlayPixels(ctx, pixels, color) {
        const ps = pcmPixelSize();
        ctx.fillStyle = color;
        for (const p of pixels) {
            if (!p || p.del) continue;
            ctx.fillRect(pcmCoord(p.x), pcmCoord(p.y), ps, ps);
        }
    }


    // ----------------------------------------------------------------
    //  PERSISTENT RED CHANNEL FLASH
    //  Started by the 🔍 button. Cleared when 📡 is tapped.
    //  Only one channel flashes at a time — starting a new one
    //  automatically stops the previous.
    // ----------------------------------------------------------------

    function startChannelFlash(ch) {
        stopChannelFlash();
        pcmFlashChannel = ch;
        pcmFlashState   = false;

        pcmFlashTimer = setInterval(function () {
            pcmFlashState = !pcmFlashState;

            const overlay = getOrCreateOverlay();
            if (!overlay) return;
            const ctx = overlay.getContext('2d');
            ctx.clearRect(0, 0, overlay.width, overlay.height);

            if (pcmFlashState) {
                const portals = getPortalsForChannel(ch);
                paintOverlayPixels(ctx, portals, 'rgba(255, 40, 40, 0.88)');
            }
        }, 420);
    }

    function stopChannelFlash() {
        if (pcmFlashTimer) { clearInterval(pcmFlashTimer); pcmFlashTimer = null; }
        pcmFlashChannel = null;
        pcmFlashState   = false;
        clearOverlay();
    }


    // ----------------------------------------------------------------
    //  HOVER STATUS BAR
    // ----------------------------------------------------------------

    function setupHoverBar() {
        const bar = document.createElement('div');
        bar.id = 'pcm-hoverbar';
        bar.style.cssText = [
            'position:fixed;bottom:0;left:0;right:0;z-index:9995;',
            'background:rgba(6,6,22,0.94);color:#eee;',
            'font-family:monospace;font-size:13px;line-height:1.5;',
            'padding:5px 14px;border-top:2px solid #ff9a00;',
            'display:none;pointer-events:none;'
        ].join('');
        document.body.appendChild(bar);

        setInterval(function () {
            if (typeof mousePos === 'undefined' || typeof getPixel === 'undefined') return;
            let pixel;
            try { pixel = getPixel(mousePos.x, mousePos.y); } catch (e) { return; }

            if (!pixel || !pixel.element || !elements[pixel.element]) {
                bar.style.display = 'none';
                return;
            }

            const el    = elements[pixel.element];
            const isIn  = el.id === elements.portal_in.id;
            const isOut = el.id === elements.portal_out.id;
            if (!isIn && !isOut) { bar.style.display = 'none'; return; }

            const ch        = parseInt(pixel.channel) || 0;
            const type      = isIn ? 'IN ▶' : '◀ OUT';
            const typeColor = isIn ? '#ff9a00' : '#00a2ff';
            const lbl       = (pcmData[ch] && pcmData[ch].label)
                            ? pcmData[ch].label
                            : '<i style="color:#555">no label</i>';
            const fld       = (pcmData[ch] && pcmData[ch].folder)
                            ? '&nbsp;|&nbsp;📁 ' + pcmData[ch].folder
                            : '';

            bar.style.display = 'block';
            bar.innerHTML = (
                'Portal <b style="color:' + typeColor + '">' + type + '</b>' +
                '&nbsp;|&nbsp;Channel <b style="color:#ff9a00">' + ch + '</b>' +
                '&nbsp;|&nbsp;' + lbl + fld
            );
        }, 150);
    }


    // ----------------------------------------------------------------
    //  FOLDER HELPERS
    // ----------------------------------------------------------------

    // Returns a deduplicated sorted list of all known folder names,
    // combining pcmFolders (explicit) and any folder strings found
    // in the channel data (for robustness after manual edits).
    function getAllFolders() {
        const set = new Set(pcmFolders);
        for (const ch in pcmData) {
            if (pcmData[ch] && pcmData[ch].folder) set.add(pcmData[ch].folder);
        }
        return Array.from(set).sort();
    }

    // Adds a folder name to pcmFolders if it is not already present.
    function registerFolder(name) {
        if (name && !pcmFolders.includes(name)) pcmFolders.push(name);
    }


    // ----------------------------------------------------------------
    //  FOLDER PICKER MODAL
    //  A tap-friendly modal that shows existing folders as buttons.
    //  No text input — all typing happens via New Folder elsewhere.
    //  onSelect(folderName) is called with the chosen folder string
    //  (empty string means "remove from folder").
    // ----------------------------------------------------------------

    function showFolderPickerModal(channelNum, currentFolder, onSelect) {
        const existing = document.getElementById('pcm-folder-modal');
        if (existing) existing.remove();

        const folders = getAllFolders();

        const modal = document.createElement('div');
        modal.id = 'pcm-folder-modal';
        modal.style.cssText = [
            'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;',
            'background:rgba(0,0,0,0.82);',
            'display:flex;align-items:center;justify-content:center;'
        ].join('');

        const box = document.createElement('div');
        box.style.cssText = [
            'background:#11112b;border:2px solid #ff9a00;border-radius:10px;',
            'max-width:340px;width:92%;max-height:80vh;',
            'display:flex;flex-direction:column;font-family:monospace;color:#eee;',
            'overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,0.9);'
        ].join('');

        // Header
        const hdr = document.createElement('div');
        hdr.style.cssText = [
            'background:#0f3460;padding:10px 14px;',
            'border-bottom:1px solid #ff9a00;font-size:12px;'
        ].join('');
        hdr.textContent = 'Choose folder for Channel ' + channelNum;
        box.appendChild(hdr);

        // Scrollable button area
        const scroll = document.createElement('div');
        scroll.style.cssText = 'overflow-y:auto;flex:1;padding:8px;display:flex;flex-direction:column;gap:6px;';

        function makePickBtn(label, value, isActive) {
            const btn = document.createElement('button');
            btn.textContent = label;
            btn.style.cssText = [
                'padding:11px 14px;border-radius:5px;cursor:pointer;',
                'font-family:monospace;font-size:12px;text-align:left;',
                'touch-action:manipulation;',
                'background:'  + (isActive ? '#1a3a1a' : '#0a0a1e') + ';',
                'color:'       + (isActive ? '#88ff88' : '#cccccc') + ';',
                'border:1px solid ' + (isActive ? '#448844' : '#303050') + ';'
            ].join('');
            btn.addEventListener('click', function () {
                modal.remove();
                onSelect(value);
            });
            return btn;
        }

        // "No folder" option always first
        scroll.appendChild(makePickBtn('✕  No folder', '', currentFolder === ''));

        if (folders.length === 0) {
            const hint = document.createElement('div');
            hint.style.cssText = 'color:#444466;font-size:11px;padding:8px 4px;text-align:center;';
            hint.textContent = 'No folders yet. Use "+ Folder" in the toolbar to create one.';
            scroll.appendChild(hint);
        } else {
            for (const f of folders) {
                scroll.appendChild(makePickBtn('📁  ' + f, f, f === currentFolder));
            }
        }

        box.appendChild(scroll);

        // Footer — cancel only
        const foot = document.createElement('div');
        foot.style.cssText = [
            'padding:8px 12px;background:#0a0a1e;',
            'border-top:1px solid #1e1e38;'
        ].join('');
        const btnCancel = document.createElement('button');
        btnCancel.textContent = 'Cancel';
        btnCancel.style.cssText = [
            'width:100%;padding:8px;background:#1a0a0a;color:#cc5544;',
            'border:1px solid #884433;border-radius:5px;cursor:pointer;',
            'font-size:12px;font-family:monospace;touch-action:manipulation;'
        ].join('');
        btnCancel.addEventListener('click', function () { modal.remove(); });
        foot.appendChild(btnCancel);
        box.appendChild(foot);

        modal.appendChild(box);
        document.body.appendChild(modal);
    }


    // ----------------------------------------------------------------
    //  NEW FOLDER CREATION
    //  Prompts for a name, adds it to pcmFolders, refreshes toolbar.
    // ----------------------------------------------------------------

    function createNewFolder() {
        promptInput(
            'Enter a name for the new folder:',
            function (name) {
                if (!name) return;
                name = name.trim();
                if (!name) return;
                registerFolder(name);
                renderPanel();
                logMessage('[PCM] Folder "' + name + '" created.');
            },
            'New Folder'
        );
    }


    // ----------------------------------------------------------------
    //  CHANNEL MOVE
    //  Changes every portal pixel of `srcCh` to `dstCh` on the live
    //  pixelMap. Label logic:
    //    - If dstCh has no label entry → copy srcCh's label + folder.
    //    - If dstCh already has a label → keep dstCh's label (no change).
    //  In both cases, srcCh's label entry is deleted afterward.
    // ----------------------------------------------------------------

    function moveChannel(srcCh) {
        promptInput(
            'Move Channel ' + srcCh + ' to which channel number?\n\n' +
            'All portal_in and portal_out pixels on channel ' + srcCh +
            ' will have their channel number changed.',
            function (r) {
                if (r === null || r === '') return;
                const dstCh = parseInt(r);
                if (isNaN(dstCh)) { logMessage('[PCM] Invalid channel number.'); return; }
                if (dstCh === srcCh) { logMessage('[PCM] Source and destination are the same.'); return; }

                const scan  = scanPortals();
                const dstHasPortals = scan.all.has(dstCh);

                function doMove() {
                    // Change all portal pixels on srcCh to dstCh
                    if (typeof pixelMap !== 'undefined') {
                        for (let x = 0; x < pixelMap.length; x++) {
                            if (!pixelMap[x]) continue;
                            for (let y = 0; y < pixelMap[x].length; y++) {
                                const p = pixelMap[x][y];
                                if (!p || !p.element || !elements[p.element]) continue;
                                if ((parseInt(p.channel) || 0) !== srcCh) continue;
                                const el = elements[p.element];
                                if (el.id === elements.portal_in.id || el.id === elements.portal_out.id) {
                                    p.channel = dstCh;
                                }
                            }
                        }
                    }

                    // Label logic
                    const srcLabel = pcmData[srcCh] || null;
                    const dstLabel = pcmData[dstCh] || null;

                    if (srcLabel) {
                        // Only copy source label if destination has no label
                        if (!dstLabel || !dstLabel.label) {
                            pcmData[dstCh] = JSON.parse(JSON.stringify(srcLabel));
                        }
                        // Always remove source label entry
                        delete pcmData[srcCh];
                    }

                    // If the flashing channel was srcCh, update or stop
                    if (pcmFlashChannel === srcCh) {
                        stopChannelFlash();
                        startChannelFlash(dstCh);
                    }

                    renderPanel();
                    logMessage('[PCM] Channel ' + srcCh + ' moved to channel ' + dstCh + '.');
                }

                if (dstHasPortals) {
                    promptConfirm(
                        'Channel ' + dstCh + ' already has portals on the canvas.\n\n' +
                        'Moving channel ' + srcCh + ' onto it will merge their pixels ' +
                        'under channel ' + dstCh + '.\n\nContinue?',
                        function (ok) { if (ok) doMove(); },
                        'Destination Channel In Use'
                    );
                } else {
                    doMove();
                }
            },
            'Move Channel ' + srcCh
        );
    }


    // ----------------------------------------------------------------
    //  EDIT CHANNEL LABEL + FOLDER
    //  Label via promptInput, then folder via the custom picker modal.
    // ----------------------------------------------------------------

    function editChannel(ch) {
        const data = pcmData[ch] || {};

        promptInput(
            'Label for Channel ' + ch + ':\n(current: ' + (data.label || 'none') + ')\n' +
            '(leave empty to clear the label)',
            function (label) {
                if (label === null) return; // cancelled
                if (!pcmData[ch]) pcmData[ch] = { label: '', folder: '' };
                pcmData[ch].label = label.trim();

                // After label is set, open the folder picker
                showFolderPickerModal(ch, pcmData[ch].folder || '', function (chosenFolder) {
                    pcmData[ch].folder = chosenFolder;
                    if (chosenFolder) registerFolder(chosenFolder);
                    renderList();
                });
            },
            'Edit Label — Channel ' + ch
        );
    }

    function manualAddChannel() {
        promptInput(
            'Enter a channel number to manually add a label for.\n' +
            '(Useful for planning channels before placing any portals.)',
            function (r) {
                if (r === null || r === '') return;
                const ch = parseInt(r);
                if (isNaN(ch)) { logMessage('[PCM] Invalid channel number.'); return; }
                if (!pcmData[ch]) pcmData[ch] = { label: '', folder: '' };
                editChannel(ch);
            },
            'Manually Add Channel Label'
        );
    }


    // ----------------------------------------------------------------
    //  EXPORT — CURRENT LIST
    // ----------------------------------------------------------------

    function exportCurrentList() {
        const saveName  = getCurrentSaveName();
        const exportObj = {
            pcmVersion:  1,
            type:        'pcm-single',
            saveName:    saveName,
            exportedAt:  Date.now(),
            folders:     pcmFolders.slice(),
            channelData: JSON.parse(JSON.stringify(pcmData))
        };
        const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = (saveName || 'project').replace(/[^a-z0-9_\-]/gi, '_') + '_channels.json';
        a.click();
    }


    // ----------------------------------------------------------------
    //  EXPORT — COMBINED LIST
    // ----------------------------------------------------------------

    function exportCombinedList() {
        const saveName  = getCurrentSaveName();
        const exportObj = {
            pcmVersion: 1,
            type:       'pcm-combined',
            exportedAt: Date.now(),
            current: {
                saveName:    saveName,
                folders:     pcmFolders.slice(),
                channelData: JSON.parse(JSON.stringify(pcmData))
            },
            uploaded: {
                saveName:    pcmOldMeta ? pcmOldMeta.saveName   : 'Unknown',
                exportedAt:  pcmOldMeta ? pcmOldMeta.exportedAt : null,
                channelData: JSON.parse(JSON.stringify(pcmOldData || {}))
            },
            merged: {
                channelData: JSON.parse(JSON.stringify(pcmMergedData || {}))
            }
        };
        const blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
        const a    = document.createElement('a');
        a.href     = URL.createObjectURL(blob);
        a.download = (saveName || 'project').replace(/[^a-z0-9_\-]/gi, '_') + '_combined.json';
        a.click();
    }


    // ----------------------------------------------------------------
    //  IMPORT — OLD PROJECT LIST
    // ----------------------------------------------------------------

    function importOldList() {
        const input    = document.createElement('input');
        input.type     = 'file';
        input.accept   = '.json';

        input.addEventListener('change', function (e) {
            const file = e.target.files[0];
            if (!file) return;

            const reader = new FileReader();
            reader.onload = function (ev) {
                let parsed;
                try { parsed = JSON.parse(ev.target.result); }
                catch (err) { logMessage('[PCM] Import failed — not valid JSON.'); return; }

                if (!parsed.pcmVersion) {
                    logMessage('[PCM] Import failed — not a valid PCM file.'); return;
                }

                if (parsed.type === 'pcm-combined') {
                    promptConfirm(
                        'This is a combined PCM export file.\n\n' +
                        'OK  →  Load the Merged section as the reference list.\n' +
                        'Cancel  →  Load the Current section instead.',
                        function (useMerged) {
                            const section = useMerged ? parsed.merged : parsed.current;
                            if (!section || !section.channelData) {
                                logMessage('[PCM] Selected section is empty.'); return;
                            }
                            loadOldData(section.channelData, {
                                saveName:   section.saveName || (useMerged ? 'Merged' : 'Current'),
                                exportedAt: parsed.exportedAt || Date.now()
                            });
                        },
                        'Import Combined PCM File'
                    );
                } else {
                    if (!parsed.channelData) {
                        logMessage('[PCM] Import failed — channelData missing.'); return;
                    }
                    loadOldData(parsed.channelData, {
                        saveName:   parsed.saveName   || 'Uploaded Project',
                        exportedAt: parsed.exportedAt || Date.now()
                    });
                }
            };
            reader.readAsText(file);
        });

        input.click();
    }

    function loadOldData(channelData, meta) {
        pcmOldData = channelData;
        pcmOldMeta = meta;

        const conflicts = Object.keys(channelData)
            .map(Number)
            .filter(function (ch) { return pcmData[ch] !== undefined; });

        if (conflicts.length > 0) {
            showConflictModal(conflicts);
        } else {
            buildAutoMerge([]);
            pcmActiveTab = 'uploaded';
            renderPanel();
            logMessage(
                '[PCM] Uploaded "' + meta.saveName + '". ' +
                Object.keys(channelData).length + ' channels, no conflicts. Merged tab ready.'
            );
        }
    }


    // ----------------------------------------------------------------
    //  CONFLICT RESOLUTION MODAL
    // ----------------------------------------------------------------

    function showConflictModal(conflicts) {
        const existing = document.getElementById('pcm-conflict-modal');
        if (existing) existing.remove();

        // Default choice: keep current for every conflict
        const choices = {};
        conflicts.forEach(function (ch) { choices[ch] = 'current'; });

        const modal = document.createElement('div');
        modal.id = 'pcm-conflict-modal';
        modal.style.cssText = [
            'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;',
            'background:rgba(0,0,0,0.84);',
            'display:flex;align-items:center;justify-content:center;'
        ].join('');

        const box = document.createElement('div');
        box.style.cssText = [
            'background:#11112b;border:2px solid #ff9a00;border-radius:10px;',
            'max-width:390px;width:94%;max-height:88vh;',
            'display:flex;flex-direction:column;font-family:monospace;color:#eee;',
            'overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,0.9);'
        ].join('');

        const boxHdr = document.createElement('div');
        boxHdr.style.cssText = [
            'background:#0f3460;padding:10px 14px;border-bottom:1px solid #ff9a00;',
            'font-size:13px;font-weight:bold;'
        ].join('');
        boxHdr.textContent = '⚠️ Channel Conflicts Detected';
        box.appendChild(boxHdr);

        const subtitle = document.createElement('div');
        subtitle.style.cssText = [
            'padding:8px 14px;font-size:11px;color:#aaa;',
            'border-bottom:1px solid #1e1e38;line-height:1.5;'
        ].join('');
        subtitle.innerHTML = (
            '<b style="color:#ff9a00">' + conflicts.length + '</b> channel' +
            (conflicts.length !== 1 ? 's' : '') + ' exist in both lists. ' +
            'Choose which label keeps in the <b style="color:#aa77ff">Merged</b> list.'
        );
        box.appendChild(subtitle);

        const scrollArea = document.createElement('div');
        scrollArea.style.cssText = 'overflow-y:auto;flex:1;padding:6px 0;';

        conflicts.forEach(function (ch) {
            const currentLabel  = (pcmData[ch]   && pcmData[ch].label)   ? pcmData[ch].label   : '(no label)';
            const uploadedLabel = (pcmOldData[ch] && pcmOldData[ch].label) ? pcmOldData[ch].label : '(no label)';

            const row = document.createElement('div');
            row.style.cssText = 'padding:9px 14px;border-bottom:1px solid #16162e;';

            const chTitle = document.createElement('div');
            chTitle.style.cssText = 'font-size:12px;color:#ff9a00;margin-bottom:6px;';
            chTitle.textContent = 'Channel ' + ch;
            row.appendChild(chTitle);

            const btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:6px;';

            const btnDefs = [
                { pick: 'current',  label: '✓ Keep Current', sub: currentLabel,  ac: '#1a3a1a', at: '#88ff88', ab: '#44884488' },
                { pick: 'uploaded', label: 'Keep Uploaded',  sub: uploadedLabel, ac: '#1a1a3a', at: '#6688ff', ab: '#44448888' },
                { pick: 'skip',     label: 'Skip',           sub: 'exclude',     ac: '#2a1a1a', at: '#cc6644', ab: '#88443388' }
            ];

            const allItems = [];

            btnDefs.forEach(function (def) {
                const btn = document.createElement('button');
                btn.style.cssText = [
                    'flex:1;padding:6px 4px;font-size:10px;line-height:1.4;',
                    'border-radius:4px;cursor:pointer;font-family:monospace;touch-action:manipulation;'
                ].join('');
                btn.innerHTML = def.label + '<br><span style="color:#999;font-size:9px;">' + def.sub + '</span>';

                function applyStyle(active) {
                    btn.style.background = active ? def.ac : '#0a0a1e';
                    btn.style.color      = active ? def.at : '#445566';
                    btn.style.border     = active ? '1px solid ' + def.ab : '1px solid #22223344';
                }

                applyStyle(def.pick === 'current');
                allItems.push({ btn, def, applyStyle });

                btn.addEventListener('click', function () {
                    choices[ch] = def.pick;
                    allItems.forEach(function (item) { item.applyStyle(item.def.pick === def.pick); });
                });

                btnRow.appendChild(btn);
            });

            row.appendChild(btnRow);
            scrollArea.appendChild(row);
        });

        box.appendChild(scrollArea);

        const modalFoot = document.createElement('div');
        modalFoot.style.cssText = [
            'padding:10px 14px;display:flex;gap:8px;',
            'border-top:1px solid #1e1e38;background:#0a0a1e;'
        ].join('');

        const btnCancel = document.createElement('button');
        btnCancel.textContent = 'Cancel Import';
        btnCancel.style.cssText = [
            'flex:1;padding:9px;background:#1a0a0a;color:#cc5544;',
            'border:1px solid #884433;border-radius:5px;cursor:pointer;',
            'font-size:12px;font-family:monospace;touch-action:manipulation;'
        ].join('');
        btnCancel.addEventListener('click', function () {
            pcmOldData = null; pcmOldMeta = null; modal.remove();
        });

        const btnApply = document.createElement('button');
        btnApply.textContent = 'Apply & Create Merged Tab';
        btnApply.style.cssText = [
            'flex:2;padding:9px;background:#0f3460;color:#eee;',
            'border:1px solid #ff9a00;border-radius:5px;cursor:pointer;',
            'font-size:12px;font-weight:bold;font-family:monospace;touch-action:manipulation;'
        ].join('');
        btnApply.addEventListener('click', function () {
            applyConflictResolution(conflicts, choices);
            modal.remove();
        });

        modalFoot.appendChild(btnCancel);
        modalFoot.appendChild(btnApply);
        box.appendChild(modalFoot);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    function applyConflictResolution(conflicts, choices) {
        buildAutoMerge(conflicts);
        conflicts.forEach(function (ch) {
            const pick = choices[ch];
            if (pick === 'current') {
                pcmMergedData[ch] = JSON.parse(JSON.stringify(pcmData[ch] || { label: '', folder: '' }));
            } else if (pick === 'uploaded') {
                pcmMergedData[ch] = JSON.parse(JSON.stringify(pcmOldData[ch] || { label: '', folder: '' }));
            }
            // 'skip' → intentionally excluded
        });
        pcmActiveTab = 'merged';
        renderPanel();
        logMessage('[PCM] Merged tab created with ' + Object.keys(pcmMergedData).length + ' channels.');
    }

    function buildAutoMerge(excludeChannels) {
        if (!pcmMergedData) pcmMergedData = {};
        const excluded = new Set((excludeChannels || []).map(Number));
        for (const ch in pcmData) {
            if (!excluded.has(Number(ch))) {
                pcmMergedData[ch] = JSON.parse(JSON.stringify(pcmData[ch]));
            }
        }
        for (const ch in (pcmOldData || {})) {
            if (!excluded.has(Number(ch)) && !pcmMergedData[ch]) {
                pcmMergedData[ch] = JSON.parse(JSON.stringify(pcmOldData[ch]));
            }
        }
    }


    // ----------------------------------------------------------------
    //  PORTAL SHIFT-SELECT OVERRIDE
    // ----------------------------------------------------------------

    function patchPortalSelect() {
        function buildPicker(typeName) {
            return function () {
                const scan     = scanPortals();
                const { ins, outs, all } = scan;
                const channels = Array.from(all).sort(function (a, b) { return a - b; });

                let msg = 'Type a channel number to use.\n';
                if (channels.length > 0) {
                    msg += '\nExisting channels on canvas:\n';
                    channels.forEach(function (ch) {
                        const st  = getStatus(ch, ins, outs);
                        const ico = st === 'ok' ? '✓' : '⚠';
                        const stl = st === 'ok' ? 'linked' : st === 'no_out' ? 'no OUT' : 'no IN';
                        const lbl = (pcmData[ch] && pcmData[ch].label)  ? '  →  ' + pcmData[ch].label  : '';
                        const fld = (pcmData[ch] && pcmData[ch].folder) ? ' [' + pcmData[ch].folder + ']' : '';
                        msg += '  ' + ico + ' Ch ' + ch + '  (' + stl + ')' + lbl + fld + '\n';
                    });
                } else {
                    msg += '(No portals on canvas yet)\n';
                }

                promptInput(msg, function (r) {
                    if (r === '' || r === null) return;
                    const ch = parseInt(r);
                    if (isNaN(ch)) { logMessage('[PCM] Invalid channel number.'); return; }

                    const scan2    = scanPortals();
                    const st       = getStatus(ch, scan2.ins, scan2.outs);
                    const inOld    = pcmOldData    && (pcmOldData[ch]    !== undefined);
                    const inMerged = pcmMergedData && (pcmMergedData[ch] !== undefined);

                    function finallyApply() { currentElementProp = { channel: ch }; }

                    function checkInUse(onConfirm) {
                        if (st === 'ok') {
                            promptConfirm(
                                'Channel ' + ch + ' already has both a portal_in AND a portal_out.\n\n' +
                                'Adding more portals on the same channel can cause unexpected routing.\n\n' +
                                'Continue anyway?',
                                function (ok) { if (ok) onConfirm(); },
                                'Channel ' + ch + ' Is Already In Use'
                            );
                        } else { onConfirm(); }
                    }

                    function checkOldList(onConfirm) {
                        if (inOld && !inMerged) {
                            const oldLabel = (pcmOldData[ch] && pcmOldData[ch].label)
                                           ? pcmOldData[ch].label : '(no label)';
                            promptConfirm(
                                'Channel ' + ch + ' exists in your uploaded project list.\n' +
                                'Label in that list: "' + oldLabel + '"\n\n' +
                                'Merge this channel into the Merged Channels list?',
                                function (doMerge) {
                                    if (doMerge) {
                                        if (!pcmMergedData) pcmMergedData = {};
                                        pcmMergedData[ch] = JSON.parse(JSON.stringify(
                                            pcmData[ch] || pcmOldData[ch]
                                        ));
                                        renderPanel();
                                        logMessage('[PCM] Channel ' + ch + ' added to the Merged list.');
                                    }
                                    onConfirm();
                                },
                                'Merge Portal Channels With Labels?'
                            );
                        } else { onConfirm(); }
                    }

                    checkOldList(function () { checkInUse(finallyApply); });

                }, typeName + ' — Channel Picker');
            };
        }

        elements.portal_in.onShiftSelect  = buildPicker('Portal IN');
        elements.portal_out.onShiftSelect = buildPicker('Portal OUT');
    }


    // ----------------------------------------------------------------
    //  SAVE / LOAD PATCHING
    // ----------------------------------------------------------------

    function patchSaveLoad() {
        const origGen = window.generateSave;
        window.generateSave = function () {
            const save    = origGen.apply(this, arguments);
            const section = {};

            if (Object.keys(pcmData).length > 0)
                section.channelData  = JSON.parse(JSON.stringify(pcmData));
            if (pcmFolders.length > 0)
                section.folders      = pcmFolders.slice();
            if (pcmOldData)
                section.uploadedData = JSON.parse(JSON.stringify(pcmOldData));
            if (pcmOldMeta)
                section.uploadedMeta = JSON.parse(JSON.stringify(pcmOldMeta));
            if (pcmMergedData)
                section.mergedData   = JSON.parse(JSON.stringify(pcmMergedData));

            if (Object.keys(section).length > 0) save.pcm = section;
            return save;
        };

        const origLoad = window.loadSave;
        window.loadSave = function (saveJSON) {
            const pcm     = (saveJSON && saveJSON.pcm) || {};
            pcmData       = pcm.channelData  || {};
            pcmFolders    = pcm.folders      || [];
            pcmOldData    = pcm.uploadedData || null;
            pcmOldMeta    = pcm.uploadedMeta || null;
            pcmMergedData = pcm.mergedData   || null;
            pcmActiveTab  = 'current';

            const result = origLoad.apply(this, arguments);
            setTimeout(function () {
                if (document.getElementById('pcm-panel')) renderPanel();
            }, 900);
            return result;
        };
    }


    // ----------------------------------------------------------------
    //  TOGGLE BUTTON
    //  Clicking 📡 always clears any active red flash, then toggles
    //  the panel open or closed.
    // ----------------------------------------------------------------

    function createToggleButton() {
        const btn = document.createElement('button');
        btn.id        = 'pcm-toggle-btn';
        btn.innerHTML = '📡';
        btn.title     = 'Portal Channel Manager';
        btn.style.cssText = [
            'position:fixed;top:48px;right:5px;z-index:10000;',
            'background:#0f3460;color:#fff;',
            'border:2px solid #ff9a00;border-radius:6px;',
            'padding:5px 10px;cursor:pointer;font-size:15px;',
            'touch-action:manipulation;',
            'box-shadow:0 2px 10px rgba(0,0,0,0.55);'
        ].join('');
        btn.addEventListener('click', togglePanel);
        document.body.appendChild(btn);
    }

    function togglePanel() {
        // Always clear any active flash first.
        stopChannelFlash();

        const existing = document.getElementById('pcm-panel');
        if (existing) {
            existing.remove();
        } else {
            openPanel();
        }
    }


    // ----------------------------------------------------------------
    //  PANEL — STRUCTURE
    // ----------------------------------------------------------------

    function openPanel() {
        const panel = document.createElement('div');
        panel.id = 'pcm-panel';
        panel.style.cssText = [
            'position:fixed;top:48px;right:5px;width:340px;max-height:84vh;',
            'background:#11112b;border:2px solid #ff9a00;border-radius:9px;',
            'z-index:9999;font-family:monospace;color:#eee;',
            'display:flex;flex-direction:column;overflow:hidden;',
            'box-shadow:0 8px 32px rgba(0,0,0,0.7);'
        ].join('');

        // Drag handle / header
        const header = document.createElement('div');
        header.id = 'pcm-drag-handle';
        header.style.cssText = [
            'background:#0f3460;padding:8px 12px;',
            'display:flex;justify-content:space-between;align-items:center;',
            'border-bottom:1px solid #ff9a00;cursor:move;',
            'user-select:none;-webkit-user-select:none;'
        ].join('');
        header.innerHTML = (
            '<span style="font-size:13px;letter-spacing:0.4px;">📡 Portal Channel Manager</span>' +
            '<button id="pcm-close-btn" style="background:none;border:none;color:#bbb;cursor:pointer;' +
            'font-size:20px;line-height:1;padding:0 4px;touch-action:manipulation;" title="Close">×</button>'
        );
        panel.appendChild(header);

        const tabBar = document.createElement('div');
        tabBar.id = 'pcm-tab-bar';
        tabBar.style.cssText = 'display:flex;background:#0a0a1e;border-bottom:1px solid #1e1e38;';
        panel.appendChild(tabBar);

        const toolbar = document.createElement('div');
        toolbar.id = 'pcm-toolbar';
        toolbar.style.cssText = [
            'padding:6px 8px;display:flex;gap:5px;flex-wrap:wrap;',
            'border-bottom:1px solid #1e1e38;background:#0a0a1e;'
        ].join('');
        panel.appendChild(toolbar);

        const listEl = document.createElement('div');
        listEl.id = 'pcm-list';
        listEl.style.cssText = 'overflow-y:auto;flex:1;';
        panel.appendChild(listEl);

        const footer = document.createElement('div');
        footer.id = 'pcm-footer';
        footer.style.cssText = [
            'padding:4px 10px;background:#080818;',
            'border-top:1px solid #1e1e38;font-size:11px;color:#777;min-height:22px;'
        ].join('');
        panel.appendChild(footer);

        document.body.appendChild(panel);

        document.getElementById('pcm-close-btn').addEventListener('click', function () {
            stopChannelFlash();
            panel.remove();
        });

        // Drag support
        let dragging = false, dX = 0, dY = 0;
        header.addEventListener('mousedown', function (e) {
            dragging = true;
            const r = panel.getBoundingClientRect();
            dX = e.clientX - r.left; dY = e.clientY - r.top;
            panel.style.right = 'auto'; e.preventDefault();
        });
        header.addEventListener('touchstart', function (e) {
            const t = e.touches[0]; dragging = true;
            const r = panel.getBoundingClientRect();
            dX = t.clientX - r.left; dY = t.clientY - r.top;
            panel.style.right = 'auto';
        }, { passive: true });
        document.addEventListener('mousemove', function (e) {
            if (!dragging) return;
            panel.style.left = (e.clientX - dX) + 'px';
            panel.style.top  = (e.clientY - dY) + 'px';
        });
        document.addEventListener('touchmove', function (e) {
            if (!dragging) return;
            const t = e.touches[0];
            panel.style.left = (t.clientX - dX) + 'px';
            panel.style.top  = (t.clientY - dY) + 'px';
        }, { passive: true });
        document.addEventListener('mouseup',  function () { dragging = false; });
        document.addEventListener('touchend', function () { dragging = false; });

        renderPanel();
    }

    function renderPanel() {
        if (!document.getElementById('pcm-panel')) return;
        renderTabs();
        renderToolbar();
        renderList();
    }


    // ----------------------------------------------------------------
    //  PANEL — TABS
    // ----------------------------------------------------------------

    function renderTabs() {
        const tabBar = document.getElementById('pcm-tab-bar');
        if (!tabBar) return;
        tabBar.innerHTML = '';

        const tabs = [{ id: 'current', label: '📋 Current' }];
        if (pcmOldData)    tabs.push({ id: 'uploaded', label: '📂 Uploaded' });
        if (pcmMergedData) tabs.push({ id: 'merged',   label: '🔀 Merged'   });

        const validIds = tabs.map(function (t) { return t.id; });
        if (!validIds.includes(pcmActiveTab)) pcmActiveTab = 'current';

        tabs.forEach(function (tab) {
            const btn      = document.createElement('button');
            const isActive = tab.id === pcmActiveTab;
            btn.textContent = tab.label;
            btn.style.cssText = [
                'flex:1;padding:6px 4px;border:none;cursor:pointer;',
                'font-family:monospace;font-size:11px;touch-action:manipulation;',
                'border-bottom:2px solid ' + (isActive ? '#ff9a00'  : 'transparent') + ';',
                'background:'              + (isActive ? '#11112b'  : '#0a0a1e')     + ';',
                'color:'                   + (isActive ? '#ff9a00'  : '#556677')     + ';'
            ].join('');
            btn.addEventListener('click', function () {
                pcmActiveTab = tab.id;
                renderPanel();
            });
            tabBar.appendChild(btn);
        });
    }


    // ----------------------------------------------------------------
    //  PANEL — TOOLBAR
    // ----------------------------------------------------------------

    function renderToolbar() {
        const toolbar = document.getElementById('pcm-toolbar');
        if (!toolbar) return;
        toolbar.innerHTML = '';

        function mkBtn(html, title, onClick) {
            const b = document.createElement('button');
            b.innerHTML = html; b.title = title;
            b.style.cssText = [
                'background:#0f3460;color:#eee;border:1px solid #404055;',
                'border-radius:4px;padding:4px 9px;cursor:pointer;',
                'font-size:11px;touch-action:manipulation;white-space:nowrap;'
            ].join('');
            b.addEventListener('click', onClick);
            return b;
        }

        if (pcmActiveTab === 'current') {
            const sortSel = document.createElement('select');
            sortSel.id = 'pcm-sort-sel';
            sortSel.style.cssText = [
                'background:#1a1a32;color:#eee;border:1px solid #404055;',
                'border-radius:4px;padding:4px 5px;font-size:11px;',
                'flex:1;min-width:0;touch-action:manipulation;'
            ].join('');
            sortSel.innerHTML = (
                '<option value="num">↕ Channel #</option>'   +
                '<option value="label">↕ Label A–Z</option>' +
                '<option value="folder">↕ Folder</option>'   +
                '<option value="status">↕ Status</option>'
            );
            sortSel.addEventListener('change', renderList);
            toolbar.appendChild(sortSel);

            toolbar.appendChild(mkBtn('🔄', 'Re-scan canvas', renderList));
            toolbar.appendChild(mkBtn('+ Label', 'Manually add a channel label', manualAddChannel));
            toolbar.appendChild(mkBtn('+ Folder', 'Create a new empty folder', createNewFolder));
            toolbar.appendChild(mkBtn('📥', 'Export current list as JSON', exportCurrentList));
            toolbar.appendChild(mkBtn('📂', 'Import an old project list', importOldList));

        } else if (pcmActiveTab === 'uploaded') {
            const badge = document.createElement('span');
            badge.style.cssText = 'flex:1;font-size:10px;color:#5577aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            badge.textContent = '📂 ' + (pcmOldMeta ? pcmOldMeta.saveName : 'Uploaded');
            toolbar.appendChild(badge);
            toolbar.appendChild(mkBtn('🔄', 'Re-scan', renderList));
            toolbar.appendChild(mkBtn('📂 Replace', 'Load a different old list', importOldList));
            toolbar.appendChild(mkBtn('📦 Export All', 'Download combined file', exportCombinedList));

        } else if (pcmActiveTab === 'merged') {
            const mbadge = document.createElement('span');
            mbadge.style.cssText = 'flex:1;font-size:10px;color:#aa77ff;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            mbadge.textContent = '🔀 Merged Result';
            toolbar.appendChild(mbadge);
            toolbar.appendChild(mkBtn('🔄', 'Re-scan', renderList));
            toolbar.appendChild(mkBtn('📦 Export All', 'Download combined file', exportCombinedList));
        }
    }


    // ----------------------------------------------------------------
    //  PANEL — CHANNEL LIST
    // ----------------------------------------------------------------

    function renderList() {
        const listEl = document.getElementById('pcm-list');
        if (!listEl) return;
        listEl.innerHTML = '';

        let data, readOnly;
        if      (pcmActiveTab === 'current')  { data = pcmData;          readOnly = false; }
        else if (pcmActiveTab === 'uploaded') { data = pcmOldData    || {}; readOnly = true; }
        else                                  { data = pcmMergedData || {}; readOnly = true; }

        const scan   = scanPortals();
        const { ins, outs, all } = scan;

        const sortSel  = document.getElementById('pcm-sort-sel');
        const sortMode = (pcmActiveTab === 'current' && sortSel) ? sortSel.value : 'num';

        const channelSet = new Set(Object.keys(data).map(Number));
        if (pcmActiveTab === 'current') all.forEach(function (ch) { channelSet.add(ch); });
        const channels = Array.from(channelSet);

        channels.sort(function (a, b) {
            if (sortMode === 'label') {
                const la = (data[a] || {}).label || '', lb = (data[b] || {}).label || '';
                return la.localeCompare(lb) || a - b;
            }
            if (sortMode === 'folder') {
                const fa = (data[a] || {}).folder || '', fb = (data[b] || {}).folder || '';
                return fa.localeCompare(fb) || a - b;
            }
            if (sortMode === 'status') {
                const order = { ok: 0, no_out: 1, no_in: 2, empty: 3 };
                return (order[getStatus(a, ins, outs)] || 0) - (order[getStatus(b, ins, outs)] || 0) || a - b;
            }
            return a - b; // 'num' default
        });

        if (channels.length === 0) {
            const msg = pcmActiveTab === 'current'
                ? 'No portal channels found.<br>Place portal_in or portal_out pixels,<br>then press 🔄 Scan.'
                : pcmActiveTab === 'uploaded' ? 'The uploaded list is empty.'
                : 'No merged channels yet.';
            listEl.innerHTML = '<div style="padding:20px 14px;color:#555;text-align:center;font-size:12px;">' + msg + '</div>';
            updateFooter(0, 0);
            return;
        }

        let currentFolder = Symbol(); // sentinel — no string equals this

        channels.forEach(function (ch) {
            const chData   = data[ch] || {};
            const st       = getStatus(ch, ins, outs);
            const folder   = chData.folder || '';
            const onCanvas = all.has(ch);

            // Folder dividers (current tab, folder sort mode only)
            if (pcmActiveTab === 'current' && sortMode === 'folder' && folder !== currentFolder) {
                currentFolder = folder;
                const divider = document.createElement('div');
                divider.style.cssText = [
                    'padding:3px 10px;background:#191935;color:#7777aa;',
                    'font-size:10px;letter-spacing:0.5px;text-transform:uppercase;'
                ].join('');
                divider.textContent = folder ? ('📁 ' + folder) : '— No folder —';
                listEl.appendChild(divider);
            }

            const stColor = onCanvas ? (st === 'ok' ? '#00e676' : '#ff5252') : '#444466';
            const stIcon  = onCanvas ? (st === 'ok' ? '✓' : '⚠') : '·';
            const stTip   = !onCanvas       ? 'Not on canvas'
                          : st === 'ok'     ? 'Linked — both IN and OUT present'
                          : st === 'no_out' ? 'Missing OUT portal'
                          :                   'Missing IN portal';

            const inCount  = ins[ch]  || 0;
            const outCount = outs[ch] || 0;

            const row = document.createElement('div');
            row.className    = 'pcm-ch-row';
            row.dataset.ch   = String(ch);
            row.style.cssText = [
                'padding:7px 10px;display:flex;align-items:center;gap:4px;',
                'border-bottom:1px solid #16162e;'
            ].join('');

            // Status icon
            const iconSpan = document.createElement('span');
            iconSpan.title = stTip;
            iconSpan.style.cssText = 'color:' + stColor + ';font-size:12px;min-width:13px;';
            iconSpan.textContent = stIcon;
            row.appendChild(iconSpan);

            // Channel number
            const chSpan = document.createElement('span');
            chSpan.style.cssText = 'color:#ff9a00;font-size:12px;min-width:44px;';
            chSpan.textContent = 'Ch ' + ch;
            row.appendChild(chSpan);

            // Cross-reference provenance badges
            if (pcmActiveTab === 'uploaded' && pcmData[ch] !== undefined) {
                const b1 = document.createElement('span');
                b1.title = 'Also in Current list';
                b1.style.cssText = 'font-size:9px;color:#ff9a00;background:#1a1200;padding:1px 4px;border-radius:3px;flex-shrink:0;';
                b1.textContent = 'cur';
                row.appendChild(b1);
            }
            if (pcmActiveTab === 'merged') {
                if (pcmData[ch] !== undefined) {
                    const b2 = document.createElement('span');
                    b2.title = 'From Current list';
                    b2.style.cssText = 'font-size:9px;color:#ff9a00;background:#1a1200;padding:1px 4px;border-radius:3px;flex-shrink:0;';
                    b2.textContent = 'cur';
                    row.appendChild(b2);
                }
                if (pcmOldData && pcmOldData[ch] !== undefined) {
                    const b3 = document.createElement('span');
                    b3.title = 'From Uploaded list';
                    b3.style.cssText = 'font-size:9px;color:#6688ff;background:#00001a;padding:1px 4px;border-radius:3px;flex-shrink:0;';
                    b3.textContent = 'upl';
                    row.appendChild(b3);
                }
            }

            // Label
            const lblSpan = document.createElement('span');
            lblSpan.style.cssText = 'flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            if (chData.label) {
                lblSpan.style.color = '#cccccc';
                lblSpan.textContent = chData.label;
            } else {
                lblSpan.style.color = '#383858';
                lblSpan.textContent = 'no label';
            }
            row.appendChild(lblSpan);

            // Folder badge (suppressed in folder-sort mode where dividers exist)
            if (chData.folder && !(pcmActiveTab === 'current' && sortMode === 'folder')) {
                const fldBadge = document.createElement('span');
                fldBadge.style.cssText = 'font-size:10px;color:#5566aa;background:#181830;padding:1px 4px;border-radius:3px;white-space:nowrap;flex-shrink:0;';
                fldBadge.textContent = '📁' + chData.folder;
                row.appendChild(fldBadge);
            }

            // IN→OUT count
            const countSpan = document.createElement('span');
            countSpan.title = inCount + ' IN, ' + outCount + ' OUT on canvas';
            countSpan.style.cssText = 'font-size:10px;color:#444466;white-space:nowrap;flex-shrink:0;';
            countSpan.textContent = onCanvas ? (inCount + '→' + outCount) : '–';
            row.appendChild(countSpan);

            // Shared button style helper
            function mkRowBtn(html, title, onClick) {
                const b = document.createElement('button');
                b.innerHTML = html; b.title = title;
                b.style.cssText = [
                    'background:none;border:1px solid #303050;color:#777799;',
                    'border-radius:3px;cursor:pointer;font-size:11px;',
                    'padding:2px 5px;touch-action:manipulation;flex-shrink:0;'
                ].join('');
                b.addEventListener('click', function (e) { e.stopPropagation(); onClick(); });
                return b;
            }

            // ✏️ Edit — current tab only
            if (!readOnly) {
                row.appendChild(mkRowBtn('✏️', 'Edit label and folder', function () {
                    editChannel(ch);
                }));
            }

            // ⇄ Move — current tab only
            if (!readOnly) {
                row.appendChild(mkRowBtn('⇄', 'Move channel to another number', function () {
                    moveChannel(ch);
                }));
            }

            // 🔍 Locate — all tabs
            const hlBtn = mkRowBtn(
                '🔍',
                onCanvas ? 'Flash this channel red until you press 📡' : 'Channel not on canvas',
                function () {
                    if (!onCanvas) {
                        logMessage('[PCM] Channel ' + ch + ' is not on the canvas.');
                        return;
                    }
                    // If already flashing this channel, stop (toggle off).
                    if (pcmFlashChannel === ch) {
                        stopChannelFlash();
                    } else {
                        startChannelFlash(ch);
                    }
                }
            );
            if (!onCanvas) hlBtn.style.color = '#333344';
            row.appendChild(hlBtn);

            row.addEventListener('mouseenter', function () { this.style.background = '#1c1c3a'; });
            row.addEventListener('mouseleave', function () { this.style.background = ''; });

            listEl.appendChild(row);
        });

        let orphanCount = 0;
        all.forEach(function (ch) { if (getStatus(ch, ins, outs) !== 'ok') orphanCount++; });
        updateFooter(channels.length, orphanCount);
    }

    function updateFooter(total, orphans) {
        const f = document.getElementById('pcm-footer');
        if (!f) return;

        const tabNote = pcmActiveTab === 'uploaded' ? ' (read-only reference)'
                      : pcmActiveTab === 'merged'   ? ' (merged result)'
                      : '';

        let orphanText = '';
        if (pcmActiveTab === 'current') {
            orphanText = orphans > 0
                ? ' &nbsp;|&nbsp; <span style="color:#ff5252">⚠ ' + orphans +
                  ' missing link' + (orphans !== 1 ? 's' : '') + '</span>'
                : ' &nbsp;|&nbsp; <span style="color:#00e676">✓ All channels linked</span>';
        }

        f.innerHTML = total + ' channel' + (total !== 1 ? 's' : '') + tabNote + orphanText;
    }


    // ----------------------------------------------------------------
    //  INIT
    // ----------------------------------------------------------------

    function init() {
        if (
            typeof elements    === 'undefined' ||
            typeof promptInput === 'undefined' ||
            !elements.portal_in
        ) {
            setTimeout(init, 400);
            return;
        }

        patchSaveLoad();
        patchPortalSelect();
        setupHoverBar();
        createToggleButton();

        console.log('[PCM] Portal Channel Manager v3.0 loaded.');
    }

    init();

})();
