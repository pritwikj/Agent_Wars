/* ===========================================================================
   rail.js — the commuter-rail NETWORK: a softened loop around the core, a
   circling train, a depot BUILDING at each stop, subway-style spur stubs that
   poke into the blocks, and a branch line + shuttle out to every satellite town.

   Nothing appears at once. infra.js reports how far the loop has paved
   (loopFrac), how built each core depot is (depotProg[]), and for each suburb
   branch how far the line is laid + how built its depot is — all paid for by the
   city's accumulated work AFTER the beltway. We render whatever state the crews
   have reached: graded trackbed + survey line ahead of the work front, depots
   under a crane until finished, the main train running only on the whole loop,
   and a small shuttle ping-ponging each branch once its track is down.

   A transit API (C.rail.transit) lets population.js route commuters onto the
   network: walk to a depot, board when a train dwells there, ride, alight, walk.
   Client-side scenery — no server changes, no persistence.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const canvas = document.getElementById('city-canvas');

  const TRACK_DEPTH = -1e12 + 10;
  const CULL_MARGIN = 90;
  const RAIL_GAUGE = 0.16;
  const TIE_SPACING = 0.42;    // world tiles between sleepers
  const TIE_HALF = 0.27;       // sleeper half-length (a bit wider than the gauge)
  const CAR_LEN = 1.5, CAR_GAP = 0.25, CAR_WID = 0.46;
  const N_CARS = 4;            // cars on the main loop train
  const N_TRAINS = 2;          // trains circulating the loop, spaced a headway apart
  const SHUTTLE_CARS = 2;      // cars on a suburb shuttle (short, so reversing reads fine)
  const CRUISE = 4.0;         // loop train cruise (tiles/s)
  const SHUTTLE_CRUISE = 3.0;
  const DWELL_MS = 1600;
  // The lead car runs CONSIST_MID ahead of the consist's middle, so stopping with
  // the consist centred on a station means leaving the lead this far past it — the
  // cars then straddle the platform instead of overrunning it.
  const CONSIST_MID = ((N_CARS - 1) / 2) * (CAR_LEN + CAR_GAP);

  // Main loop trains and per-branch shuttles.
  let trains = [];             // [{lead,v,dwellUntil,alpha,atStation}]
  let shuttles = [];           // [{pos,v,dir,dwellUntil,atEnd,alpha}] parallel to rail.branchGeo
  let stationPts = [];         // ready depots, for the rider API
  let crossings = [];          // [{tx,ty,dirx,diry}] level crossings (built rail ∩ road)
  let crossSig = '';           // cache key so crossings recompute only when geometry/roads change
  let infraVer = -1;

  function rebuild() {
    const rail = C.infra.rail();
    const total = rail ? rail.total : 0;
    trains = [];
    for (let k = 0; k < N_TRAINS; k++) {
      trains.push({ lead: (total * k) / N_TRAINS, v: 0, dwellUntil: 0, alpha: 0, atStation: -1, justLeft: -1 });
    }
    const n = rail ? rail.branchGeo.length : 0;
    shuttles = [];
    for (let i = 0; i < n; i++) shuttles.push({ pos: 0, v: 0, dir: 1, dwellUntil: 0, atEnd: -1, alpha: 0 });
    stationPts = [];
    infraVer = C.infra.version();
  }

  // Nearest stop ahead of a train's consist CENTRE (lead - CONSIST_MID), as
  // {d: arc distance, i: station index}. `skip` is the stop just departed — ignored
  // while still adjacent so the train pulls away instead of re-dwelling on the spot.
  function nearestStationFwd(rail, lead, skip) {
    const ref = lead - CONSIST_MID;
    let bd = Infinity, bi = -1;
    for (let i = 0; i < rail.stations.length; i++) {
      let d = rail.stations[i].sArc - ref;
      d = ((d % rail.total) + rail.total) % rail.total;
      if (i === skip && d < 1.0) continue;
      if (d < bd) { bd = d; bi = i; }
    }
    return { d: bd, i: bi };
  }

  // A shuttle runs its branch out-and-back, dwelling at each end.
  function updateShuttle(sh, path, now, dt) {
    if (sh.alpha < 1) sh.alpha = Math.min(1, sh.alpha + dt * 1.6);
    if (sh.dwellUntil > now) { sh.v = 0; return; }   // dwelling — atEnd holds
    sh.atEnd = -1;
    const target = sh.dir > 0 ? path.total : 0;
    const d = Math.abs(target - sh.pos);
    if (d < 0.25 && sh.v < 0.6) {
      sh.dwellUntil = now + DWELL_MS; sh.v = 0;
      sh.atEnd = sh.dir > 0 ? 1 : 0;   // 1 = suburb end, 0 = core end
      sh.dir = -sh.dir;                // reverse for the return leg
      return;
    }
    const t = d < 4 ? Math.min(SHUTTLE_CRUISE, 0.5 + d * 1.1) : SHUTTLE_CRUISE;
    const a = t > sh.v ? 2.6 : -4.0;
    sh.v = Math.max(0, sh.v + a * dt);
    sh.pos = Math.max(0, Math.min(path.total, sh.pos + sh.dir * sh.v * dt));
  }

  function rebuildStationPts(rail) {
    stationPts = [];
    if (!rail.complete) return;
    rail.stations.forEach((s, i) => {
      if (rail.depotProg[i] >= 1) stationPts.push({ sid: s.sid, tx: s.board.tx, ty: s.board.ty, core: true, line: 'core' });
    });
    rail.branchGeo.forEach((br, i) => {
      const bs = rail.branches[i];
      if (bs.paveFrac >= 1 && bs.depotProg >= 1 && rail.depotProg[br.coreIdx] >= 1) {
        stationPts.push({ sid: br.sid, tx: br.board.tx, ty: br.board.ty, core: false, line: br.sid, coreSid: br.coreSid });
      }
    });
  }

  function update(dt, now) {
    C.infra.ensure();
    if (infraVer !== C.infra.version()) rebuild();
    const rail = C.infra.rail();
    if (!rail) return;

    // main loop trains — run only once the whole loop is laid
    for (const train of trains) {
      if (!rail.complete) { train.v = 0; train.alpha = 0; train.atStation = -1; train.justLeft = -1; continue; }
      if (train.alpha < 1) train.alpha = Math.min(1, train.alpha + dt * 1.6);
      if (train.dwellUntil > now) { train.v = 0; continue; }   // dwelling — atStation holds
      train.atStation = -1;
      const ns = nearestStationFwd(rail, train.lead, train.justLeft);
      if (ns.i >= 0 && ns.d < 0.25 && train.v < 0.6) {
        train.dwellUntil = now + DWELL_MS; train.v = 0; train.atStation = ns.i; train.justLeft = ns.i;
        train.lead = rail.stations[ns.i].sArc + CONSIST_MID;   // snap so cars straddle the platform
      } else {
        const target = ns.d < 4 ? Math.min(CRUISE, 0.5 + ns.d * 1.1) : CRUISE;
        const a = target > train.v ? 3.0 : -4.5;
        train.v = Math.max(0, train.v + a * dt);
        train.lead += train.v * dt;
        // once pulled clear of the stop we just left, allow stopping there again next lap
        if (train.justLeft >= 0) {
          let ds = rail.stations[train.justLeft].sArc - (train.lead - CONSIST_MID);
          ds = ((ds % rail.total) + rail.total) % rail.total;
          if (ds > 2.0) train.justLeft = -1;
        }
      }
    }

    // suburb shuttles — each runs once its branch line is fully laid
    for (let i = 0; i < rail.branchGeo.length; i++) {
      const sh = shuttles[i]; if (!sh) continue;
      if (rail.branches[i].paveFrac < 1) { sh.alpha = 0; sh.atEnd = -1; continue; }
      updateShuttle(sh, rail.branchGeo[i], now, dt);
    }

    rebuildStationPts(rail);

    // level crossings change only when the road network or how far the rail is
    // laid changes — recompute on a cheap signature, not every frame.
    const sig = C.infra.roadVersion() + ':' + Math.round(rail.loopFrac * 40) + ':' +
      rail.branches.map((b) => Math.round(b.paveFrac * 20)).join(',');
    if (sig !== crossSig) { crossSig = sig; crossings = findCrossings(rail); }
  }

  // ---- drawing primitives ---------------------------------------------------
  const w2s = (tx, ty, z) => C.worldToScreen(tx, ty, z || 0);
  const hsl = (h, s, l) => 'hsl(' + h + ',' + s + '%,' + l + '%)';
  function poly(ctx, pts) {
    ctx.beginPath(); ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
  }
  function strokeBetween(ctx, p0, p1, w, color, dash) {
    ctx.strokeStyle = color; ctx.lineWidth = w;
    if (dash) ctx.setLineDash(dash); else ctx.setLineDash([]);
    ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    ctx.setLineDash([]);
  }
  function edgePoint(a, b, f) { return { tx: a.tx + (b.tx - a.tx) * f, ty: a.ty + (b.ty - a.ty) * f }; }

  // A length of finished (laid) or graded (unlaid) track between two world tiles —
  // a gravel ballast bed, evenly spaced perpendicular sleepers, and twin steel
  // rails with a bright top highlight.
  function drawRailWorld(ctx, a, b, laid) {
    const ax = a.tx + 0.5, ay = a.ty + 0.5, bx = b.tx + 0.5, by = b.ty + 0.5;
    const s0 = w2s(ax, ay, 0), s1 = w2s(bx, by, 0);
    ctx.lineCap = 'butt';
    // ballast bed: a dark shoulder under a gravel crown
    strokeBetween(ctx, s0, s1, 10, 'rgba(20,26,34,0.18)');
    strokeBetween(ctx, s0, s1, 8, laid ? '#9a9086' : '#7c6a4f');
    if (!laid) { strokeBetween(ctx, s0, s1, 6, 'rgba(96,80,56,0.45)'); return; }   // graded earth

    let dx = bx - ax, dy = by - ay; const L = Math.hypot(dx, dy) || 1; dx /= L; dy /= L;
    const px = -dy, py = dx;                          // unit perpendicular (tile space)
    // sleepers — evenly spaced ties, drawn as one path
    ctx.strokeStyle = '#5c4a34'; ctx.lineWidth = 2.2; ctx.setLineDash([]);
    const ties = Math.max(1, Math.round(L / TIE_SPACING));
    ctx.beginPath();
    for (let i = 0; i <= ties; i++) {
      const f = i / ties, cx = ax + (bx - ax) * f, cy = ay + (by - ay) * f;
      const e0 = w2s(cx + px * TIE_HALF, cy + py * TIE_HALF, 0);
      const e1 = w2s(cx - px * TIE_HALF, cy - py * TIE_HALF, 0);
      ctx.moveTo(e0.x, e0.y); ctx.lineTo(e1.x, e1.y);
    }
    ctx.stroke();
    // twin steel rails + highlight
    for (const sgn of [-1, 1]) {
      const r0 = w2s(ax + px * sgn * RAIL_GAUGE, ay + py * sgn * RAIL_GAUGE, 0);
      const r1 = w2s(bx + px * sgn * RAIL_GAUGE, by + py * sgn * RAIL_GAUGE, 0);
      strokeBetween(ctx, r0, r1, 1.7, '#6b7178');
      strokeBetween(ctx, r0, r1, 0.7, 'rgba(226,231,237,0.9)');
    }
  }
  function drawSurveyWorld(ctx, a, b) {
    strokeBetween(ctx, w2s(a.tx + 0.5, a.ty + 0.5, 0), w2s(b.tx + 0.5, b.ty + 0.5, 0),
      5, 'rgba(150,134,96,0.32)', [3, 6]);
  }
  function drawWorkFront(ctx, p) {
    const s = w2s(p.tx + 0.5, p.ty + 0.5, 0);
    ctx.fillStyle = '#6f5234';
    for (let i = 0; i < 3; i++) ctx.fillRect(s.x - 4 + i * 3, s.y - 1 - i, 2.4, 1.4);
  }

  // ---- level crossings ------------------------------------------------------
  // Sample the BUILT rail (loop up to loopFrac, branches up to paveFrac) and flag
  // every integer tile that also carries a drivable road — those are the spots a
  // road and the railway cross at grade.
  function findCrossings(rail) {
    const roadTiles = (C.infra.drivableTiles && C.infra.drivableTiles()) || [];
    const out = [];
    if (!roadTiles.length) return out;
    const roadSet = new Set(roadTiles.map((t) => Math.round(t.tx) + ',' + Math.round(t.ty)));
    const seen = new Set();
    const step = 0.34;
    const sample = (p) => {
      const k = Math.round(p.tx) + ',' + Math.round(p.ty);
      if (!roadSet.has(k) || seen.has(k)) return;
      seen.add(k);
      out.push({ tx: Math.round(p.tx), ty: Math.round(p.ty), dirx: p.dirx, diry: p.diry });
    };
    const builtArc = rail.loopFrac * rail.total;
    for (let s = 0; s <= builtArc; s += step) sample(C.infra.posOnLoop(rail, s));
    rail.branchGeo.forEach((br, i) => {
      const pf = rail.branches[i].paveFrac; if (pf <= 0) return;
      const bArc = pf * br.total;
      for (let s = 0; s <= bArc; s += step) sample(C.infra.posOnPath(br, s));
    });
    return out;
  }

  // A grade crossing: an asphalt deck repaving the rail across the road, the rails
  // carried over it, and a white stop line on each road approach.
  function drawCrossing(ctx, c) {
    const cx = c.tx + 0.5, cy = c.ty + 0.5;
    const dx = c.dirx, dy = c.diry, px = -dy, py = dx;     // rail dir + road dir
    const road = (C.PAL && C.PAL.road) || '#4e565f';
    poly(ctx, [
      w2s(cx + dx * -0.55 + px * -0.5, cy + dy * -0.55 + py * -0.5, 0.02),
      w2s(cx + dx * 0.55 + px * -0.5, cy + dy * 0.55 + py * -0.5, 0.02),
      w2s(cx + dx * 0.55 + px * 0.5, cy + dy * 0.55 + py * 0.5, 0.02),
      w2s(cx + dx * -0.55 + px * 0.5, cy + dy * -0.55 + py * 0.5, 0.02),
    ]);
    ctx.fillStyle = road; ctx.fill();
    for (const sgn of [-1, 1]) {
      const r0 = w2s(cx + dx * -0.55 + px * sgn * RAIL_GAUGE, cy + dy * -0.55 + py * sgn * RAIL_GAUGE, 0.04);
      const r1 = w2s(cx + dx * 0.55 + px * sgn * RAIL_GAUGE, cy + dy * 0.55 + py * sgn * RAIL_GAUGE, 0.04);
      strokeBetween(ctx, r0, r1, 1.4, '#6b7178');
    }
    ctx.strokeStyle = 'rgba(236,238,240,0.82)'; ctx.lineWidth = 1.4; ctx.setLineDash([]);
    for (const off of [-0.42, 0.42]) {
      const w0 = w2s(cx + dx * -0.42 + px * off, cy + dy * -0.42 + py * off, 0.05);
      const w1 = w2s(cx + dx * 0.42 + px * off, cy + dy * 0.42 + py * off, 0.05);
      ctx.beginPath(); ctx.moveTo(w0.x, w0.y); ctx.lineTo(w1.x, w1.y); ctx.stroke();
    }
  }

  // Track along a closed loop up to arc length `built`, with a work front + survey
  // line ahead of it; the rest of the ring is still being graded.
  function drawLoop(ctx, loop, built) {
    ctx.save(); ctx.lineJoin = 'round';
    let s = 0;
    for (let i = 0; i < loop.corners.length; i++) {
      const a = loop.corners[i], b = loop.corners[(i + 1) % loop.corners.length], eLen = loop.seg[i];
      if (built >= s + eLen) drawRailWorld(ctx, a, b, true);
      else if (built > s) {
        const f = (built - s) / eLen, mid = edgePoint(a, b, f);
        drawRailWorld(ctx, a, mid, true);
        const end = Math.min(1, f + 0.12);
        drawRailWorld(ctx, mid, edgePoint(a, b, end), false);
        if (end < 1) drawSurveyWorld(ctx, edgePoint(a, b, end), b);
        drawWorkFront(ctx, mid);
      } else drawSurveyWorld(ctx, a, b);
      s += eLen;
    }
    ctx.restore();
  }

  // Track along an OPEN branch polyline up to fraction paveFrac of its length.
  function drawBranch(ctx, br, paveFrac) {
    ctx.save(); ctx.lineJoin = 'round';
    const built = paveFrac * br.total;
    let s = 0;
    for (let i = 0; i < br.corners.length - 1; i++) {
      const a = br.corners[i], b = br.corners[i + 1], eLen = br.seg[i];
      if (built >= s + eLen) drawRailWorld(ctx, a, b, true);
      else if (built > s) {
        const f = (built - s) / eLen, mid = edgePoint(a, b, f);
        drawRailWorld(ctx, a, mid, true);
        const end = Math.min(1, f + 0.18);
        drawRailWorld(ctx, mid, edgePoint(a, b, end), false);
        if (end < 1) drawSurveyWorld(ctx, edgePoint(a, b, end), b);
        drawWorkFront(ctx, mid);
      } else drawSurveyWorld(ctx, a, b);
      s += eLen;
    }
    ctx.restore();
  }

  // ---- station depot (an actual little building, raised by a crew) ----------
  function railBox(ctx, tx, ty, w, d, z0, h, hue, sat, lit) {
    const zT = z0 + h;
    const nT = w2s(tx, ty, zT), eT = w2s(tx + w, ty, zT), sT = w2s(tx + w, ty + d, zT), wT = w2s(tx, ty + d, zT);
    const sB = w2s(tx + w, ty + d, z0), wB = w2s(tx, ty + d, z0), eB = w2s(tx + w, ty, z0);
    ctx.fillStyle = hsl(hue, sat, lit - 6); poly(ctx, [wT, sT, sB, wB]); ctx.fill();   // SW face
    ctx.fillStyle = hsl(hue, sat, lit - 15); poly(ctx, [sT, eT, eB, sB]); ctx.fill();  // SE face
    ctx.fillStyle = hsl(hue, sat, lit + 8); poly(ctx, [nT, eT, sT, wT]); ctx.fill();   // top
    ctx.strokeStyle = 'rgba(18,24,32,0.18)'; ctx.lineWidth = 1;
    ctx.beginPath(); ctx.moveTo(wT.x, wT.y); ctx.lineTo(sT.x, sT.y); ctx.lineTo(eT.x, eT.y); ctx.stroke();
  }

  // Axis-aligned footprint for a depot centred at (cx,cy), W along the track
  // tangent t and D inward along the normal n (both cardinal unit vectors).
  function depotAABB(cx, cy, t, n, W, D) {
    const xs = [], ys = [];
    for (const a of [-W / 2, W / 2]) for (const b of [0, D]) {
      xs.push(cx + t.x * a + n.x * b); ys.push(cy + t.y * a + n.y * b);
    }
    const tx = Math.min.apply(null, xs), ty = Math.min.apply(null, ys);
    return { tx, ty, w: Math.max.apply(null, xs) - tx, d: Math.max.apply(null, ys) - ty };
  }

  function drawCrane(ctx, aabb, Hfull, prog) {
    ctx.strokeStyle = 'rgba(120,110,90,0.75)'; ctx.lineWidth = 1;
    const corners = [[aabb.tx, aabb.ty], [aabb.tx + aabb.w, aabb.ty], [aabb.tx + aabb.w, aabb.ty + aabb.d], [aabb.tx, aabb.ty + aabb.d]];
    for (const [x, y] of corners) {
      const b = w2s(x, y, 0), tp = w2s(x, y, Hfull);
      ctx.beginPath(); ctx.moveTo(b.x, b.y); ctx.lineTo(tp.x, tp.y); ctx.stroke();
    }
    const base = w2s(aabb.tx, aabb.ty, 0), mast = w2s(aabb.tx, aabb.ty, Hfull + 16);
    ctx.strokeStyle = '#d8a23a'; ctx.lineWidth = 1.6;
    ctx.beginPath(); ctx.moveTo(base.x, base.y); ctx.lineTo(mast.x, mast.y); ctx.stroke();
    const jib = w2s(aabb.tx + aabb.w + 0.8, aabb.ty, Hfull + 16);
    ctx.beginPath(); ctx.moveTo(mast.x, mast.y); ctx.lineTo(jib.x, jib.y); ctx.stroke();
    ctx.strokeStyle = 'rgba(50,55,60,0.6)'; ctx.lineWidth = 0.6;
    const hook = w2s(aabb.tx + aabb.w * 0.6, aabb.ty, Hfull * prog + 2);
    ctx.beginPath(); ctx.moveTo((mast.x + jib.x) / 2, (mast.y + jib.y) / 2); ctx.lineTo(hook.x, hook.y); ctx.stroke();
  }

  // center: the RAIL point the train stops at; nrm: city-side normal {nx,ny};
  // prog 0..1; hue tints the headhouse; half/depth size the platform. A station =
  // a side platform that HUGS the track (so a stopped train's doors face it), a
  // yellow safety edge on the track side, a headhouse set just behind it, and a
  // posted canopy over the platform. While building, a crane stands in.
  function drawDepot(ctx, center, nrm, prog, hue, half, depth) {
    const n = { x: nrm.nx, y: nrm.ny };
    const t = { x: -n.y, y: n.x };                         // along-track tangent
    const PH = half || 2.2, PD = depth || 0.9;
    const C2 = (a, b, z) => w2s(center.tx + t.x * a + n.x * b, center.ty + t.y * a + n.y * b, z);
    const quad = (p0, p1, p2, p3, fill, stroke) => {
      poly(ctx, [p0, p1, p2, p3]);
      if (fill) { ctx.fillStyle = fill; ctx.fill(); }
      if (stroke) { ctx.strokeStyle = stroke; ctx.lineWidth = 0.8; ctx.stroke(); }
    };
    // raised platform slab running ALONG the track (track edge at b≈-0.12, just
    // over the near rail) + a yellow tactile safety strip on the track side
    quad(C2(-PH, -0.12, 0.5), C2(PH, -0.12, 0.5), C2(PH, PD, 0.5), C2(-PH, PD, 0.5), 'rgba(198,203,210,0.96)', 'rgba(40,46,54,0.3)');
    quad(C2(-PH, -0.12, 0.55), C2(PH, -0.12, 0.55), C2(PH, 0.02, 0.55), C2(-PH, 0.02, 0.55), 'rgba(216,182,72,0.9)');

    // headhouse, set just BEHIND the platform (inward); height rises with progress
    const hc = { tx: center.tx + n.x * (PD + 0.55), ty: center.ty + n.y * (PD + 0.55) };
    const aabb = depotAABB(hc.tx, hc.ty, t, n, 1.9, 1.0);
    const Hfull = 18, h = Math.max(2, Hfull * Math.min(1, prog));
    railBox(ctx, aabb.tx, aabb.ty, aabb.w, aabb.d, 0, h, hue, 14, 64);

    if (prog < 1) { drawCrane(ctx, aabb, Hfull, prog); return; }   // still under construction

    const fr = aabb.ty + aabb.d;                                   // front (south) wall line
    // overhanging roof slab
    quad(w2s(aabb.tx - 0.12, aabb.ty - 0.12, h + 0.4), w2s(aabb.tx + aabb.w + 0.12, aabb.ty - 0.12, h + 0.4),
      w2s(aabb.tx + aabb.w + 0.12, fr + 0.12, h + 0.4), w2s(aabb.tx - 0.12, fr + 0.12, h + 0.4), hsl(hue, 10, 42));
    // blue station sign band + a dark doorway on the front face
    quad(w2s(aabb.tx + 0.15, fr, h * 0.72), w2s(aabb.tx + aabb.w - 0.15, fr, h * 0.72),
      w2s(aabb.tx + aabb.w - 0.15, fr, h * 0.52), w2s(aabb.tx + 0.15, fr, h * 0.52), '#3f6f9e');
    quad(w2s(aabb.tx + aabb.w * 0.42, fr, 0), w2s(aabb.tx + aabb.w * 0.6, fr, 0),
      w2s(aabb.tx + aabb.w * 0.6, fr, h * 0.42), w2s(aabb.tx + aabb.w * 0.42, fr, h * 0.42), '#2b2f36');

    // platform canopy: a thin semi-transparent roof on posts (riders show beneath),
    // running the length of the platform over the track-side half
    const zCan = 8.5;
    ctx.strokeStyle = 'rgba(120,128,138,0.85)'; ctx.lineWidth = 1;
    for (const [a, b] of [[-PH + 0.2, 0.0], [PH - 0.2, 0.0], [-PH + 0.2, PD - 0.1], [PH - 0.2, PD - 0.1]]) {
      const p0 = C2(a, b, 0.5), p1 = C2(a, b, zCan);
      ctx.beginPath(); ctx.moveTo(p0.x, p0.y); ctx.lineTo(p1.x, p1.y); ctx.stroke();
    }
    quad(C2(-PH, -0.18, zCan), C2(PH, -0.18, zCan), C2(PH, PD, zCan), C2(-PH, PD, zCan), 'rgba(74,84,96,0.6)', 'rgba(255,255,255,0.18)');
  }

  // South-anchor depth for a whole station (platform + headhouse), so it sorts
  // against buildings like everything else. Uses the SE corner (max tx+ty) of the
  // union footprint — mirrors how drawDepot lays the platform and building out.
  function depotDepth(center, nrm, half, depth) {
    const n = { x: nrm.nx, y: nrm.ny }, t = { x: -n.y, y: n.x };
    const PH = half || 2.2, PD = depth || 0.9;
    const hc = { tx: center.tx + n.x * (PD + 0.55), ty: center.ty + n.y * (PD + 0.55) };
    const aabb = depotAABB(hc.tx, hc.ty, t, n, 1.9, 1.0);
    let mx = -Infinity, my = -Infinity;
    const acc = (x, y) => { if (x > mx) mx = x; if (y > my) my = y; };
    for (const a of [-PH, PH]) for (const b of [-0.18, PD]) acc(center.tx + t.x * a + n.x * b, center.ty + t.y * a + n.y * b);
    acc(aabb.tx + aabb.w, aabb.ty + aabb.d);
    return C.depthKey(mx, my);
  }

  // ---- train / shuttle cars -------------------------------------------------
  // A car has an undercarriage skirt, a light body with a window band + livery
  // stripe, and a vented roof; the lead car gets a cab windshield + headlights.
  // Drawn against the CAMERA-facing side/end (sign of the screen vectors) so it
  // reads correctly whichever way the train rounds the loop.
  function drawCar(ctx, p, alpha, lead, tail) {
    const base = w2s(p.tx + 0.5, p.ty + 0.5, 0);
    const fwd = w2s(p.tx + 0.5 + p.dirx, p.ty + 0.5 + p.diry, 0);
    const fx = fwd.x - base.x, fy = fwd.y - base.y, rx = -fy, ry = fx;
    const hL = CAR_LEN / 2, hW = CAR_WID / 2;
    const c = (a, t, z) => ({ x: base.x + fx * a + rx * t, y: base.y + fy * a + ry * t - z });
    const quad = (p0, p1, p2, p3, fill) => { poly(ctx, [p0, p1, p2, p3]); ctx.fillStyle = fill; ctx.fill(); };
    const tN = (fx >= 0 ? 1 : -1) * hW;        // camera-facing long side
    const aE = (fy >= 0 ? 1 : -1) * hL;        // camera-facing end
    const zF = 1.7, zS = 3.3, zH = 6.0, zT = 7.4;   // skirt top, sill, window head, roof
    ctx.save();
    ctx.globalAlpha = alpha;
    // ground shadow
    quad(c(-hL, -hW, 0), c(hL, -hW, 0), c(hL, hW, 0), c(-hL, hW, 0), 'rgba(24,30,40,0.22)');
    // near long side: dark skirt + light body
    quad(c(-hL, tN, 0), c(hL, tN, 0), c(hL, tN, zF), c(-hL, tN, zF), '#363d45');
    quad(c(-hL, tN, zF), c(hL, tN, zF), c(hL, tN, zT), c(-hL, tN, zT), lead ? '#dde3e8' : '#d2d8df');
    // camera-facing end: skirt + body
    quad(c(aE, -hW, 0), c(aE, hW, 0), c(aE, hW, zF), c(aE, -hW, zF), '#2f353d');
    quad(c(aE, -hW, zF), c(aE, hW, zF), c(aE, hW, zT), c(aE, -hW, zT), lead ? '#c8ced5' : '#bcc3cb');
    // roof + a raised vent strip
    quad(c(-hL, -hW, zT), c(hL, -hW, zT), c(hL, hW, zT), c(-hL, hW, zT), '#b3bac2');
    quad(c(-hL * 0.8, -hW * 0.5, zT + 0.7), c(hL * 0.8, -hW * 0.5, zT + 0.7), c(hL * 0.8, hW * 0.5, zT + 0.7), c(-hL * 0.8, hW * 0.5, zT + 0.7), '#c9d0d6');
    // livery stripe + window band on the near side (slightly inset)
    const ti = tN - (fx >= 0 ? 1 : -1) * 0.03;
    quad(c(-hL, ti, zS - 0.7), c(hL, ti, zS - 0.7), c(hL, ti, zS - 0.3), c(-hL, ti, zS - 0.3), '#c2402f');
    const win = (a0, a1) => quad(c(a0, ti, zS), c(a1, ti, zS), c(a1, ti, zH), c(a0, ti, zH), '#2b4150');
    if (lead) {
      win(-hL * 0.84, -hL * 0.16); win(hL * 0.12, hL * 0.62);
      if (fy > 0) {   // loco front faces the camera: windshield + headlights
        quad(c(aE - 0.03, -hW * 0.7, zS + 0.4), c(aE - 0.03, hW * 0.7, zS + 0.4), c(aE - 0.03, hW * 0.7, zH + 0.5), c(aE - 0.03, -hW * 0.7, zH + 0.5), '#1d3240');
        const h1 = c(aE, -hW * 0.55, zF + 0.5), h2 = c(aE, hW * 0.55, zF + 0.5);
        ctx.fillStyle = '#fff4c8'; ctx.beginPath(); ctx.arc(h1.x, h1.y, 0.9, 0, 7); ctx.arc(h2.x, h2.y, 0.9, 0, 7); ctx.fill();
      }
    } else {
      win(-hL * 0.82, -hL * 0.46); win(-hL * 0.32, hL * 0.02); win(hL * 0.16, hL * 0.5); win(hL * 0.64, hL * 0.88);
    }
    // rear car: red tail lamps when the back end faces the camera
    if (tail && fy < 0) {
      const t1 = c(aE, -hW * 0.55, zF + 0.4), t2 = c(aE, hW * 0.55, zF + 0.4);
      ctx.fillStyle = '#e23b2e'; ctx.beginPath();
      ctx.arc(t1.x, t1.y, 0.7, 0, 7); ctx.arc(t2.x, t2.y, 0.7, 0, 7); ctx.fill();
    }
    ctx.restore();
  }

  function onScreen(tx, ty, vt, cw, ch) {
    const ss = w2s(tx + 0.5, ty + 0.5, 0);
    const sx = ss.x * vt.zoom + vt.offX, sy = ss.y * vt.zoom + vt.offY;
    return !(sx < -CULL_MARGIN || sx > cw + CULL_MARGIN || sy < -CULL_MARGIN || sy > ch + CULL_MARGIN);
  }

  function collectDrawables(list, now, camera) {
    const rail = C.infra.rail();
    if (!rail) return;
    const vt = camera ? camera.viewTransform() : null;
    const cw = (canvas && canvas.clientWidth) || 1e5, ch = (canvas && canvas.clientHeight) || 1e5;
    const builtArc = rail.loopFrac * rail.total;

    // loop + branch track (under everything)
    list.push({ depth: TRACK_DEPTH, draw: (ctx) => drawLoop(ctx, rail, builtArc) });
    rail.branchGeo.forEach((br, i) => {
      if (rail.branches[i].paveFrac > 0) list.push({ depth: TRACK_DEPTH + 1 + i, draw: (ctx) => drawBranch(ctx, br, rail.branches[i].paveFrac) });
    });

    // grade crossings, on top of the bed where a road crosses the rail
    for (const c of crossings) {
      if (vt && !onScreen(c.tx, c.ty, vt, cw, ch)) continue;
      list.push({ depth: TRACK_DEPTH + 200, draw: (ctx) => drawCrossing(ctx, c) });
    }

    // core depots: platform appears once the loop reaches the stop; the building
    // then rises under a crane.
    rail.stations.forEach((s, i) => {
      if (!rail.complete && builtArc < s.sArc) return;
      if (vt && !onScreen(s.depot.tx, s.depot.ty, vt, cw, ch)) return;
      list.push({
        depth: depotDepth(s.depot, s.normal, s.platHalf, s.platDepth),
        draw: (ctx) => drawDepot(ctx, s.depot, s.normal, rail.depotProg[i], 210, s.platHalf, s.platDepth),
      });
    });
    // suburb depots: shown once their branch line is fully laid
    rail.branchGeo.forEach((br, i) => {
      if (rail.branches[i].paveFrac < 1) return;
      if (vt && !onScreen(br.depot.tx, br.depot.ty, vt, cw, ch)) return;
      list.push({ depth: depotDepth(br.depot, br.normal, br.platHalf, br.platDepth), draw: (ctx) => drawDepot(ctx, br.depot, br.normal, rail.branches[i].depotProg, 28, br.platHalf, br.platDepth) });
    });

    // main loop trains
    if (rail.complete) {
      for (const train of trains) {
        for (let i = 0; i < N_CARS; i++) {
          const p = C.infra.posOnLoop(rail, train.lead - i * (CAR_LEN + CAR_GAP));
          if (vt && !onScreen(p.tx, p.ty, vt, cw, ch)) continue;
          list.push({ depth: C.depthKey(p.tx, p.ty), draw: (ctx) => drawCar(ctx, p, train.alpha, i === 0, i === N_CARS - 1) });
        }
      }
    }
    // suburb shuttles
    rail.branchGeo.forEach((br, i) => {
      const sh = shuttles[i];
      if (!sh || rail.branches[i].paveFrac < 1) return;
      for (let c = 0; c < SHUTTLE_CARS; c++) {
        const p = C.infra.posOnPath(br, sh.pos - sh.dir * c * (CAR_LEN + CAR_GAP));
        if (vt && !onScreen(p.tx, p.ty, vt, cw, ch)) continue;
        const pp = sh.dir >= 0 ? p : { tx: p.tx, ty: p.ty, dirx: -p.dirx, diry: -p.diry };
        list.push({ depth: C.depthKey(p.tx, p.ty), draw: (ctx) => drawCar(ctx, pp, sh.alpha, c === 0, c === SHUTTLE_CARS - 1) });
      }
    });
  }

  function reset() { infraVer = -1; rebuild(); }

  // ---- transit API (consumed by population.js) ------------------------------
  // Riders pick a line ('core' loop, or a branch 'b<k>'), walk to a depot, board
  // when a train dwells at THEIR stop, ride, and alight. With several trains on the
  // loop, dwellingAt() tests a specific stop so two trains can serve two stations
  // at once.
  function dwellingAt(line, sid) {
    const rail = C.infra.rail();
    if (!rail) return false;
    if (line === 'core') {
      for (const train of trains) {
        if (train.atStation < 0 || rail.stations[train.atStation].sid !== sid) continue;
        if (rail.depotProg[train.atStation] >= 1) return true;
      }
      return false;
    }
    const k = parseInt(line.slice(1), 10);
    const sh = shuttles[k], br = rail.branchGeo[k];
    if (!sh || !br || sh.atEnd < 0) return false;
    if (sh.atEnd === 1) return br.sid === sid;                          // suburb end
    return rail.depotProg[br.coreIdx] >= 1 && br.coreSid === sid;       // core end
  }

  C.rail = {
    update, collectDrawables, reset,
    transit: {
      ready: function () { const r = C.infra.rail(); return !!(r && r.complete && stationPts.length >= 2); },
      stations: function () { return stationPts; },
      dwellingAt: dwellingAt,
    },
  };
})();
