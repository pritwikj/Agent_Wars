/* ===========================================================================
   iso.js — isometric projection, spiral block placement, depth keys, and the
   camera (auto-fit + manual pan/zoom).

   Projection: 2:1 diamonds. World position = continuous tile coords (tx, ty),
   z = height in pixels.
     screenX = (tx - ty) * TILE_W/2
     screenY = (tx + ty) * TILE_H/2 - z

   Depth: painter's algorithm on a single per-frame draw list. Sort key =
   (tx + ty) of the entity's SOUTH ANCHOR corner (for an [w,d] footprint at
   origin (tx,ty): anchor (tx+w-1, ty+d-1)). Citizens only ever stand on
   road tiles — never inside building footprints — which is the invariant
   that keeps this simple sort correct for multi-tile buildings.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const HALF_W = C.TILE_W / 2;
  const HALF_H = C.TILE_H / 2;

  function worldToScreen(tx, ty, z) {
    return { x: (tx - ty) * HALF_W, y: (tx + ty) * HALF_H - (z || 0) };
  }

  // Depth key for sorting; entities pass their south-anchor tile.
  function depthKey(tx, ty) { return (tx + ty) * 4096 + ty; }

  // ---- Spiral block placement ----------------------------------------------
  // Global block slot index -> block grid coords. Slot 0 = (0,0), then an
  // outward clockwise spiral (E, S, W, N with growing run lengths). Cached.
  const spiralCache = [{ bx: 0, by: 0 }];
  const posToSlot = new Map([['0,0', 0]]); // "bx,by" -> slot (reverse of spiralCache)
  const SPIRAL_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]]; // E, S, W, N
  let spiralState = { x: 0, y: 0, dir: 0, run: 1, stepInRun: 0, legInRun: 0 };
  function spiralSlot(s) {
    // Extend the cached walk as needed (run lengths 1,1,2,2,3,3,...).
    while (spiralCache.length <= s) {
      const st = spiralState;
      st.x += SPIRAL_DIRS[st.dir][0];
      st.y += SPIRAL_DIRS[st.dir][1];
      st.stepInRun++;
      if (st.stepInRun >= st.run) {
        st.stepInRun = 0;
        st.dir = (st.dir + 1) % 4;
        st.legInRun++;
        if (st.legInRun >= 2) { st.legInRun = 0; st.run++; }
      }
      spiralCache.push({ bx: st.x, by: st.y });
      posToSlot.set(st.x + ',' + st.y, spiralCache.length - 1);
    }
    return spiralCache[s];
  }

  // Reverse: block grid coords -> global slot index. Extends the spiral until it
  // has enumerated the full Chebyshev ring containing (bx,by) — (2r+1)^2 slots.
  function slotForPos(bx, by) {
    const key = bx + ',' + by;
    let s = posToSlot.get(key);
    if (s !== undefined) return s;
    const ring = Math.max(Math.abs(bx), Math.abs(by));
    const need = (2 * ring + 1) * (2 * ring + 1);
    while (spiralCache.length < need) spiralSlot(spiralCache.length);
    return posToSlot.get(key);
  }

  // Block tile origin (north corner tile) for a global block slot.
  function blockOrigin(slot) {
    const { bx, by } = spiralSlot(slot);
    return { tx: bx * C.BLOCK_TILES, ty: by * C.BLOCK_TILES };
  }

  // ---- Camera -----------------------------------------------------------------
  // Auto-fit frames the whole city; any drag/wheel suspends auto-fit and a 30s
  // idle timer resumes it. zoom in [MIN_ZOOM, MAX_ZOOM] — the low floor lets the
  // wheel pull right back for a whole-metro view.
  const AUTOFIT_RESUME_MS = 30_000;
  const MIN_ZOOM = 0.12, MAX_ZOOM = 2.5;
  function createCamera(canvas) {
    const cam = {
      x: 0, y: 0,          // world point at viewport center
      zoom: 1,
      targetX: 0, targetY: 0, targetZoom: 1,
      manual: false,
      lastInputAt: 0,
      bounds: null,         // world-space rect to auto-fit { minX, minY, maxX, maxY }
    };

    cam.setBounds = function (b) {
      cam.bounds = b;
      if (!cam.manual) cam.fit();
    };

    cam.fit = function () {
      const b = cam.bounds;
      if (!b) return;
      const cssW = canvas.clientWidth || 800;
      const cssH = canvas.clientHeight || 600;
      const pad = C.TILE_W * 1.5;
      const w = Math.max(1, b.maxX - b.minX + pad * 2);
      const h = Math.max(1, b.maxY - b.minY + pad * 2);
      cam.targetZoom = C.clamp(Math.min(cssW / w, cssH / h), MIN_ZOOM, MAX_ZOOM);
      cam.targetX = (b.minX + b.maxX) / 2;
      cam.targetY = (b.minY + b.maxY) / 2;
    };

    cam.update = function (dt) {
      // resume auto-fit after idle
      if (cam.manual && performance.now() - cam.lastInputAt > AUTOFIT_RESUME_MS) {
        cam.manual = false;
        cam.fit();
      }
      const k = Math.min(1, dt * 3.5); // ease
      cam.x = C.lerp(cam.x, cam.targetX, k);
      cam.y = C.lerp(cam.y, cam.targetY, k);
      cam.zoom = C.lerp(cam.zoom, cam.targetZoom, k);
    };

    // Fly the camera to a world point (pre-camera screen px) at a chosen zoom.
    // Marks the move as manual so auto-fit doesn't immediately yank back; the
    // existing 30s idle timer resumes the whole-metro framing afterwards.
    cam.focusOn = function (wx, wy, zoom) {
      cam.manual = true;
      cam.lastInputAt = performance.now();
      cam.targetX = wx;
      cam.targetY = wy;
      if (typeof zoom === 'number') cam.targetZoom = C.clamp(zoom, MIN_ZOOM, MAX_ZOOM);
    };

    // Return to the default whole-metro auto-fit view (cancels manual pan/zoom).
    cam.resetView = function () {
      cam.manual = false;
      cam.fit();
    };

    // World -> canvas CSS pixel transform parameters.
    cam.viewTransform = function () {
      const cssW = canvas.clientWidth || 800;
      const cssH = canvas.clientHeight || 600;
      return {
        zoom: cam.zoom,
        offX: cssW / 2 - cam.x * cam.zoom,
        offY: cssH / 2 - cam.y * cam.zoom,
      };
    };

    // ---- Input: drag-pan + wheel-zoom ------------------------------------
    let dragging = false, lastMx = 0, lastMy = 0;
    function markManual() {
      cam.manual = true;
      cam.lastInputAt = performance.now();
    }
    canvas.addEventListener('mousedown', (e) => {
      dragging = true; lastMx = e.clientX; lastMy = e.clientY;
      markManual();
    });
    window.addEventListener('mousemove', (e) => {
      if (!dragging) return;
      const dx = e.clientX - lastMx, dy = e.clientY - lastMy;
      lastMx = e.clientX; lastMy = e.clientY;
      cam.targetX -= dx / cam.zoom;
      cam.targetY -= dy / cam.zoom;
      cam.x = cam.targetX; cam.y = cam.targetY; // direct, no easing while dragging
      markManual();
    });
    window.addEventListener('mouseup', () => { dragging = false; });
    canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      markManual();
      const factor = Math.exp(-e.deltaY * 0.0025);
      const nz = C.clamp(cam.targetZoom * factor, MIN_ZOOM, MAX_ZOOM);
      // zoom about the cursor: keep the world point under the mouse fixed
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left, my = e.clientY - rect.top;
      const vt = cam.viewTransform();
      const wx = (mx - vt.offX) / vt.zoom;
      const wy = (my - vt.offY) / vt.zoom;
      const cssW = canvas.clientWidth || 800, cssH = canvas.clientHeight || 600;
      cam.targetX = wx - (mx - cssW / 2) / nz;
      cam.targetY = wy - (my - cssH / 2) / nz;
      cam.targetZoom = nz;
    }, { passive: false });

    return cam;
  }

  Object.assign(window.CITY, { worldToScreen, depthKey, spiralSlot, slotForPos, blockOrigin, createCamera });
})();
