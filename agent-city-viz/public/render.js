/* ===========================================================================
   render.js — main animation loop and scene composition.

   Layers per frame (back to front):
     1. sky          — CSS gradient on the page body (free)
     2. ground       — static offscreen canvas (roads + grass), rebuilt only
                       when blocks appear (groundVersion changes)
     3. draw list    — lots (sprite-cached buildings), cranes, trees on empty
                       parcels, citizens — one painter's-algorithm sort by
                       south-anchor depth key
     4. effects      — particles (dust/sparks/smoke/confetti) on top
   (workers are silent: no labels, speech bubbles or activity feed.)

   Canvas is devicePixelRatio-aware with smoothing ON — crisp vector iso at
   any zoom (deliberate departure from the old 640x640 pixel-art blit).
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;

  const canvas = document.getElementById('city-canvas');
  const ctx = canvas.getContext('2d');
  const camera = C.createCamera(canvas);

  let groundCanvas = null;
  let groundMeta = null; // { minX, minY, res }
  let lastGroundVersion = -1;
  const GROUND_RES = 2;
  const GROUND_MAX_PX = 8192;
  const PATH_BUDGET = 16; // A* searches/frame shared by pedestrians + traffic

  // ---- Canvas sizing ----------------------------------------------------------
  function resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = canvas.clientWidth, h = canvas.clientHeight;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) {
      canvas.width = Math.round(w * dpr);
      canvas.height = Math.round(h * dpr);
    }
  }
  window.addEventListener('resize', () => { resize(); camera.fit(); });

  // ---- Static ground layer ------------------------------------------------------
  function blocksForRender() {
    const set = new Set(C.usedBlocks());
    set.add(0); // origin block always exists (fresh-city home for workers)
    return [...set];
  }

  function rebuildGround() {
    lastGroundVersion = C.getGroundVersion();
    const blocks = blocksForRender();
    const B = C.BLOCK_TILES;
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    for (const slot of blocks) {
      const o = C.blockOrigin(slot);
      for (const [cx, cy] of [[0, 0], [B, 0], [0, B], [B, B]]) {
        const p = C.worldToScreen(o.tx + cx, o.ty + cy, 0);
        minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x);
        minY = Math.min(minY, p.y); maxY = Math.max(maxY, p.y);
      }
    }
    // grow the ground to cover the ambient infrastructure ring + airport so the
    // beltway/rail/runway sit on countryside grass rather than on bare sky.
    if (C.infra && C.infra.screenExtent) {
      const e = C.infra.screenExtent();
      if (e.minX < minX) minX = e.minX;
      if (e.minY < minY) minY = e.minY;
      if (e.maxX > maxX) maxX = e.maxX;
      if (e.maxY > maxY) maxY = e.maxY;
    }
    const margin = C.TILE_W;
    minX -= margin; minY -= margin; maxX += margin; maxY += margin;
    let res = GROUND_RES;
    while ((maxX - minX) * res > GROUND_MAX_PX || (maxY - minY) * res > GROUND_MAX_PX) res /= 2;

    groundCanvas = document.createElement('canvas');
    groundCanvas.width = Math.ceil((maxX - minX) * res);
    groundCanvas.height = Math.ceil((maxY - minY) * res);
    groundMeta = { minX, minY, res };
    const g = groundCanvas.getContext('2d');
    g.setTransform(res, 0, 0, res, -minX * res, -minY * res);

    // countryside backdrop the whole metro (incl. its outskirts) sits on
    g.fillStyle = '#83bd69';
    g.fillRect(minX, minY, maxX - minX, maxY - minY);

    // ---- Block-grid occupancy so streets connect into one network -----------
    // A block's roads are its 1-tile border; where two blocks touch, their
    // borders merge into a single continuous 2-tile street. We record which
    // grid cells are built so lane markings run down the TRUE centre of a
    // shared street (one line, not one per block) and crosswalks land only on
    // genuine junctions — the difference between a connected grid and a field
    // of boxed-off road loops.
    const cells = new Map();
    for (const slot of blocks) {
      const s = C.spiralSlot(slot);
      cells.set(s.bx + ',' + s.by, { bx: s.bx, by: s.by, o: C.blockOrigin(slot) });
    }
    const has = (bx, by) => cells.has(bx + ',' + by);

    // ---- Pavement + lawns (blocks are tile-disjoint, so no cross-overwrite) --
    for (const slot of blocks) {
      const o = C.blockOrigin(slot);
      // neighborhood tint: lush green uptown, drier/greyer in poorer areas
      const prof = C.NEIGHBORHOODS[C.neighborhoodFor(slot).klass] || C.NEIGHBORHOODS.middle;
      const grass = C.tintHex(C.PAL.grass, prof.grass);
      const grassEdge = C.tintHex(C.PAL.grassEdge, prof.grass);
      const grassHi = C.tintHex(C.PAL.grassHi, prof.grass);
      const sidewalk = C.tintHex(C.PAL.sidewalk, prof.sidewalk);
      const sidewalkHi = C.tintHex(C.PAL.curb, prof.sidewalk);       // lighter paving
      const curb = C.tintHex(C.PAL.sidewalkEdge, prof.sidewalk);     // dark kerb line
      // Asphalt fill with NO outline: an outline would stroke a dark seam down
      // the centre of every shared street and box each block in. Same-colour
      // fills of adjacent blocks merge seamlessly into one road surface.
      C.drawDiamond(g, o.tx, o.ty, B, B, C.PAL.road);
      // Kerb-side sidewalk: a concrete slab hugging the building line (local
      // 0.6..1.0), so it sits BETWEEN the car lane in the middle of the street
      // and the buildings — and, unlike the old interior ring, is never hidden
      // under a parcel's footprint (parcels start at local 1.0). A dark kerb on
      // the asphalt edge + a lighter scored band sell it as poured concrete.
      C.drawDiamond(g, o.tx + 0.6, o.ty + 0.6, B - 1.2, B - 1.2, sidewalk, curb);
      C.drawDiamond(g, o.tx + 0.78, o.ty + 0.78, B - 1.56, B - 1.56, sidewalkHi);
      // expansion-joint ticks across the footway so it doesn't read as a flat slab
      g.strokeStyle = 'rgba(120,128,138,0.4)'; g.lineWidth = 0.5; g.setLineDash([]);
      for (let t = 1; t < B; t += 1.5) {
        const a = C.worldToScreen(o.tx + t, o.ty + 0.6, 0), b1 = C.worldToScreen(o.tx + t, o.ty + 1.0, 0);
        const a2 = C.worldToScreen(o.tx + t, o.ty + B - 1.0, 0), b2 = C.worldToScreen(o.tx + t, o.ty + B - 0.6, 0);
        const c = C.worldToScreen(o.tx + 0.6, o.ty + t, 0), d1 = C.worldToScreen(o.tx + 1.0, o.ty + t, 0);
        const c2 = C.worldToScreen(o.tx + B - 1.0, o.ty + t, 0), d2 = C.worldToScreen(o.tx + B - 0.6, o.ty + t, 0);
        g.beginPath();
        g.moveTo(a.x, a.y); g.lineTo(b1.x, b1.y); g.moveTo(a2.x, a2.y); g.lineTo(b2.x, b2.y);
        g.moveTo(c.x, c.y); g.lineTo(d1.x, d1.y); g.moveTo(c2.x, c2.y); g.lineTo(d2.x, d2.y);
        g.stroke();
      }
      // grass interior (the building zone): laid right up to the sidewalk kerb at
      // local 1.0 — darker base + lighter inset = a soft, un-flat lawn
      C.drawDiamond(g, o.tx + 1.0, o.ty + 1.0, B - 2.0, B - 2.0, grass, grassEdge);
      C.drawDiamond(g, o.tx + 1.3, o.ty + 1.3, B - 2.6, B - 2.6, grassHi);
      // internal alley seams — thin paved paths on the parcel grid lines that
      // divide the 6x6 interior into its 3x3 lots (cosmetic; citizens still
      // walk only the perimeter ring). Hidden under any building/tree on top.
      for (const gx of [3, 5]) C.drawDiamond(g, o.tx + gx - 0.16, o.ty + 1, 0.32, B - 2, sidewalk);
      for (const gy of [3, 5]) C.drawDiamond(g, o.tx + 1, o.ty + gy - 0.16, B - 2, 0.32, sidewalk);
    }

    // ---- Street markings: one centre-line per street + junction crosswalks ---
    // Drawn after ALL pavement so a marking is never clipped by a neighbour's
    // fill. A centre-line is drawn ONCE, on the shared boundary between two
    // adjacent blocks (the real middle of the 2-tile street), inset from each
    // end so junctions read as clean crossings rather than overlapping loops.
    const seg = (ax, ay, bx2, by2, color, w, pattern) => {
      const p0 = C.worldToScreen(ax, ay, 0), p1 = C.worldToScreen(bx2, by2, 0);
      g.strokeStyle = color; g.lineWidth = w; g.lineCap = 'butt';
      g.setLineDash(pattern || []);
      g.beginPath(); g.moveTo(p0.x, p0.y); g.lineTo(p1.x, p1.y); g.stroke();
      g.setLineDash([]);
    };
    // Zebra crosswalk: rungs laid across a street arm. (cx,cy) = arm centre on a
    // block corner; (dx,dy) = unit along the street; span = half street width.
    const crosswalk = (cx, cy, dx, dy, span) => {
      const px = -dy, py = dx;                       // across-street direction
      g.strokeStyle = 'rgba(238,240,242,0.7)'; g.lineWidth = 1.0; g.lineCap = 'butt';
      g.setLineDash([]);
      for (let i = -2; i <= 2; i++) {
        const t = i * 0.2;
        const a = C.worldToScreen(cx + dx * t - px * span, cy + dy * t - py * span, 0);
        const b = C.worldToScreen(cx + dx * t + px * span, cy + dy * t + py * span, 0);
        g.beginPath(); g.moveTo(a.x, a.y); g.lineTo(b.x, b.y); g.stroke();
      }
    };
    // Every road edge gets exactly ONE centre-line. A shared edge (two blocks
    // touching) draws a single line on the boundary — the true middle of the
    // 2-tile street — and is drawn only by the left/top block so it is never
    // doubled. A frontage edge (no neighbour: the cluster's outer ring) draws a
    // line down the middle of its own lane, so no street is left unmarked.
    const LINE = 'rgba(232,226,196,0.85)';           // soft warm centre-line
    const D = [4, 5];
    for (const { bx, by, o } of cells.values()) {
      const x0 = o.tx, y0 = o.ty, x1 = o.tx + B, y1 = o.ty + B;
      // --- vertical streets ---
      if (has(bx + 1, by)) {                          // shared: line on the boundary
        seg(x1, y0 + 1.2, x1, y1 - 1.2, LINE, 0.7, D);
        if (has(bx, by - 1) || has(bx + 1, by - 1)) crosswalk(x1, y0 + 0.5, 0, 1, 0.9);
        if (has(bx, by + 1) || has(bx + 1, by + 1)) crosswalk(x1, y1 - 0.5, 0, 1, 0.9);
      } else {                                        // frontage: line down own lane
        seg(x1 - 0.5, y0 + 1.2, x1 - 0.5, y1 - 1.2, LINE, 0.7, D);
      }
      if (!has(bx - 1, by)) seg(x0 + 0.5, y0 + 1.2, x0 + 0.5, y1 - 1.2, LINE, 0.7, D);
      // --- horizontal streets ---
      if (has(bx, by + 1)) {                          // shared: line on the boundary
        seg(x0 + 1.2, y1, x1 - 1.2, y1, LINE, 0.7, D);
        if (has(bx - 1, by) || has(bx - 1, by + 1)) crosswalk(x0 + 0.5, y1, 1, 0, 0.9);
        if (has(bx + 1, by) || has(bx + 1, by + 1)) crosswalk(x1 - 0.5, y1, 1, 0, 0.9);
      } else {                                        // frontage: line down own lane
        seg(x0 + 1.2, y1 - 0.5, x1 - 1.2, y1 - 0.5, LINE, 0.7, D);
      }
      if (!has(bx, by - 1)) seg(x0 + 1.2, y0 + 0.5, x1 - 1.2, y0 + 0.5, LINE, 0.7, D);
    }
    camera.setBounds(C.worldBounds());
  }

  // ---- Trees on parcels that have no lot yet --------------------------------------
  function drawTree(ctx2, tx, ty, seed) {
    const p = C.worldToScreen(tx, ty, 0);
    const s = 0.85 + (seed % 5) * 0.13;
    // ground shadow toward the SW (matches building light direction)
    ctx2.fillStyle = 'rgba(' + C.PAL.shadow + ',0.16)';
    ctx2.beginPath();
    ctx2.ellipse(p.x - 2.5 * s, p.y + 0.5, 6 * s, 2.8 * s, 0, 0, Math.PI * 2);
    ctx2.fill();
    // trunk
    ctx2.strokeStyle = '#6f5235';
    ctx2.lineWidth = 1.8 * s;
    ctx2.lineCap = 'round';
    ctx2.beginPath();
    ctx2.moveTo(p.x, p.y);
    ctx2.lineTo(p.x, p.y - 7 * s);
    ctx2.stroke();
    ctx2.lineCap = 'butt';
    // layered canopy: shaded base, body, sunlit cap
    const dark = (seed & 1) ? '#4f9a48' : '#5aa551';
    const mid = (seed & 1) ? '#62b257' : '#6dbd61';
    ctx2.fillStyle = dark;
    ctx2.beginPath(); ctx2.arc(p.x + 1.6 * s, p.y - 9 * s, 4.4 * s, 0, Math.PI * 2); ctx2.fill();
    ctx2.beginPath(); ctx2.arc(p.x - 1.8 * s, p.y - 9.5 * s, 4.2 * s, 0, Math.PI * 2); ctx2.fill();
    ctx2.fillStyle = mid;
    ctx2.beginPath(); ctx2.arc(p.x, p.y - 11 * s, 5.2 * s, 0, Math.PI * 2); ctx2.fill();
    ctx2.fillStyle = 'rgba(214,243,170,0.55)';
    ctx2.beginPath(); ctx2.arc(p.x - 1.7 * s, p.y - 12.4 * s, 2.4 * s, 0, Math.PI * 2); ctx2.fill();
  }

  // A nursery sapling — a half-grown tree shown while a green parcel is still
  // being landscaped by the city's workers (scale grows toward a full tree).
  function drawSapling(ctx2, tx, ty, scale) {
    const p = C.worldToScreen(tx, ty, 0);
    const s = 0.5 + 0.5 * (scale || 0.5);
    ctx2.fillStyle = 'rgba(' + C.PAL.shadow + ',0.14)';
    ctx2.beginPath(); ctx2.ellipse(p.x - 1.2 * s, p.y + 0.4, 3 * s, 1.4 * s, 0, 0, Math.PI * 2); ctx2.fill();
    ctx2.strokeStyle = '#7a5d3c'; ctx2.lineWidth = 1.2 * s; ctx2.lineCap = 'round';
    ctx2.beginPath(); ctx2.moveTo(p.x, p.y); ctx2.lineTo(p.x, p.y - 4 * s); ctx2.stroke();
    ctx2.lineCap = 'butt';
    ctx2.fillStyle = '#6dbd61';
    ctx2.beginPath(); ctx2.arc(p.x, p.y - 5 * s, 2.4 * s, 0, Math.PI * 2); ctx2.fill();
  }
  // A surveyor's stake + ribbon — marks a parcel that's been zoned but not yet
  // planted (the "site prepared, work pending" cue).
  function drawStake(ctx2, tx, ty) {
    const p = C.worldToScreen(tx, ty, 0);
    ctx2.strokeStyle = '#b9a07a'; ctx2.lineWidth = 1;
    ctx2.beginPath(); ctx2.moveTo(p.x, p.y); ctx2.lineTo(p.x, p.y - 7); ctx2.stroke();
    ctx2.fillStyle = '#e25b5b';
    ctx2.beginPath(); ctx2.moveTo(p.x, p.y - 7); ctx2.lineTo(p.x + 4, p.y - 5.6); ctx2.lineTo(p.x, p.y - 4.4); ctx2.closePath(); ctx2.fill();
  }

  // ---- Ambient parcel zoning -------------------------------------------------
  // The server keeps building lots growable (a session's work must show), so
  // parks & landfills live HERE as cosmetic zoning on parcels a district has
  // not built on yet — exactly how a Cities-Skylines park is a zoned tile
  // rather than a "grown" structure. Each empty parcel rolls a zone by seed.
  function drawPond(ctx2, tx, ty) {
    const p = C.worldToScreen(tx, ty, 0);
    const rx = 13, ry = rx * 0.5;
    ctx2.fillStyle = '#6fb6d6';
    ctx2.beginPath(); ctx2.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2); ctx2.fill();
    ctx2.fillStyle = 'rgba(255,255,255,0.25)';
    ctx2.beginPath(); ctx2.ellipse(p.x - 3, p.y - 1.5, rx * 0.4, ry * 0.4, 0, 0, Math.PI * 2); ctx2.fill();
    ctx2.strokeStyle = 'rgba(40,90,120,0.4)'; ctx2.lineWidth = 1;
    ctx2.beginPath(); ctx2.ellipse(p.x, p.y, rx, ry, 0, 0, Math.PI * 2); ctx2.stroke();
  }
  function drawFountain(ctx2, tx, ty) {
    const p = C.worldToScreen(tx, ty, 0);
    ctx2.fillStyle = '#c3cad1';
    ctx2.beginPath(); ctx2.ellipse(p.x, p.y, 8, 4, 0, 0, Math.PI * 2); ctx2.fill();
    ctx2.fillStyle = '#7fc1dd';
    ctx2.beginPath(); ctx2.ellipse(p.x, p.y - 1, 5, 2.5, 0, 0, Math.PI * 2); ctx2.fill();
    ctx2.strokeStyle = 'rgba(180,220,235,0.8)'; ctx2.lineWidth = 1.4;
    ctx2.beginPath(); ctx2.moveTo(p.x, p.y - 2); ctx2.lineTo(p.x, p.y - 9); ctx2.stroke();
  }
  function drawMound(ctx2, tx, ty, seed, s) {
    const p = C.worldToScreen(tx, ty, 0);
    const rx = 9 * s, ry = rx * 0.55;
    ctx2.fillStyle = 'rgba(' + C.PAL.shadow + ',0.14)';
    ctx2.beginPath(); ctx2.ellipse(p.x - 2, p.y + 1, rx, ry * 0.7, 0, 0, Math.PI * 2); ctx2.fill();
    ctx2.fillStyle = (seed & 1) ? '#8a7d4a' : '#9a8b52';
    ctx2.beginPath(); ctx2.ellipse(p.x, p.y - ry * 0.5, rx, ry, 0, 0, Math.PI * 2); ctx2.fill();
    ctx2.fillStyle = 'rgba(255,255,255,0.10)';
    ctx2.beginPath(); ctx2.ellipse(p.x - rx * 0.3, p.y - ry * 0.8, rx * 0.4, ry * 0.4, 0, 0, Math.PI * 2); ctx2.fill();
    const bits = ['#b94f3e', '#3f6f9e', '#c8a84b'];
    for (let i = 0; i < 3; i++) {
      ctx2.fillStyle = bits[(seed >> (i * 2)) % bits.length];
      ctx2.fillRect(p.x + ((seed >> i) % 7) - 3, p.y - 2 - i, 2, 2);
    }
  }

  // Empty parcels are landscaped by the city's workers too — nothing greens
  // instantly. `order` is the parcel's place in the core-out reveal queue and
  // `cw` the city's accumulated work; a parcel is bare dirt until work reaches
  // its threshold, then plants up (saplings) and finally reads as a full
  // park/plaza/landfill. Older/central parcels finish first.
  const LAND_STEP = 1.4;   // work units between successive parcels greening
  const LAND_SPAN = 6;     // work units to fully landscape one parcel

  function addParcelZone(list, d, block, p, order, cw) {
    const po = C.parcelOrigin(block, p);
    const seed = C.hash32(d.key + ':zone:' + block + ':' + p);
    const prof = C.NEIGHBORHOODS[C.neighborhoodFor(block).klass] || C.NEIGHBORHOODS.middle;
    const patchDepth = C.depthKey(po.tx + 0.05, po.ty + 0.05); // flat ground sits behind features
    const tree = (sx, sy, sd) => list.push({
      depth: C.depthKey(po.tx + sx, po.ty + sy),
      draw: (ctx2) => drawTree(ctx2, po.tx + sx, po.ty + sy, sd),
    });
    const push = (sx, sy, draw) => list.push({ depth: C.depthKey(po.tx + sx, po.ty + sy), draw });

    // Landscaping progress for this parcel (1 = finished, established city).
    const lp = order == null ? 1 : C.clamp((cw - order * LAND_STEP) / LAND_SPAN, 0, 1);
    if (lp < 1) {
      // site being prepared: graded dirt, a survey stake, and saplings that
      // multiply as the work front reaches this parcel.
      list.push({ depth: patchDepth, draw: (c) => C.drawDiamond(c, po.tx + 0.1, po.ty + 0.1, 1.8, 1.8, C.PAL.dirt, 'rgba(0,0,0,0.08)') });
      push(0.32, 0.34, (c) => drawStake(c, po.tx + 0.32, po.ty + 0.34));
      const spots = [[0.75, 0.85], [1.4, 1.15], [1.0, 1.5]];
      const nS = Math.floor(lp * 3 + 0.0001);
      for (let i = 0; i < nS; i++) {
        const sp = spots[i];
        push(sp[0], sp[1], (c) => drawSapling(c, po.tx + sp[0], po.ty + sp[1], lp));
      }
      if (lp > 0.1 && lp < 0.95) push(1.5, 0.65, (c) => drawMound(c, po.tx + 1.5, po.ty + 0.65, seed, 0.5));
      return;
    }
    // Weighted zoning biased by neighborhood: lush parks + fountains/plazas
    // uptown; bare, worn, littered lots in poorer areas.
    const W = [
      ['park', 3 * prof.foliage + 0.2],
      ['grove', 2 * prof.foliage],
      ['plaza', 3 * prof.landmarkProb],
      ['lawn', 1.4],
      ['land', 3 * prof.wornProb + 0.05],
    ];
    let tot = 0; for (const e of W) tot += e[1];
    let roll = ((seed % 1000) / 1000) * tot;
    let zone = 'lawn';
    for (const e of W) { if (roll < e[1]) { zone = e[0]; break; } roll -= e[1]; }
    const dense = prof.foliage >= 0.8;
    if (zone === 'park') {                          // park: a few trees, maybe a pond
      tree(0.6, 0.7, seed); tree(1.4, 1.3, seed >>> 5);
      if (dense) tree(1.0, 0.5, seed >>> 9);
      if ((seed >>> 3) & 1) push(1.4, 0.7, (c) => drawPond(c, po.tx + 1.4, po.ty + 0.7));
    } else if (zone === 'grove') {                  // grove: dense trees
      tree(0.55, 0.6, seed); tree(1.3, 0.7, seed >>> 4);
      tree(0.8, 1.4, seed >>> 8); tree(1.5, 1.45, seed >>> 12);
    } else if (zone === 'plaza') {                  // plaza: paved square + fountain/trees
      list.push({ depth: patchDepth, draw: (c) => C.drawDiamond(c, po.tx + 0.15, po.ty + 0.15, 1.7, 1.7, C.PAL.plaza, 'rgba(0,0,0,0.06)') });
      if ((seed >> 2) & 1) push(1, 1, (c) => drawFountain(c, po.tx + 1, po.ty + 1));
      else { tree(0.5, 0.5, seed); tree(1.5, 1.5, seed >>> 6); }
    } else if (zone === 'lawn') {                   // open lawn: mostly bare grass
      if (prof.foliage >= 0.6 && ((seed >>> 6) & 1)) tree(1.0, 1.0, seed >>> 7);
    } else {                                        // landfill: dirt + mounds + debris
      list.push({ depth: patchDepth, draw: (c) => C.drawDiamond(c, po.tx + 0.1, po.ty + 0.1, 1.8, 1.8, C.PAL.dirt, 'rgba(0,0,0,0.08)') });
      push(0.75, 0.8, (c) => drawMound(c, po.tx + 0.75, po.ty + 0.8, seed, 1));
      push(1.4, 1.35, (c) => drawMound(c, po.tx + 1.4, po.ty + 1.35, seed >>> 7, 0.8));
    }
  }

  function collectParkDrawables(list) {
    const cw = (C.infra && C.infra.cityWork) ? C.infra.cityWork() : 1e9;
    let order = 0; // core-out reveal queue position across all empty parcels
    for (const d of C.districts.values()) {
      const blocks = d.blocks || [];
      const usage = C.parcelUsage(d);
      for (let bi = 0; bi < blocks.length; bi++) {
        const taken = usage.get(blocks[bi]);
        for (let p = 0; p < C.LOTS_PER_BLOCK; p++) {
          if (!taken || !taken.has(p)) addParcelZone(list, d, blocks[bi], p, order++, cw);
        }
      }
    }
  }

  // ---- Scene draw list --------------------------------------------------------------
  function collectLotDrawables(list, now) {
    for (const d of C.districts.values()) {
      for (const lot of d.lots || []) {
        if (!lot) continue;
        list.push({
          depth: C.lotDepth(lot),
          draw: (ctx2) => {
            C.drawLot(ctx2, lot, d, camera.zoom);
            if (lot.state === 'construction') {
              C.drawSiteProps(ctx2, lot, now); // hoarding, cones, beacon, materials, digger
              C.drawCrane(ctx2, lot, now);
            }
          },
        });
      }
    }
  }

  // ---- Main loop ---------------------------------------------------------------------
  let lastT = 0;
  let running = false;

  function frame(now) {
    if (!running) return;
    const dt = Math.min(0.1, lastT ? (now - lastT) / 1000 : 0.016);
    lastT = now;

    if (C.getGroundVersion() !== lastGroundVersion) rebuildGround();

    resize();
    camera.update(dt);
    C.updateCitizens(dt, now);
    // ambient life: ration A* across pedestrians + traffic, then advance them
    if (C.graph) C.graph.resetBudget(PATH_BUDGET);
    if (C.pop) C.pop.update(dt, now, camera);
    if (C.traffic) C.traffic.update(dt, now, camera);
    // ambient infrastructure (beltway, connector freeways, commuter rail, airport)
    if (C.highway) C.highway.update(dt, now, camera);
    if (C.connectors) C.connectors.update(dt, now, camera);
    if (C.rail) C.rail.update(dt, now, camera);
    if (C.airport) C.airport.update(dt, now, camera);

    const dpr = window.devicePixelRatio || 1;
    const vt = camera.viewTransform();

    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    // countryside fills the ENTIRE viewport (not just the metro's bounds) so the
    // whole screen is open green space for the city to grow into.
    ctx.fillStyle = '#83bd69';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.imageSmoothingEnabled = true;
    ctx.imageSmoothingQuality = 'high';
    // world transform: world px -> canvas px
    ctx.setTransform(dpr * vt.zoom, 0, 0, dpr * vt.zoom, dpr * vt.offX, dpr * vt.offY);

    // ground
    if (groundCanvas && groundMeta) {
      ctx.drawImage(
        groundCanvas,
        groundMeta.minX, groundMeta.minY,
        groundCanvas.width / groundMeta.res, groundCanvas.height / groundMeta.res
      );
    }

    // cast-shadow pass — flat on the ground, under every building so towers
    // shade their neighbours (kept separate from the sprite cache).
    for (const d of C.districts.values()) {
      for (const lot of d.lots || []) {
        if (lot) C.drawLotShadow(ctx, lot);
      }
    }

    // depth-sorted scene
    const list = [];
    if (C.terrain) C.terrain.collectDrawables(list, camera, now); // natural countryside
    collectLotDrawables(list, now);
    collectParkDrawables(list);
    C.collectCitizenDrawables(list, now);
    if (C.pop) C.pop.collectDrawables(list, now, camera);
    if (C.traffic) C.traffic.collectDrawables(list, now, camera);
    if (C.highway) C.highway.collectDrawables(list, now, camera);
    if (C.connectors) C.connectors.collectDrawables(list, now, camera);
    if (C.rail) C.rail.collectDrawables(list, now, camera);
    if (C.airport) C.airport.collectDrawables(list, now, camera);
    list.sort((a, b) => a.depth - b.depth);
    for (const d of list) d.draw(ctx);

    // effects on top
    C.fx.updateAndDraw(ctx, dt, now);

    requestAnimationFrame(frame);
  }

  // ---- City event plumbing (called from client.js) --------------------------------------
  function applyCitySnapshot(city) {
    C.applyCity(city);
    if (C.pop) C.pop.reset();       // residents are derived from the city
    if (C.traffic) C.traffic.reset();
    if (C.highway) C.highway.reset();
    if (C.connectors) C.connectors.reset();
    if (C.rail) C.rail.reset();
    if (C.airport) C.airport.reset();
    camera.setBounds(C.worldBounds());
  }

  function applyCityDelta(msg) {
    const res = C.applyCityDelta(msg);
    if (!res) return;
    const { event, lot } = res;
    if (event === 'complete') {
      C.invalidateLot(lot.id);
      const pl = C.lotPlacement(lot);
      const zTop = ((lot.building && lot.building.floors) || 1) * C.FLOOR_H;
      C.fx.spawnConfetti(pl.tx + pl.w / 2, pl.ty + pl.d / 2, zTop);
    } else if (event === 'incident') {
      const pl = C.lotPlacement(lot);
      const stage = C.stageOf(lot);
      const zTop = (stage.built || 0) * C.FLOOR_H;
      C.fx.startSmoke(lot.id, pl.tx + pl.w / 2, pl.ty + pl.d / 2, zTop, 30_000);
    } else if (event === 'groundbreak') {
      // New lot OR a renovation pass on an existing building — bust any cached
      // sprite (a prior 'done' sprite would otherwise render the old height).
      C.invalidateLot(lot.id);
      camera.setBounds(C.worldBounds());
    }
  }

  function start() {
    if (running) return;
    running = true;
    resize();
    rebuildGround();
    requestAnimationFrame((t) => { lastT = t; frame(t); });
  }

  C.render = {
    start,
    // entity stream
    applySnapshot: (entities) => {
      C.applyCitizenSnapshot(entities);
    },
    spawnSprite: (entity, animate) => C.spawnCitizen(entity, animate),
    updateSprite: (entity) => C.updateCitizen(entity),
    removeSprite: (id) => C.removeCitizen(id),
    setAggregates: (a) => C.setAggregates(a),
    // city stream
    applyCitySnapshot,
    applyCityDelta,
    counts: () => C.citizenCounts(),
    camera,
  };
})();
