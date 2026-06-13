/* ===========================================================================
   infra.js — geometry AND construction state for the city's ambient
   INFRASTRUCTURE: the highway beltway, the commuter rail loop, and the airport.

   NOTHING here "just appears". Every network is BUILT UP, paid for by the
   city's accumulated work (Σ district.totalWork — the same persisted unit that
   raises buildings). A young city paves its beltway edge-by-edge, then lays its
   rail loop, then constructs its airport; an established city already has them
   (its workers built them over many work units before the page loaded). The
   draw modules (highway/rail/airport.js) read this state to render finished
   spans, active roadworks, and the equipment at each work front.

   The three systems are CONCURRENT funding streams, not one queue: each exists
   once the city is big enough (beltway always, rail loop ≥4 blocks, airport ≥6
   blocks) and then draws on the city's work IN PARALLEL, staggered only by a
   head-start so roads visibly lead, rail follows, and the airport comes last —
   none waits for the one before it to finish. The only cross-stream gate kept is
   the physically real one: a suburb's branch line waits for its connector road.

   LOCAL BUDGETS: the regional skeleton (beltway, rail loop, core depots, airport,
   connectors) is funded from the city's total work, but each satellite's commuter
   BRANCH is funded from that town's OWN share of the work — its buildings'
   accumulated effort, regrouped by cluster (satelliteBudgets). So a busy suburb
   earns its spur from its own activity while downtown is still building its loop.

   The beltway, once an edge is paved, becomes REAL ROAD: its tiles (plus a ramp
   to the nearest block) are published via drivableTiles() and folded into the
   pathgraph, so ordinary traffic drives on it. roadVersion() bumps whenever a
   new edge opens so the graph rebuilds.

   Geometry (corners/loops/airport rect) is cached on the ground version; the
   cheap construction state is recomputed whenever the work total changes.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const B = C.BLOCK_TILES;

  // ---- Tunables -------------------------------------------------------------
  const BELT_MARGIN = 2;            // highway ring, tiles outside the blocks
  const RAIL_MARGIN = 3;            // rail loop, just outside the beltway (hugs the city edge)
  const RAIL_MIN_BLOCKS = 4;
  const AIRPORT_MIN_BLOCKS = 6;
  const AF_GAP = 3;                 // tiles past the rail loop's east edge
  const AF_LEN = 14;               // runway length (along +tx)
  const AF_HALF = 4;               // airfield half-depth (along ty)
  const CONN_WORK_PER_TILE = 3;     // Σwork to pave one tile of a connector freeway
  const TOWN_MARGIN = 2;            // clearing kept around a satellite town
  const RAIL_CHAMFER = 4;           // corner radius on the rail loop (rounds the rectangle)
  const RAIL_CORNER_PTS = 4;        // straight segments approximating each rounded corner
  const RAIL_PLATFORM_HALF = 2.6;   // station platform half-length, along the track tangent
  const RAIL_PLATFORM_DEPTH = 0.9;  // platform reach inward (city-side) from the rail line
  const RAIL_BOARD_INSET = 0.7;     // where riders stand on the platform, beside a stopped train
  const RAIL_DEPOT_INSET = 1.5;     // headhouse building tiles inward, just behind the platform
  const RAIL_BRANCH_WORK_PER_TILE = 3;  // Σwork to lay one tile of a suburb branch line
  const RAIL_TOWN_MIN_BLOCKS = 2;   // a suburb earns rail only once it's a real town
                                    // (≥ this many blocks) AND its road is finished —
                                    // a lone outpost gets a freeway first, rail later.

  // Work (Σ totalWork units) to construct each piece.
  const HW_EDGE_WORK = 30;          // per beltway edge (×4 = a full ring)
  const RAIL_EDGE_WORK = 30;        // per rail edge
  const RAIL_DEPOT_WORK = 24;       // crew-work to raise one station depot building
  const AIRPORT_WORK = 180;         // whole airfield, staged
  const HW_TOTAL = HW_EDGE_WORK * 4;
  const RAIL_TOTAL = RAIL_EDGE_WORK * 4;

  // Each system is its own FUNDING STREAM, not a stage in one queue: the beltway,
  // the rail loop, and the airport draw from the city's work CONCURRENTLY, each
  // starting after a head-start so the roads still visibly lead, the rail follows,
  // and the airport comes last — but none waits for the one before it to FINISH.
  // (Streams are independent, so total work "spent" can exceed Σwork — like a city
  // funding roads, transit, and aviation from separate budgets at the same time.)
  const RAIL_HEAD_WORK = 60;        // rail loop begins once the city has this much work (≈2 beltway edges)
  const AIRPORT_HEAD_WORK = 150;    // aviation begins later still, but overlaps road + rail

  let builtVersion = -1;
  let ver = 0;
  let geo = null;

  let lastWork = -1;
  let con = null;
  let roadVer = 0;
  let lastBuiltEdges = 0;
  let lastCompleteConns = 0;

  // ---- Geometry (cached on ground version) ----------------------------------
  // Partition built blocks into 8-connected TOWNS; the CORE is the cluster at
  // the origin (else the largest). Beltway/rail/airport ring the CORE only — the
  // detached satellite towns are tied back to it by connector freeways. (Same
  // clustering idea as the growth model, recomputed here purely for rendering.)
  function clusterTowns() {
    let blocks = C.usedBlocks();
    if (!blocks.length) blocks = [0];
    const cells = [];
    const idx = new Map();
    for (const slot of blocks) {
      const { bx, by } = C.spiralSlot(slot);
      idx.set(bx + ',' + by, cells.length);
      cells.push({ bx, by });
    }
    const parent = cells.map((_, i) => i);
    const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
    for (let i = 0; i < cells.length; i++) {
      const p = cells[i];
      for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
        if (!dx && !dy) continue;
        const j = idx.get((p.bx + dx) + ',' + (p.by + dy));
        if (j !== undefined) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
      }
    }
    const groups = new Map();
    for (let i = 0; i < cells.length; i++) {
      const r = find(i);
      let t = groups.get(r);
      if (!t) { t = { cells: [], x0: Infinity, y0: Infinity, x1: -Infinity, y1: -Infinity, sx: 0, sy: 0 }; groups.set(r, t); }
      const c = cells[i];
      t.cells.push(c); t.sx += c.bx; t.sy += c.by;
      const ox = c.bx * B, oy = c.by * B;
      if (ox < t.x0) t.x0 = ox; if (oy < t.y0) t.y0 = oy;
      if (ox + B - 1 > t.x1) t.x1 = ox + B - 1; if (oy + B - 1 > t.y1) t.y1 = oy + B - 1;
    }
    const towns = [];
    for (const t of groups.values()) {
      towns.push({
        cells: t.cells, size: t.cells.length,
        x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1,
        cx: (t.sx / t.cells.length) * B + B / 2, cy: (t.sy / t.cells.length) * B + B / 2,
      });
    }
    let core = null;
    for (const t of towns) if (t.cells.some((c) => c.bx === 0 && c.by === 0)) { core = t; break; }
    if (!core) for (const t of towns) if (!core || t.size > core.size) core = t;
    for (const t of towns) t.core = (t === core);
    return { towns, core };
  }

  function computeCityBounds(core) {
    return { x0: core.x0, y0: core.y0, x1: core.x1, y1: core.y1, blocks: core.size };
  }

  // L-shaped connector freeways: tie each satellite town to the core beltway with
  // a two-segment road from the town edge facing the core to the nearest point on
  // the belt rectangle. Tiles are ordered CORE-end first so paving extends OUT
  // toward the new town (the freeway reaches the suburb).
  function buildConnectors(towns, core, belt) {
    const bx0 = belt.corners[0].tx, by0 = belt.corners[0].ty;
    const bx1 = belt.corners[2].tx, by1 = belt.corners[2].ty;
    const out = [];
    for (const t of towns) {
      if (t.core) continue;
      let best = null, bestD = Infinity;
      for (const c of t.cells) {
        const cx = c.bx * B + B / 2, cy = c.by * B + B / 2;
        const d = (cx - core.cx) * (cx - core.cx) + (cy - core.cy) * (cy - core.cy);
        if (d < bestD) { bestD = d; best = c; }
      }
      const ox = best.bx * B, oy = best.by * B, mid = B >> 1;
      const dx = core.cx - (ox + mid), dy = core.cy - (oy + mid);
      const horiz = Math.abs(dx) >= Math.abs(dy);
      const anchor = horiz
        ? { tx: dx > 0 ? ox + B - 1 : ox, ty: oy + mid }
        : { tx: ox + mid, ty: dy > 0 ? oy + B - 1 : oy };
      const join = { tx: C.clamp(anchor.tx, bx0, bx1), ty: C.clamp(anchor.ty, by0, by1) };
      const corner = horiz ? { tx: join.tx, ty: anchor.ty } : { tx: anchor.tx, ty: join.ty };
      const tiles = edgeTiles(anchor, corner);
      const seg2 = edgeTiles(corner, join);
      for (let i = 1; i < seg2.length; i++) tiles.push(seg2[i]);
      tiles.reverse(); // core-end (join) first
      out.push({ tiles, length: tiles.length, anchor, join, corner, segs: [[anchor, corner], [corner, join]], town: { cx: t.cx, cy: t.cy, size: t.size } });
    }
    out.sort((a, b) => a.length - b.length); // nearest towns get their freeway first
    return out;
  }

  function rect(m, b) {
    return [
      { tx: b.x0 - m, ty: b.y0 - m },   // 0 NW
      { tx: b.x1 + m, ty: b.y0 - m },   // 1 NE
      { tx: b.x1 + m, ty: b.y1 + m },   // 2 SE
      { tx: b.x0 - m, ty: b.y1 + m },   // 3 SW
    ];
  }

  function loopMetrics(corners) {
    const seg = [];
    let total = 0;
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], c = corners[(i + 1) % corners.length];
      const L = Math.hypot(c.tx - a.tx, c.ty - a.ty);
      seg.push(L); total += L;
    }
    return { seg, total };
  }

  // Open-polyline metrics (n-1 segments), for the suburb branch lines.
  function pathMetrics(corners) {
    const seg = [];
    let total = 0;
    for (let i = 0; i < corners.length - 1; i++) {
      const L = Math.hypot(corners[i + 1].tx - corners[i].tx, corners[i + 1].ty - corners[i].ty);
      seg.push(L); total += L;
    }
    return { seg, total };
  }

  // Round every corner of a closed polygon into a small circular arc, turning a
  // rigid rectangle into a smoothly curved ring that reads as a real rail
  // alignment — trains sweep the corners instead of kinking at a hard cut.
  function chamfer(pts, c) {
    const out = [];
    const n = pts.length;
    for (let i = 0; i < n; i++) {
      const prev = pts[(i - 1 + n) % n], cur = pts[i], next = pts[(i + 1) % n];
      const inx = cur.tx - prev.tx, iny = cur.ty - prev.ty, lIn = Math.hypot(inx, iny) || 1;
      const oux = next.tx - cur.tx, ouy = next.ty - cur.ty, lOut = Math.hypot(oux, ouy) || 1;
      const cc = Math.min(c, lIn / 2, lOut / 2);
      const ux = inx / lIn, uy = iny / lIn;      // incoming unit dir
      const vx = oux / lOut, vy = ouy / lOut;    // outgoing unit dir
      const a = { tx: cur.tx - ux * cc, ty: cur.ty - uy * cc };   // arc start (on incoming edge)
      const b = { tx: cur.tx + vx * cc, ty: cur.ty + vy * cc };   // arc end (on outgoing edge)
      // Quadratic-Bezier sweep from a to b with the rectangle corner as control
      // point — gives a clean rounded corner whose midpoint bulges toward `cur`.
      out.push(a);
      for (let k = 1; k < RAIL_CORNER_PTS; k++) {
        const t = k / RAIL_CORNER_PTS, mt = 1 - t;
        const w0 = mt * mt, w1 = 2 * mt * t, w2 = t * t;
        out.push({ tx: w0 * a.tx + w1 * cur.tx + w2 * b.tx, ty: w0 * a.ty + w1 * cur.ty + w2 * b.ty });
      }
      out.push(b);
    }
    return out;
  }

  // Arc length from corner 0 to a point P known to lie on one of the loop edges.
  function arcLengthAt(corners, seg, P) {
    let s = 0;
    for (let i = 0; i < corners.length; i++) {
      const a = corners[i], b = corners[(i + 1) % corners.length];
      const abx = b.tx - a.tx, aby = b.ty - a.ty, L2 = abx * abx + aby * aby;
      const t = L2 > 0 ? ((P.tx - a.tx) * abx + (P.ty - a.ty) * aby) / L2 : 0;
      if (t >= -1e-6 && t <= 1 + 1e-6) {
        const px = a.tx + abx * t, py = a.ty + aby * t;
        if (Math.hypot(P.tx - px, P.ty - py) < 1e-3) return s + t * Math.sqrt(L2);
      }
      s += seg[i];
    }
    return s;
  }

  // Where the CORE's buildings actually sit, weighted by how built-up each block
  // is (finished towers count for more than fresh groundbreaks). Returns a tile
  // point, or null when there's nothing built yet. This is the SAME per-building
  // work the agent model deposits per lot, regrouped by block — so stations face
  // the city's real centre of mass, not the geometric middle of the loop.
  function devCentroid(core) {
    if (!core) return null;
    const coreSet = new Set(core.cells.map((c) => c.bx + ',' + c.by));
    let sx = 0, sy = 0, sw = 0;
    for (const d of C.districts.values()) {
      for (const lot of d.lots || []) {
        const { bx, by } = C.spiralSlot(lot.block);
        if (!coreSet.has(bx + ',' + by)) continue;
        const wgt = (lot.everCompleted || lot.state === 'complete') ? 1.5 : 0.6;
        sx += (bx * B + B / 2) * wgt; sy += (by * B + B / 2) * wgt; sw += wgt;
      }
    }
    return sw > 0 ? { x: sx / sw, y: sy / sw } : null;
  }

  // Slide a station along one side of the loop toward `target`, but keep it on the
  // side's STRAIGHT span (clear of the chamfered corners) so it still lies on a
  // real loop edge for arc-length math. Falls back to the side midpoint.
  function slideOnSide(lo, hi, target) {
    const pad = RAIL_CHAMFER + 1.5;
    const a = lo + pad, b2 = hi - pad;
    if (a >= b2 || target == null) return (lo + hi) / 2;
    return C.clamp(target, a, b2);
  }

  // Build the softened rail loop, its four core station depots (with inward
  // subway-style spur stubs), and one branch line out to each satellite town.
  function buildRail(b, towns, core) {
    const rr = rect(RAIL_MARGIN, b);
    const corners = chamfer(rr, RAIL_CHAMFER);
    const m = loopMetrics(corners);
    const cx = (b.x0 + b.x1) / 2, cy = (b.y0 + b.y1) / 2;
    // One station per side, slid along the side toward the city's DEVELOPMENT
    // centre of mass rather than pinned to the geometric midpoint — so a lopsided
    // city's stations sit where its buildings are. (All on the chamfered loop.)
    const dev = devCentroid(core);
    const dx = dev ? dev.x : null, dy = dev ? dev.y : null;
    const sideMid = [
      { tx: slideOnSide(rr[0].tx, rr[1].tx, dx), ty: rr[0].ty },  // N
      { tx: rr[1].tx, ty: slideOnSide(rr[1].ty, rr[2].ty, dy) },  // E
      { tx: slideOnSide(rr[3].tx, rr[2].tx, dx), ty: rr[2].ty },  // S
      { tx: rr[0].tx, ty: slideOnSide(rr[0].ty, rr[3].ty, dy) },  // W
    ];
    // Inward (city-side) cardinal normal for each side — N,E,S,W — so the platform
    // runs straight along the rail tangent and the headhouse sits squarely behind it.
    const SIDE_NORMAL = [{ nx: 0, ny: 1 }, { nx: -1, ny: 0 }, { nx: 0, ny: -1 }, { nx: 1, ny: 0 }];
    const stations = sideMid.map((P, i) => {
      const { nx, ny } = SIDE_NORMAL[i];
      return {
        sid: 'c' + i,
        loop: { tx: P.tx, ty: P.ty },                 // train stops here, on the rail line
        sArc: arcLengthAt(corners, m.seg, P),
        normal: { nx, ny },
        // riders wait on the platform edge, right beside a stopped train
        board: { tx: P.tx + nx * RAIL_BOARD_INSET, ty: P.ty + ny * RAIL_BOARD_INSET },
        // headhouse building, just behind the platform (drawn from the rail point)
        depot: { tx: P.tx, ty: P.ty },
        platHalf: RAIL_PLATFORM_HALF, platDepth: RAIL_PLATFORM_DEPTH,
      };
    });
    const branches = [];
    for (const t of towns) {
      if (t.core) continue;
      // join the core depot nearest this town
      let ci = 0, cb = Infinity;
      for (let i = 0; i < stations.length; i++) {
        const d = (stations[i].loop.tx - t.cx) ** 2 + (stations[i].loop.ty - t.cy) ** 2;
        if (d < cb) { cb = d; ci = i; }
      }
      const start = stations[ci].loop;
      const dx = cx - t.cx, dy = cy - t.cy, horiz = Math.abs(dx) >= Math.abs(dy);
      const sd = horiz
        ? { tx: dx > 0 ? t.x0 - TOWN_MARGIN : t.x1 + TOWN_MARGIN, ty: Math.round(t.cy) }
        : { tx: Math.round(t.cx), ty: dy > 0 ? t.y0 - TOWN_MARGIN : t.y1 + TOWN_MARGIN };
      const elbow = horiz ? { tx: start.tx, ty: sd.ty } : { tx: sd.tx, ty: start.ty };
      const bc = [{ tx: start.tx, ty: start.ty }, elbow, { tx: sd.tx, ty: sd.ty }];
      // Side-platform normal: perpendicular to the final approach segment, pointed
      // toward the town body — so the shuttle stops ALONGSIDE a platform, not
      // nose-first into a building.
      const fdx = sd.tx - elbow.tx, fdy = sd.ty - elbow.ty;
      let snx, sny;
      if (Math.abs(fdx) >= Math.abs(fdy)) { snx = 0; sny = 1; } else { snx = 1; sny = 0; }
      if (snx * (t.cx - sd.tx) + sny * (t.cy - sd.ty) < 0) { snx = -snx; sny = -sny; }
      branches.push(Object.assign({
        coreIdx: ci, coreSid: 'c' + ci, corners: bc, depot: sd, normal: { nx: snx, ny: sny },
        board: { tx: sd.tx + snx * RAIL_BOARD_INSET, ty: sd.ty + sny * RAIL_BOARD_INSET },
        platHalf: RAIL_PLATFORM_HALF, platDepth: RAIL_PLATFORM_DEPTH,
        town: { cx: t.cx, cy: t.cy, size: t.size },
      }, pathMetrics(bc)));
    }
    branches.sort((a, b2) => a.total - b2.total);   // nearest suburb gets its line first
    branches.forEach((br, i) => { br.sid = 'b' + i; });
    return Object.assign({ corners, stations, branches }, m);
  }

  function rebuildGeo() {
    const { towns, core } = clusterTowns();
    const b = computeCityBounds(core);
    const beltCorners = rect(BELT_MARGIN, b);
    const belt = Object.assign({ corners: beltCorners }, loopMetrics(beltCorners));
    let rail = null;
    if (b.blocks >= RAIL_MIN_BLOCKS) rail = buildRail(b, towns, core);
    let airport = null;
    if (b.blocks >= AIRPORT_MIN_BLOCKS) {
      const yc = Math.round((b.y0 + b.y1) / 2);
      const ax0 = b.x1 + RAIL_MARGIN + AF_GAP;
      airport = {
        x0: ax0, x1: ax0 + AF_LEN, y0: yc - AF_HALF, y1: yc + AF_HALF,
        cx: ax0 + AF_LEN / 2, cy: yc,
        runY: yc, runX0: ax0 + 1.5, runX1: ax0 + AF_LEN - 1.5,
      };
    }
    const connectors = buildConnectors(towns, core, belt);
    geo = { b, belt, rail, airport, towns, core, connectors };
    builtVersion = C.getGroundVersion();
    ver++;
    lastWork = -1; // force construction recompute against the new geometry
  }

  function ensure() {
    if (!geo || builtVersion !== C.getGroundVersion()) rebuildGeo();
    return geo;
  }

  // ---- Construction state (recomputed when work changes) --------------------
  function cityWork() {
    let w = 0;
    for (const d of C.districts.values()) w += d.totalWork || 0;
    return w;
  }

  // A per-building proxy for how much agent work a lot has soaked up: the work to
  // raise it (required for a finished building, progress-so-far for one still
  // going up) plus roughly another required per renovation pass. Absolute scale
  // doesn't matter — it's only ever used as a SHARE between towns.
  function lotWork(lot) {
    if (!lot) return 0;
    const done = lot.everCompleted || lot.state === 'complete';
    let wk = done ? (lot.required || 0) : (lot.progress || 0);
    wk += (lot.upgrades || 0) * (lot.required || 0);
    return wk;
  }

  // LOCAL BUDGETS (issue #1). The city's accumulated work is the same unit the
  // agent model deposits into individual buildings; here we regroup it by TOWN
  // (each lot's block -> its cluster) so a satellite funds infrastructure from its
  // OWN activity. The regional skeleton (beltway, rail loop, core depots, airport,
  // connector freeways) stays on the shared pool, but each satellite's commuter
  // BRANCH is paid for out of its local share — a busy suburb earns its spur while
  // downtown is still finishing its loop; a sleepy one doesn't, however rich the
  // core. Returns townKey -> that satellite's budget (its share of total work).
  function satelliteBudgets(g, total) {
    const towns = g.towns || [];
    const blockTown = new Map();
    towns.forEach((t, i) => { for (const c of t.cells) blockTown.set(c.bx + ',' + c.by, i); });
    const raw = towns.map(() => 0);
    let sum = 0;
    for (const d of C.districts.values()) {
      for (const lot of d.lots || []) {
        const { bx, by } = C.spiralSlot(lot.block);
        const ti = blockTown.get(bx + ',' + by);
        if (ti === undefined) continue;
        const wk = lotWork(lot); raw[ti] += wk; sum += wk;
      }
    }
    const out = new Map();
    if (sum <= 0) return out;
    towns.forEach((t, i) => {
      if (t.core) return;
      out.set(Math.round(t.cx) + ',' + Math.round(t.cy), total * (raw[i] / sum));
    });
    return out;
  }

  // Integer tiles along an axis-aligned edge between two corner tiles.
  function edgeTiles(a, b) {
    const out = [];
    const x0 = Math.round(a.tx), y0 = Math.round(a.ty);
    const x1 = Math.round(b.tx), y1 = Math.round(b.ty);
    if (y0 === y1) { const s = Math.sign(x1 - x0) || 1; for (let x = x0; x !== x1 + s; x += s) out.push({ tx: x, ty: y0 }); }
    else { const s = Math.sign(y1 - y0) || 1; for (let y = y0; y !== y1 + s; y += s) out.push({ tx: x0, ty: y }); }
    return out;
  }

  // A short ramp from the midpoint of beltway edge i inward to the block ring,
  // so cars can get on/off the highway.
  function rampTiles(b, i) {
    const mx = Math.round((b.x0 + b.x1) / 2), my = Math.round((b.y0 + b.y1) / 2);
    const out = [];
    if (i === 0) for (let y = b.y0 - BELT_MARGIN + 1; y <= b.y0 - 1; y++) out.push({ tx: mx, ty: y }); // N
    else if (i === 1) for (let x = b.x1 + 1; x <= b.x1 + BELT_MARGIN - 1; x++) out.push({ tx: x, ty: my }); // E
    else if (i === 2) for (let y = b.y1 + 1; y <= b.y1 + BELT_MARGIN - 1; y++) out.push({ tx: mx, ty: y }); // S
    else for (let x = b.x0 - BELT_MARGIN + 1; x <= b.x0 - 1; x++) out.push({ tx: x, ty: my });           // W
    return out;
  }

  function computeConstruction() {
    const g = ensure();
    const w = cityWork();
    if (con && w === lastWork) return con;
    lastWork = w;

    // Each satellite's local share of the city's work — funds its OWN rail branch.
    const satBudget = satelliteBudgets(g, w);

    // 1) Highway
    const hwWork = Math.max(0, Math.min(HW_TOTAL, w));
    const hwBuiltEdges = Math.min(4, Math.floor(hwWork / HW_EDGE_WORK));
    const hwActiveEdge = hwBuiltEdges < 4 ? hwBuiltEdges : -1;
    const hwActiveFrac = hwActiveEdge >= 0 ? (hwWork - hwBuiltEdges * HW_EDGE_WORK) / HW_EDGE_WORK : 1;
    const highway = {
      corners: g.belt.corners, seg: g.belt.seg, total: g.belt.total,
      builtEdges: hwBuiltEdges, activeEdge: hwActiveEdge, activeFrac: hwActiveFrac,
      complete: hwBuiltEdges >= 4,
    };

    // 2) Connector freeways: built after the beltway, nearest town first, from a
    //    shared pool of leftover work. Each paves from its CORE end out toward the
    //    satellite over its length — so a young metro reaches its suburbs one
    //    freeway at a time, an established one already has them all. (Computed
    //    before rail because a suburb's branch line waits for its road.)
    let connPool = Math.max(0, w - HW_TOTAL);
    let completeConns = 0;
    const townKey = (t) => Math.round(t.cx) + ',' + Math.round(t.cy);
    const roadDone = new Map();
    const connectors = g.connectors.map((c) => {
      const cost = CONN_WORK_PER_TILE * c.length;
      const spent = Math.min(cost, connPool);
      connPool -= spent;
      const frac = cost > 0 ? spent / cost : 1;
      const complete = frac >= 0.999;
      if (complete) completeConns++;
      if (c.town) roadDone.set(townKey(c.town), complete);
      return { tiles: c.tiles, length: c.length, builtFrac: frac, complete, anchor: c.anchor, join: c.join, corner: c.corner };
    });

    // 3) Rail: the CORE skeleton (loop + the four core depots) is its own regional
    //    stream off total work — starts after RAIL_HEAD_WORK, paves the loop, then
    //    raises the depots from the stream's leftover pool. Each suburb BRANCH,
    //    though, is paid for out of that SUBURB'S OWN local budget (issue #1), so a
    //    busy satellite lays its spur in parallel with the core loop instead of
    //    queuing behind the core depots. A suburb is eligible only once it has
    //    grown into a real town (≥ RAIL_TOWN_MIN_BLOCKS) AND its connector road is
    //    finished — the one cross-stream prerequisite we keep, because it's
    //    physically real: rail to a suburb follows the road to it.
    let rail = null;
    if (g.rail) {
      const railStream = Math.max(0, w - RAIL_HEAD_WORK);
      const loopWork = Math.min(RAIL_TOTAL, railStream);
      const loopFrac = loopWork / RAIL_TOTAL;
      const complete = loopFrac >= 1;
      let pool = complete ? Math.max(0, railStream - RAIL_TOTAL) : 0;
      const depotProg = g.rail.stations.map(() => {
        const s = Math.min(RAIL_DEPOT_WORK, pool); pool -= s; return s / RAIL_DEPOT_WORK;
      });
      const branches = g.rail.branches.map((br) => {
        const eligible = br.town && br.town.size >= RAIL_TOWN_MIN_BLOCKS && roadDone.get(townKey(br.town)) === true;
        if (!eligible) return { paveFrac: 0, depotProg: 0, eligible: false };
        let tb = (br.town ? satBudget.get(townKey(br.town)) : 0) || 0;   // the suburb's OWN budget
        const paveCost = br.total * RAIL_BRANCH_WORK_PER_TILE;
        const ps = Math.min(paveCost, tb); tb -= ps;
        const paveFrac = paveCost > 0 ? ps / paveCost : 1;
        const ds = paveFrac >= 1 ? Math.min(RAIL_DEPOT_WORK, tb) : 0; tb -= ds;
        return { paveFrac, depotProg: ds / RAIL_DEPOT_WORK, eligible: true };
      });
      rail = {
        corners: g.rail.corners, seg: g.rail.seg, total: g.rail.total,
        stations: g.rail.stations, branchGeo: g.rail.branches,
        loopFrac, complete, depotProg, branches,
      };
    }

    // 4) Airport: its OWN stream too, starting after AIRPORT_HEAD_WORK — so the
    //    airfield rises alongside a still-growing rail network rather than waiting
    //    for the whole loop + every branch to finish first.
    let airport = null;
    if (g.airport) {
      const aw = Math.max(0, Math.min(AIRPORT_WORK, w - AIRPORT_HEAD_WORK));
      airport = Object.assign({}, g.airport, { progress: aw / AIRPORT_WORK, complete: aw >= AIRPORT_WORK });
    }

    // Publish drivable tiles (paved beltway edges + their ramps + COMPLETED
    // connector freeways) and bump the road version when any of those change so
    // the pathgraph re-stitches and ordinary traffic drives town-to-core.
    const tiles = [];
    for (let i = 0; i < highway.builtEdges; i++) {
      const a = g.belt.corners[i], b = g.belt.corners[(i + 1) % 4];
      for (const t of edgeTiles(a, b)) tiles.push(t);
      for (const t of rampTiles(g.b, i)) tiles.push(t);
    }
    for (const c of connectors) if (c.complete) for (const t of c.tiles) tiles.push(t);
    if (highway.builtEdges !== lastBuiltEdges || completeConns !== lastCompleteConns) {
      lastBuiltEdges = highway.builtEdges; lastCompleteConns = completeConns; roadVer++;
    }

    con = { highway, rail, airport, connectors, drivable: tiles };
    return con;
  }

  // ---- Public API -----------------------------------------------------------
  function screenExtent() {
    const g = ensure();
    let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    const acc = (tx, ty) => {
      const p = C.worldToScreen(tx, ty, 0);
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    };
    for (const pt of g.belt.corners) acc(pt.tx, pt.ty);
    if (g.rail) for (const pt of g.rail.corners) acc(pt.tx, pt.ty);
    if (g.airport) { const a = g.airport; acc(a.x0, a.y0); acc(a.x1, a.y0); acc(a.x1, a.y1); acc(a.x0, a.y1); }
    // satellite towns + their freeways sit outside the core beltway — include
    // them so the autofit camera and the ground canvas frame the whole metro.
    if (g.towns) for (const t of g.towns) { acc(t.x0, t.y0); acc(t.x1, t.y1); }
    if (g.connectors) for (const c of g.connectors) { acc(c.anchor.tx, c.anchor.ty); acc(c.join.tx, c.join.ty); }
    return { minX, minY, maxX, maxY };
  }

  // Tile bboxes of every town (core + satellites) and thin rects along each
  // connector freeway — terrain.js reads these to keep countryside off the
  // developed land and off the roads.
  function townBounds() {
    const g = ensure();
    return (g.towns || []).map((t) => ({ x0: t.x0, y0: t.y0, x1: t.x1, y1: t.y1, core: !!t.core }));
  }
  function connectorCorridors() {
    const g = ensure();
    const out = [];
    for (const c of (g.connectors || [])) {
      for (const s of c.segs) {
        const a = s[0], b = s[1];
        out.push({
          x0: Math.min(a.tx, b.tx) - 1, y0: Math.min(a.ty, b.ty) - 1,
          x1: Math.max(a.tx, b.tx) + 1, y1: Math.max(a.ty, b.ty) + 1,
        });
      }
    }
    return out;
  }

  // Position + heading at arc-length s along a closed corner loop.
  function posOnLoop(loop, s) {
    const total = loop.total || 1;
    s = ((s % total) + total) % total;
    for (let i = 0; i < loop.corners.length; i++) {
      const L = loop.seg[i];
      if (s <= L || i === loop.corners.length - 1) {
        const a = loop.corners[i], b = loop.corners[(i + 1) % loop.corners.length];
        const t = L > 1e-6 ? s / L : 0;
        const dx = b.tx - a.tx, dy = b.ty - a.ty;
        const m = Math.hypot(dx, dy) || 1;
        return { tx: a.tx + dx * t, ty: a.ty + dy * t, dirx: dx / m, diry: dy / m };
      }
      s -= L;
    }
    const a = loop.corners[0];
    return { tx: a.tx, ty: a.ty, dirx: 1, diry: 0 };
  }

  // Position + heading at arc-length s along an OPEN polyline (suburb branches).
  function posOnPath(path, s) {
    s = Math.max(0, Math.min(path.total, s));
    for (let i = 0; i < path.corners.length - 1; i++) {
      const L = path.seg[i];
      if (s <= L || i === path.corners.length - 2) {
        const a = path.corners[i], b = path.corners[i + 1];
        const t = L > 1e-6 ? s / L : 0;
        const dx = b.tx - a.tx, dy = b.ty - a.ty, mm = Math.hypot(dx, dy) || 1;
        return { tx: a.tx + dx * t, ty: a.ty + dy * t, dirx: dx / mm, diry: dy / mm };
      }
      s -= L;
    }
    const a = path.corners[0];
    return { tx: a.tx, ty: a.ty, dirx: 1, diry: 0 };
  }

  // Arc-length at the end of beltway/rail edge i (for marking built spans).
  function lenToEdge(loop, edges) {
    let s = 0;
    for (let i = 0; i < edges; i++) s += loop.seg[i];
    return s;
  }

  C.infra = {
    ensure,
    version: () => ver,
    cityBounds: () => ensure().b,
    cityWork,
    highway: () => computeConstruction().highway,
    rail: () => computeConstruction().rail,
    airport: () => computeConstruction().airport,
    connectors: () => computeConstruction().connectors,
    drivableTiles: () => computeConstruction().drivable,
    roadVersion: () => { computeConstruction(); return roadVer; },
    screenExtent,
    townBounds,
    connectorCorridors,
    posOnLoop,
    posOnPath,
    lenToEdge,
    constants: { BELT_MARGIN, HW_EDGE_WORK, TOWN_MARGIN },
  };
})();
