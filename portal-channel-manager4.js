// ================================================================
//  PORTAL CHANNEL MANAGER — Sandboxels Mod
//  Version 4.0
//
//  CHANGES FROM v3.0:
//  1. Folder deletion — 🗑️ on dividers (folder-sort mode) and an
//     "Unused Folders" section at the bottom of the list.
//  2. 📡 button moved into the game toolbar (#toolControls).
//  3. Flash behaviour: opening panel stops flash; closing (✕ or 📡
//     when panel is open) leaves flash running. Reset stops flash.
//  4. Hover bar is tappable on mobile — channel number, label and
//     folder text are interactive. Sticky for 400 ms after lift.
//  5. "+ Label" toolbar button removed.
//  6. Multi-select: long-press a row (300 ms) enters selection mode;
//     toolbar becomes "Move to Folder / Cancel".
//  7. Routing warning shown only for portal_out, not portal_in.
//
//  HOW TO INSTALL:
//  Host this file and paste the URL into Sandboxels → Mods.
//
//  SAVE COMPATIBILITY:
//  All data is stored under the "pcm" key in the save file.
//  If the mod is absent, that key is silently ignored.
// ================================================================

(function () {
    'use strict';

    // ----------------------------------------------------------------
    //  STATE
    // ----------------------------------------------------------------

    // Current project channel labels.
    // { [channelNumber]: { label: string, folder: string } }
    let pcmData = {};

    // All named folders (including empty ones created with "+ Folder").
    let pcmFolders = [];

    // Uploaded reference list and its metadata.
    let pcmOldData = null;
    let pcmOldMeta = null;

    // Merged list produced by conflict resolution.
    let pcmMergedData = null;

    // Active panel tab.
    let pcmActiveTab = 'current';

    // Persistent red flash state.
    let pcmFlashChannel = null;
    let pcmFlashTimer   = null;
    let pcmFlashState   = false;

    // Multi-select state (Current tab only).
    let pcmSelectionMode     = false;
    let pcmSelectedChannels  = new Set();

    // Hover bar sticky state.
    let hoverBarInfo        = null;   // { ch, isIn, x, y }
    let hoverBarLastSeen    = 0;
    let hoverBarRenderedKey = null;   // "<ch>:<isIn>" — avoids redundant DOM rebuilds


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
    //  SAVE NAME
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
        const all = new Set([...Object.keys(ins), ...Object.keys(outs)].map(Number));
        return { ins, outs, all };
    }

    function getStatus(ch, ins, outs) {
        const hi = !!ins[ch], ho = !!outs[ch];
        if (hi && ho) return 'ok';
        if (hi) return 'no_out';
        if (ho) return 'no_in';
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
                if (el.id === elements.portal_in.id || el.id === elements.portal_out.id) result.push(p);
            }
        }
        return result;
    }

    // Safely re-fetches a portal pixel at a stored (x, y) coordinate.
    function getPortalPixelAt(x, y) {
        if (typeof pixelMap === 'undefined') return null;
        if (!pixelMap[x] || !pixelMap[x][y]) return null;
        const p = pixelMap[x][y];
        if (!p || !p.element || !elements[p.element]) return null;
        const el = elements[p.element];
        if (el.id === elements.portal_in.id || el.id === elements.portal_out.id) return p;
        return null;
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
        overlay.style.left   = rect.left + 'px';
        overlay.style.top    = rect.top  + 'px';
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
    //  Started by 🔍. Stopped only by: opening 📡, canvas reset,
    //  or tapping 🔍 again on the same channel (toggle off).
    //  Closing the panel does NOT stop the flash.
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
                paintOverlayPixels(ctx, getPortalsForChannel(ch), 'rgba(255,40,40,0.88)');
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
    //  HOVER STATUS BAR  (tap-to-edit, sticky on mobile)
    //
    //  The bar shows three interactive segments:
    //    · Channel number → change this portal pixel's channel
    //    · Label text     → edit the label for that channel
    //    · Folder badge   → open the folder picker for that channel
    //
    //  On mobile, when the user lifts their finger the portal is no
    //  longer under the cursor. The bar stays visible for 400 ms after
    //  the last valid hover so the user can tap it before it hides.
    //  During that window the DOM is not rebuilt, so click handlers
    //  remain stable.
    // ----------------------------------------------------------------

    function setupHoverBar() {
        const bar = document.createElement('div');
        bar.id = 'pcm-hoverbar';
        bar.style.cssText = [
            'position:fixed;bottom:0;left:0;right:0;z-index:9995;',
            'background:rgba(6,6,22,0.94);color:#eee;',
            'font-family:monospace;font-size:13px;line-height:1.8;',
            'padding:5px 14px;border-top:2px solid #ff9a00;',
            'display:none;cursor:default;',
            'touch-action:manipulation;'
        ].join('');
        document.body.appendChild(bar);

        const STICKY_MS = 400;

        function buildBarDOM(info) {
            bar.innerHTML = '';

            const typeColor = info.isIn ? '#ff9a00' : '#00a2ff';
            const typeText  = info.isIn ? 'IN ▶' : '◀ OUT';

            function txt(s) {
                const n = document.createTextNode(s);
                return n;
            }
            function nbsps(n) {
                const span = document.createElement('span');
                span.innerHTML = '&nbsp;|&nbsp;';
                return span;
            }

            // "Portal IN ▶" (not interactive)
            const portalSpan = document.createElement('span');
            portalSpan.innerHTML = 'Portal <b style="color:' + typeColor + '">' + typeText + '</b>';
            bar.appendChild(portalSpan);
            bar.appendChild(nbsps());

            // Channel number — tappable
            const chSpan = document.createElement('span');
            chSpan.innerHTML = 'Ch <b style="color:#ff9a00;text-decoration:underline dotted;cursor:pointer;">' + info.ch + '</b>';
            chSpan.title = 'Tap to change this portal\'s channel number';
            chSpan.style.cssText = 'cursor:pointer;';
            chSpan.addEventListener('click', function () {
                const px = getPortalPixelAt(info.x, info.y);
                if (!px) { logMessage('[PCM] Portal pixel is no longer at that position.'); return; }
                promptInput(
                    'Change this portal pixel to channel number:\n(current: ' + info.ch + ')',
                    function (r) {
                        if (r === null || r === '') return;
                        const newCh = parseInt(r);
                        if (isNaN(newCh)) { logMessage('[PCM] Invalid channel number.'); return; }
                        const px2 = getPortalPixelAt(info.x, info.y);
                        if (!px2) { logMessage('[PCM] Portal pixel no longer exists.'); return; }
                        px2.channel = newCh;
                        // Force bar re-render on next tick
                        hoverBarRenderedKey = null;
                        logMessage('[PCM] Portal pixel channel changed to ' + newCh + '.');
                    },
                    'Change Portal Channel'
                );
            });
            bar.appendChild(chSpan);
            bar.appendChild(nbsps());

            // Label — tappable
            const lblSpan = document.createElement('span');
            const hasLabel = !!(pcmData[info.ch] && pcmData[info.ch].label);
            lblSpan.style.cssText = 'cursor:pointer;';
            if (hasLabel) {
                lblSpan.innerHTML = '<span style="text-decoration:underline dotted;">' + pcmData[info.ch].label + '</span>';
            } else {
                lblSpan.innerHTML = '<i style="color:#555;text-decoration:underline dotted;">no label</i>';
            }
            lblSpan.title = 'Tap to edit label';
            lblSpan.addEventListener('click', function () {
                const data = pcmData[info.ch] || {};
                promptInput(
                    'Label for Channel ' + info.ch + ':\n(current: ' + (data.label || 'none') + ')',
                    function (label) {
                        if (label === null) return;
                        if (!pcmData[info.ch]) pcmData[info.ch] = { label: '', folder: '' };
                        pcmData[info.ch].label = label.trim();
                        hoverBarRenderedKey = null;
                        renderList();
                    },
                    'Edit Label — Channel ' + info.ch
                );
            });
            bar.appendChild(lblSpan);

            // Folder — tappable (only shown if present, or always with edit hint)
            const hasFolders = getAllFolders().length > 0;
            const currentFolder = (pcmData[info.ch] && pcmData[info.ch].folder) || '';
            if (currentFolder || hasFolders) {
                bar.appendChild(nbsps());
                const fldSpan = document.createElement('span');
                fldSpan.style.cssText = 'cursor:pointer;';
                if (currentFolder) {
                    fldSpan.innerHTML = '<span style="text-decoration:underline dotted;">📁 ' + currentFolder + '</span>';
                } else {
                    fldSpan.innerHTML = '<i style="color:#555;text-decoration:underline dotted;">no folder</i>';
                }
                fldSpan.title = 'Tap to change folder';
                fldSpan.addEventListener('click', function () {
                    showFolderPickerModal(info.ch, currentFolder, function (chosen) {
                        if (!pcmData[info.ch]) pcmData[info.ch] = { label: '', folder: '' };
                        pcmData[info.ch].folder = chosen;
                        if (chosen) registerFolder(chosen);
                        hoverBarRenderedKey = null;
                        renderList();
                    });
                });
                bar.appendChild(fldSpan);
            }
        }

        setInterval(function () {
            if (typeof mousePos === 'undefined' || typeof getPixel === 'undefined') return;
            let pixel;
            try { pixel = getPixel(mousePos.x, mousePos.y); } catch (e) { return; }

            const el    = pixel && pixel.element && elements[pixel.element];
            const isIn  = el && el.id === elements.portal_in.id;
            const isOut = el && el.id === elements.portal_out.id;

            if (isIn || isOut) {
                const ch  = parseInt(pixel.channel) || 0;
                const key = ch + ':' + (isIn ? 'in' : 'out');
                hoverBarInfo     = { ch, isIn: !!isIn, x: mousePos.x, y: mousePos.y };
                hoverBarLastSeen = Date.now();
                bar.style.display = 'block';

                // Only rebuild DOM when the displayed portal changes
                if (hoverBarRenderedKey !== key) {
                    hoverBarRenderedKey = key;
                    buildBarDOM(hoverBarInfo);
                }
            } else {
                if (hoverBarInfo && (Date.now() - hoverBarLastSeen) < STICKY_MS) {
                    // Sticky window — keep bar visible without rebuilding
                    bar.style.display = 'block';
                } else {
                    bar.style.display = 'none';
                    hoverBarInfo        = null;
                    hoverBarRenderedKey = null;
                }
            }
        }, 150);
    }


    // ----------------------------------------------------------------
    //  FOLDER HELPERS
    // ----------------------------------------------------------------

    function getAllFolders() {
        const set = new Set(pcmFolders);
        for (const ch in pcmData) {
            if (pcmData[ch] && pcmData[ch].folder) set.add(pcmData[ch].folder);
        }
        return Array.from(set).sort();
    }

    function registerFolder(name) {
        if (name && !pcmFolders.includes(name)) pcmFolders.push(name);
    }

    // Deletes a folder: removes from pcmFolders and clears the folder
    // field on all channels that used it.
    function deleteFolder(name) {
        pcmFolders = pcmFolders.filter(function (f) { return f !== name; });
        for (const ch in pcmData) {
            if (pcmData[ch] && pcmData[ch].folder === name) {
                pcmData[ch].folder = '';
            }
        }
        renderList();
    }


    // ----------------------------------------------------------------
    //  FOLDER PICKER MODAL
    // ----------------------------------------------------------------

    function showFolderPickerModal(channelLabel, currentFolder, onSelect) {
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

        const hdr = document.createElement('div');
        hdr.style.cssText = 'background:#0f3460;padding:10px 14px;border-bottom:1px solid #ff9a00;font-size:12px;';
        hdr.textContent = typeof channelLabel === 'number'
            ? 'Choose folder for Channel ' + channelLabel
            : channelLabel; // allows passing a custom header string
        box.appendChild(hdr);

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
            btn.addEventListener('click', function () { modal.remove(); onSelect(value); });
            return btn;
        }

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

        const foot = document.createElement('div');
        foot.style.cssText = 'padding:8px 12px;background:#0a0a1e;border-top:1px solid #1e1e38;';
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
    //  NEW FOLDER
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

                const scan = scanPortals();
                const dstHasPortals = scan.all.has(dstCh);

                function doMove() {
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
                    const srcLabel = pcmData[srcCh] || null;
                    const dstLabel = pcmData[dstCh] || null;
                    if (srcLabel) {
                        if (!dstLabel || !dstLabel.label) {
                            pcmData[dstCh] = JSON.parse(JSON.stringify(srcLabel));
                        }
                        delete pcmData[srcCh];
                    }
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
    // ----------------------------------------------------------------

    function editChannel(ch) {
        const data = pcmData[ch] || {};
        promptInput(
            'Label for Channel ' + ch + ':\n(current: ' + (data.label || 'none') + ')\n' +
            '(leave empty to clear the label)',
            function (label) {
                if (label === null) return;
                if (!pcmData[ch]) pcmData[ch] = { label: '', folder: '' };
                pcmData[ch].label = label.trim();
                showFolderPickerModal(ch, pcmData[ch].folder || '', function (chosen) {
                    pcmData[ch].folder = chosen;
                    if (chosen) registerFolder(chosen);
                    hoverBarRenderedKey = null;
                    renderList();
                });
            },
            'Edit Label — Channel ' + ch
        );
    }


    // ----------------------------------------------------------------
    //  EXPORT — CURRENT LIST
    // ----------------------------------------------------------------

    function exportCurrentList() {
        const saveName = getCurrentSaveName();
        const obj = {
            pcmVersion:  1,
            type:        'pcm-single',
            saveName:    saveName,
            exportedAt:  Date.now(),
            folders:     pcmFolders.slice(),
            channelData: JSON.parse(JSON.stringify(pcmData))
        };
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (saveName || 'project').replace(/[^a-z0-9_\-]/gi, '_') + '_channels.json';
        a.click();
    }


    // ----------------------------------------------------------------
    //  EXPORT — COMBINED LIST
    // ----------------------------------------------------------------

    function exportCombinedList() {
        const saveName = getCurrentSaveName();
        const obj = {
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
        const blob = new Blob([JSON.stringify(obj, null, 2)], { type: 'application/json' });
        const a = document.createElement('a');
        a.href = URL.createObjectURL(blob);
        a.download = (saveName || 'project').replace(/[^a-z0-9_\-]/gi, '_') + '_combined.json';
        a.click();
    }


    // ----------------------------------------------------------------
    //  IMPORT — OLD PROJECT LIST
    // ----------------------------------------------------------------

    function importOldList() {
        const input  = document.createElement('input');
        input.type   = 'file';
        input.accept = '.json';
        input.addEventListener('change', function (e) {
            const file = e.target.files[0];
            if (!file) return;
            const reader = new FileReader();
            reader.onload = function (ev) {
                let parsed;
                try { parsed = JSON.parse(ev.target.result); }
                catch (err) { logMessage('[PCM] Import failed — not valid JSON.'); return; }
                if (!parsed.pcmVersion) { logMessage('[PCM] Import failed — not a valid PCM file.'); return; }
                if (parsed.type === 'pcm-combined') {
                    promptConfirm(
                        'This is a combined PCM export file.\n\n' +
                        'OK  →  Load the Merged section as the reference list.\n' +
                        'Cancel  →  Load the Current section instead.',
                        function (useMerged) {
                            const section = useMerged ? parsed.merged : parsed.current;
                            if (!section || !section.channelData) { logMessage('[PCM] Selected section is empty.'); return; }
                            loadOldData(section.channelData, {
                                saveName:   section.saveName || (useMerged ? 'Merged' : 'Current'),
                                exportedAt: parsed.exportedAt || Date.now()
                            });
                        },
                        'Import Combined PCM File'
                    );
                } else {
                    if (!parsed.channelData) { logMessage('[PCM] Import failed — channelData missing.'); return; }
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
        const conflicts = Object.keys(channelData).map(Number)
            .filter(function (ch) { return pcmData[ch] !== undefined; });
        if (conflicts.length > 0) {
            showConflictModal(conflicts);
        } else {
            buildAutoMerge([]);
            pcmActiveTab = 'uploaded';
            renderPanel();
            logMessage('[PCM] Uploaded "' + meta.saveName + '". ' +
                Object.keys(channelData).length + ' channels, no conflicts.');
        }
    }


    // ----------------------------------------------------------------
    //  CONFLICT RESOLUTION MODAL
    // ----------------------------------------------------------------

    function showConflictModal(conflicts) {
        const existing = document.getElementById('pcm-conflict-modal');
        if (existing) existing.remove();

        const choices = {};
        conflicts.forEach(function (ch) { choices[ch] = 'current'; });

        const modal = document.createElement('div');
        modal.id = 'pcm-conflict-modal';
        modal.style.cssText = [
            'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;',
            'background:rgba(0,0,0,0.84);display:flex;align-items:center;justify-content:center;'
        ].join('');

        const box = document.createElement('div');
        box.style.cssText = [
            'background:#11112b;border:2px solid #ff9a00;border-radius:10px;',
            'max-width:390px;width:94%;max-height:88vh;',
            'display:flex;flex-direction:column;font-family:monospace;color:#eee;',
            'overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,0.9);'
        ].join('');

        const bHdr = document.createElement('div');
        bHdr.style.cssText = 'background:#0f3460;padding:10px 14px;border-bottom:1px solid #ff9a00;font-size:13px;font-weight:bold;';
        bHdr.textContent = '⚠️ Channel Conflicts Detected';
        box.appendChild(bHdr);

        const sub = document.createElement('div');
        sub.style.cssText = 'padding:8px 14px;font-size:11px;color:#aaa;border-bottom:1px solid #1e1e38;line-height:1.5;';
        sub.innerHTML = '<b style="color:#ff9a00">' + conflicts.length + '</b> channel' +
            (conflicts.length !== 1 ? 's' : '') + ' exist in both lists. ' +
            'Choose which label to keep in the <b style="color:#aa77ff">Merged</b> list.';
        box.appendChild(sub);

        const scrollArea = document.createElement('div');
        scrollArea.style.cssText = 'overflow-y:auto;flex:1;padding:6px 0;';

        conflicts.forEach(function (ch) {
            const curLbl = (pcmData[ch]   && pcmData[ch].label)   ? pcmData[ch].label   : '(no label)';
            const uplLbl = (pcmOldData[ch] && pcmOldData[ch].label) ? pcmOldData[ch].label : '(no label)';
            const row = document.createElement('div');
            row.style.cssText = 'padding:9px 14px;border-bottom:1px solid #16162e;';
            const title = document.createElement('div');
            title.style.cssText = 'font-size:12px;color:#ff9a00;margin-bottom:6px;';
            title.textContent = 'Channel ' + ch;
            row.appendChild(title);
            const bRow = document.createElement('div');
            bRow.style.cssText = 'display:flex;gap:6px;';

            const defs = [
                { pick:'current',  label:'✓ Keep Current', sub:curLbl, ac:'#1a3a1a', at:'#88ff88', ab:'#44884488' },
                { pick:'uploaded', label:'Keep Uploaded',  sub:uplLbl, ac:'#1a1a3a', at:'#6688ff', ab:'#44448888' },
                { pick:'skip',     label:'Skip',           sub:'exclude', ac:'#2a1a1a', at:'#cc6644', ab:'#88443388' }
            ];
            const allItems = [];
            defs.forEach(function (def) {
                const btn = document.createElement('button');
                btn.style.cssText = 'flex:1;padding:6px 4px;font-size:10px;line-height:1.4;border-radius:4px;cursor:pointer;font-family:monospace;touch-action:manipulation;';
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
                bRow.appendChild(btn);
            });
            row.appendChild(bRow);
            scrollArea.appendChild(row);
        });

        box.appendChild(scrollArea);

        const foot = document.createElement('div');
        foot.style.cssText = 'padding:10px 14px;display:flex;gap:8px;border-top:1px solid #1e1e38;background:#0a0a1e;';

        const btnCancel = document.createElement('button');
        btnCancel.textContent = 'Cancel Import';
        btnCancel.style.cssText = 'flex:1;padding:9px;background:#1a0a0a;color:#cc5544;border:1px solid #884433;border-radius:5px;cursor:pointer;font-size:12px;font-family:monospace;touch-action:manipulation;';
        btnCancel.addEventListener('click', function () { pcmOldData = null; pcmOldMeta = null; modal.remove(); });

        const btnApply = document.createElement('button');
        btnApply.textContent = 'Apply & Create Merged Tab';
        btnApply.style.cssText = 'flex:2;padding:9px;background:#0f3460;color:#eee;border:1px solid #ff9a00;border-radius:5px;cursor:pointer;font-size:12px;font-weight:bold;font-family:monospace;touch-action:manipulation;';
        btnApply.addEventListener('click', function () { applyConflictResolution(conflicts, choices); modal.remove(); });

        foot.appendChild(btnCancel);
        foot.appendChild(btnApply);
        box.appendChild(foot);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    function applyConflictResolution(conflicts, choices) {
        buildAutoMerge(conflicts);
        conflicts.forEach(function (ch) {
            const pick = choices[ch];
            if (pick === 'current')  pcmMergedData[ch] = JSON.parse(JSON.stringify(pcmData[ch]   || { label:'', folder:'' }));
            if (pick === 'uploaded') pcmMergedData[ch] = JSON.parse(JSON.stringify(pcmOldData[ch] || { label:'', folder:'' }));
        });
        pcmActiveTab = 'merged';
        renderPanel();
        logMessage('[PCM] Merged tab created with ' + Object.keys(pcmMergedData).length + ' channels.');
    }

    function buildAutoMerge(excludeChannels) {
        if (!pcmMergedData) pcmMergedData = {};
        const excluded = new Set((excludeChannels || []).map(Number));
        for (const ch in pcmData) {
            if (!excluded.has(Number(ch))) pcmMergedData[ch] = JSON.parse(JSON.stringify(pcmData[ch]));
        }
        for (const ch in (pcmOldData || {})) {
            if (!excluded.has(Number(ch)) && !pcmMergedData[ch]) {
                pcmMergedData[ch] = JSON.parse(JSON.stringify(pcmOldData[ch]));
            }
        }
    }


    // ----------------------------------------------------------------
    //  PORTAL SHIFT-SELECT OVERRIDE
    //  Routing warning ("channel already linked") fires only for
    //  portal_out. portal_in does not show that warning.
    // ----------------------------------------------------------------

    function patchPortalSelect() {
        function buildPicker(typeName, isOut) {
            return function () {
                const { ins, outs, all } = scanPortals();
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

                    // Routing warning — portal_out only
                    function checkInUse(onConfirm) {
                        if (isOut && st === 'ok') {
                            promptConfirm(
                                'Channel ' + ch + ' already has both a portal_in AND a portal_out.\n\n' +
                                'Adding another portal_out on the same channel can cause unexpected routing.\n\n' +
                                'Continue anyway?',
                                function (ok) { if (ok) onConfirm(); },
                                'Channel ' + ch + ' Already Has an OUT Portal'
                            );
                        } else {
                            onConfirm();
                        }
                    }

                    function checkOldList(onConfirm) {
                        if (inOld && !inMerged) {
                            const oldLabel = (pcmOldData[ch] && pcmOldData[ch].label) ? pcmOldData[ch].label : '(no label)';
                            promptConfirm(
                                'Channel ' + ch + ' exists in your uploaded project list.\n' +
                                'Label in that list: "' + oldLabel + '"\n\n' +
                                'Merge this channel into the Merged Channels list?',
                                function (doMerge) {
                                    if (doMerge) {
                                        if (!pcmMergedData) pcmMergedData = {};
                                        pcmMergedData[ch] = JSON.parse(JSON.stringify(pcmData[ch] || pcmOldData[ch]));
                                        renderPanel();
                                        logMessage('[PCM] Channel ' + ch + ' added to the Merged list.');
                                    }
                                    onConfirm();
                                },
                                'Merge Portal Channels With Labels?'
                            );
                        } else {
                            onConfirm();
                        }
                    }

                    checkOldList(function () { checkInUse(finallyApply); });

                }, typeName + ' — Channel Picker');
            };
        }

        elements.portal_in.onShiftSelect  = buildPicker('Portal IN',  false);
        elements.portal_out.onShiftSelect = buildPicker('Portal OUT', true);
    }


    // ----------------------------------------------------------------
    //  SAVE / LOAD PATCHING
    // ----------------------------------------------------------------

    function patchSaveLoad() {
        const origGen = window.generateSave;
        window.generateSave = function () {
            const save    = origGen.apply(this, arguments);
            const section = {};
            if (Object.keys(pcmData).length > 0) section.channelData  = JSON.parse(JSON.stringify(pcmData));
            if (pcmFolders.length > 0)            section.folders      = pcmFolders.slice();
            if (pcmOldData)                        section.uploadedData = JSON.parse(JSON.stringify(pcmOldData));
            if (pcmOldMeta)                        section.uploadedMeta = JSON.parse(JSON.stringify(pcmOldMeta));
            if (pcmMergedData)                     section.mergedData   = JSON.parse(JSON.stringify(pcmMergedData));
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
    //  Placed at the end of #toolControls (the game's main toolbar).
    //  Falls back to a fixed-position button if that element is absent.
    //
    //  Flash behaviour:
    //    OPENING the panel  → stop flash
    //    CLOSING the panel  → leave flash running
    // ----------------------------------------------------------------

    function createToggleButton() {
        const btn = document.createElement('button');
        btn.id        = 'pcm-toggle-btn';
        btn.innerHTML = '📡';
        btn.title     = 'Portal Channel Manager';
        // Mirror the game toolbar button style as closely as possible
        btn.style.cssText = [
            'background:none;border:none;cursor:pointer;',
            'font-size:18px;padding:0 6px;vertical-align:middle;',
            'touch-action:manipulation;line-height:1;',
            'opacity:0.85;'
        ].join('');
        btn.addEventListener('mouseenter', function () { btn.style.opacity = '1'; });
        btn.addEventListener('mouseleave', function () { btn.style.opacity = '0.85'; });
        btn.addEventListener('click', togglePanel);

        const toolControls = document.getElementById('toolControls');
        if (toolControls) {
            toolControls.appendChild(btn);
        } else {
            // Fallback for unexpected DOM layouts
            btn.style.cssText += 'position:fixed;top:5px;right:5px;z-index:10000;font-size:20px;';
            document.body.appendChild(btn);
        }
    }

    function togglePanel() {
        const existing = document.getElementById('pcm-panel');
        if (existing) {
            // CLOSING — leave flash running; exit selection mode
            pcmSelectionMode = false;
            pcmSelectedChannels.clear();
            existing.remove();
        } else {
            // OPENING — stop flash, then open panel
            stopChannelFlash();
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
        toolbar.style.cssText = 'padding:6px 8px;display:flex;gap:5px;flex-wrap:wrap;border-bottom:1px solid #1e1e38;background:#0a0a1e;';
        panel.appendChild(toolbar);

        const listEl = document.createElement('div');
        listEl.id = 'pcm-list';
        listEl.style.cssText = 'overflow-y:auto;flex:1;';
        panel.appendChild(listEl);

        const footer = document.createElement('div');
        footer.id = 'pcm-footer';
        footer.style.cssText = 'padding:4px 10px;background:#080818;border-top:1px solid #1e1e38;font-size:11px;color:#777;min-height:22px;';
        panel.appendChild(footer);

        document.body.appendChild(panel);

        // Close button — does NOT stop flash
        document.getElementById('pcm-close-btn').addEventListener('click', function () {
            pcmSelectionMode = false;
            pcmSelectedChannels.clear();
            panel.remove();
        });

        // Drag
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
        if (!tabs.find(function (t) { return t.id === pcmActiveTab; })) pcmActiveTab = 'current';
        tabs.forEach(function (tab) {
            const btn      = document.createElement('button');
            const isActive = tab.id === pcmActiveTab;
            btn.textContent = tab.label;
            btn.style.cssText = [
                'flex:1;padding:6px 4px;border:none;cursor:pointer;',
                'font-family:monospace;font-size:11px;touch-action:manipulation;',
                'border-bottom:2px solid ' + (isActive ? '#ff9a00' : 'transparent') + ';',
                'background:'              + (isActive ? '#11112b' : '#0a0a1e')     + ';',
                'color:'                   + (isActive ? '#ff9a00' : '#556677')     + ';'
            ].join('');
            btn.addEventListener('click', function () {
                pcmSelectionMode = false; pcmSelectedChannels.clear();
                pcmActiveTab = tab.id; renderPanel();
            });
            tabBar.appendChild(btn);
        });
    }


    // ----------------------------------------------------------------
    //  PANEL — TOOLBAR
    //  In selection mode the toolbar is replaced with "Move to Folder"
    //  and "Cancel" buttons regardless of which tab is active.
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

        if (pcmSelectionMode) {
            const count = pcmSelectedChannels.size;
            const label = document.createElement('span');
            label.style.cssText = 'flex:1;font-size:11px;color:#aaaacc;';
            label.textContent = count + ' channel' + (count !== 1 ? 's' : '') + ' selected';
            toolbar.appendChild(label);

            toolbar.appendChild(mkBtn('📁 Move to Folder', 'Assign selected channels to a folder', function () {
                if (pcmSelectedChannels.size === 0) return;
                showFolderPickerModal(
                    pcmSelectedChannels.size + ' selected channels',
                    '',
                    function (chosen) {
                        pcmSelectedChannels.forEach(function (ch) {
                            if (!pcmData[ch]) pcmData[ch] = { label: '', folder: '' };
                            pcmData[ch].folder = chosen;
                            if (chosen) registerFolder(chosen);
                        });
                        pcmSelectionMode = false;
                        pcmSelectedChannels.clear();
                        renderPanel();
                    }
                );
            }));

            toolbar.appendChild(mkBtn('✕ Cancel', 'Exit selection mode', function () {
                pcmSelectionMode = false;
                pcmSelectedChannels.clear();
                renderPanel();
            }));
            return;
        }

        if (pcmActiveTab === 'current') {
            const sortSel = document.createElement('select');
            sortSel.id = 'pcm-sort-sel';
            sortSel.style.cssText = 'background:#1a1a32;color:#eee;border:1px solid #404055;border-radius:4px;padding:4px 5px;font-size:11px;flex:1;min-width:0;touch-action:manipulation;';
            sortSel.innerHTML = (
                '<option value="num">↕ Channel #</option>'   +
                '<option value="label">↕ Label A–Z</option>' +
                '<option value="folder">↕ Folder</option>'   +
                '<option value="status">↕ Status</option>'
            );
            sortSel.addEventListener('change', renderList);
            toolbar.appendChild(sortSel);
            toolbar.appendChild(mkBtn('🔄', 'Re-scan canvas', renderList));
            toolbar.appendChild(mkBtn('+ Folder', 'Create a new empty folder', createNewFolder));
            toolbar.appendChild(mkBtn('📥', 'Export current list', exportCurrentList));
            toolbar.appendChild(mkBtn('📂', 'Import old project list', importOldList));

        } else if (pcmActiveTab === 'uploaded') {
            const badge = document.createElement('span');
            badge.style.cssText = 'flex:1;font-size:10px;color:#5577aa;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            badge.textContent = '📂 ' + (pcmOldMeta ? pcmOldMeta.saveName : 'Uploaded');
            toolbar.appendChild(badge);
            toolbar.appendChild(mkBtn('🔄', 'Re-scan', renderList));
            toolbar.appendChild(mkBtn('📂 Replace', 'Load a different list', importOldList));
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
    //
    //  Folder-sort dividers have a 🗑️ delete button.
    //  After all channels, an "Unused Folders" section lists any
    //  folder in pcmFolders that has zero channels assigned.
    //  Long-press (300 ms) enters multi-select mode.
    // ----------------------------------------------------------------

    function renderList() {
        const listEl = document.getElementById('pcm-list');
        if (!listEl) return;
        listEl.innerHTML = '';

        let data, readOnly;
        if      (pcmActiveTab === 'current')  { data = pcmData;          readOnly = false; }
        else if (pcmActiveTab === 'uploaded') { data = pcmOldData    || {}; readOnly = true; }
        else                                  { data = pcmMergedData || {}; readOnly = true; }

        const { ins, outs, all } = scanPortals();
        const sortSel  = document.getElementById('pcm-sort-sel');
        const sortMode = (pcmActiveTab === 'current' && sortSel) ? sortSel.value : 'num';

        const channelSet = new Set(Object.keys(data).map(Number));
        if (pcmActiveTab === 'current') all.forEach(function (ch) { channelSet.add(ch); });
        const channels = Array.from(channelSet);

        channels.sort(function (a, b) {
            if (sortMode === 'label') {
                const la = (data[a]||{}).label||'', lb = (data[b]||{}).label||'';
                return la.localeCompare(lb) || a - b;
            }
            if (sortMode === 'folder') {
                const fa = (data[a]||{}).folder||'', fb = (data[b]||{}).folder||'';
                return fa.localeCompare(fb) || a - b;
            }
            if (sortMode === 'status') {
                const order = { ok:0, no_out:1, no_in:2, empty:3 };
                return (order[getStatus(a,ins,outs)]||0) - (order[getStatus(b,ins,outs)]||0) || a - b;
            }
            return a - b;
        });

        if (channels.length === 0) {
            const msg = pcmActiveTab === 'current'
                ? 'No portal channels found.<br>Place portal_in or portal_out pixels,<br>then press 🔄 Scan.'
                : pcmActiveTab === 'uploaded' ? 'The uploaded list is empty.'
                : 'No merged channels yet.';
            listEl.innerHTML = '<div style="padding:20px 14px;color:#555;text-align:center;font-size:12px;">' + msg + '</div>';
            updateFooter(0, 0);
            renderUnusedFolders(listEl, readOnly);
            return;
        }

        let currentFolderSentinel = Symbol();

        channels.forEach(function (ch) {
            const chData   = data[ch] || {};
            const st       = getStatus(ch, ins, outs);
            const folder   = chData.folder || '';
            const onCanvas = all.has(ch);
            const isSelected = pcmSelectedChannels.has(ch);

            // Folder dividers with 🗑️ (Current tab, folder-sort mode only)
            if (pcmActiveTab === 'current' && sortMode === 'folder' && folder !== currentFolderSentinel) {
                currentFolderSentinel = folder;
                const divider = document.createElement('div');
                divider.style.cssText = [
                    'padding:3px 10px;background:#191935;color:#7777aa;',
                    'font-size:10px;letter-spacing:0.5px;text-transform:uppercase;',
                    'display:flex;align-items:center;justify-content:space-between;'
                ].join('');
                const divLabel = document.createElement('span');
                divLabel.textContent = folder ? ('📁 ' + folder) : '— No folder —';
                divider.appendChild(divLabel);

                if (folder) {
                    const delBtn = document.createElement('button');
                    delBtn.innerHTML = '🗑️';
                    delBtn.title = 'Delete folder "' + folder + '" (clears assignment from all channels)';
                    delBtn.style.cssText = [
                        'background:none;border:none;cursor:pointer;',
                        'font-size:12px;padding:0 2px;touch-action:manipulation;opacity:0.6;'
                    ].join('');
                    delBtn.addEventListener('mouseenter', function () { delBtn.style.opacity = '1'; });
                    delBtn.addEventListener('mouseleave', function () { delBtn.style.opacity = '0.6'; });
                    delBtn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        promptConfirm(
                            'Delete folder "' + folder + '"?\n\n' +
                            'This will remove the folder name and clear its assignment from all channels that use it.',
                            function (ok) { if (ok) deleteFolder(folder); },
                            'Delete Folder'
                        );
                    });
                    divider.appendChild(delBtn);
                }
                listEl.appendChild(divider);
            }

            const stColor = onCanvas ? (st === 'ok' ? '#00e676' : '#ff5252') : '#444466';
            const stIcon  = onCanvas ? (st === 'ok' ? '✓' : '⚠') : '·';
            const stTip   = !onCanvas ? 'Not on canvas'
                          : st === 'ok'     ? 'Linked — both IN and OUT present'
                          : st === 'no_out' ? 'Missing OUT portal'
                          :                   'Missing IN portal';

            const row = document.createElement('div');
            row.className    = 'pcm-ch-row';
            row.dataset.ch   = String(ch);
            row.style.cssText = [
                'padding:7px 10px;display:flex;align-items:center;gap:4px;',
                'border-bottom:1px solid #16162e;cursor:pointer;',
                isSelected ? 'background:#1a1a44;' : ''
            ].join('');

            // Selection-mode checkbox indicator
            if (pcmSelectionMode && !readOnly) {
                const chk = document.createElement('span');
                chk.style.cssText = [
                    'width:14px;height:14px;border-radius:3px;flex-shrink:0;',
                    'border:1px solid ' + (isSelected ? '#7788ff' : '#404055') + ';',
                    'background:' + (isSelected ? '#334488' : 'transparent') + ';',
                    'display:flex;align-items:center;justify-content:center;font-size:9px;'
                ].join('');
                chk.textContent = isSelected ? '✓' : '';
                row.appendChild(chk);
            }

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

            // Provenance badges (Uploaded / Merged tabs)
            if (pcmActiveTab === 'uploaded' && pcmData[ch] !== undefined) {
                const b = document.createElement('span');
                b.title = 'Also in Current list';
                b.style.cssText = 'font-size:9px;color:#ff9a00;background:#1a1200;padding:1px 4px;border-radius:3px;flex-shrink:0;';
                b.textContent = 'cur';
                row.appendChild(b);
            }
            if (pcmActiveTab === 'merged') {
                if (pcmData[ch] !== undefined) {
                    const b = document.createElement('span');
                    b.title = 'From Current list';
                    b.style.cssText = 'font-size:9px;color:#ff9a00;background:#1a1200;padding:1px 4px;border-radius:3px;flex-shrink:0;';
                    b.textContent = 'cur';
                    row.appendChild(b);
                }
                if (pcmOldData && pcmOldData[ch] !== undefined) {
                    const b = document.createElement('span');
                    b.title = 'From Uploaded list';
                    b.style.cssText = 'font-size:9px;color:#6688ff;background:#00001a;padding:1px 4px;border-radius:3px;flex-shrink:0;';
                    b.textContent = 'upl';
                    row.appendChild(b);
                }
            }

            // Label
            const lblSpan = document.createElement('span');
            lblSpan.style.cssText = 'flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;';
            if (chData.label) { lblSpan.style.color = '#cccccc'; lblSpan.textContent = chData.label; }
            else              { lblSpan.style.color = '#383858'; lblSpan.textContent = 'no label'; }
            row.appendChild(lblSpan);

            // Folder badge (suppressed where folder dividers show)
            if (chData.folder && !(pcmActiveTab === 'current' && sortMode === 'folder')) {
                const fb = document.createElement('span');
                fb.style.cssText = 'font-size:10px;color:#5566aa;background:#181830;padding:1px 4px;border-radius:3px;white-space:nowrap;flex-shrink:0;';
                fb.textContent = '📁' + chData.folder;
                row.appendChild(fb);
            }

            // IN→OUT count
            const countSpan = document.createElement('span');
            countSpan.title = (ins[ch]||0) + ' IN, ' + (outs[ch]||0) + ' OUT on canvas';
            countSpan.style.cssText = 'font-size:10px;color:#444466;white-space:nowrap;flex-shrink:0;';
            countSpan.textContent = onCanvas ? ((ins[ch]||0) + '→' + (outs[ch]||0)) : '–';
            row.appendChild(countSpan);

            // Row button helper
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

            // Row buttons — suppressed in selection mode to avoid confusion
            if (!pcmSelectionMode) {
                if (!readOnly) {
                    row.appendChild(mkRowBtn('✏️', 'Edit label and folder', function () { editChannel(ch); }));
                    row.appendChild(mkRowBtn('⇄',  'Move channel to another number', function () { moveChannel(ch); }));
                }

                const hlBtn = mkRowBtn(
                    '🔍',
                    onCanvas ? 'Flash channel red (press 📡 to stop)' : 'Channel not on canvas',
                    function () {
                        if (!onCanvas) { logMessage('[PCM] Channel ' + ch + ' is not on the canvas.'); return; }
                        if (pcmFlashChannel === ch) stopChannelFlash();
                        else startChannelFlash(ch);
                    }
                );
                if (!onCanvas) hlBtn.style.color = '#333344';
                row.appendChild(hlBtn);
            }

            // Long-press for multi-select (Current tab, not read-only)
            if (!readOnly) {
                let lpTimer = null;

                row.addEventListener('touchstart', function () {
                    lpTimer = setTimeout(function () {
                        lpTimer = null;
                        if (!pcmSelectionMode) {
                            pcmSelectionMode = true;
                            pcmSelectedChannels.clear();
                        }
                        pcmSelectedChannels.add(ch);
                        renderPanel();
                    }, 300);
                }, { passive: true });

                row.addEventListener('touchmove', function () {
                    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
                }, { passive: true });

                row.addEventListener('touchend', function () {
                    if (lpTimer) { clearTimeout(lpTimer); lpTimer = null; }
                });

                // In selection mode, tap toggles selection
                row.addEventListener('click', function () {
                    if (!pcmSelectionMode) return;
                    if (pcmSelectedChannels.has(ch)) pcmSelectedChannels.delete(ch);
                    else pcmSelectedChannels.add(ch);
                    renderList(); // partial re-render: just update row styles
                });
            }

            row.addEventListener('mouseenter', function () {
                if (!isSelected) this.style.background = '#1c1c3a';
            });
            row.addEventListener('mouseleave', function () {
                if (!pcmSelectedChannels.has(parseInt(this.dataset.ch))) this.style.background = '';
            });

            listEl.appendChild(row);
        });

        renderUnusedFolders(listEl, readOnly);

        let orphanCount = 0;
        all.forEach(function (ch) { if (getStatus(ch, ins, outs) !== 'ok') orphanCount++; });
        updateFooter(channels.length, orphanCount);
    }

    // Appends an "Unused Folders" section to the list container.
    // Only shown on the Current tab.
    function renderUnusedFolders(listEl, readOnly) {
        if (pcmActiveTab !== 'current' || readOnly) return;

        const usedFolders = new Set();
        for (const ch in pcmData) {
            if (pcmData[ch] && pcmData[ch].folder) usedFolders.add(pcmData[ch].folder);
        }
        const unused = pcmFolders.filter(function (f) { return !usedFolders.has(f); });
        if (unused.length === 0) return;

        const sectionHeader = document.createElement('div');
        sectionHeader.style.cssText = [
            'padding:4px 10px;background:#0f0f22;color:#556677;',
            'font-size:10px;letter-spacing:0.5px;text-transform:uppercase;',
            'border-top:2px solid #1e1e38;margin-top:4px;'
        ].join('');
        sectionHeader.textContent = 'Unused Folders';
        listEl.appendChild(sectionHeader);

        unused.forEach(function (f) {
            const row = document.createElement('div');
            row.style.cssText = [
                'padding:6px 10px;display:flex;align-items:center;justify-content:space-between;',
                'border-bottom:1px solid #16162e;'
            ].join('');

            const nameSpan = document.createElement('span');
            nameSpan.style.cssText = 'font-size:11px;color:#445566;';
            nameSpan.textContent = '📁 ' + f;
            row.appendChild(nameSpan);

            const delBtn = document.createElement('button');
            delBtn.innerHTML = '🗑️';
            delBtn.title = 'Delete unused folder "' + f + '"';
            delBtn.style.cssText = [
                'background:none;border:none;cursor:pointer;',
                'font-size:12px;padding:0 2px;touch-action:manipulation;opacity:0.5;'
            ].join('');
            delBtn.addEventListener('mouseenter', function () { delBtn.style.opacity = '1'; });
            delBtn.addEventListener('mouseleave', function () { delBtn.style.opacity = '0.5'; });
            delBtn.addEventListener('click', function () {
                promptConfirm(
                    'Delete empty folder "' + f + '"?',
                    function (ok) { if (ok) { pcmFolders = pcmFolders.filter(function (x) { return x !== f; }); renderList(); } },
                    'Delete Folder'
                );
            });
            row.appendChild(delBtn);

            listEl.appendChild(row);
        });
    }

    function updateFooter(total, orphans) {
        const f = document.getElementById('pcm-footer');
        if (!f) return;
        const tabNote = pcmActiveTab === 'uploaded' ? ' (read-only reference)'
                      : pcmActiveTab === 'merged'   ? ' (merged result)' : '';
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
        if (typeof elements === 'undefined' || typeof promptInput === 'undefined' || !elements.portal_in) {
            setTimeout(init, 400);
            return;
        }

        patchSaveLoad();
        patchPortalSelect();
        setupHoverBar();
        createToggleButton();

        // Stop flash on canvas reset
        if (typeof runAfterReset !== 'undefined' && Array.isArray(runAfterReset)) {
            runAfterReset.push(stopChannelFlash);
        }

        console.log('[PCM] Portal Channel Manager v4.0 loaded.');
    }

    init();

})();
