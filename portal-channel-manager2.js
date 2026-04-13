// ================================================================
//  PORTAL CHANNEL MANAGER — Sandboxels Mod
//  Version 2.0  |  Includes Project Manager
//
//  HOW TO INSTALL:
//  Host this file publicly and paste its URL into the Mods panel
//  in Sandboxels. A 📡 button will appear near the top-right.
//
//  SAVE COMPATIBILITY:
//  All PCM data (labels, uploaded list, merged list) is written
//  into the save file under the key "pcm". If this mod is not
//  installed, that key is silently ignored — the save loads
//  perfectly normally with no side effects.
//
//  PROJECT MANAGER SUMMARY:
//  📥 Export  — downloads the current channel list as a .json file.
//  📂 Import  — loads an old project's channel list into a read-only
//               "Uploaded" tab for cross-project reference.
//  🔀 Merged  — a third tab built by resolving conflicts between the
//               current and uploaded lists. Appears after the first
//               merge action, either at import time or when placing
//               a portal on a channel that exists in the old list.
//  📦 Export All — downloads a combined file (current + uploaded +
//               merged) for archival. Visible once a list is uploaded.
// ================================================================

(function () {
    'use strict';

    // ----------------------------------------------------------------
    //  STATE
    // ----------------------------------------------------------------

    // Current project's channel labels.
    // Structure: { [channelNumber]: { label: string, folder: string } }
    let pcmData = {};

    // Uploaded old project list. null = nothing uploaded yet.
    let pcmOldData = null;

    // Metadata from the uploaded file.
    // Structure: { saveName: string, exportedAt: number }
    let pcmOldMeta = null;

    // Merged channel list built from conflict resolution.
    // null = no merge has been performed yet.
    let pcmMergedData = null;

    // Which tab is currently visible in the panel.
    // Possible values: 'current' | 'uploaded' | 'merged'
    let pcmActiveTab = 'current';

    // Orphan-flash (canvas) state — channels with missing IN or OUT.
    let orphanFlashTimer = null;
    let orphanFlashState = false;
    let orphanChannels   = new Set();

    // Per-channel highlight timer (the blue/orange flash on locate).
    let highlightTimer = null;


    // ----------------------------------------------------------------
    //  CANVAS COORDINATE HELPERS
    //  Wrap the game's canvasCoord gracefully in case it is not yet
    //  available during early initialisation.
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
    //  CURRENT SAVE NAME
    // ----------------------------------------------------------------

    function getCurrentSaveName() {
        if (typeof currentSaveData !== 'undefined' && currentSaveData.name) {
            return currentSaveData.name;
        }
        return 'Untitled Save';
    }


    // ----------------------------------------------------------------
    //  PORTAL SCAN
    //  Walks the entire pixelMap and tallies portal_in / portal_out
    //  counts per channel number.
    // ----------------------------------------------------------------

    function scanPortals() {
        var ins = {}, outs = {};
        if (typeof pixelMap === 'undefined') return { ins: ins, outs: outs, all: new Set() };

        for (var x = 0; x < pixelMap.length; x++) {
            if (!pixelMap[x]) continue;
            for (var y = 0; y < pixelMap[x].length; y++) {
                var p = pixelMap[x][y];
                if (!p || !p.element || !elements[p.element]) continue;
                var ch = parseInt(p.channel) || 0;
                var el = elements[p.element];
                if (el.id === elements.portal_in.id)  ins[ch]  = (ins[ch]  || 0) + 1;
                if (el.id === elements.portal_out.id) outs[ch] = (outs[ch] || 0) + 1;
            }
        }
        var allKeys = Object.keys(ins).concat(Object.keys(outs)).map(Number);
        var all = new Set(allKeys);
        return { ins: ins, outs: outs, all: all };
    }

    function getStatus(ch, ins, outs) {
        var hi = !!ins[ch], ho = !!outs[ch];
        if (hi && ho) return 'ok';
        if (hi)       return 'no_out';
        if (ho)       return 'no_in';
        return 'empty';
    }

    function getAllOrphanChannels() {
        var scan = scanPortals();
        var ins = scan.ins, outs = scan.outs, all = scan.all;
        var result = new Set();
        all.forEach(function (ch) {
            if (getStatus(ch, ins, outs) !== 'ok') result.add(ch);
        });
        return result;
    }

    function getPortalsForChannel(ch) {
        var result = [];
        if (typeof pixelMap === 'undefined') return result;
        for (var x = 0; x < pixelMap.length; x++) {
            if (!pixelMap[x]) continue;
            for (var y = 0; y < pixelMap[x].length; y++) {
                var p = pixelMap[x][y];
                if (!p || !p.element || !elements[p.element]) continue;
                var pCh = parseInt(p.channel) || 0;
                if (pCh !== ch) continue;
                var el = elements[p.element];
                if (el.id === elements.portal_in.id || el.id === elements.portal_out.id) {
                    result.push(p);
                }
            }
        }
        return result;
    }


    // ----------------------------------------------------------------
    //  CANVAS OVERLAY
    //  A transparent canvas stacked above the game canvas, used for
    //  non-destructive pixel highlighting and orphan flash.
    // ----------------------------------------------------------------

    function getOrCreateOverlay() {
        var gameCanvas = document.querySelector('canvas');
        if (!gameCanvas) return null;

        var overlay = document.getElementById('pcm-overlay');
        if (!overlay) {
            overlay = document.createElement('canvas');
            overlay.id = 'pcm-overlay';
            overlay.style.cssText = 'position:fixed;pointer-events:none;z-index:1000;';
            document.body.appendChild(overlay);
        }

        // Re-sync size and position every call to handle window resize.
        var rect = gameCanvas.getBoundingClientRect();
        overlay.width        = gameCanvas.width;
        overlay.height       = gameCanvas.height;
        overlay.style.left   = rect.left   + 'px';
        overlay.style.top    = rect.top    + 'px';
        overlay.style.width  = rect.width  + 'px';
        overlay.style.height = rect.height + 'px';

        return overlay;
    }

    function clearOverlay() {
        var o = document.getElementById('pcm-overlay');
        if (o) o.getContext('2d').clearRect(0, 0, o.width, o.height);
    }

    function paintOverlayPixels(ctx, pixels, color) {
        var ps = pcmPixelSize();
        ctx.fillStyle = color;
        for (var i = 0; i < pixels.length; i++) {
            var p = pixels[i];
            if (!p || p.del) continue;
            ctx.fillRect(pcmCoord(p.x), pcmCoord(p.y), ps, ps);
        }
    }


    // ----------------------------------------------------------------
    //  ORPHAN FLASH
    //  Runs on a 650 ms interval while the panel is closed.
    //  Highlights channels that have IN but no OUT (or vice versa).
    //  Stops when the panel opens; restarts when the panel closes.
    // ----------------------------------------------------------------

    function startOrphanFlash() {
        stopOrphanFlash();
        orphanFlashTimer = setInterval(function () {
            orphanChannels = getAllOrphanChannels();

            if (orphanChannels.size === 0) {
                clearOverlay();
                document.querySelectorAll('.pcm-ch-row').forEach(function (r) {
                    r.style.background = '';
                });
                return;
            }

            orphanFlashState = !orphanFlashState;

            var overlay = getOrCreateOverlay();
            if (overlay) {
                var ctx = overlay.getContext('2d');
                ctx.clearRect(0, 0, overlay.width, overlay.height);
                if (orphanFlashState) {
                    orphanChannels.forEach(function (ch) {
                        var pixels = getPortalsForChannel(ch);
                        paintOverlayPixels(ctx, pixels, 'rgba(255,50,50,0.72)');
                    });
                }
            }

            document.querySelectorAll('.pcm-ch-row').forEach(function (row) {
                var ch = parseInt(row.dataset.ch);
                if (orphanChannels.has(ch)) {
                    row.style.background = orphanFlashState ? 'rgba(255,50,50,0.18)' : '';
                }
            });
        }, 650);
    }

    function stopOrphanFlash() {
        if (orphanFlashTimer) { clearInterval(orphanFlashTimer); orphanFlashTimer = null; }
        clearOverlay();
        document.querySelectorAll('.pcm-ch-row').forEach(function (r) {
            r.style.background = '';
        });
    }


    // ----------------------------------------------------------------
    //  CHANNEL HIGHLIGHT (locate flash)
    //  Flashes portal_in pixels orange and portal_out pixels blue,
    //  alternating with white, seven times, then fades out.
    // ----------------------------------------------------------------

    function flashChannelOnCanvas(ch) {
        var portals   = getPortalsForChannel(ch);
        var inPixels  = portals.filter(function (p) { return elements[p.element].id === elements.portal_in.id; });
        var outPixels = portals.filter(function (p) { return elements[p.element].id === elements.portal_out.id; });

        if (!portals.length) {
            logMessage('[PCM] Channel ' + ch + ' has no portals on the canvas.');
            return;
        }

        if (highlightTimer) clearInterval(highlightTimer);

        var step  = 0;
        var steps = [
            { i: 'rgba(255,154,0,0.85)',  o: 'rgba(0,162,255,0.85)' },
            { i: 'rgba(255,255,255,0.9)', o: 'rgba(255,255,255,0.9)' },
            { i: 'rgba(255,154,0,0.85)',  o: 'rgba(0,162,255,0.85)' },
            { i: 'rgba(255,255,255,0.9)', o: 'rgba(255,255,255,0.9)' },
            { i: 'rgba(255,154,0,0.85)',  o: 'rgba(0,162,255,0.85)' },
            { i: 'rgba(255,255,255,0.9)', o: 'rgba(255,255,255,0.9)' },
            { i: 'rgba(255,154,0,0.85)',  o: 'rgba(0,162,255,0.85)' },
            null  // final step: clear
        ];

        highlightTimer = setInterval(function () {
            var s       = steps[step];
            var overlay = getOrCreateOverlay();
            if (!overlay) { clearInterval(highlightTimer); return; }

            var ctx = overlay.getContext('2d');
            ctx.clearRect(0, 0, overlay.width, overlay.height);

            if (s) {
                paintOverlayPixels(ctx, inPixels,  s.i);
                paintOverlayPixels(ctx, outPixels, s.o);
            }

            step++;
            if (step >= steps.length) {
                clearInterval(highlightTimer);
                clearOverlay();
                // Resume orphan flash if the panel has been closed in the meantime.
                if (!document.getElementById('pcm-panel')) startOrphanFlash();
            }
        }, 230);
    }


    // ----------------------------------------------------------------
    //  HOVER STATUS BAR
    //  A persistent strip at the bottom of the screen. Appears
    //  whenever the cursor or finger rests on a portal pixel and shows
    //  the channel number, type, and label.
    // ----------------------------------------------------------------

    function setupHoverBar() {
        var bar = document.createElement('div');
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
            var pixel;
            try { pixel = getPixel(mousePos.x, mousePos.y); } catch (e) { return; }

            if (!pixel || !pixel.element || !elements[pixel.element]) {
                bar.style.display = 'none';
                return;
            }

            var el    = elements[pixel.element];
            var isIn  = el.id === elements.portal_in.id;
            var isOut = el.id === elements.portal_out.id;
            if (!isIn && !isOut) { bar.style.display = 'none'; return; }

            var ch        = parseInt(pixel.channel) || 0;
            var type      = isIn ? 'IN ▶' : '◀ OUT';
            var typeColor = isIn ? '#ff9a00' : '#00a2ff';
            var lbl       = (pcmData[ch] && pcmData[ch].label)
                          ? pcmData[ch].label
                          : '<i style="color:#555">no label</i>';
            var fld       = (pcmData[ch] && pcmData[ch].folder)
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
    //  EXPORT — CURRENT LIST
    //  Downloads pcmData as a standalone .json file.
    //  The save's name is included so the file is identifiable later.
    // ----------------------------------------------------------------

    function exportCurrentList() {
        var saveName  = getCurrentSaveName();
        var exportObj = {
            pcmVersion:  1,
            type:        'pcm-single',
            saveName:    saveName,
            exportedAt:  Date.now(),
            channelData: JSON.parse(JSON.stringify(pcmData))
        };
        var blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
        var a    = document.createElement('a');
        a.href   = URL.createObjectURL(blob);
        a.download = (saveName || 'project').replace(/[^a-z0-9_\-]/gi, '_') + '_channels.json';
        a.click();
    }


    // ----------------------------------------------------------------
    //  EXPORT — COMBINED LIST
    //  Downloads a single file containing current, uploaded, and merged
    //  lists together. Intended as a cross-project archive.
    // ----------------------------------------------------------------

    function exportCombinedList() {
        var saveName  = getCurrentSaveName();
        var exportObj = {
            pcmVersion: 1,
            type:       'pcm-combined',
            exportedAt: Date.now(),
            current: {
                saveName:    saveName,
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
        var blob = new Blob([JSON.stringify(exportObj, null, 2)], { type: 'application/json' });
        var a    = document.createElement('a');
        a.href   = URL.createObjectURL(blob);
        a.download = (saveName || 'project').replace(/[^a-z0-9_\-]/gi, '_') + '_combined.json';
        a.click();
    }


    // ----------------------------------------------------------------
    //  IMPORT — OLD PROJECT LIST
    //  Opens a file picker, parses the JSON, then either shows the
    //  conflict resolution modal (if channel numbers overlap) or
    //  builds an automatic merge (if there are no conflicts).
    // ----------------------------------------------------------------

    function importOldList() {
        var input    = document.createElement('input');
        input.type   = 'file';
        input.accept = '.json';

        input.addEventListener('change', function (e) {
            var file = e.target.files[0];
            if (!file) return;

            var reader = new FileReader();
            reader.onload = function (ev) {
                var parsed;
                try {
                    parsed = JSON.parse(ev.target.result);
                } catch (err) {
                    logMessage('[PCM] Import failed — file is not valid JSON.');
                    return;
                }

                if (!parsed.pcmVersion) {
                    logMessage('[PCM] Import failed — file is not a valid PCM channel list.');
                    return;
                }

                if (parsed.type === 'pcm-combined') {
                    // A combined file has three sections. Ask the user which to
                    // load as the reference. Merged is the most useful default.
                    promptConfirm(
                        'This is a combined PCM export file.\n\n' +
                        'OK  →  Load the Merged section as the reference list.\n' +
                        'Cancel  →  Load the Current section instead.',
                        function (useMerged) {
                            var section = useMerged ? parsed.merged : parsed.current;
                            if (!section || !section.channelData) {
                                logMessage('[PCM] The selected section is empty or missing.'); return;
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
                        logMessage('[PCM] Import failed — channelData field is missing.');
                        return;
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

    // Applies the uploaded data to pcmOldData/Meta, then determines
    // whether conflicts exist and takes the appropriate action.
    function loadOldData(channelData, meta) {
        pcmOldData = channelData;
        pcmOldMeta = meta;
        // pcmMergedData is intentionally not reset here — the user may
        // have prior merge work from a previous session.

        var conflicts = [];
        for (var ch in channelData) {
            if (pcmData[Number(ch)] !== undefined) conflicts.push(Number(ch));
        }

        if (conflicts.length > 0) {
            showConflictModal(conflicts);
        } else {
            // No conflicts — silently build a full union into the merged list.
            buildAutoMerge([]);
            pcmActiveTab = 'uploaded';
            renderPanel();
            logMessage(
                '[PCM] Uploaded "' + meta.saveName + '". ' +
                Object.keys(channelData).length +
                ' channels, no conflicts. Merged tab created automatically.'
            );
        }
    }


    // ----------------------------------------------------------------
    //  CONFLICT RESOLUTION MODAL
    //  A full-screen overlay presenting every conflicting channel
    //  with three options: Keep Current, Keep Uploaded, or Skip.
    //  This approach is more touch-friendly than sequential prompts.
    // ----------------------------------------------------------------

    function showConflictModal(conflicts) {
        var existing = document.getElementById('pcm-conflict-modal');
        if (existing) existing.remove();

        // choices[ch] = 'current' | 'uploaded' | 'skip'
        var choices = {};
        conflicts.forEach(function (ch) { choices[ch] = 'current'; });

        var modal = document.createElement('div');
        modal.id = 'pcm-conflict-modal';
        modal.style.cssText = [
            'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;',
            'background:rgba(0,0,0,0.84);',
            'display:flex;align-items:center;justify-content:center;'
        ].join('');

        var box = document.createElement('div');
        box.style.cssText = [
            'background:#11112b;border:2px solid #ff9a00;border-radius:10px;',
            'max-width:390px;width:94%;max-height:88vh;',
            'display:flex;flex-direction:column;font-family:monospace;color:#eee;',
            'overflow:hidden;box-shadow:0 12px 48px rgba(0,0,0,0.9);'
        ].join('');

        var boxHeader = document.createElement('div');
        boxHeader.style.cssText = [
            'background:#0f3460;padding:10px 14px;border-bottom:1px solid #ff9a00;',
            'font-size:13px;font-weight:bold;'
        ].join('');
        boxHeader.textContent = '⚠️ Channel Conflicts Detected';
        box.appendChild(boxHeader);

        var subtitle = document.createElement('div');
        subtitle.style.cssText = [
            'padding:8px 14px;font-size:11px;color:#aaa;',
            'border-bottom:1px solid #1e1e38;line-height:1.5;'
        ].join('');
        subtitle.innerHTML = (
            '<b style="color:#ff9a00">' + conflicts.length + '</b> channel' +
            (conflicts.length !== 1 ? 's' : '') + ' exist in both lists. ' +
            'Choose which label to keep in the ' +
            '<b style="color:#aa77ff">Merged</b> list for each.'
        );
        box.appendChild(subtitle);

        var scrollArea = document.createElement('div');
        scrollArea.style.cssText = 'overflow-y:auto;flex:1;padding:6px 0;';

        conflicts.forEach(function (ch) {
            var currentLabel  = (pcmData[ch]   && pcmData[ch].label)   ? pcmData[ch].label   : '(no label)';
            var uploadedLabel = (pcmOldData[ch] && pcmOldData[ch].label) ? pcmOldData[ch].label : '(no label)';

            var row = document.createElement('div');
            row.style.cssText = 'padding:9px 14px;border-bottom:1px solid #16162e;';

            var chTitle = document.createElement('div');
            chTitle.style.cssText = 'font-size:12px;color:#ff9a00;margin-bottom:6px;';
            chTitle.textContent = 'Channel ' + ch;
            row.appendChild(chTitle);

            var btnRow = document.createElement('div');
            btnRow.style.cssText = 'display:flex;gap:6px;';

            var btnDefs = [
                {
                    pick: 'current',
                    label: '✓ Keep Current',
                    sub: currentLabel,
                    activeColor: '#1a3a1a', activeText: '#88ff88', activeBorder: '#44884488'
                },
                {
                    pick: 'uploaded',
                    label: 'Keep Uploaded',
                    sub: uploadedLabel,
                    activeColor: '#1a1a3a', activeText: '#6688ff', activeBorder: '#44448888'
                },
                {
                    pick: 'skip',
                    label: 'Skip',
                    sub: 'exclude',
                    activeColor: '#2a1a1a', activeText: '#cc6644', activeBorder: '#88443388'
                }
            ];

            var allBtnItems = [];

            btnDefs.forEach(function (def) {
                var btn = document.createElement('button');
                btn.dataset.pick = def.pick;
                btn.style.cssText = [
                    'flex:1;padding:6px 4px;font-size:10px;line-height:1.4;',
                    'border-radius:4px;cursor:pointer;font-family:monospace;',
                    'touch-action:manipulation;'
                ].join('');
                btn.innerHTML = (
                    def.label +
                    '<br><span style="color:#999;font-size:9px;">' + def.sub + '</span>'
                );

                function applyStyle(isActive) {
                    btn.style.background = isActive ? def.activeColor : '#0a0a1e';
                    btn.style.color      = isActive ? def.activeText  : '#445566';
                    btn.style.border     = isActive
                        ? '1px solid ' + def.activeBorder
                        : '1px solid #22223344';
                }

                applyStyle(def.pick === 'current'); // default selection
                allBtnItems.push({ btn: btn, def: def, applyStyle: applyStyle });

                btn.addEventListener('click', function () {
                    choices[ch] = def.pick;
                    allBtnItems.forEach(function (item) {
                        item.applyStyle(item.def.pick === def.pick);
                    });
                });

                btnRow.appendChild(btn);
            });

            row.appendChild(btnRow);
            scrollArea.appendChild(row);
        });

        box.appendChild(scrollArea);

        var modalFooter = document.createElement('div');
        modalFooter.style.cssText = [
            'padding:10px 14px;display:flex;gap:8px;',
            'border-top:1px solid #1e1e38;background:#0a0a1e;'
        ].join('');

        var btnCancel = document.createElement('button');
        btnCancel.textContent = 'Cancel Import';
        btnCancel.style.cssText = [
            'flex:1;padding:9px;background:#1a0a0a;color:#cc5544;',
            'border:1px solid #884433;border-radius:5px;cursor:pointer;',
            'font-size:12px;font-family:monospace;touch-action:manipulation;'
        ].join('');
        btnCancel.addEventListener('click', function () {
            pcmOldData = null; pcmOldMeta = null;
            modal.remove();
        });

        var btnApply = document.createElement('button');
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

        modalFooter.appendChild(btnCancel);
        modalFooter.appendChild(btnApply);
        box.appendChild(modalFooter);
        modal.appendChild(box);
        document.body.appendChild(modal);
    }

    // Called after the user clicks "Apply" in the conflict modal.
    function applyConflictResolution(conflicts, choices) {
        buildAutoMerge(conflicts); // auto-merge all non-conflicting channels

        conflicts.forEach(function (ch) {
            var pick = choices[ch];
            if (pick === 'current') {
                pcmMergedData[ch] = JSON.parse(JSON.stringify(
                    pcmData[ch] || { label: '', folder: '' }
                ));
            } else if (pick === 'uploaded') {
                pcmMergedData[ch] = JSON.parse(JSON.stringify(
                    pcmOldData[ch] || { label: '', folder: '' }
                ));
            }
            // pick === 'skip' → channel intentionally excluded from merged
        });

        pcmActiveTab = 'merged';
        renderPanel();
        logMessage(
            '[PCM] Merged tab created with ' + Object.keys(pcmMergedData).length + ' channels.'
        );
    }

    // Populates pcmMergedData with all channels from both the current
    // and uploaded lists, excluding any in excludeChannels (which are
    // handled separately by the conflict resolver).
    function buildAutoMerge(excludeChannels) {
        if (!pcmMergedData) pcmMergedData = {};
        var excluded = new Set((excludeChannels || []).map(Number));

        for (var ch in pcmData) {
            if (!excluded.has(Number(ch))) {
                pcmMergedData[ch] = JSON.parse(JSON.stringify(pcmData[ch]));
            }
        }
        for (var ch2 in (pcmOldData || {})) {
            if (!excluded.has(Number(ch2)) && !pcmMergedData[ch2]) {
                pcmMergedData[ch2] = JSON.parse(JSON.stringify(pcmOldData[ch2]));
            }
        }
    }


    // ----------------------------------------------------------------
    //  PORTAL SHIFT-SELECT OVERRIDE
    //  Replaces the default plain number prompt with a full channel
    //  picker showing existing channels with labels and status.
    //  After the user enters a number, two chained checks run:
    //    1. Does this channel exist in the uploaded list but not yet
    //       in the merged list? → offer to add it to Merged.
    //    2. Does this channel already have both IN and OUT on canvas?
    //       → warn before proceeding.
    //  Placement only happens after both checks pass.
    // ----------------------------------------------------------------

    function patchPortalSelect() {
        function buildPicker(typeName) {
            return function () {
                var scan     = scanPortals();
                var ins      = scan.ins, outs = scan.outs, all = scan.all;
                var channels = Array.from(all).sort(function (a, b) { return a - b; });

                var msg = 'Type a channel number to use.\n';
                if (channels.length > 0) {
                    msg += '\nExisting channels on canvas:\n';
                    channels.forEach(function (ch) {
                        var st  = getStatus(ch, ins, outs);
                        var ico = st === 'ok' ? '✓' : '⚠';
                        var stl = st === 'ok'     ? 'linked'
                                : st === 'no_out' ? 'no OUT' : 'no IN';
                        var lbl = (pcmData[ch] && pcmData[ch].label)
                                ? '  →  ' + pcmData[ch].label : '';
                        var fld = (pcmData[ch] && pcmData[ch].folder)
                                ? ' [' + pcmData[ch].folder + ']' : '';
                        msg += '  ' + ico + ' Ch ' + ch + '  (' + stl + ')' + lbl + fld + '\n';
                    });
                } else {
                    msg += '(No portals on canvas yet)\n';
                }

                promptInput(msg, function (r) {
                    if (r === '' || r === null) return;
                    var ch = parseInt(r);
                    if (isNaN(ch)) { logMessage('[PCM] Invalid channel number.'); return; }

                    var scan2     = scanPortals();
                    var st        = getStatus(ch, scan2.ins, scan2.outs);
                    var inOldList = pcmOldData && (pcmOldData[ch] !== undefined);
                    var inMerged  = pcmMergedData && (pcmMergedData[ch] !== undefined);

                    function finallyApply() {
                        currentElementProp = { channel: ch };
                    }

                    // Check 2: channel fully linked on canvas already.
                    function checkInUseWarning(onConfirm) {
                        if (st === 'ok') {
                            promptConfirm(
                                'Channel ' + ch + ' already has both a portal_in AND a portal_out.\n\n' +
                                'Adding more portals on the same channel can cause unexpected routing.\n\n' +
                                'Continue anyway?',
                                function (ok) { if (ok) onConfirm(); },
                                'Channel ' + ch + ' Is Already In Use'
                            );
                        } else {
                            onConfirm();
                        }
                    }

                    // Check 1: channel exists in the uploaded list but not merged.
                    function checkOldListWarning(onConfirm) {
                        if (inOldList && !inMerged) {
                            var oldLabel = (pcmOldData[ch] && pcmOldData[ch].label)
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
                        } else {
                            onConfirm();
                        }
                    }

                    // Run check 1 → check 2 → apply.
                    checkOldListWarning(function () {
                        checkInUseWarning(function () {
                            finallyApply();
                        });
                    });

                }, typeName + ' — Channel Picker');
            };
        }

        elements.portal_in.onShiftSelect  = buildPicker('Portal IN');
        elements.portal_out.onShiftSelect = buildPicker('Portal OUT');
    }


    // ----------------------------------------------------------------
    //  SAVE / LOAD PATCHING
    //  generateSave is wrapped to embed all PCM state into the save
    //  JSON under the key "pcm". loadSave is wrapped to restore it.
    //  If the mod is not installed, the "pcm" key is silently ignored.
    // ----------------------------------------------------------------

    function patchSaveLoad() {
        var origGen = window.generateSave;
        window.generateSave = function () {
            var save       = origGen.apply(this, arguments);
            var pcmSection = {};

            if (Object.keys(pcmData).length > 0)
                pcmSection.channelData  = JSON.parse(JSON.stringify(pcmData));
            if (pcmOldData)
                pcmSection.uploadedData = JSON.parse(JSON.stringify(pcmOldData));
            if (pcmOldMeta)
                pcmSection.uploadedMeta = JSON.parse(JSON.stringify(pcmOldMeta));
            if (pcmMergedData)
                pcmSection.mergedData   = JSON.parse(JSON.stringify(pcmMergedData));

            if (Object.keys(pcmSection).length > 0) save.pcm = pcmSection;
            return save;
        };

        var origLoad = window.loadSave;
        window.loadSave = function (saveJSON) {
            var pcm       = (saveJSON && saveJSON.pcm) || {};
            pcmData       = pcm.channelData  || {};
            pcmOldData    = pcm.uploadedData || null;
            pcmOldMeta    = pcm.uploadedMeta || null;
            pcmMergedData = pcm.mergedData   || null;
            pcmActiveTab  = 'current';

            var result = origLoad.apply(this, arguments);

            setTimeout(function () {
                if (document.getElementById('pcm-panel')) renderPanel();
            }, 900);

            return result;
        };
    }


    // ----------------------------------------------------------------
    //  PANEL — TOGGLE BUTTON
    // ----------------------------------------------------------------

    function createToggleButton() {
        var btn = document.createElement('button');
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
        var existing = document.getElementById('pcm-panel');
        if (existing) {
            existing.remove();
            startOrphanFlash();
        } else {
            openPanel();
        }
    }


    // ----------------------------------------------------------------
    //  PANEL — STRUCTURE
    //  The panel is a flex column: drag header → tab bar → toolbar →
    //  scrollable channel list → footer.
    //  renderPanel() re-renders tabs, toolbar, and list in sequence.
    // ----------------------------------------------------------------

    function openPanel() {
        stopOrphanFlash();

        var panel = document.createElement('div');
        panel.id = 'pcm-panel';
        panel.style.cssText = [
            'position:fixed;top:48px;right:5px;width:340px;max-height:84vh;',
            'background:#11112b;border:2px solid #ff9a00;border-radius:9px;',
            'z-index:9999;font-family:monospace;color:#eee;',
            'display:flex;flex-direction:column;overflow:hidden;',
            'box-shadow:0 8px 32px rgba(0,0,0,0.7);'
        ].join('');

        var header = document.createElement('div');
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

        var tabBar = document.createElement('div');
        tabBar.id = 'pcm-tab-bar';
        tabBar.style.cssText = 'display:flex;background:#0a0a1e;border-bottom:1px solid #1e1e38;';
        panel.appendChild(tabBar);

        var toolbar = document.createElement('div');
        toolbar.id = 'pcm-toolbar';
        toolbar.style.cssText = [
            'padding:6px 8px;display:flex;gap:5px;flex-wrap:wrap;',
            'border-bottom:1px solid #1e1e38;background:#0a0a1e;'
        ].join('');
        panel.appendChild(toolbar);

        var listEl = document.createElement('div');
        listEl.id = 'pcm-list';
        listEl.style.cssText = 'overflow-y:auto;flex:1;';
        panel.appendChild(listEl);

        var footer = document.createElement('div');
        footer.id = 'pcm-footer';
        footer.style.cssText = [
            'padding:4px 10px;background:#080818;',
            'border-top:1px solid #1e1e38;font-size:11px;color:#777;min-height:22px;'
        ].join('');
        panel.appendChild(footer);

        document.body.appendChild(panel);

        document.getElementById('pcm-close-btn').addEventListener('click', function () {
            panel.remove();
            startOrphanFlash();
        });

        // Drag support — mouse and touch
        var dragging = false, dX = 0, dY = 0;
        header.addEventListener('mousedown', function (e) {
            dragging = true;
            var r = panel.getBoundingClientRect();
            dX = e.clientX - r.left; dY = e.clientY - r.top;
            panel.style.right = 'auto'; e.preventDefault();
        });
        header.addEventListener('touchstart', function (e) {
            var t = e.touches[0]; dragging = true;
            var r = panel.getBoundingClientRect();
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
            var t = e.touches[0];
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
        var tabBar = document.getElementById('pcm-tab-bar');
        if (!tabBar) return;
        tabBar.innerHTML = '';

        var tabs = [{ id: 'current', label: '📋 Current' }];
        if (pcmOldData)    tabs.push({ id: 'uploaded', label: '📂 Uploaded' });
        if (pcmMergedData) tabs.push({ id: 'merged',   label: '🔀 Merged'   });

        var validIds = tabs.map(function (t) { return t.id; });
        if (validIds.indexOf(pcmActiveTab) === -1) pcmActiveTab = 'current';

        tabs.forEach(function (tab) {
            var btn      = document.createElement('button');
            var isActive = tab.id === pcmActiveTab;
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
    //  Content differs per active tab.
    //    Current  — sort selector, scan, add label, export, import
    //    Uploaded — project name badge, replace, export all
    //    Merged   — result badge, export all
    // ----------------------------------------------------------------

    function renderToolbar() {
        var toolbar = document.getElementById('pcm-toolbar');
        if (!toolbar) return;
        toolbar.innerHTML = '';

        function mkBtn(html, title, onClick) {
            var b = document.createElement('button');
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
            var sortSel = document.createElement('select');
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
            toolbar.appendChild(mkBtn('📥 Export', 'Download current list as JSON', exportCurrentList));
            toolbar.appendChild(mkBtn('📂 Import', 'Load an old project list', importOldList));

        } else if (pcmActiveTab === 'uploaded') {
            var badge = document.createElement('span');
            badge.style.cssText = [
                'flex:1;font-size:10px;color:#5577aa;',
                'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
            ].join('');
            badge.textContent = '📂 ' + (pcmOldMeta ? pcmOldMeta.saveName : 'Uploaded');
            toolbar.appendChild(badge);

            toolbar.appendChild(mkBtn('🔄', 'Re-scan', renderList));
            toolbar.appendChild(mkBtn('📂 Replace', 'Load a different old list', importOldList));
            toolbar.appendChild(mkBtn('📦 Export All', 'Download current + uploaded + merged', exportCombinedList));

        } else if (pcmActiveTab === 'merged') {
            var mbadge = document.createElement('span');
            mbadge.style.cssText = [
                'flex:1;font-size:10px;color:#aa77ff;',
                'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
            ].join('');
            mbadge.textContent = '🔀 Merged Result';
            toolbar.appendChild(mbadge);

            toolbar.appendChild(mkBtn('🔄', 'Re-scan', renderList));
            toolbar.appendChild(mkBtn('📦 Export All', 'Download combined file', exportCombinedList));
        }
    }


    // ----------------------------------------------------------------
    //  PANEL — CHANNEL LIST
    //  Shared renderer for all three tabs. Data source and editability
    //  differ per tab. Cross-reference badges show provenance on the
    //  Uploaded and Merged tabs.
    // ----------------------------------------------------------------

    function renderList() {
        var listEl = document.getElementById('pcm-list');
        if (!listEl) return;
        listEl.innerHTML = '';

        var data, readOnly;
        if (pcmActiveTab === 'current') {
            data = pcmData; readOnly = false;
        } else if (pcmActiveTab === 'uploaded') {
            data = pcmOldData    || {}; readOnly = true;
        } else {
            data = pcmMergedData || {}; readOnly = true;
        }

        var scan  = scanPortals();
        var ins   = scan.ins, outs = scan.outs, all = scan.all;

        var sortSel  = document.getElementById('pcm-sort-sel');
        var sortMode = (pcmActiveTab === 'current' && sortSel) ? sortSel.value : 'num';

        var channelSet = new Set(Object.keys(data).map(Number));
        if (pcmActiveTab === 'current') {
            all.forEach(function (ch) { channelSet.add(ch); });
        }
        var channels = Array.from(channelSet);

        channels.sort(function (a, b) {
            if (sortMode === 'num') return a - b;
            if (sortMode === 'label') {
                var la = (data[a] || {}).label || '', lb = (data[b] || {}).label || '';
                return la.localeCompare(lb) || a - b;
            }
            if (sortMode === 'folder') {
                var fa = (data[a] || {}).folder || '', fb = (data[b] || {}).folder || '';
                return fa.localeCompare(fb) || a - b;
            }
            if (sortMode === 'status') {
                var order = { ok: 0, no_out: 1, no_in: 2, empty: 3 };
                return (order[getStatus(a, ins, outs)] || 0) - (order[getStatus(b, ins, outs)] || 0) || a - b;
            }
            return a - b;
        });

        if (channels.length === 0) {
            var msg = pcmActiveTab === 'current'
                ? 'No portal channels found.<br>Place portal_in or portal_out pixels,<br>then press 🔄 Scan.'
                : pcmActiveTab === 'uploaded'
                ? 'The uploaded list is empty.'
                : 'No merged channels yet.';
            listEl.innerHTML = (
                '<div style="padding:20px 14px;color:#555;text-align:center;font-size:12px;">' +
                msg + '</div>'
            );
            updateFooter(0, 0);
            return;
        }

        var currentFolder = Symbol(); // sentinel — no string can equal this

        channels.forEach(function (ch) {
            var chData   = data[ch] || {};
            var st       = getStatus(ch, ins, outs);
            var folder   = chData.folder || '';
            var onCanvas = all.has(ch);

            // Folder dividers (current tab, folder sort mode only)
            if (pcmActiveTab === 'current' && sortMode === 'folder' && folder !== currentFolder) {
                currentFolder = folder;
                var divider = document.createElement('div');
                divider.style.cssText = [
                    'padding:3px 10px;background:#191935;color:#7777aa;',
                    'font-size:10px;letter-spacing:0.5px;text-transform:uppercase;'
                ].join('');
                divider.textContent = folder ? ('📁 ' + folder) : '— No folder —';
                listEl.appendChild(divider);
            }

            var stColor = onCanvas
                ? (st === 'ok' ? '#00e676' : '#ff5252')
                : '#444466';
            var stIcon  = onCanvas ? (st === 'ok' ? '✓' : '⚠') : '·';
            var stTip   = !onCanvas       ? 'Not on canvas'
                        : st === 'ok'     ? 'Linked — both IN and OUT present'
                        : st === 'no_out' ? 'Missing OUT portal'
                        :                   'Missing IN portal';

            var inCount  = ins[ch]  || 0;
            var outCount = outs[ch] || 0;

            var row = document.createElement('div');
            row.className    = 'pcm-ch-row';
            row.dataset.ch   = String(ch);
            row.style.cssText = [
                'padding:7px 10px;display:flex;align-items:center;gap:5px;',
                'border-bottom:1px solid #16162e;cursor:pointer;'
            ].join('');

            var iconSpan = document.createElement('span');
            iconSpan.title = stTip;
            iconSpan.style.cssText = 'color:' + stColor + ';font-size:12px;min-width:13px;';
            iconSpan.textContent = stIcon;
            row.appendChild(iconSpan);

            var chSpan = document.createElement('span');
            chSpan.style.cssText = 'color:#ff9a00;font-size:12px;min-width:44px;';
            chSpan.textContent = 'Ch ' + ch;
            row.appendChild(chSpan);

            // Cross-reference provenance badges
            if (pcmActiveTab === 'uploaded' && pcmData[ch] !== undefined) {
                var b1 = document.createElement('span');
                b1.title = 'Also in Current list';
                b1.style.cssText = 'font-size:9px;color:#ff9a00;background:#1a1200;padding:1px 4px;border-radius:3px;';
                b1.textContent = 'cur';
                row.appendChild(b1);
            }
            if (pcmActiveTab === 'merged') {
                if (pcmData[ch] !== undefined) {
                    var b2 = document.createElement('span');
                    b2.title = 'From Current list';
                    b2.style.cssText = 'font-size:9px;color:#ff9a00;background:#1a1200;padding:1px 4px;border-radius:3px;';
                    b2.textContent = 'cur';
                    row.appendChild(b2);
                }
                if (pcmOldData && pcmOldData[ch] !== undefined) {
                    var b3 = document.createElement('span');
                    b3.title = 'From Uploaded list';
                    b3.style.cssText = 'font-size:9px;color:#6688ff;background:#00001a;padding:1px 4px;border-radius:3px;';
                    b3.textContent = 'upl';
                    row.appendChild(b3);
                }
            }

            var lblSpan = document.createElement('span');
            lblSpan.style.cssText = [
                'flex:1;font-size:12px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
            ].join('');
            if (chData.label) {
                lblSpan.style.color = '#cccccc';
                lblSpan.textContent = chData.label;
            } else {
                lblSpan.style.color = '#383858';
                lblSpan.textContent = 'no label';
            }
            row.appendChild(lblSpan);

            if (chData.folder && !(pcmActiveTab === 'current' && sortMode === 'folder')) {
                var fldBadge = document.createElement('span');
                fldBadge.style.cssText = [
                    'font-size:10px;color:#5566aa;background:#181830;',
                    'padding:1px 4px;border-radius:3px;white-space:nowrap;'
                ].join('');
                fldBadge.textContent = '📁' + chData.folder;
                row.appendChild(fldBadge);
            }

            var countSpan = document.createElement('span');
            countSpan.title = inCount + ' IN, ' + outCount + ' OUT on canvas';
            countSpan.style.cssText = 'font-size:10px;color:#444466;white-space:nowrap;';
            countSpan.textContent = onCanvas ? (inCount + '→' + outCount) : '–';
            row.appendChild(countSpan);

            // Edit button — current tab only
            if (!readOnly) {
                var editBtn = document.createElement('button');
                editBtn.title = 'Edit label and folder';
                editBtn.style.cssText = [
                    'background:none;border:1px solid #303050;color:#777799;',
                    'border-radius:3px;cursor:pointer;font-size:11px;',
                    'padding:2px 6px;touch-action:manipulation;flex-shrink:0;'
                ].join('');
                editBtn.innerHTML = '✏️';
                (function (capturedCh) {
                    editBtn.addEventListener('click', function (e) {
                        e.stopPropagation();
                        editChannel(capturedCh);
                    });
                }(ch));
                row.appendChild(editBtn);
            }

            // Highlight (locate) button — all tabs
            var hlBtn = document.createElement('button');
            hlBtn.title = onCanvas
                ? 'Flash this channel on canvas'
                : 'Channel not currently on canvas';
            hlBtn.style.cssText = [
                'background:none;border:1px solid #303050;',
                'color:' + (onCanvas ? '#777799' : '#333344') + ';',
                'border-radius:3px;cursor:pointer;font-size:11px;',
                'padding:2px 6px;touch-action:manipulation;flex-shrink:0;'
            ].join('');
            hlBtn.innerHTML = '🔍';
            (function (capturedCh, capturedOnCanvas) {
                var action = function () {
                    if (capturedOnCanvas) {
                        flashChannelOnCanvas(capturedCh);
                    } else {
                        logMessage('[PCM] Channel ' + capturedCh + ' is not on the canvas.');
                    }
                };
                hlBtn.addEventListener('click', function (e) { e.stopPropagation(); action(); });
                row.addEventListener('click', function () { if (capturedOnCanvas) action(); });
            }(ch, onCanvas));
            row.appendChild(hlBtn);

            row.addEventListener('mouseenter', function () { this.style.background = '#1c1c3a'; });
            row.addEventListener('mouseleave', function () {
                if (!orphanChannels.has(parseInt(this.dataset.ch))) this.style.background = '';
            });

            listEl.appendChild(row);
        });

        var orphanCount = 0;
        all.forEach(function (ch) { if (getStatus(ch, ins, outs) !== 'ok') orphanCount++; });
        updateFooter(channels.length, orphanCount);
    }

    function updateFooter(total, orphans) {
        var f = document.getElementById('pcm-footer');
        if (!f) return;

        var tabNote = pcmActiveTab === 'uploaded' ? ' (read-only reference)'
                    : pcmActiveTab === 'merged'   ? ' (merged result)'
                    : '';

        var orphanText = '';
        if (pcmActiveTab === 'current') {
            orphanText = orphans > 0
                ? ' &nbsp;|&nbsp; <span style="color:#ff5252">⚠ ' + orphans +
                  ' missing link' + (orphans !== 1 ? 's' : '') + '</span>'
                : ' &nbsp;|&nbsp; <span style="color:#00e676">✓ All channels linked</span>';
        }

        f.innerHTML = total + ' channel' + (total !== 1 ? 's' : '') + tabNote + orphanText;
    }


    // ----------------------------------------------------------------
    //  EDIT CHANNEL LABEL / FOLDER
    // ----------------------------------------------------------------

    function editChannel(ch) {
        var data = pcmData[ch] || {};

        var existingFolders = [];
        for (var k in pcmData) {
            if (pcmData[k] && pcmData[k].folder) existingFolders.push(pcmData[k].folder);
        }
        existingFolders = existingFolders.filter(function (v, i, a) { return a.indexOf(v) === i; });
        var folderHint = existingFolders.length
            ? '\nExisting folders: ' + existingFolders.join(', ') : '';

        promptInput(
            'Label for Channel ' + ch + ':\n(current: ' + (data.label || 'none') + ')',
            function (label) {
                if (label === null) return;
                if (!pcmData[ch]) pcmData[ch] = { label: '', folder: '' };
                pcmData[ch].label = label.trim();

                promptInput(
                    'Folder for Channel ' + ch + ':' + folderHint +
                    '\n(leave empty to remove from any folder)',
                    function (folder) {
                        if (folder === null) return;
                        pcmData[ch].folder = folder.trim();
                        renderList();
                    },
                    'Assign Folder — Channel ' + ch
                );
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
                var ch = parseInt(r);
                if (isNaN(ch)) { logMessage('[PCM] Invalid channel number.'); return; }
                if (!pcmData[ch]) pcmData[ch] = { label: '', folder: '' };
                editChannel(ch);
            },
            'Manually Add Channel Label'
        );
    }


    // ----------------------------------------------------------------
    //  INIT
    //  Polls until the game's element registry and prompt system are
    //  available, then wires everything up.
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
        startOrphanFlash();

        console.log('[PCM] Portal Channel Manager v2.0 loaded.');
    }

    init();

})();
