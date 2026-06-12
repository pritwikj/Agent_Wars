/* ===========================================================================
   buildings.js — procedural flat-shaded isometric buildings + construction
   stages, with a per-building sprite cache so towers cost one drawImage.

   Every building is derived from lot.building.seed (style, palette tinted by
   district hue, window pattern, roof furniture) so the same save file always
   renders the same skyline.

   Shading model: sun from the upper-NE. Each face gets a vertical gradient
   (lighter near the top, ambient-occluded toward the ground), the top ridge
   catches a bright highlight, and the building casts a soft silhouette shadow
   on the ground (drawn in a separate pass — see drawLotShadow / render.js).

   Construction stages from ratio = progress/required:
     < 0.10  excavation pit
     < 0.25  foundation slab
     < 1.00  floors rising (floorsBuilt = floor(ratio * floors)) + scaffold
     1.00    complete (parapet + roof membrane, windows lit, no scaffold)
   The crane and animated effects are drawn per-frame in effects.js / render.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const w2s = C.worldToScreen;

  // ---- Low-level fill helpers ----------------------------------------------
  function hsl(h, s, l) { return 'hsl(' + h + ',' + s + '%,' + C.clamp(l, 3, 97) + '%)'; }

  function poly(ctx, pts) {
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }

  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Vertical (screen-space) gradient across a face quad, top -> bottom.
  function vGrad(ctx, pts, top, bot) {
    let yMin = Infinity, yMax = -Infinity;
    for (const p of pts) { if (p.y < yMin) yMin = p.y; if (p.y > yMax) yMax = p.y; }
    const g = ctx.createLinearGradient(0, yMin, 0, yMax + 0.001);
    g.addColorStop(0, top);
    g.addColorStop(1, bot);
    return g;
  }

  // ---- Primitive: flat ground diamond --------------------------------------
  function drawDiamond(ctx, tx, ty, w, d, fill, stroke) {
    const pts = [w2s(tx, ty, 0), w2s(tx + w, ty, 0), w2s(tx + w, ty + d, 0), w2s(tx, ty + d, 0)];
    poly(ctx, pts);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }
  function drawDiamondAt(ctx, tx, ty, w, d, z, fill, stroke) {
    const pts = [w2s(tx, ty, z), w2s(tx + w, ty, z), w2s(tx + w, ty + d, z), w2s(tx, ty + d, z)];
    poly(ctx, pts);
    ctx.fillStyle = fill;
    ctx.fill();
    if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 1; ctx.stroke(); }
  }

  // ---- Primitive: iso box (top + two visible faces, gradient-shaded) --------
  // Visible faces: SW (S-W edge) is lit mid; SE (S-E edge) is the shade side.
  function drawBox(ctx, tx, ty, w, d, z0, h, col) {
    const zT = z0 + h;
    const nT = w2s(tx, ty, zT), eT = w2s(tx + w, ty, zT);
    const sT = w2s(tx + w, ty + d, zT), wT = w2s(tx, ty + d, zT);
    const sB = w2s(tx + w, ty + d, z0), wB = w2s(tx, ty + d, z0), eB = w2s(tx + w, ty, z0);

    // SW (left/front) face — W..S edge
    const left = [wT, sT, sB, wB];
    poly(ctx, left);
    ctx.fillStyle = vGrad(ctx, left, hsl(col.h, col.s, col.l - 4), hsl(col.h, col.s + 4, col.l - 15));
    ctx.fill();

    // SE (right/shade) face — S..E edge
    const right = [sT, eT, eB, sB];
    poly(ctx, right);
    ctx.fillStyle = vGrad(ctx, right, hsl(col.h, col.s, col.l - 13), hsl(col.h, col.s + 6, col.l - 24));
    ctx.fill();

    // top face — gentle gradient front-to-back
    const top = [nT, eT, sT, wT];
    poly(ctx, top);
    ctx.fillStyle = vGrad(ctx, top, hsl(col.h, col.s, col.l + 11), hsl(col.h, col.s, col.l + 4));
    ctx.fill();

    // crisp edges: bright sun ridge on top, soft seams on the corners
    ctx.lineJoin = 'round';
    ctx.strokeStyle = 'rgba(255,255,255,0.22)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(wT.x, wT.y); ctx.lineTo(nT.x, nT.y); ctx.lineTo(eT.x, eT.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(18,24,32,0.20)';
    ctx.beginPath();
    ctx.moveTo(wT.x, wT.y); ctx.lineTo(sT.x, sT.y); ctx.lineTo(eT.x, eT.y); // top front ridge
    ctx.moveTo(sT.x, sT.y); ctx.lineTo(sB.x, sB.y);                          // front vertical corner
    ctx.stroke();
  }

  // ---- Style derivation -------------------------------------------------------
  // Window/wall STYLE and base palette now follow the building TYPE (its
  // category) rather than a free seed roll, so an office reads as glass, a
  // house as warm brick, a power hall as bare concrete — then a per-seed
  // lightness wobble keeps neighbours of the same type from looking cloned.
  //   style 'glass'    -> curtain wall   (com: office, skyscraper)
  //   style 'brick'    -> punched windows, warm (res: house/apartment, school)
  //   style 'concrete' -> punched/none, cool   (civic: power_station, transit)
  // Colour is per-BUILDING, not per-district — the city is no longer zoned by
  // project, so each category carries an absolute base hue and a small per-seed
  // hue jitter keeps same-type neighbours distinct without going rainbow.
  const CAT_STYLE = {
    res:     { style: 'brick',    hue: 24,  s: 36, l: 56 },  // warm brick / terracotta
    com:     { style: 'glass',    hue: 205, s: 24, l: 62 },  // cool glass
    retail:  { style: 'stucco',   hue: 40,  s: 24, l: 70 },  // light stucco storefront
    school:  { style: 'brick',    hue: 8,   s: 32, l: 56 },  // brick red
    power:   { style: 'concrete', hue: 212, s: 8,  l: 64 },  // bare concrete
    industrial:{ style: 'concrete', hue: 28, s: 14, l: 52 }, // weathered tan-grey metal/brick
    transit: { style: 'concrete', hue: 200, s: 16, l: 64 },  // steel grey-blue
    police:  { style: 'concrete', hue: 218, s: 18, l: 60 },  // pale civic grey-blue
    hospital:{ style: 'glass',    hue: 192, s: 10, l: 80 },  // clean white / teal glass
    fire:    { style: 'brick',    hue: 4,   s: 40, l: 50 },  // fire-engine red brick
    prison:  { style: 'concrete', hue: 36,  s: 6,  l: 58 },  // drab tan concrete
    farm:    { style: 'brick',    hue: 30,  s: 30, l: 58 },  // homestead clapboard
  };
  function buildingStyle(lot, _district) {
    const b = lot.building || {};
    const seed = b.seed || 1;
    const type = b.type || 'office';
    const cat = C.buildingCategory(type);
    const cs = CAT_STYLE[cat] || CAT_STYLE.com;
    let hue = (cs.hue + ((seed >>> 12) % 25) - 12 + 360) % 360; // ±12 per-seed
    // SUBDIVISION COHESION: every house on a block shares one palette so a
    // suburban/rural block reads as a planned community of like homes rather
    // than a row of mismatched buildings (render-only; does not touch seeds).
    if ((type === 'house' || type === 'townhouse') && typeof lot.block === 'number') {
      const blockHue = (CAT_STYLE.res.hue + (C.hash32('subdiv:' + lot.block) % 34) - 17 + 360) % 360;
      hue = (blockHue + ((seed >>> 12) % 7) - 3 + 360) % 360; // tight per-home wobble
    }
    const col = { h: hue, s: cs.s, l: cs.l + ((seed >>> 4) % 9) - 4 };
    // neighborhood cleanliness: grimier/desaturated in poorer areas, a touch
    // brighter downtown/uptown. Subtle so the category palette still dominates.
    if (typeof lot.block === 'number' && C.neighborhoodFor) {
      const t = C.NEIGHBORHOODS[C.neighborhoodFor(lot.block).klass];
      if (t && t.buildingTint) {
        col.l += t.buildingTint.dl || 0;
        col.s = Math.max(0, col.s + (t.buildingTint.ds || 0));
      }
    }
    return { style: cs.style, col, seed, hue, type, cat };
  }

  // ---- Windows (two genuinely-visible faces) ---------------------------------
  // SW face: plane ty+d, param along +tx (w tiles). SE face: plane tx+w,
  // param along +ty (d tiles). edgePt returns the screen point at edge param
  // p (in tiles) and height z.
  function edgePt(side, tx, ty, w, d, p, z) {
    return side === 'left' ? w2s(tx + p, ty + d, z) : w2s(tx + w, ty + p, z);
  }

  function drawWindows(ctx, tx, ty, w, d, z0, floors, st) {
    for (const side of ['left', 'right']) {
      const tiles = side === 'left' ? w : d;
      if (st.style === 'glass') curtainWall(ctx, side, tx, ty, w, d, z0, floors, tiles, st);
      else punchedWindows(ctx, side, tx, ty, w, d, z0, floors, tiles, st);
    }
  }

  function curtainWall(ctx, side, tx, ty, w, d, z0, floors, tiles, st) {
    const H = floors * C.FLOOR_H;
    const tl = edgePt(side, tx, ty, w, d, 0, z0 + H);
    const tr = edgePt(side, tx, ty, w, d, tiles, z0 + H);
    const br = edgePt(side, tx, ty, w, d, tiles, z0);
    const bl = edgePt(side, tx, ty, w, d, 0, z0);
    const reflect = side === 'left' ? 0.55 : 0.32; // sun side reflects more sky
    poly(ctx, [tl, tr, br, bl]);
    ctx.fillStyle = vGrad(ctx, [tl, tr, br, bl],
      'rgba(213,234,246,' + reflect + ')', 'rgba(70,96,122,0.34)');
    ctx.fill();

    // mullions
    ctx.strokeStyle = 'rgba(236,243,248,0.30)';
    ctx.lineWidth = 0.7;
    const cols = tiles * 2;
    ctx.beginPath();
    for (let i = 0; i <= cols; i++) {
      const p = (i / cols) * tiles;
      const a = edgePt(side, tx, ty, w, d, p, z0 + H), b = edgePt(side, tx, ty, w, d, p, z0);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let f = 0; f <= floors; f++) {
      const z = z0 + f * C.FLOOR_H;
      const a = edgePt(side, tx, ty, w, d, 0, z), b = edgePt(side, tx, ty, w, d, tiles, z);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();

    if (!st.complete) return;
    // a scatter of lit panels gives the glass life when finished
    const lit = st.seed >>> 3;
    for (let f = 0; f < floors; f++) {
      for (let c = 0; c < cols; c++) {
        if (((lit >>> ((f * 5 + c * 3) % 29)) & 7) !== 0) continue;
        fillCell(ctx, side, tx, ty, w, d, z0, f, c / cols * tiles, (c + 1) / cols * tiles, 0.12, 0.92,
          'rgba(255,238,170,0.72)');
      }
    }
  }

  function punchedWindows(ctx, side, tx, ty, w, d, z0, floors, tiles, st) {
    const lit = st.seed >>> 3;
    const perTile = 2;
    const pane = st.style === 'brick' ? 'rgba(38,52,74,0.62)' : 'rgba(46,62,86,0.55)';
    const frame = 'rgba(244,246,248,0.20)';
    for (let f = 0; f < floors; f++) {
      for (let k = 0; k < tiles; k++) {
        for (let c = 0; c < perTile; c++) {
          const p0 = k + (c + 0.22) / perTile;
          const p1 = k + (c + 0.78) / perTile;
          const isLit = st.complete && (((lit >>> ((f * 7 + (k * perTile + c) * 3) % 28)) & 3) === 0);
          fillCell(ctx, side, tx, ty, w, d, z0, f, p0, p1, 0.30, 0.78,
            isLit ? 'rgba(255,232,150,0.85)' : pane, frame);
        }
      }
    }
  }

  // Fill one window cell on a face: param span [p0,p1] (tiles), vertical span
  // [zLoFrac,zHiFrac] within floor f. Optional frame stroke.
  function fillCell(ctx, side, tx, ty, w, d, z0, f, p0, p1, zLoFrac, zHiFrac, fill, frame) {
    const zLo = z0 + (f + zLoFrac) * C.FLOOR_H;
    const zHi = z0 + (f + zHiFrac) * C.FLOOR_H;
    const a = edgePt(side, tx, ty, w, d, p0, zHi);
    const b = edgePt(side, tx, ty, w, d, p1, zHi);
    const c = edgePt(side, tx, ty, w, d, p1, zLo);
    const e = edgePt(side, tx, ty, w, d, p0, zLo);
    poly(ctx, [a, b, c, e]);
    ctx.fillStyle = fill;
    ctx.fill();
    if (frame) { ctx.strokeStyle = frame; ctx.lineWidth = 0.6; ctx.stroke(); }
  }

  // A flat signage/door panel on one wall face, spanning param [p0,p1] (tiles)
  // and ABSOLUTE height [zLo,zHi] (px) — like fillCell but not tied to a floor.
  function facePanel(ctx, side, tx, ty, w, d, p0, p1, zLo, zHi, fill, frame) {
    const a = edgePt(side, tx, ty, w, d, p0, zHi);
    const b = edgePt(side, tx, ty, w, d, p1, zHi);
    const c = edgePt(side, tx, ty, w, d, p1, zLo);
    const e = edgePt(side, tx, ty, w, d, p0, zLo);
    poly(ctx, [a, b, c, e]);
    ctx.fillStyle = fill;
    ctx.fill();
    if (frame) { ctx.strokeStyle = frame; ctx.lineWidth = 0.6; ctx.stroke(); }
  }

  // ---- Parapet + roof membrane (finished buildings) --------------------------
  function drawRoofCap(ctx, tx, ty, w, d, zTop, st) {
    // recessed gravel membrane inside the parapet rim (the box top is the rim).
    // Neutral mid-gray so it reads as a roof, not a void, on light buildings.
    const inset = 0.11;
    drawDiamondAt(ctx, tx + inset, ty + inset, w - 2 * inset, d - 2 * inset, zTop,
      hsl(st.hue, 7, 48), 'rgba(18,22,28,0.22)');
    // bright lip on the NW parapet edge sells the raised rim
    const a = w2s(tx + inset, ty + d - inset, zTop);
    const b = w2s(tx + inset, ty + inset, zTop);
    const e = w2s(tx + w - inset, ty + inset, zTop);
    ctx.strokeStyle = 'rgba(255,255,255,0.20)';
    ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(e.x, e.y); ctx.stroke();
  }

  // ---- Roof furniture -----------------------------------------------------------
  function drawRoof(ctx, tx, ty, w, d, zTop, st, tier) {
    const s = st.seed;
    if (tier >= 3 && (s & 3) === 0) {
      const p = w2s(tx + w * 0.5, ty + d * 0.5, zTop);
      ctx.strokeStyle = '#9aa2ab';
      ctx.lineWidth = 1.5;
      ctx.beginPath(); ctx.moveTo(p.x, p.y); ctx.lineTo(p.x, p.y - 18); ctx.stroke();
      ctx.fillStyle = '#e0524a';
      ctx.beginPath(); ctx.arc(p.x, p.y - 19, 2, 0, Math.PI * 2); ctx.fill();
    } else if ((s & 3) === 1) {
      drawBox(ctx, tx + w * 0.5, ty + d * 0.18, w * 0.3, d * 0.3, zTop, 5, { h: 0, s: 0, l: 74 });
    } else if (tier >= 2 && (s & 3) === 2) {
      drawBox(ctx, tx + w * 0.14, ty + d * 0.52, w * 0.26, d * 0.26, zTop, 9, { h: 26, s: 34, l: 50 });
    } else if (tier >= 3) {
      // rooftop bulkhead / stair head
      drawBox(ctx, tx + w * 0.32, ty + d * 0.32, w * 0.36, d * 0.36, zTop, 6, { h: st.hue, s: 8, l: 58 });
    }
  }

  // ---- Type-specific caps (drawn on a finished building's wall top) ----------

  // House: a hip roof of warm tile + a little chimney, in place of a flat
  // parapet — the silhouette is what reads as "house" at iso scale.
  function drawHouseRoof(ctx, pl, h, st) {
    const { tx, ty, w, d } = pl;
    const rh = C.FLOOR_H * 0.95;
    const apex = w2s(tx + w / 2, ty + d / 2, h + rh);
    const eT = w2s(tx + w, ty, h), sT = w2s(tx + w, ty + d, h), wT = w2s(tx, ty + d, h);
    const rhue = (st.hue + 16) % 360;
    // SW (front-left) slope, then SE (front-right, shade) slope
    poly(ctx, [wT, sT, apex]); ctx.fillStyle = hsl(rhue, 46, 40); ctx.fill();
    poly(ctx, [sT, eT, apex]); ctx.fillStyle = hsl(rhue, 48, 32); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.moveTo(wT.x, wT.y); ctx.lineTo(apex.x, apex.y); ctx.lineTo(eT.x, eT.y); ctx.stroke();
    // chimney poking from the front-left slope
    drawBox(ctx, tx + w * 0.2, ty + d * 0.62, w * 0.16, d * 0.16, h, C.FLOOR_H * 1.1, { h: st.hue, s: 14, l: 44 });
  }

  // Mansion: a grand four-sided hip roof, twin chimneys and a columned front
  // portico — the estate silhouette that reads as wealth next to the row homes.
  function drawMansionRoof(ctx, pl, h, st) {
    const { tx, ty, w, d } = pl;
    const rh = C.FLOOR_H * 1.15;
    const apex = w2s(tx + w / 2, ty + d / 2, h + rh);
    const nT = w2s(tx, ty, h), eT = w2s(tx + w, ty, h);
    const sT = w2s(tx + w, ty + d, h), wT = w2s(tx, ty + d, h);
    const rhue = (st.hue + 14) % 360;
    // back slopes first (occluded), then the two visible front slopes over them
    poly(ctx, [wT, nT, apex]); ctx.fillStyle = hsl(rhue, 45, 37); ctx.fill();
    poly(ctx, [nT, eT, apex]); ctx.fillStyle = hsl(rhue, 44, 39); ctx.fill();
    poly(ctx, [wT, sT, apex]); ctx.fillStyle = hsl(rhue, 46, 43); ctx.fill();  // SW lit
    poly(ctx, [sT, eT, apex]); ctx.fillStyle = hsl(rhue, 48, 33); ctx.fill();  // SE shade
    ctx.strokeStyle = 'rgba(255,255,255,0.16)'; ctx.lineWidth = 0.9;
    ctx.beginPath();
    ctx.moveTo(wT.x, wT.y); ctx.lineTo(apex.x, apex.y); ctx.lineTo(eT.x, eT.y);
    ctx.moveTo(sT.x, sT.y); ctx.lineTo(apex.x, apex.y);
    ctx.stroke();
    // twin chimneys on opposite quarters
    drawBox(ctx, tx + w * 0.18, ty + d * 0.66, w * 0.12, d * 0.12, h, C.FLOOR_H * 1.0, { h: st.hue, s: 14, l: 44 });
    drawBox(ctx, tx + w * 0.70, ty + d * 0.20, w * 0.12, d * 0.12, h, C.FLOOR_H * 0.9, { h: st.hue, s: 14, l: 40 });
    // columned portico over the front entrance (south edge, centre)
    const cx0 = tx + w * 0.30, cx1 = tx + w * 0.70, fy = ty + d + 0.16, ph = C.FLOOR_H * 1.5;
    drawBox(ctx, cx0 - 0.04, ty + d * 0.84, (cx1 - cx0) + 0.08, (fy - (ty + d * 0.84)) + 0.04, ph, 3, { h: 38, s: 10, l: 80 });
    ctx.strokeStyle = 'rgba(245,244,238,0.94)'; ctx.lineWidth = 2.4;
    for (let i = 0; i <= 3; i++) {
      const px = cx0 + (cx1 - cx0) * (i / 3);
      const a = w2s(px, fy, 0), b = w2s(px, fy, ph);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // pediment triangle above the porch roof
    const lA = w2s(cx0 - 0.04, fy, ph + 3), rA = w2s(cx1 + 0.04, fy, ph + 3);
    const pk = w2s((cx0 + cx1) / 2, fy, ph + 3 + C.FLOOR_H * 0.7);
    poly(ctx, [lA, rA, pk]); ctx.fillStyle = hsl(38, 12, 78); ctx.fill();
    ctx.strokeStyle = 'rgba(120,110,90,0.5)'; ctx.lineWidth = 0.8; ctx.stroke();
  }

  // Townhouse: a flat parapet dressed with an overhanging cornice, vertical
  // pilasters that split the front into repeated bays, and a street stoop — the
  // brownstone-row read at iso scale.
  function drawTownhouseTrim(ctx, pl, h, st) {
    const { tx, ty, w, d } = pl;
    // overhanging cornice band just below the roofline (sticks out on all sides)
    drawBox(ctx, tx - 0.05, ty - 0.05, w + 0.10, d + 0.10, h - C.FLOOR_H * 0.16,
      C.FLOOR_H * 0.16, { h: st.hue, s: 10, l: C.clamp(st.col.l + 14, 0, 82) });
    // pilasters dividing the front (SW) face into bays
    ctx.strokeStyle = 'rgba(30,36,46,0.16)'; ctx.lineWidth = 1.1;
    for (let k = 0; k <= w; k++) {
      const a = w2s(tx + k, ty + d, 0), b = w2s(tx + k, ty + d, h - C.FLOOR_H * 0.16);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // front stoop: two stacked steps at the entrance (south edge, centre)
    const sx = tx + w * 0.5;
    drawBox(ctx, sx - 0.18, ty + d, 0.36, 0.22, 0, C.FLOOR_H * 0.5, { h: st.hue, s: 8, l: 70 });
    drawBox(ctx, sx - 0.12, ty + d + 0.07, 0.24, 0.15, 0, C.FLOOR_H * 0.28, { h: st.hue, s: 8, l: 76 });
  }

  // Condo: per-floor balcony slabs + railings on the two visible faces and a
  // setback rooftop penthouse — the mid-rise residential read between flats and
  // office towers. Balconies draw over the body windows; crown sits on the cap.
  function drawCondoBalconies(ctx, pl, floors, st) {
    const { tx, ty, w, d } = pl;
    for (const side of ['left', 'right']) {
      const tiles = side === 'left' ? w : d;
      const slab = side === 'left' ? 'rgba(238,240,242,0.62)' : 'rgba(208,212,216,0.5)';
      for (let f = 1; f < floors; f++) {
        const z = f * C.FLOOR_H;
        const a = edgePt(side, tx, ty, w, d, 0, z), b = edgePt(side, tx, ty, w, d, tiles, z);
        ctx.strokeStyle = slab; ctx.lineWidth = 2.2;
        ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
        const ra = edgePt(side, tx, ty, w, d, 0, z + C.FLOOR_H * 0.34);
        const rb = edgePt(side, tx, ty, w, d, tiles, z + C.FLOOR_H * 0.34);
        ctx.strokeStyle = 'rgba(118,128,138,0.42)'; ctx.lineWidth = 0.8;
        ctx.beginPath(); ctx.moveTo(ra.x, ra.y); ctx.lineTo(rb.x, rb.y); ctx.stroke();
      }
    }
  }
  function drawCondoCrown(ctx, pl, h, st) {
    const { tx, ty, w, d } = pl;
    const ins = 0.28;
    drawBox(ctx, tx + ins, ty + ins, w - 2 * ins, d - 2 * ins, h, C.FLOOR_H * 1.1,
      { h: st.col.h, s: st.col.s, l: C.clamp(st.col.l + 4, 0, 90) });
    // small rooftop mechanical box on the penthouse
    drawBox(ctx, tx + w * 0.4, ty + d * 0.4, w * 0.2, d * 0.2, h + C.FLOOR_H * 1.1,
      C.FLOOR_H * 0.5, { h: st.hue, s: 6, l: 56 });
  }

  // Skyscraper: a glassy setback crown + an antenna mast with a beacon.
  function drawSpire(ctx, pl, h, st) {
    const { tx, ty, w, d } = pl;
    const ins = 0.3;
    drawBox(ctx, tx + ins, ty + ins, w - 2 * ins, d - 2 * ins, h, C.FLOOR_H * 2, { h: st.col.h, s: st.col.s, l: st.col.l - 5 });
    const base = w2s(tx + w / 2, ty + d / 2, h + C.FLOOR_H * 2);
    ctx.strokeStyle = '#aeb6bf'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(base.x, base.y - 28); ctx.stroke();
    ctx.fillStyle = '#e0524a';
    ctx.beginPath(); ctx.arc(base.x, base.y - 29, 2.2, 0, Math.PI * 2); ctx.fill();
  }

  // School: a flagpole + pennant in the district hue on the front-left corner.
  function drawSchoolTrim(ctx, pl, h, st) {
    const base = w2s(pl.tx + 0.14, pl.ty + pl.d - 0.14, h);
    ctx.strokeStyle = '#cfd5db'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(base.x, base.y - 24); ctx.stroke();
    ctx.fillStyle = hsl(st.hue, 58, 52);
    ctx.beginPath();
    ctx.moveTo(base.x, base.y - 24); ctx.lineTo(base.x + 10, base.y - 21); ctx.lineTo(base.x, base.y - 18);
    ctx.closePath(); ctx.fill();
  }

  // ---- Civic painters (full lot — base hall + distinctive silhouette) --------

  // A concrete cooling tower (frustum) standing on the ground, venting steam.
  function drawCoolingTower(ctx, cx, cy, hgt) {
    const base = w2s(cx, cy, 0), top = w2s(cx, cy, hgt);
    const rB = 12, rT = 9, ry = 0.42;
    const body = [
      { x: base.x - rB, y: base.y }, { x: top.x - rT, y: top.y },
      { x: top.x + rT, y: top.y }, { x: base.x + rB, y: base.y },
    ];
    poly(ctx, body);
    ctx.fillStyle = vGrad(ctx, body, 'hsl(210,8%,79%)', 'hsl(210,11%,53%)');
    ctx.fill();
    // shade the SE half
    poly(ctx, [{ x: top.x, y: top.y }, { x: top.x + rT, y: top.y }, { x: base.x + rB, y: base.y }, { x: base.x, y: base.y }]);
    ctx.fillStyle = 'rgba(20,26,34,0.10)'; ctx.fill();
    // dark throat + bright back lip
    ctx.fillStyle = 'rgba(38,44,52,0.92)';
    ctx.beginPath(); ctx.ellipse(top.x, top.y, rT, rT * ry, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.22)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(top.x, top.y, rT, rT * ry, 0, Math.PI, Math.PI * 2); ctx.stroke();
    // steam
    ctx.fillStyle = 'rgba(238,242,246,0.5)';
    for (let i = 0; i < 3; i++) {
      ctx.beginPath(); ctx.arc(top.x + (i - 1) * 4, top.y - 7 - i * 5, 5 - i * 0.8, 0, Math.PI * 2); ctx.fill();
    }
  }

  function drawSmokestack(ctx, cx, cy, hgt) {
    const base = w2s(cx, cy, 0), top = w2s(cx, cy, hgt);
    const r = 4.5;
    const body = [
      { x: base.x - r, y: base.y }, { x: top.x - r * 0.8, y: top.y },
      { x: top.x + r * 0.8, y: top.y }, { x: base.x + r, y: base.y },
    ];
    poly(ctx, body);
    ctx.fillStyle = vGrad(ctx, body, 'hsl(210,6%,70%)', 'hsl(210,9%,46%)'); ctx.fill();
    ctx.fillStyle = '#c5483e';
    ctx.fillRect(top.x - r * 0.8, top.y + 5, r * 1.6, 3);
    ctx.fillStyle = 'rgba(38,44,52,0.9)';
    ctx.beginPath(); ctx.ellipse(top.x, top.y, r * 0.8, r * 0.34, 0, 0, Math.PI * 2); ctx.fill();
  }

  // Power station: a low concrete hall with a roller door, a back smokestack
  // and two cooling towers standing in front (front so they occlude correctly).
  function paintPowerStation(ctx, pl, st, floors) {
    const { tx, ty, w, d } = pl;
    const h = floors * C.FLOOR_H;
    drawSmokestack(ctx, tx + w * 0.32, ty + d * 0.28, C.FLOOR_H * 4.6); // behind the hall
    drawBox(ctx, tx, ty, w, d, 0, h, st.col);
    drawRoofCap(ctx, tx, ty, w, d, h, st);
    // roller door on the SW (front) face
    fillCell(ctx, 'left', tx, ty, w, d, 0, 0, w * 0.28, w * 0.72, 0.08, 0.86,
      'rgba(58,64,72,0.7)', 'rgba(228,231,234,0.25)');
    drawCoolingTower(ctx, tx + w * 0.62, ty + d * 0.7, C.FLOOR_H * 5.0);
    drawCoolingTower(ctx, tx + w * 0.3, ty + d * 0.82, C.FLOOR_H * 5.0);
  }

  // Factory: a long low production hall with a sawtooth north-light roof (a row
  // of glazed monitors marching across the top), two back smokestacks and big
  // roller doors on the front face — the silhouette that reads as "industry"
  // at iso scale, without the office-window grid.
  function paintFactory(ctx, pl, st, floors) {
    const { tx, ty, w, d } = pl;
    const h = floors * C.FLOOR_H;
    // two smokestacks at the back (drawn first so the hall occludes their base)
    drawSmokestack(ctx, tx + w * 0.22, ty + d * 0.2, C.FLOOR_H * 4.2);
    drawSmokestack(ctx, tx + w * 0.36, ty + d * 0.13, C.FLOOR_H * 3.4);
    // main hall + flat roof membrane
    drawBox(ctx, tx, ty, w, d, 0, h, st.col);
    drawRoofCap(ctx, tx, ty, w, d, h, st);
    // two roller/loading doors on the SW (front) face
    fillCell(ctx, 'left', tx, ty, w, d, 0, 0, w * 0.18, w * 0.46, 0.06, 0.7,
      'rgba(54,60,68,0.72)', 'rgba(228,231,234,0.22)');
    fillCell(ctx, 'left', tx, ty, w, d, 0, 0, w * 0.54, w * 0.82, 0.06, 0.7,
      'rgba(54,60,68,0.72)', 'rgba(228,231,234,0.22)');
    // sawtooth north-light monitors: a row of low ridges with a glazed face
    const n = 4;
    const mw = w * 0.1;
    for (let i = 0; i < n; i++) {
      const cx = tx + w * (0.14 + (i / n) * 0.72);
      drawBox(ctx, cx, ty + d * 0.14, mw, d * 0.72, h, C.FLOOR_H * 0.6,
        { h: st.col.h, s: 8, l: Math.max(8, st.col.l - 7) });
      // teal glazing band on the monitor's lit (NE) face
      fillCell(ctx, 'right', cx, ty + d * 0.14, mw, d * 0.72, h, 0,
        0, d * 0.72, 0.12, 0.55, 'rgba(150,196,202,0.5)', 'rgba(40,58,62,0.3)');
    }
  }

  // Transit hub: a low station box under a wide flat canopy, plus a painted
  // platform edge stripe — reads as a depot/station, not a residence.
  function paintTransit(ctx, pl, st, floors) {
    const { tx, ty, w, d } = pl;
    const h = floors * C.FLOOR_H;
    drawBox(ctx, tx, ty, w, d, 0, h, st.col);
    drawWindows(ctx, tx, ty, w, d, 0, floors, st);
    // overhanging canopy slab on a thin lip
    drawBox(ctx, tx - 0.12, ty - 0.12, w + 0.24, d + 0.24, h, 3, { h: st.hue, s: 14, l: 70 });
    drawRoofCap(ctx, tx - 0.12, ty - 0.12, w + 0.24, d + 0.24, h + 3, st);
    // yellow platform safety stripe along the SE edge
    const a = w2s(tx + w, ty, 0), b = w2s(tx + w, ty + d, 0);
    ctx.strokeStyle = 'rgba(230,193,77,0.85)'; ctx.lineWidth = 2; ctx.setLineDash([4, 3]);
    ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke(); ctx.setLineDash([]);
  }

  // Police station: a clean civic hall with a navy signage band over the door
  // and a blue beacon on a short rooftop mast.
  function paintPolice(ctx, pl, st, floors) {
    const { tx, ty, w, d } = pl;
    const h = floors * C.FLOOR_H;
    drawBox(ctx, tx, ty, w, d, 0, h, st.col);
    drawWindows(ctx, tx, ty, w, d, 0, floors, st);
    drawRoofCap(ctx, tx, ty, w, d, h, st);
    // navy signage band high on the sunny (SW) face
    facePanel(ctx, 'left', tx, ty, w, d, w * 0.1, w * 0.9, h * 0.82, h * 0.93, '#1f3566');
    // glass entrance at street level
    facePanel(ctx, 'left', tx, ty, w, d, w * 0.36, w * 0.64, 0, h * 0.22,
      'rgba(150,190,220,0.55)', 'rgba(230,235,240,0.3)');
    // rooftop police beacon
    const b = w2s(tx + w * 0.5, ty + d * 0.5, h);
    ctx.strokeStyle = '#9aa2ab'; ctx.lineWidth = 1.4;
    ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(b.x, b.y - 13); ctx.stroke();
    ctx.fillStyle = 'rgba(120,170,255,0.45)';
    ctx.beginPath(); ctx.arc(b.x, b.y - 14, 4.4, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#2f6fe0';
    ctx.beginPath(); ctx.arc(b.x, b.y - 14, 2.3, 0, Math.PI * 2); ctx.fill();
  }

  // Hospital: a clean white block with a big red cross on the wall and a marked
  // rooftop helipad.
  function paintHospital(ctx, pl, st, floors) {
    const { tx, ty, w, d } = pl;
    const h = floors * C.FLOOR_H;
    drawBox(ctx, tx, ty, w, d, 0, h, st.col);
    drawWindows(ctx, tx, ty, w, d, 0, floors, st);
    drawRoofCap(ctx, tx, ty, w, d, h, st);
    // red cross on a white plate, high on the SW face
    const cx = w / 2;
    facePanel(ctx, 'left', tx, ty, w, d, cx - 0.5, cx + 0.5, h * 0.46, h * 0.86, 'rgba(252,252,252,0.94)');
    facePanel(ctx, 'left', tx, ty, w, d, cx - 0.15, cx + 0.15, h * 0.52, h * 0.80, '#d8463a'); // vertical bar
    facePanel(ctx, 'left', tx, ty, w, d, cx - 0.33, cx + 0.33, h * 0.61, h * 0.71, '#d8463a'); // horizontal bar
    // rooftop helipad
    const c = w2s(tx + w / 2, ty + d / 2, h);
    ctx.fillStyle = 'rgba(44,48,54,0.82)';
    ctx.beginPath(); ctx.ellipse(c.x, c.y, 11, 5.5, 0, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(240,228,120,0.9)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.ellipse(c.x, c.y, 8.4, 4.2, 0, 0, Math.PI * 2); ctx.stroke();
    ctx.strokeStyle = 'rgba(245,245,245,0.95)'; ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(c.x - 3, c.y - 2.3); ctx.lineTo(c.x - 3, c.y + 2.3);
    ctx.moveTo(c.x + 3, c.y - 2.3); ctx.lineTo(c.x + 3, c.y + 2.3);
    ctx.moveTo(c.x - 3, c.y); ctx.lineTo(c.x + 3, c.y);
    ctx.stroke();
  }

  // Fire station: red-brick hall with a tall hose-drying tower at the back and
  // engine bay doors across the front.
  function paintFireStation(ctx, pl, st, floors) {
    const { tx, ty, w, d } = pl;
    const h = floors * C.FLOOR_H;
    // drill / hose tower at the NE (back) corner so it rises behind the hall
    drawBox(ctx, tx + w * 0.04, ty + d * 0.04, Math.min(0.7, w * 0.34), Math.min(0.7, d * 0.34),
      0, h + C.FLOOR_H * 2.2, { h: st.col.h, s: st.col.s, l: st.col.l - 7 });
    drawBox(ctx, tx, ty, w, d, 0, h, st.col);
    drawWindows(ctx, tx, ty, w, d, 0, floors, st);
    drawRoofCap(ctx, tx, ty, w, d, h, st);
    // engine bay doors along the SW front
    const bays = w >= 2 ? 2 : 1;
    for (let i = 0; i < bays; i++) {
      const p0 = (i + 0.12) / bays * w, p1 = (i + 0.88) / bays * w;
      facePanel(ctx, 'left', tx, ty, w, d, p0, p1, 0, h * 0.46, 'rgba(38,42,50,0.8)', 'rgba(220,224,228,0.22)');
      facePanel(ctx, 'left', tx, ty, w, d, p0, p1, h * 0.46, h * 0.52, '#9c2f24'); // red header
    }
  }

  // Prison: a drab low cellblock set in a paved compound, ringed by corner
  // watchtowers (the silhouette that reads as "prison" at iso scale).
  function drawWatchtower(ctx, cx, cy, hgt) {
    drawBox(ctx, cx - 0.12, cy - 0.12, 0.24, 0.24, 0, hgt, { h: 34, s: 8, l: 46 });          // post
    drawBox(ctx, cx - 0.26, cy - 0.26, 0.52, 0.52, hgt, C.FLOOR_H * 0.9, { h: 34, s: 10, l: 62 }); // cabin
    const top = w2s(cx, cy, hgt + C.FLOOR_H * 0.9);
    ctx.fillStyle = 'rgba(255,236,150,0.92)';
    ctx.beginPath(); ctx.arc(top.x, top.y - 2, 1.7, 0, Math.PI * 2); ctx.fill();
  }
  function paintPrison(ctx, pl, st, floors) {
    const { tx, ty, w, d } = pl;
    const h = floors * C.FLOOR_H;
    const towerH = h + C.FLOOR_H * 1.6;
    // paved compound yard
    drawDiamond(ctx, tx - 0.05, ty - 0.05, w + 0.1, d + 0.1, 'rgba(150,148,138,0.55)', 'rgba(0,0,0,0.12)');
    // back watchtower (drawn first; it sits behind the cellblock)
    drawWatchtower(ctx, tx + 0.12, ty + 0.12, towerH);
    // cellblock, inset from the perimeter
    drawBox(ctx, tx + 0.28, ty + 0.28, w - 0.56, d - 0.56, 0, h, st.col);
    drawWindows(ctx, tx + 0.28, ty + 0.28, w - 0.56, d - 0.56, 0, floors, st);
    drawRoofCap(ctx, tx + 0.28, ty + 0.28, w - 0.56, d - 0.56, h, st);
    // front watchtowers (after the block, so they occlude it correctly)
    drawWatchtower(ctx, tx + w - 0.12, ty + d - 0.12, towerH);
    drawWatchtower(ctx, tx + 0.12, ty + d - 0.12, towerH);
  }

  // ---- Commercial tower archetypes (office / skyscraper variety) -------------
  // A real downtown is a mix of materials, massings and crowns, so every
  // com-category building rolls an archetype from its seed: a glass/teal/bronze/
  // silver/limestone material, a slab / setback / tapered massing, a curtain /
  // banded / piered facade, and one of several roof crowns. Deterministic, so a
  // building always renders the same; sprite-cached like everything else.
  const TOWER_MAT = [
    { h: 205, s: 26, l: 60, glassH: 205 }, // blue glass
    { h: 172, s: 22, l: 58, glassH: 168 }, // teal / green glass
    { h: 34,  s: 28, l: 52, glassH: 36  }, // bronze
    { h: 210, s: 7,  l: 70, glassH: 205 }, // silver / white metal
    { h: 30,  s: 14, l: 66, glassH: 42  }, // warm limestone / stone
    { h: 218, s: 12, l: 28, glassH: 214 }, // charcoal / black glass (432 Park, Salesforce dark)
    { h: 44,  s: 30, l: 64, glassH: 48  }, // champagne / gold glass
    { h: 18,  s: 32, l: 46, glassH: 22  }, // prewar warm brick / terracotta
    { h: 150, s: 16, l: 60, glassH: 150 }, // green-blue spandrel glass
    { h: 28,  s: 8,  l: 80, glassH: 40  }, // pale art-deco cast stone (Empire State)
  ];

  function clampInset(pl, inset) {
    const lim = (Math.min(pl.w, pl.d) - 0.6) / 2; // keep each segment >= 0.6 tiles wide
    return Math.max(0, Math.min(inset, lim));
  }

  // Vertical massing as a stack of {z0, f (floors), inset} segments.
  function towerSegments(floors, massing, seed) {
    const FH = C.FLOOR_H;
    if (massing === 0 || floors < 4) return [{ z0: 0, f: floors, inset: 0 }];
    if (massing === 1) {                       // setbacks (2 or 3 steps)
      if (floors >= 14 && ((seed >>> 14) & 1)) {
        const a = Math.round(floors * 0.55), b = Math.round(floors * 0.8);
        return [
          { z0: 0, f: a, inset: 0 },
          { z0: a * FH, f: b - a, inset: 0.16 },
          { z0: b * FH, f: floors - b, inset: 0.34 },
        ];
      }
      const a = Math.round(floors * 0.68);
      return [{ z0: 0, f: a, inset: 0 }, { z0: a * FH, f: floors - a, inset: 0.22 }];
    }
    if (massing === 3) {                        // art-deco wedding cake (Empire State)
      // a broad base, then a tall shaft, then several tight stepped setbacks
      // that march in toward a slender tower — the classic NYC 1930s ziggurat.
      const n = floors >= 40 ? 5 : 4;
      const baseF = Math.max(2, Math.round(floors * 0.34));
      const segs = [{ z0: 0, f: baseF, inset: 0 }];
      let used = baseF, z = baseF * FH;
      const rest = floors - baseF;
      for (let i = 1; i < n; i++) {
        const hi = Math.round((rest * i) / (n - 1));
        const lo = Math.round((rest * (i - 1)) / (n - 1));
        const f = hi - lo;
        if (f <= 0) continue;
        segs.push({ z0: z, f, inset: 0.10 + i * 0.13 });
        z += f * FH; used += f;
      }
      if (used < floors) segs[segs.length - 1].f += floors - used;
      return segs;
    }
    const n = 4, per = floors / n, segs = [];   // gentle continuous taper
    for (let i = 0; i < n; i++) {
      const lo = Math.round(i * per), hi = Math.round((i + 1) * per);
      if (hi > lo) segs.push({ z0: lo * FH, f: hi - lo, inset: i * 0.12 });
    }
    return segs.length ? segs : [{ z0: 0, f: floors, inset: 0 }];
  }

  // A glass facade with curtain / banded / piered treatments + material tint.
  function towerFacade(ctx, side, tx, ty, w, d, z0, floors, st, mat, variant) {
    const tiles = side === 'left' ? w : d;
    const H = floors * C.FLOOR_H;
    const tl = edgePt(side, tx, ty, w, d, 0, z0 + H);
    const tr = edgePt(side, tx, ty, w, d, tiles, z0 + H);
    const br = edgePt(side, tx, ty, w, d, tiles, z0);
    const bl = edgePt(side, tx, ty, w, d, 0, z0);
    const reflect = side === 'left' ? 0.5 : 0.3;
    poly(ctx, [tl, tr, br, bl]);
    ctx.fillStyle = vGrad(ctx, [tl, tr, br, bl],
      'hsla(' + mat.glassH + ',42%,84%,' + reflect + ')',
      'hsla(' + mat.glassH + ',30%,40%,0.34)');
    ctx.fill();

    if (variant === 'banded') {                // horizontal spandrel band per floor
      for (let f = 0; f < floors; f++) {
        fillCell(ctx, side, tx, ty, w, d, z0, f, 0, tiles, 0.0, 0.34,
          'hsla(' + mat.h + ',' + mat.s + '%,' + Math.max(8, mat.l - 18) + '%,0.85)');
      }
    } else if (variant === 'piers') {          // vertical solid piers
      for (let c = 0; c <= tiles; c++) {
        const p0 = Math.max(0, c - 0.12), p1 = Math.min(tiles, c + 0.12);
        if (p1 <= p0) continue;
        const a = edgePt(side, tx, ty, w, d, p0, z0 + H), b = edgePt(side, tx, ty, w, d, p1, z0 + H);
        const cc = edgePt(side, tx, ty, w, d, p1, z0), e = edgePt(side, tx, ty, w, d, p0, z0);
        poly(ctx, [a, b, cc, e]);
        ctx.fillStyle = 'hsla(' + mat.h + ',' + Math.max(0, mat.s - 6) + '%,' + (mat.l + 6) + '%,0.95)';
        ctx.fill();
      }
    }
    // mullion grid
    ctx.strokeStyle = 'rgba(236,243,248,0.25)'; ctx.lineWidth = 0.6;
    const cols = Math.max(1, Math.round(tiles * 2));
    ctx.beginPath();
    for (let i = 0; i <= cols; i++) {
      const p = (i / cols) * tiles;
      const a = edgePt(side, tx, ty, w, d, p, z0 + H), b = edgePt(side, tx, ty, w, d, p, z0);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    for (let f = 0; f <= floors; f++) {
      const z = z0 + f * C.FLOOR_H;
      const a = edgePt(side, tx, ty, w, d, 0, z), b = edgePt(side, tx, ty, w, d, tiles, z);
      ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
    // a scatter of lit windows once complete
    if (st.complete) {
      const lit = st.seed >>> 3;
      for (let f = 0; f < floors; f++) {
        for (let c = 0; c < cols; c++) {
          if (((lit >>> ((f * 5 + c * 3) % 29)) & 7) !== 0) continue;
          fillCell(ctx, side, tx, ty, w, d, z0, f, (c / cols) * tiles, ((c + 1) / cols) * tiles, 0.14, 0.9,
            'rgba(255,238,170,0.7)');
        }
      }
    }
  }

  function drawCrown(ctx, pl, h, col, mat, seed, type) {
    const { tx, ty, w, d } = pl;
    const cx = tx + w / 2, cy = ty + d / 2;
    const st = { hue: mat.h, seed };
    const kinds = type === 'skyscraper'
      ? ['mech', 'antenna', 'spire', 'pyramid', 'stepped', 'antenna', 'deco', 'dome', 'deco']
      : ['flat', 'flat', 'mech', 'antenna', 'watertank', 'watertank'];
    const crown = kinds[(seed >>> 11) % kinds.length];
    const FH = C.FLOOR_H;

    if (crown === 'pyramid') {                  // tapered glass cap to an apex
      const ph = FH * Math.max(2.2, Math.min(w, d) * 1.5);
      const apex = w2s(cx, cy, h + ph);
      const eT = w2s(tx + w, ty, h), sT = w2s(tx + w, ty + d, h), wT = w2s(tx, ty + d, h);
      poly(ctx, [wT, sT, apex]); ctx.fillStyle = hsl(mat.glassH, 30, 46); ctx.fill();
      poly(ctx, [sT, eT, apex]); ctx.fillStyle = hsl(mat.glassH, 32, 37); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(wT.x, wT.y); ctx.lineTo(apex.x, apex.y); ctx.lineTo(eT.x, eT.y); ctx.stroke();
      ctx.strokeStyle = '#aeb6bf'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(apex.x, apex.y); ctx.lineTo(apex.x, apex.y - 13); ctx.stroke();
      ctx.fillStyle = '#e0524a'; ctx.beginPath(); ctx.arc(apex.x, apex.y - 14, 1.8, 0, Math.PI * 2); ctx.fill();
      return;
    }

    drawRoofCap(ctx, tx, ty, w, d, h, st); // flat membrane under the rest

    if (crown === 'flat') {
      drawBox(ctx, tx + w * 0.36, ty + d * 0.36, w * 0.28, d * 0.28, h, FH * 0.6, { h: mat.h, s: 6, l: mat.l + 4 });
    } else if (crown === 'mech') {              // mechanical penthouse + vent + mast
      drawBox(ctx, tx + w * 0.18, ty + d * 0.2, w * 0.46, d * 0.42, h, FH * 1.4, { h: mat.h, s: 8, l: Math.max(8, mat.l - 4) });
      drawBox(ctx, tx + w * 0.6, ty + d * 0.5, w * 0.22, d * 0.26, h, FH * 0.7, { h: mat.h, s: 6, l: mat.l + 2 });
      const a = w2s(tx + w * 0.4, ty + d * 0.42, h + FH * 1.4);
      ctx.strokeStyle = '#9aa2ab'; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x, a.y - 11); ctx.stroke();
    } else if (crown === 'antenna') {           // lattice mast (+ guy wires, beacon)
      const mast = type === 'skyscraper' ? 34 : 18;
      const base = w2s(cx, cy, h), tip = { x: base.x, y: base.y - mast };
      ctx.strokeStyle = '#aeb6bf'; ctx.lineWidth = type === 'skyscraper' ? 1.8 : 1.3;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(150,158,167,0.5)'; ctx.lineWidth = 0.5;
      for (const s of [-1, 1]) {
        const g = w2s(cx + s * w * 0.3, cy + s * d * 0.3, h);
        ctx.beginPath(); ctx.moveTo(tip.x, tip.y); ctx.lineTo(g.x, g.y); ctx.stroke();
      }
      ctx.fillStyle = '#e0524a'; ctx.beginPath(); ctx.arc(tip.x, tip.y + 1, 2, 0, Math.PI * 2); ctx.fill();
      if ((seed >> 15) & 1) {                   // twin mast
        const b2 = w2s(cx + w * 0.18, cy + d * 0.18, h);
        ctx.strokeStyle = '#aeb6bf'; ctx.lineWidth = 1.2;
        ctx.beginPath(); ctx.moveTo(b2.x, b2.y); ctx.lineTo(b2.x, b2.y - mast * 0.6); ctx.stroke();
      }
    } else if (crown === 'spire') {             // glass crown + needle
      const ins = 0.28;
      drawBox(ctx, tx + ins, ty + ins, w - 2 * ins, d - 2 * ins, h, FH * 2, { h: col.h, s: col.s, l: Math.max(8, col.l - 5) });
      const base = w2s(cx, cy, h + FH * 2);
      ctx.strokeStyle = '#aeb6bf'; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(base.x, base.y - 30); ctx.stroke();
      ctx.fillStyle = '#e0524a'; ctx.beginPath(); ctx.arc(base.x, base.y - 31, 2.2, 0, Math.PI * 2); ctx.fill();
    } else if (crown === 'stepped') {           // ziggurat
      drawBox(ctx, tx + w * 0.12, ty + d * 0.12, w * 0.76, d * 0.76, h, FH * 1.1, { h: col.h, s: col.s, l: Math.max(8, col.l - 3) });
      drawBox(ctx, tx + w * 0.28, ty + d * 0.28, w * 0.44, d * 0.44, h + FH * 1.1, FH, { h: col.h, s: col.s, l: col.l - 1 });
      const a = w2s(cx, cy, h + FH * 2.1);
      ctx.strokeStyle = '#aeb6bf'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(a.x, a.y - 15); ctx.stroke();
      ctx.fillStyle = '#e0524a'; ctx.beginPath(); ctx.arc(a.x, a.y - 16, 1.8, 0, Math.PI * 2); ctx.fill();
    } else if (crown === 'deco') {              // art-deco crown: tight tiered setbacks + a tall fluted needle (Empire State / Chrysler)
      let bz = h, bw = w, bd = d, bx = tx, by = ty;
      for (let i = 0; i < 3; i++) {
        const ins = 0.16 + i * 0.12;
        const sw = w * (1 - ins * 2), sd = d * (1 - ins * 2);
        bx = tx + (w - sw) / 2; by = ty + (d - sd) / 2; bw = sw; bd = sd;
        drawBox(ctx, bx, by, bw, bd, bz, FH * 0.7, { h: col.h, s: col.s, l: C.clamp(col.l + 4 + i * 3, 12, 88) });
        bz += FH * 0.7;
      }
      // metallic finial mast with a beacon — the spire that makes it read deco
      const base = w2s(cx, cy, bz);
      const tip = { x: base.x, y: base.y - 30 };
      ctx.strokeStyle = '#cfd6dd'; ctx.lineWidth = 2.2;
      ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(tip.x, tip.y); ctx.stroke();
      ctx.strokeStyle = 'rgba(207,214,221,0.6)'; ctx.lineWidth = 1;
      for (let i = 1; i <= 3; i++) {                 // fluted rings up the needle
        const ry = base.y - (30 * i) / 4, rw = 3.2 * (1 - i / 4);
        ctx.beginPath(); ctx.moveTo(tip.x - rw, ry); ctx.lineTo(tip.x + rw, ry); ctx.stroke();
      }
      ctx.fillStyle = '#ffd34d'; ctx.beginPath(); ctx.arc(tip.x, tip.y, 2, 0, Math.PI * 2); ctx.fill();
    } else if (crown === 'dome') {              // rounded glowing glass crown (Salesforce / US Bank / Wilshire Grand)
      const ins = 0.22;
      const cw = w * (1 - ins * 2), cd = d * (1 - ins * 2);
      drawBox(ctx, tx + (w - cw) / 2, ty + (d - cd) / 2, cw, cd, h, FH * 1.6, { h: mat.glassH, s: 30, l: 52 });
      const top = w2s(cx, cy, h + FH * 1.6);
      const rx = (cw * C.TILE_W) / 2 * 0.5;
      const g = ctx.createRadialGradient(top.x, top.y, 1, top.x, top.y, rx);
      g.addColorStop(0, 'rgba(255,247,210,0.95)');
      g.addColorStop(0.6, 'hsla(' + mat.glassH + ',45%,72%,0.85)');
      g.addColorStop(1, 'hsla(' + mat.glassH + ',40%,48%,0.7)');
      ctx.fillStyle = g;
      ctx.beginPath(); ctx.ellipse(top.x, top.y, rx, rx * 0.7, 0, Math.PI, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(255,255,255,0.35)'; ctx.lineWidth = 1;
      ctx.beginPath(); ctx.ellipse(top.x, top.y, rx, rx * 0.7, 0, Math.PI, Math.PI * 2); ctx.stroke();
    } else if (crown === 'watertank') {         // NYC rooftop wooden water tank on a steel cradle
      drawRoofCap(ctx, tx, ty, w, d, h, st);
      const tkx = tx + w * 0.58, tky = ty + d * 0.3;
      const legH = FH * 0.7, tankH = FH * 1.3, tw = Math.min(0.5, w * 0.3), td = Math.min(0.5, d * 0.3);
      // steel cradle legs
      ctx.strokeStyle = '#5b6066'; ctx.lineWidth = 1;
      for (const [lx, ly] of [[0, 0], [tw, 0], [tw, td], [0, td]]) {
        const lo = w2s(tkx + lx, tky + ly, h), hi = w2s(tkx + lx, tky + ly, h + legH);
        ctx.beginPath(); ctx.moveTo(lo.x, lo.y); ctx.lineTo(hi.x, hi.y); ctx.stroke();
      }
      // wooden barrel
      drawBox(ctx, tkx, tky, tw, td, h + legH, tankH, { h: 26, s: 34, l: 42 });
      // conical lid
      const apex = w2s(tkx + tw / 2, tky + td / 2, h + legH + tankH + FH * 0.5);
      const eT = w2s(tkx + tw, tky, h + legH + tankH), sT = w2s(tkx + tw, tky + td, h + legH + tankH), wT = w2s(tkx, tky + td, h + legH + tankH);
      poly(ctx, [wT, sT, apex]); ctx.fillStyle = '#4a3622'; ctx.fill();
      poly(ctx, [sT, eT, apex]); ctx.fillStyle = '#3a2a1a'; ctx.fill();
    }
  }

  function paintTower(ctx, pl, st, floors, type) {
    const seed = st.seed;
    const mat = TOWER_MAT[(seed >>> 2) % TOWER_MAT.length];
    const col = { h: mat.h, s: mat.s, l: C.clamp(mat.l + ((seed >>> 4) % 7) - 3, 12, 84) };
    let massing = (seed >>> 5) % 4;             // 0 slab, 1 setback, 2 taper, 3 art-deco
    if (type === 'office' && massing >= 2) massing = (seed >>> 9) & 1;          // offices: slab/setback only
    if (type === 'skyscraper' && massing === 0 && ((seed >>> 17) & 1)) massing = 1; // towers rarely plain slabs
    if (massing === 3 && floors < 24) massing = 1;                              // wedding cake needs height
    const variant = ['curtain', 'banded', 'piers'][(seed >>> 8) % 3];
    const segs = towerSegments(floors, massing, seed);
    for (const sg of segs) {
      const ins = clampInset(pl, sg.inset);
      const tx = pl.tx + ins, ty = pl.ty + ins, w = pl.w - 2 * ins, d = pl.d - 2 * ins;
      drawBox(ctx, tx, ty, w, d, sg.z0, sg.f * C.FLOOR_H, col);
      for (const side of ['left', 'right']) towerFacade(ctx, side, tx, ty, w, d, sg.z0, sg.f, st, mat, variant);
    }
    const top = segs[segs.length - 1];
    const tIns = clampInset(pl, top.inset);
    const tpl = { tx: pl.tx + tIns, ty: pl.ty + tIns, w: pl.w - 2 * tIns, d: pl.d - 2 * tIns };
    drawCrown(ctx, tpl, top.z0 + top.f * C.FLOOR_H, col, mat, seed, type);
  }

  // ---- Retail (shops / stores / restaurants) ---------------------------------
  // A low-rise storefront: a ground-floor display window under a striped awning,
  // a recessed door, optional residence/office floors above, and an illuminated
  // sign box on the roof. The awning colour reads the retail subtype.
  const RETAIL = {
    shop:       { a1: '#3f9e7a', a2: '#83cbb1', sign: { h: 163, s: 45, l: 36 } }, // green grocer/boutique
    store:      { a1: '#3f74b0', a2: '#8bb2dd', sign: { h: 212, s: 50, l: 40 } }, // blue big-box
    restaurant: { a1: '#c75a3e', a2: '#e6a085', sign: { h: 14,  s: 62, l: 44 } }, // warm diner
  };
  function paintRetail(ctx, pl, st, floors) {
    const { tx, ty, w, d } = pl;
    const h = floors * C.FLOOR_H;
    drawBox(ctx, tx, ty, w, d, 0, h, st.col);
    // upper floors (the flat/office above the shop) get punched windows; the
    // ground floor is left bare so the storefront below paints over it cleanly.
    if (floors > 1) {
      const lit = st.seed >>> 3;
      for (const side of ['left', 'right']) {
        const tiles = side === 'left' ? w : d;
        for (let f = 1; f < floors; f++) {
          for (let k = 0; k < tiles; k++) {
            for (let c = 0; c < 2; c++) {
              const p0 = k + (c + 0.24) / 2, p1 = k + (c + 0.76) / 2;
              const on = st.complete && (((lit >>> ((f * 7 + (k * 2 + c) * 3) % 28)) & 3) === 0);
              fillCell(ctx, side, tx, ty, w, d, 0, f, p0, p1, 0.30, 0.78,
                on ? 'rgba(255,232,150,0.85)' : 'rgba(46,62,86,0.52)', 'rgba(244,246,248,0.20)');
            }
          }
        }
      }
    }
    drawRoofCap(ctx, tx, ty, w, d, h, st);
    // storefront on both visible faces (a corner shop reads from either side)
    const r = RETAIL[st.type] || RETAIL.shop;
    const gh = Math.min(C.FLOOR_H, h);
    for (const side of ['left', 'right']) {
      const tiles = side === 'left' ? w : d;
      const glass = side === 'left' ? 'rgba(150,196,222,0.64)' : 'rgba(120,162,190,0.5)';
      facePanel(ctx, side, tx, ty, w, d, tiles * 0.06, tiles * 0.94, gh * 0.10, gh * 0.70, glass, 'rgba(240,244,248,0.30)');
      facePanel(ctx, side, tx, ty, w, d, tiles * 0.44, tiles * 0.56, 0, gh * 0.64, 'rgba(64,80,98,0.62)'); // door
      // striped awning band above the glass
      const segs = Math.max(3, Math.round(tiles * 3));
      for (let i = 0; i < segs; i++) {
        const p0 = tiles * 0.03 + tiles * 0.94 * (i / segs);
        const p1 = tiles * 0.03 + tiles * 0.94 * ((i + 1) / segs);
        facePanel(ctx, side, tx, ty, w, d, p0, p1, gh * 0.70, gh * 0.90, (i & 1) ? r.a1 : r.a2);
      }
    }
    // illuminated rooftop sign pylon along the front (SW) parapet
    drawBox(ctx, tx + w * 0.15, ty + d * 0.74, w * 0.70, d * 0.10, h, C.FLOOR_H * 0.8, r.sign);
  }

  // ---- Farm (rural ground feature: tilled field + homestead + silo) ----------
  function drawSilo(ctx, cx, cy, hgt) {
    const base = w2s(cx, cy, 0), top = w2s(cx, cy, hgt);
    const rr = 5.5;
    poly(ctx, [{ x: base.x - rr, y: base.y }, { x: top.x - rr, y: top.y }, { x: top.x + rr, y: top.y }, { x: base.x + rr, y: base.y }]);
    ctx.fillStyle = vGrad(ctx, [{ x: 0, y: top.y }, { x: 0, y: base.y }], 'hsl(40,12%,82%)', 'hsl(40,14%,58%)');
    ctx.fill();
    poly(ctx, [{ x: top.x, y: top.y }, { x: top.x + rr, y: top.y }, { x: base.x + rr, y: base.y }, { x: base.x, y: base.y }]);
    ctx.fillStyle = 'rgba(20,26,34,0.10)'; ctx.fill();
    // domed cap
    ctx.fillStyle = '#9aa0a6';
    ctx.beginPath(); ctx.ellipse(top.x, top.y, rr, rr * 0.5, 0, Math.PI, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = 'rgba(255,255,255,0.2)'; ctx.lineWidth = 0.8;
    ctx.beginPath(); ctx.ellipse(top.x, top.y, rr, rr * 0.5, 0, Math.PI, Math.PI * 2); ctx.stroke();
  }
  function paintFarm(ctx, pl, st) {
    const { tx, ty, w, d } = pl;
    // tilled field over the whole parcel footprint
    drawDiamond(ctx, tx, ty, w, d, '#b79a68', 'rgba(80,60,30,0.25)');
    // crop rows: lines parallel to +tx, alternating crop greens
    const rows = 8;
    for (let i = 1; i < rows; i++) {
      const ry = ty + d * (i / rows);
      const a = w2s(tx + 0.05, ry, 0), b = w2s(tx + w - 0.05, ry, 0);
      ctx.strokeStyle = (i & 1) ? '#6f9a48' : '#86b35c';
      ctx.lineWidth = 1.6;
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.stroke();
    }
    // a barn/homestead at the NE (back) corner so it sits behind the field rows
    const hx = tx + 0.1, hy = ty + 0.1, hw = 0.7, hd = 0.7, hh = C.FLOOR_H * 1.4;
    drawBox(ctx, hx, hy, hw, hd, 0, hh, st.col);
    // pitched roof on the homestead
    const rhgt = C.FLOOR_H * 0.9;
    const apex = w2s(hx + hw / 2, hy + hd / 2, hh + rhgt);
    const eT = w2s(hx + hw, hy, hh), sT = w2s(hx + hw, hy + hd, hh), wT = w2s(hx, hy + hd, hh);
    const rhue = (st.hue + 16) % 360;
    poly(ctx, [wT, sT, apex]); ctx.fillStyle = hsl(rhue, 44, 38); ctx.fill();
    poly(ctx, [sT, eT, apex]); ctx.fillStyle = hsl(rhue, 46, 30); ctx.fill();
    // a grain silo beside the barn
    drawSilo(ctx, tx + 1.55, ty + 0.45, C.FLOOR_H * 2.4);
  }

  // ---- Scaffold wrap (construction) -----------------------------------------------
  function drawScaffold(ctx, tx, ty, w, d, z0, zTop) {
    ctx.strokeStyle = C.PAL.scaffold;
    ctx.lineWidth = 1;
    const steps = Math.max(1, Math.round((zTop - z0) / (C.FLOOR_H * 0.75)));
    for (let i = 0; i <= steps; i++) {
      const z = z0 + ((zTop - z0) * i) / steps;
      const a = w2s(tx, ty + d, z), b = w2s(tx + w, ty + d, z), e = w2s(tx + w, ty, z);
      ctx.beginPath(); ctx.moveTo(a.x, a.y); ctx.lineTo(b.x, b.y); ctx.lineTo(e.x, e.y); ctx.stroke();
    }
    for (const [cx, cy] of [[0, d], [w, d], [w, 0]]) {
      const lo = w2s(tx + cx, ty + cy, z0), hi = w2s(tx + cx, ty + cy, zTop);
      ctx.beginPath(); ctx.moveTo(lo.x, lo.y); ctx.lineTo(hi.x, hi.y); ctx.stroke();
    }
  }

  // ---- Stage math ------------------------------------------------------------------
  function stageOf(lot) {
    if (lot.state === 'complete') return { key: 'done', ratio: 1 };
    const ratio = C.clamp((lot.progress || 0) / Math.max(1, lot.required || 1), 0, 1);
    if (ratio < 0.10) return { key: 'dig', ratio };
    if (ratio < 0.25) return { key: 'foundation', ratio };
    const floors = (lot.building && lot.building.floors) || 1;
    const built = Math.max(1, Math.floor(ratio * floors));
    return { key: 'rise' + built, ratio, built };
  }

  function buildingHeight(lot) {
    const stage = stageOf(lot);
    if (stage.key === 'dig') return 0;
    if (stage.key === 'foundation') return 4;
    const floors = (lot.building && lot.building.floors) || 1;
    if (stage.key === 'done') return floors * C.FLOOR_H;
    return (stage.built || 1) * C.FLOOR_H;
  }

  // ---- The actual lot painter (uncached core) -----------------------------------------
  function paintLot(ctx, lot, district) {
    const pl = C.lotPlacement(lot);
    const st = buildingStyle(lot, district);
    const stage = stageOf(lot);
    st.complete = stage.key === 'done';
    const floors = (lot.building && lot.building.floors) || 1;
    const tier = (lot.building && lot.building.tier) || 1;
    const type = st.type;
    const cat = st.cat;

    // Parcel ground: planted garden when complete, packed dirt while building.
    // Garden stays green (slight per-seed variation) rather than tracking the
    // district hue — pink/blue lawns read as candy, greens read as a city.
    const groundCol = st.complete
      ? hsl(96 + ((st.seed >>> 5) % 26) - 12, 40, 64)
      : C.PAL.dirt;
    drawDiamond(ctx, pl.parcelTx, pl.parcelTy, 2, 2, groundCol, 'rgba(0,0,0,0.07)');
    if (st.complete && cat !== 'farm') {
      // a hint of paving / planter at the building base (a farm is open field)
      drawDiamond(ctx, pl.tx - 0.12, pl.ty - 0.12, pl.w + 0.24, pl.d + 0.24, 'rgba(200,205,210,0.55)');
    }

    if (stage.key === 'dig') {
      drawDiamond(ctx, pl.tx + 0.15, pl.ty + 0.15, pl.w * 0.7, pl.d * 0.7, C.PAL.dirtDark);
      drawDiamond(ctx, pl.tx + 0.3, pl.ty + 0.3, pl.w * 0.4, pl.d * 0.4, '#7c5a39');
      return;
    }
    if (stage.key === 'foundation') {
      drawBox(ctx, pl.tx, pl.ty, pl.w, pl.d, 0, 4, { h: 0, s: 0, l: 66 });
      return;
    }
    if (stage.key === 'done') {
      const h = floors * C.FLOOR_H;
      // civic types have their own silhouette (towers / canopy)
      if (cat === 'power') { paintPowerStation(ctx, pl, st, floors); return; }
      if (cat === 'industrial') { paintFactory(ctx, pl, st, floors); return; }
      if (cat === 'transit') { paintTransit(ctx, pl, st, floors); return; }
      if (cat === 'police') { paintPolice(ctx, pl, st, floors); return; }
      if (cat === 'hospital') { paintHospital(ctx, pl, st, floors); return; }
      if (cat === 'fire') { paintFireStation(ctx, pl, st, floors); return; }
      if (cat === 'prison') { paintPrison(ctx, pl, st, floors); return; }
      if (cat === 'retail') { paintRetail(ctx, pl, st, Math.max(1, floors)); return; }
      if (cat === 'farm') { paintFarm(ctx, pl, st); return; }
      if (cat === 'com') { paintTower(ctx, pl, st, floors, type); return; } // varied office/skyscraper
      drawBox(ctx, pl.tx, pl.ty, pl.w, pl.d, 0, h, st.col);
      drawWindows(ctx, pl.tx, pl.ty, pl.w, pl.d, 0, floors, st);
      if (type === 'house') {
        drawHouseRoof(ctx, pl, h, st); // pitched roof instead of a flat parapet
      } else if (type === 'mansion') {
        drawMansionRoof(ctx, pl, h, st); // grand hip roof + portico
      } else if (type === 'townhouse') {
        drawRoofCap(ctx, pl.tx, pl.ty, pl.w, pl.d, h, st);
        drawTownhouseTrim(ctx, pl, h, st); // cornice + bays + stoop
      } else if (type === 'condo') {
        drawCondoBalconies(ctx, pl, floors, st); // per-floor balconies over the body
        drawRoofCap(ctx, pl.tx, pl.ty, pl.w, pl.d, h, st);
        drawCondoCrown(ctx, pl, h, st);    // setback penthouse
      } else {
        drawRoofCap(ctx, pl.tx, pl.ty, pl.w, pl.d, h, st);
        drawRoof(ctx, pl.tx, pl.ty, pl.w, pl.d, h, st, tier);
        if (type === 'skyscraper') drawSpire(ctx, pl, h, st);
        else if (type === 'school') drawSchoolTrim(ctx, pl, h, st);
      }
      return;
    }
    // rising
    const built = stage.built;
    const h = built * C.FLOOR_H;
    drawBox(ctx, pl.tx, pl.ty, pl.w, pl.d, 0, h, st.col);
    drawWindows(ctx, pl.tx, pl.ty, pl.w, pl.d, 0, built, st);
    drawDiamondAt(ctx, pl.tx, pl.ty, pl.w, pl.d, h, 'rgba(196,201,207,0.95)', 'rgba(20,28,36,0.25)');
    const zLo = Math.max(0, h - 2 * C.FLOOR_H);
    drawScaffold(ctx, pl.tx, pl.ty, pl.w, pl.d, zLo, h + C.FLOOR_H * 0.4);
  }

  // ---- Cast shadow (separate ground pass, drawn before buildings) ------------
  // Convex hull (monotone chain) of the footprint base corners plus those
  // corners projected to the ground along the sun direction.
  function convexHull(pts) {
    pts = pts.slice().sort((a, b) => a.x - b.x || a.y - b.y);
    const cross = (o, a, b) => (a.x - o.x) * (b.y - o.y) - (a.y - o.y) * (b.x - o.x);
    const lo = [], hi = [];
    for (const p of pts) {
      while (lo.length >= 2 && cross(lo[lo.length - 2], lo[lo.length - 1], p) <= 0) lo.pop();
      lo.push(p);
    }
    for (let i = pts.length - 1; i >= 0; i--) {
      const p = pts[i];
      while (hi.length >= 2 && cross(hi[hi.length - 2], hi[hi.length - 1], p) <= 0) hi.pop();
      hi.push(p);
    }
    lo.pop(); hi.pop();
    return lo.concat(hi);
  }

  function drawLotShadow(ctx, lot) {
    const h = buildingHeight(lot);
    if (h < 2) return;
    const pl = C.lotPlacement(lot);
    const dx = C.SUN.shadowDX * h, dy = C.SUN.shadowDY * h;
    const corners = [[pl.tx, pl.ty], [pl.tx + pl.w, pl.ty], [pl.tx + pl.w, pl.ty + pl.d], [pl.tx, pl.ty + pl.d]];
    const pts = [];
    for (const [cx, cy] of corners) {
      const b = w2s(cx, cy, 0);
      pts.push(b, { x: b.x + dx, y: b.y + dy });
    }
    const hull = convexHull(pts);
    poly(ctx, hull);
    ctx.fillStyle = 'rgba(' + C.PAL.shadow + ',0.16)';
    ctx.fill();
  }

  // ---- Sprite cache --------------------------------------------------------------
  // key = lotId|stageKey|zoomBucket -> { canvas, ox, oy } where (ox, oy) is the
  // canvas-pixel position of the lot's PARCEL NW corner ground point.
  const cache = new Map();
  const CACHE_CAP = 500;

  function zoomBucket(zoom) {
    return C.clamp(Math.round(zoom * 2) / 2, 0.5, 2.5);
  }

  function lotSprite(lot, district, zoom) {
    const zb = zoomBucket(zoom);
    const stage = stageOf(lot);
    const key = lot.id + '|' + stage.key + '|' + zb;
    let entry = cache.get(key);
    if (entry) {
      cache.delete(key); cache.set(key, entry); // LRU bump
      return entry;
    }
    const b = lot.building || {};
    const floors = b.floors || 1;
    const cat = C.buildingCategory(b.type || 'office');
    // headroom above the wall top for type-specific caps (towers / spire / canopy)
    let topH = floors * C.FLOOR_H;
    if (cat === 'power') topH = Math.max(topH, C.FLOOR_H * 5.0) + 22;        // cooling towers + steam
    else if (cat === 'industrial') topH = Math.max(topH, C.FLOOR_H * 4.2) + 18; // back smokestacks
    else if (b.type === 'skyscraper') topH += C.FLOOR_H * 3 + 36;           // crown variety (spire/pyramid/stepped + antenna)
    else if (cat === 'com') topH += C.FLOOR_H * 2.5 + 30;                    // office crowns (mech room / antenna / water tank)
    else if (cat === 'transit') topH += 14;                                  // canopy lip
    else if (cat === 'fire') topH += C.FLOOR_H * 2.2 + 12;                   // hose-drying tower
    else if (cat === 'prison') topH += C.FLOOR_H * 1.6 + C.FLOOR_H * 0.9 + 14; // watchtowers
    else if (cat === 'police') topH += 20;                                   // beacon mast
    else if (cat === 'retail') topH += C.FLOOR_H * 0.8 + 14;                  // rooftop sign pylon
    else if (cat === 'farm') topH = Math.max(topH, C.FLOOR_H * 2.4) + 16;     // silo + homestead roof
    else if (b.type === 'condo') topH += C.FLOOR_H * 1.8 + 12;                // setback penthouse + mech box
    else if (b.type === 'mansion') topH += C.FLOOR_H * 1.4 + 14;              // hip roof + chimneys
    else topH += 24;                                                         // generic roof furniture (house/townhouse/apartment)
    const maxH = topH + 24;
    const wpx = (C.TILE_W * 2 + 8) * zb;
    const hpx = (C.TILE_H * 2 + maxH + 8) * zb;
    const cv = document.createElement('canvas');
    cv.width = Math.ceil(wpx);
    cv.height = Math.ceil(hpx);
    const cctx = cv.getContext('2d');
    const pl = C.lotPlacement(lot);
    const origin = w2s(pl.parcelTx, pl.parcelTy, 0);
    const ox = cv.width / 2;
    const oy = cv.height - C.TILE_H * 2 * zb - 4;
    cctx.setTransform(zb, 0, 0, zb, ox - origin.x * zb, oy - origin.y * zb);
    paintLot(cctx, lot, district);
    entry = { canvas: cv, ox, oy, zb };
    cache.set(key, entry);
    if (cache.size > CACHE_CAP) cache.delete(cache.keys().next().value);
    return entry;
  }

  /** Draw a lot via its cached sprite. ctx must be in WORLD transform. */
  function drawLot(ctx, lot, district, zoom) {
    const entry = lotSprite(lot, district, zoom);
    const pl = C.lotPlacement(lot);
    const origin = w2s(pl.parcelTx, pl.parcelTy, 0);
    const s = 1 / entry.zb;
    ctx.drawImage(
      entry.canvas,
      origin.x - entry.ox * s,
      origin.y - entry.oy * s,
      entry.canvas.width * s,
      entry.canvas.height * s
    );
  }

  /** Depth-sort anchor for a lot (south corner of its parcel). */
  function lotDepth(lot) {
    const pl = C.lotPlacement(lot);
    return C.depthKey(pl.parcelTx + 1, pl.parcelTy + 1);
  }

  /** Invalidate cached sprites for a lot (its stage changed). */
  function invalidateLot(lotId) {
    for (const key of [...cache.keys()]) {
      if (key.startsWith(lotId + '|')) cache.delete(key);
    }
  }

  // ---- Crane (per-frame, animated; only on active construction lots) ---------------
  function drawCrane(ctx, lot, now) {
    const stage = stageOf(lot);
    if (stage.key === 'dig' || stage.key === 'done') return;
    const pl = C.lotPlacement(lot);
    const built = stage.built || 0;
    const mastH = Math.max(3, built + 3) * C.FLOOR_H;
    const base = w2s(pl.parcelTx + 1.85, pl.parcelTy + 1.85, 0);
    const top = { x: base.x, y: base.y - mastH };
    // lattice mast
    ctx.strokeStyle = '#d8902c';
    ctx.lineWidth = 2;
    ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(top.x, top.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(216,144,44,0.5)';
    ctx.lineWidth = 0.7;
    for (let z = base.y; z > top.y; z -= 9) {
      ctx.beginPath(); ctx.moveTo(base.x - 1.6, z); ctx.lineTo(base.x + 1.6, z - 4.5); ctx.stroke();
    }
    // slowly swinging jib
    const ang = Math.sin(now / 4000 + (lot.building.seed % 7)) * 0.9;
    const jibLen = C.TILE_W * 1.1;
    const jx = top.x + Math.cos(ang) * jibLen;
    const jy = top.y + Math.sin(ang) * jibLen * 0.3;
    ctx.strokeStyle = '#d8902c';
    ctx.lineWidth = 1.5;
    ctx.beginPath(); ctx.moveTo(top.x, top.y); ctx.lineTo(jx, jy); ctx.stroke();
    ctx.beginPath(); ctx.moveTo(top.x, top.y);
    ctx.lineTo(top.x - Math.cos(ang) * jibLen * 0.35, top.y - Math.sin(ang) * jibLen * 0.3 * 0.35);
    ctx.stroke();
    const hookY = jy + mastH * 0.45;
    ctx.strokeStyle = 'rgba(60,60,60,0.7)';
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(jx, jy); ctx.lineTo(jx, hookY); ctx.stroke();
    ctx.fillStyle = '#d8902c';
    ctx.fillRect(jx - 2, hookY, 4, 4);
  }

  // ---- Construction-zone site props (per-frame, active construction lots) ----------
  // Ground clutter that makes a building site read unmistakably as a WORK ZONE:
  // safety hoarding, cones, an amber beacon, material stockpiles, a skip, a
  // warning sign, and an excavator during the dig/foundation stages. All keyed
  // off the building's seed (never the agent's tool kind — design rule 1) and
  // placed in the viewer-facing half of the parcel so they layer over the
  // building's front faces correctly. Drawn AFTER the building sprite, BEFORE
  // the crane (see render.js).

  // Temporary mesh fencing run along a ground edge a->b, with orange top rail.
  function fenceRun(ctx, ax, ay, bx, by) {
    const segs = 4, H = 11;
    for (let i = 0; i < segs; i++) {
      const t0 = i / segs, t1 = (i + 1) / segs;
      const x0 = ax + (bx - ax) * t0, y0 = ay + (by - ay) * t0;
      const x1 = ax + (bx - ax) * t1, y1 = ay + (by - ay) * t1;
      const aLo = w2s(x0, y0, 0), bLo = w2s(x1, y1, 0), bHi = w2s(x1, y1, H), aHi = w2s(x0, y0, H);
      poly(ctx, [aLo, bLo, bHi, aHi]);
      ctx.fillStyle = 'rgba(190,194,198,0.16)';      // see-through mesh
      ctx.fill();
      ctx.strokeStyle = 'rgba(120,126,132,0.55)';
      ctx.lineWidth = 0.7;
      ctx.stroke();
      ctx.beginPath();                               // cross braces
      ctx.moveTo(aLo.x, aLo.y); ctx.lineTo(bHi.x, bHi.y);
      ctx.moveTo(bLo.x, bLo.y); ctx.lineTo(aHi.x, aHi.y);
      ctx.stroke();
      ctx.strokeStyle = '#ff7a18';                   // orange top rail
      ctx.lineWidth = 2;
      ctx.beginPath(); ctx.moveTo(aHi.x, aHi.y); ctx.lineTo(bHi.x, bHi.y); ctx.stroke();
    }
    for (let i = 0; i <= segs; i++) {                // posts + feet
      const t = i / segs, x = ax + (bx - ax) * t, y = ay + (by - ay) * t;
      const lo = w2s(x, y, 0), hi = w2s(x, y, H);
      ctx.strokeStyle = '#8a9096'; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.moveTo(lo.x, lo.y); ctx.lineTo(hi.x, hi.y); ctx.stroke();
      ctx.fillStyle = 'rgba(40,46,52,0.4)';
      ctx.beginPath(); ctx.ellipse(lo.x, lo.y, 2.4, 1.1, 0, 0, Math.PI * 2); ctx.fill();
    }
  }

  function coneAt(ctx, tx, ty) {
    const base = w2s(tx, ty, 0), tip = w2s(tx, ty, 7);
    ctx.fillStyle = '#e8690d';                       // base flange
    ctx.beginPath(); ctx.ellipse(base.x, base.y, 3.6, 1.6, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ff7a18';                       // cone body
    ctx.beginPath();
    ctx.moveTo(tip.x, tip.y); ctx.lineTo(base.x - 3.2, base.y); ctx.lineTo(base.x + 3.2, base.y);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.9)';         // reflective band
    ctx.beginPath();
    ctx.moveTo(tip.x - 1.5, tip.y + 2.6); ctx.lineTo(tip.x + 1.5, tip.y + 2.6);
    ctx.lineTo(tip.x + 1.9, tip.y + 3.9); ctx.lineTo(tip.x - 1.9, tip.y + 3.9);
    ctx.closePath(); ctx.fill();
  }

  function moundAt(ctx, tx, ty, r, col) {            // gravel / sand stockpile
    const c = w2s(tx, ty, 0), top = w2s(tx, ty, 6.5);
    ctx.fillStyle = 'rgba(40,46,52,0.22)';
    ctx.beginPath(); ctx.ellipse(c.x, c.y, r, r * 0.45, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = col;
    ctx.beginPath();
    ctx.moveTo(c.x - r, c.y);
    ctx.quadraticCurveTo(c.x - r * 0.4, top.y, c.x, top.y - 1);
    ctx.quadraticCurveTo(c.x + r * 0.4, top.y, c.x + r, c.y);
    ctx.closePath(); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.12)';        // sunlit face
    ctx.beginPath();
    ctx.moveTo(c.x, top.y - 1);
    ctx.quadraticCurveTo(c.x + r * 0.4, top.y, c.x + r, c.y);
    ctx.lineTo(c.x, c.y); ctx.closePath(); ctx.fill();
  }

  function pipeStack(ctx, tx, ty) {                  // stacked pipe / duct ends
    const b = w2s(tx, ty, 0), r = 2.3;
    const ends = [[-2.6, 0], [0.2, 0], [3, 0], [-1.2, -3.6], [1.6, -3.6]];
    for (const [dx, dy] of ends) {
      ctx.fillStyle = '#9aa1a6';
      ctx.beginPath(); ctx.ellipse(b.x + dx, b.y + dy - 3, r, r, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = '#5f676c';
      ctx.beginPath(); ctx.ellipse(b.x + dx, b.y + dy - 3, r * 0.5, r * 0.5, 0, 0, Math.PI * 2); ctx.fill();
    }
  }

  function skipAt(ctx, tx, ty, seed) {               // builder's skip / dumpster
    const hue = (seed & 8) ? 14 : 45;                // rusty orange or yellow
    drawBox(ctx, tx, ty, 0.7, 0.45, 0, 7, { h: hue, s: 72, l: 50 });
    const a = w2s(tx, ty + 0.45, 7), b = w2s(tx + 0.7, ty, 7);
    ctx.fillStyle = 'rgba(40,30,18,0.55)';           // rubble heaped above the rim
    ctx.beginPath();
    ctx.moveTo(a.x, a.y); ctx.lineTo((a.x + b.x) / 2, Math.min(a.y, b.y) - 2.5); ctx.lineTo(b.x, b.y);
    ctx.closePath(); ctx.fill();
  }

  // Ambient site crew — extra hard-hat workers beyond the session figures, so a
  // building site looks properly busy. Purely decorative (not tied to any
  // session); positions are seeded, the work animation is driven by `now`.
  function siteWorker(ctx, tx, ty, now, phase, hue) {
    const p = w2s(tx, ty, 0);
    const swing = Math.abs(Math.sin(now / 150 + phase));   // tool / dig motion
    const bob = swing * 1.0;
    const baseY = p.y - bob;
    const H = 15;
    ctx.fillStyle = 'rgba(30,40,50,0.22)';                  // shadow
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 4.6, 2.2, 0, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#3a4450';                              // legs
    ctx.fillRect(p.x - 2.2, baseY - 5, 1.8, 5);
    ctx.fillRect(p.x + 0.5, baseY - 5, 1.8, 5);
    ctx.fillStyle = 'hsl(' + hue + ',62%,52%)';             // hi-vis vest
    roundRect(ctx, p.x - 2.8, baseY - H + 4, 5.6, H - 8, 1.8); ctx.fill();
    ctx.fillStyle = 'rgba(255,255,255,0.5)';                // vest stripe
    ctx.fillRect(p.x - 2.4, baseY - H + 7, 4.8, 1);
    ctx.strokeStyle = '#caa36a';                            // swinging tool arm
    ctx.lineWidth = 1.6;
    ctx.beginPath();
    ctx.moveTo(p.x + 2, baseY - H + 8);
    ctx.lineTo(p.x + 5, baseY - H + 5 - swing * 3);
    ctx.stroke();
    const headY = baseY - H + 1;
    ctx.fillStyle = '#e8b88f';                              // head
    ctx.beginPath(); ctx.arc(p.x, headY, 2.3, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#ffb400';                              // hard hat
    ctx.beginPath(); ctx.arc(p.x, headY - 0.7, 2.5, Math.PI, 0); ctx.fill();
    ctx.fillRect(p.x - 3, headY - 1, 6, 1);
  }

  function diggerAt(ctx, tx, ty, now) {              // excavator (dig/foundation)
    const b = w2s(tx, ty, 0);
    ctx.fillStyle = '#3a4046';                        // tracks
    ctx.fillRect(b.x - 7, b.y - 3.5, 14, 4);
    ctx.fillStyle = '#22262b';
    for (let i = -6; i <= 5; i += 2.4) { ctx.fillRect(b.x + i, b.y - 3.5, 1.2, 4); }
    ctx.fillStyle = '#f2b21a';                        // cab body
    ctx.fillRect(b.x - 5, b.y - 11, 9, 8);
    ctx.fillStyle = '#2b6c8f';                        // cab glass
    ctx.fillRect(b.x - 3.5, b.y - 10, 4, 4);
    const sw = Math.sin(now / 700) * 0.25;            // boom slowly digs
    const sh = { x: b.x + 3, y: b.y - 9 };
    const elbow = { x: sh.x + 8, y: sh.y + 1 + sw * 6 };
    const bucket = { x: elbow.x + 3, y: elbow.y + 6 };
    ctx.strokeStyle = '#d99a16'; ctx.lineWidth = 2.4; ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(sh.x, sh.y); ctx.lineTo(elbow.x, elbow.y); ctx.lineTo(bucket.x, bucket.y);
    ctx.stroke();
    ctx.fillStyle = '#caa033';                        // bucket
    ctx.beginPath();
    ctx.moveTo(bucket.x - 1, bucket.y - 2); ctx.lineTo(bucket.x + 3.5, bucket.y);
    ctx.lineTo(bucket.x + 1.5, bucket.y + 3.5); ctx.closePath(); ctx.fill();
  }

  function drawSiteProps(ctx, lot, now, hasCrew) {
    const stage = stageOf(lot);
    if (stage.key === 'done') return;
    const pl = C.lotPlacement(lot);
    const px = pl.parcelTx, py = pl.parcelTy;
    const seed = (lot.building && lot.building.seed) || 0;

    // Safety hoarding along the two viewer-facing parcel edges, each stopping
    // short of the S corner to leave a site gate.
    fenceRun(ctx, px + 0.08, py + 1.92, px + 1.25, py + 1.92);   // front-left edge
    fenceRun(ctx, px + 1.92, py + 0.08, px + 1.92, py + 1.25);   // front-right edge

    // Material stockpiles on the visible margins.
    moundAt(ctx, px + 0.5, py + 1.55, 6.5, '#b89b6a');           // sand / gravel
    pipeStack(ctx, px + 1.55, py + 0.5);
    skipAt(ctx, px + 1.42, py + 1.42, seed);

    // Excavator while the pit is open / slab going in.
    if (stage.key === 'dig' || stage.key === 'foundation') {
      diggerAt(ctx, px + 1.0, py + 1.5, now);
    }

    // Ambient crew working the site — ONLY when a Claude Code session is
    // actually building here (hasCrew). An unmanned site keeps its props
    // (hoarding, materials, crane) but stands empty: a construction site with
    // no workers, never a fake-busy one.
    if (hasCrew) {
      const crew = [
        [px + 0.78, py + 1.35, 0.0, 28],
        [px + 1.35, py + 0.8, 1.7, 200],
        [px + 1.62, py + 1.62, 3.1, 140],
        [px + 0.45, py + 1.05, 4.4, 48],
      ];
      for (const c of crew) siteWorker(ctx, c[0], c[1], now, c[2], c[3]);
    }

    // Cones flanking the gate at the near corner.
    coneAt(ctx, px + 1.5, py + 2.02);
    coneAt(ctx, px + 2.02, py + 1.5);
    coneAt(ctx, px + 0.72, py + 2.04);

    // Amber safety beacon on the gate post, blinking.
    const blink = Math.sin(now / 300) + 1 > 1.2;
    const bp = w2s(px + 1.25, py + 1.92, 12);
    ctx.fillStyle = blink ? 'rgba(255,170,30,0.95)' : 'rgba(150,90,10,0.6)';
    ctx.beginPath(); ctx.arc(bp.x, bp.y, blink ? 2.6 : 1.8, 0, Math.PI * 2); ctx.fill();
    if (blink) {
      ctx.fillStyle = 'rgba(255,200,80,0.28)';
      ctx.beginPath(); ctx.arc(bp.x, bp.y, 5.2, 0, Math.PI * 2); ctx.fill();
    }
  }

  Object.assign(window.CITY, {
    drawDiamond, drawBox, drawLot, drawLotShadow, drawCrane, drawSiteProps, lotDepth, stageOf,
    invalidateLot, buildingStyle, buildingHeight,
  });
})();
