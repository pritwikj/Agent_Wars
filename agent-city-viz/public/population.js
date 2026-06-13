/* ===========================================================================
   population.js — the ambient citizenry: residents and character pedestrians
   that grow with the city's housing and walk it via the shared street graph.

   This is a SEPARATE, lighter layer from citizens.js (the agent "workers"):
     - Population is derived from COMPLETED residential buildings (houses,
       townhouses, mansions, condos, apartments, plus downtown-tower penthouses)
       — occupancy ~ floors x footprint.
     - Up to a rendered cap, pedestrians spawn from those homes, pick a goal
       (downtown for suits, parks/plazas for kids & vendors, a random block
       otherwise), A*-route on C.graph, walk it, then re-route on arrival.
     - Type + appearance are seeded (hash32) and biased by the home block's
       neighborhood class, so uptown skews dog-walkers/joggers, the inner city
       skews denser foot traffic, downtown skews business + tourists + vendors.

   Pedestrians hug the curb (interior lane offset); cars (traffic.js) ride the
   road. Everything is client-side and recomputed from the streamed city — no
   server changes, no persistence.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;
  const B = C.BLOCK_TILES;
  const canvas = document.getElementById('city-canvas');

  // ---- Tunables -------------------------------------------------------------
  const VISIBLE_FRACTION = 0.05;   // fraction of abstract population shown afoot (uncapped)
  const SPAWN_PER_FRAME = 4;
  const RETIRE_PER_FRAME = 3;
  const RECALC_MS = 700;           // population / destination recompute cadence
  // Tiles to shift toward the block interior so a ped drawn at (tile + 0.5)
  // lands on the SIDEWALK band, not the road. Ring tiles sit at block-local
  // 0.5 / 7.5 (the car lane); the visible sidewalk slab spans local 0.6..1.0
  // (between the asphalt and the building line), so ~0.35 centres the walker on
  // the kerb-side footway, clear of the cars in the middle of the street.
  const PED_OFFSET = 0.35;
  const CULL_MARGIN = 48;          // px beyond viewport before we stop drawing

  const SPEED = {                  // tiles / second
    resident: 1.6, business: 2.0, tourist: 1.5, kid: 1.35, elderly: 1.1,
    jogger: 2.8, dogWalker: 1.5, cyclist: 3.4, vendor: 1.2,
  };
  const SKINS = ['#f0c9a0', '#e8b88f', '#d49a6a', '#b87a4e', '#8d5a3b'];

  // ---- State ----------------------------------------------------------------
  const peds = new Map();          // id -> ped
  let nextId = 1;
  let lastRecalc = -1e9;
  let cityPop = 0;
  let breakdown = { downtown: 0, upper: 0, middle: 0, working: 0, inner: 0 };
  let resBlocks = [];              // [{slot, w}] residential homes, weighted
  let resTotalW = 0;
  let allBlocks = [0];             // every block slot (usedBlocks + origin)
  let downtownBlocks = [];         // slots whose class is downtown
  let leisurePts = [];             // {tx,ty} centers of empty (green) parcels

  // ---- Population accounting -------------------------------------------------
  function occupancyOf(lot) {
    const b = lot.building; if (!b) return 0;
    const fp = b.footprint || [1, 1];
    const area = (fp[0] || 1) * (fp[1] || 1);
    const floors = b.floors || 1;
    const cat = C.buildingCategory(b.type);
    // res now spans house/townhouse/mansion/condo/apartment — all counted here
    if (cat === 'res') return Math.round(floors * area * 3);
    // downtown office/skyscraper towers still house some penthouse residents
    // (this is separate from the 'condo' res type, so there's no double-count)
    if (cat === 'com' && C.neighborhoodFor(lot.block).klass === 'downtown') {
      return Math.round(floors * area * 0.6);
    }
    return 0;
  }

  function recompute() {
    cityPop = 0;
    breakdown = { downtown: 0, upper: 0, middle: 0, working: 0, inner: 0 };
    const wByBlock = new Map();
    for (const d of C.districts.values()) {
      const lots = d.lots || [];
      for (const lot of lots) {
        if (!lot || lot.state !== 'complete') continue;
        const occ = occupancyOf(lot);
        if (occ <= 0) continue;
        cityPop += occ;
        const klass = C.neighborhoodFor(lot.block).klass;
        breakdown[klass] = (breakdown[klass] || 0) + occ;
        wByBlock.set(lot.block, (wByBlock.get(lot.block) || 0) + occ);
      }
      // leisure destinations: centers of not-yet-built (green/plaza) parcels
      const blocks = d.blocks || [];
      const usage = C.parcelUsage(d);
      for (let bi = 0; bi < blocks.length; bi++) {
        const taken = usage.get(blocks[bi]);
        for (let p = 0; p < C.LOTS_PER_BLOCK; p++) {
          if (leisurePts.length > 160) break;
          if (taken && taken.has(p)) continue;
          const po = C.parcelOrigin(blocks[bi], p);
          leisurePts.push({ tx: po.tx + 1, ty: po.ty + 1 });
        }
      }
    }
    resBlocks = [];
    resTotalW = 0;
    for (const [slot, w] of wByBlock) { resBlocks.push({ slot, w }); resTotalW += w; }
    allBlocks = C.usedBlocks(); if (!allBlocks.length) allBlocks = [0];
    downtownBlocks = allBlocks.filter((s) => C.neighborhoodFor(s).klass === 'downtown');
  }

  // ---- Pickers --------------------------------------------------------------
  function pickWeightedBlock() {
    if (resTotalW > 0) {
      let r = Math.random() * resTotalW;
      for (const e of resBlocks) { if (r < e.w) return e.slot; r -= e.w; }
    }
    return allBlocks[(Math.random() * allBlocks.length) | 0];
  }
  function randRingTile(slot) {
    const ring = C.ringTiles(slot);
    return ring[(Math.random() * ring.length) | 0];
  }
  function randLeisure() {
    if (!leisurePts.length) return null;
    return leisurePts[(Math.random() * leisurePts.length) | 0];
  }
  function pickType(slot) {
    const mix = (C.NEIGHBORHOODS[C.neighborhoodFor(slot).klass] || C.NEIGHBORHOODS.middle).pedMix;
    let tot = 0; for (const k in mix) tot += mix[k];
    let r = Math.random() * tot;
    for (const k in mix) { if (r < mix[k]) return k; r -= mix[k]; }
    return 'resident';
  }

  // ---- Appearance ------------------------------------------------------------
  function dress(ped) {
    const h = C.hash32(ped.id + ':look');
    ped.skin = SKINS[h % SKINS.length];
    ped.size = 1;
    ped.h = 13;
    ped.bw = 5;
    ped.legs = '#3a4450';
    ped.hat = null;
    ped.accent = 'hsl(' + (h % 360) + ',55%,52%)';
    const clothH = (h >>> 8) % 360;
    switch (ped.type) {
      case 'business':
        ped.cloth = (h & 1) ? '#2c3340' : '#34302c'; ped.h = 14; ped.legs = '#23282f'; break;
      case 'tourist':
        ped.cloth = 'hsl(' + clothH + ',70%,58%)'; ped.hat = '#e8e4d8'; break;
      case 'kid':
        ped.cloth = 'hsl(' + clothH + ',75%,60%)'; ped.size = 0.74; ped.h = 9; ped.bw = 4; break;
      case 'elderly':
        ped.cloth = 'hsl(' + clothH + ',12%,55%)'; ped.h = 12.5; break;
      case 'jogger':
        ped.cloth = 'hsl(' + clothH + ',80%,55%)'; ped.legs = '#2b2f36'; ped.hat = null; break;
      case 'dogWalker':
        ped.cloth = 'hsl(' + clothH + ',45%,52%)'; break;
      case 'cyclist':
        ped.cloth = 'hsl(' + clothH + ',72%,52%)'; ped.hat = '#d8dde2'; ped.h = 12; break;
      case 'vendor':
        ped.cloth = '#c8c2b4'; ped.accent = '#b5503e'; break;
      default:
        ped.cloth = 'hsl(' + clothH + ',42%,' + (46 + (h % 16)) + '%)';
    }
  }

  // ---- Spawn / retire --------------------------------------------------------
  function spawnPed() {
    const home = pickWeightedBlock();
    const t = randRingTile(home);
    const ped = {
      id: 'p' + (nextId++),
      type: pickType(home),
      homeBlock: home,
      tx: t.tx, ty: t.ty,
      dirx: 1, diry: 0,
      path: null, pi: 0,
      pendingLinger: 0, lingerUntil: 0,
      moving: false,
      // commuter-rail rider state (see Transit section); 'walk' = ordinary ped.
      mode: 'walk', tstate: null, line: null,
      homeSid: -1, destSid: -1, hx: 0, hy: 0, dx2: 0, dy2: 0, fgx: 0, fgy: 0,
      walkPhase: Math.random() * Math.PI * 2,
      pacePhase: Math.random() * Math.PI * 2,
      alpha: 0,
    };
    // Each person walks at their own pace (±~18%) so a crowd never moves in
    // lockstep; cyclists/joggers vary less since they hold a cadence. A slow
    // per-ped wobble (applied in step) adds natural gait variation on top.
    const spread = (ped.type === 'cyclist' || ped.type === 'jogger') ? 0.1 : 0.18;
    ped.pace = (SPEED[ped.type] || 1.6) * (1 - spread + Math.random() * spread * 2);
    ped.speed = ped.pace;
    dress(ped);
    peds.set(ped.id, ped);
  }

  function retire(n) {
    let removed = 0;
    for (const [id, p] of peds) {
      if (removed >= n) break;
      if (p.mode === 'transit') continue;   // don't yank a commuter mid-journey
      peds.delete(id); removed++;
    }
  }

  function targetCount(camera) {
    // Uncapped: the visible crowd scales with the whole city's population. The
    // zoom factor is a render level-of-detail (you can't pick out individuals
    // when zoomed way out), NOT a cap — C.pop.population() is the true count.
    const baseline = Math.min(allBlocks.length * 2, 30);
    let t = Math.round(baseline + cityPop * VISIBLE_FRACTION);
    const z = camera ? camera.zoom : 1;
    if (z < 0.5) t = Math.round(t * 0.4);
    else if (z < 0.8) t = Math.round(t * 0.7);
    return t;
  }

  // ---- Transit: commuters ride the rail network -----------------------------
  // A downtown-bound commuter walks to the depot nearest home, waits, boards when
  // a train/shuttle dwells there, rides hidden, alights at the destination depot,
  // then walks on. Suburb residents ride their branch shuttle to the core depot;
  // core residents ride the loop train between core depots. The depot a rider
  // uses must already be built — readiness is gated by C.rail.transit.stations().
  const TRANSIT_PROB = 0.5;        // chance such a commuter takes a train

  // deterministic per-ped scatter so a waiting crowd doesn't stack on one tile
  function platformSpot(tx, ty, ped) {
    const jx = ((C.hash32(ped.id + ':sx') % 100) / 100 - 0.5) * 0.9;
    const jy = ((C.hash32(ped.id + ':sy') % 100) / 100 - 0.5) * 0.9;
    return { tx: tx + jx, ty: ty + jy };
  }

  function tryTransit(ped) {
    const R = C.rail && C.rail.transit;
    if (!R || !R.ready() || !downtownBlocks.length) return false;
    const sts = R.stations();
    if (!sts || sts.length < 2) return false;
    // nearest built depot to home
    let home = null, hb = Infinity;
    for (const s of sts) { const d = Math.hypot(s.tx - ped.tx, s.ty - ped.ty); if (d < hb) { hb = d; home = s; } }
    if (!home) return false;
    const g = randRingTile(downtownBlocks[(Math.random() * downtownBlocks.length) | 0]);
    let line, dest;
    if (home.core) {                          // ride the loop to the core depot nearest downtown
      line = 'core';
      let best = null, bb = Infinity;
      for (const s of sts) { if (!s.core) continue; const d = Math.hypot(s.tx - g.tx, s.ty - g.ty); if (d < bb) { bb = d; best = s; } }
      dest = best;
      if (!dest || dest.sid === home.sid) return false;   // already at the best stop — just walk
    } else {                                  // suburb: ride the branch shuttle to its core depot
      line = home.line;
      dest = sts.find((s) => s.sid === home.coreSid);
      if (!dest) return false;                // the core terminus isn't built yet
    }
    const path = C.graph.findPath(ped.tx, ped.ty, home.tx, home.ty, false, true);
    if (!path || path.length < 2) return false;
    ped.mode = 'transit'; ped.tstate = 'toStation'; ped.line = line;
    ped.homeSid = home.sid; ped.destSid = dest.sid;
    ped.hx = home.tx; ped.hy = home.ty; ped.dx2 = dest.tx; ped.dy2 = dest.ty;
    ped.fgx = g.tx; ped.fgy = g.ty;
    ped.path = path; ped.pi = 1; ped.pendingLinger = 0;
    return true;
  }

  // Advance a rider whenever it has no active walking path. The walking legs
  // (to the platform, then from the destination platform to the goal) are driven
  // by the normal step() loop; this only handles the boarding/riding hand-offs.
  function handleTransit(ped, now) {
    const atHome = C.rail.transit.dwellingAt(ped.line, ped.homeSid);
    const atDest = C.rail.transit.dwellingAt(ped.line, ped.destSid);
    switch (ped.tstate) {
      case 'toStation': {            // reached the access node — step onto the platform
        ped.path = [{ tx: ped.tx, ty: ped.ty }, platformSpot(ped.hx, ped.hy, ped)];
        ped.pi = 1; ped.tstate = 'approach';
        break;
      }
      case 'approach':               // now standing on the platform
        ped.tstate = 'waiting'; ped.moving = false;
        break;
      case 'waiting':                // board when our train is at the platform
        ped.moving = false;
        if (atHome) ped.tstate = 'riding';
        break;
      case 'riding':                 // hidden aboard until the destination stop
        ped.moving = false;
        if (atDest) {
          const spot = platformSpot(ped.dx2, ped.dy2, ped);
          ped.tx = spot.tx; ped.ty = spot.ty; ped.alpha = 0;   // reappear, fade in
          ped.path = null; ped.tstate = 'fromStation';
        }
        break;
      case 'fromStation': {          // walk from the platform to the original goal
        if (!ped.path) {
          const path = C.graph.findPath(ped.tx, ped.ty, ped.fgx, ped.fgy, false, true);
          if (path && path.length >= 2) { ped.path = path; ped.pi = 1; break; }
        }
        ped.mode = 'walk'; ped.tstate = null;                  // arrived — rejoin foot traffic
        ped.pendingLinger = 2000 + Math.random() * 4000;
        break;
      }
      default:
        ped.mode = 'walk'; ped.tstate = null;
    }
  }

  // ---- Routing + motion ------------------------------------------------------
  function pickGoalAndPath(ped, now) {
    let gx, gy, linger = 0;
    const t = ped.type;
    if ((t === 'business' || t === 'tourist' || t === 'resident') &&
        Math.random() < TRANSIT_PROB && tryTransit(ped)) return true;
    if (t === 'vendor') {
      const pt = randLeisure();
      if (pt) { gx = pt.tx; gy = pt.ty; linger = 8000 + Math.random() * 14000; }
    } else if ((t === 'kid' || t === 'elderly') && Math.random() < 0.6) {
      const pt = randLeisure();
      if (pt) { gx = pt.tx; gy = pt.ty; linger = 2500 + Math.random() * 5000; }
    } else if ((t === 'business' || t === 'tourist') && downtownBlocks.length && Math.random() < 0.7) {
      const r = randRingTile(downtownBlocks[(Math.random() * downtownBlocks.length) | 0]);
      gx = r.tx; gy = r.ty;
    }
    if (gx == null) { const r = randRingTile(allBlocks[(Math.random() * allBlocks.length) | 0]); gx = r.tx; gy = r.ty; }
    const path = C.graph.findPath(ped.tx, ped.ty, gx, gy, false, true); // avoid highways
    if (!path || path.length < 2) return false;   // budget spent or already there
    ped.path = path; ped.pi = 1; ped.pendingLinger = linger;
    return true;
  }

  // True at a block-corner ring tile (where two streets meet) — the natural
  // place a pedestrian pauses to wait for a gap before crossing.
  function isCornerTile(tx, ty) {
    const lx = ((tx % B) + B) % B, ly = ((ty % B) + B) % B;
    return (lx < 1 || lx > B - 2) && (ly < 1 || ly > B - 2);
  }

  function step(ped, dt, now) {
    ped.pacePhase += dt * 1.7;
    // gentle gait wobble around the personal pace (never below 70%)
    const spd = ped.speed * (0.88 + 0.12 * Math.sin(ped.pacePhase)) * dt;
    const wp = ped.path[ped.pi];
    const dx = wp.tx - ped.tx, dy = wp.ty - ped.ty;
    const dist = Math.hypot(dx, dy);
    if (dist <= spd || dist < 1e-4) {
      ped.tx = wp.tx; ped.ty = wp.ty; ped.pi++;
      if (ped.pi >= ped.path.length) { ped.path = null; ped.moving = false; return; }
      // sometimes wait at a corner to "cross" — pedestrians don't flow through
      // junctions uninterrupted; joggers/cyclists/vendors keep their momentum.
      if (now && ped.type !== 'jogger' && ped.type !== 'cyclist' && ped.type !== 'vendor' &&
          isCornerTile(wp.tx, wp.ty) && Math.random() < 0.16) {
        ped.lingerUntil = now + 500 + Math.random() * 1400;
        ped.moving = false;
      }
    } else {
      ped.tx += (dx / dist) * spd; ped.ty += (dy / dist) * spd;
      // smooth facing so turns sweep rather than snap (reads on the dog leash,
      // briefcase side, and gait direction)
      const k = Math.min(1, dt * 8);
      ped.dirx += (dx / dist - ped.dirx) * k; ped.diry += (dy / dist - ped.diry) * k;
      const m = Math.hypot(ped.dirx, ped.diry) || 1; ped.dirx /= m; ped.diry /= m;
      ped.walkPhase += dt * 9; ped.moving = true;
    }
  }

  function update(dt, now, camera) {
    if (!C.graph) return;
    C.graph.ensureBuilt();
    if (now - lastRecalc > RECALC_MS) { leisurePts = []; recompute(); lastRecalc = now; }

    const target = targetCount(camera);
    for (let i = 0; i < SPAWN_PER_FRAME && peds.size < target; i++) spawnPed();
    if (peds.size > target) retire(Math.min(RETIRE_PER_FRAME, peds.size - target));

    for (const ped of peds.values()) {
      if (ped.alpha < 1) ped.alpha = Math.min(1, ped.alpha + dt * 2.2);
      if (ped.lingerUntil > now) { ped.moving = false; ped.walkPhase += dt * 0.6; continue; }
      if (ped.path && ped.pi < ped.path.length) { step(ped, dt, now); continue; }
      if (ped.mode === 'transit') { handleTransit(ped, now); continue; }
      if (ped.pendingLinger) { ped.lingerUntil = now + ped.pendingLinger; ped.pendingLinger = 0; ped.moving = false; continue; }
      pickGoalAndPath(ped, now); // no-op until a search slot frees up
      ped.moving = false;
    }
  }

  // ---- Drawing ---------------------------------------------------------------
  function roundRect(ctx, x, y, w, h, r) {
    ctx.beginPath();
    ctx.moveTo(x + r, y);
    ctx.arcTo(x + w, y, x + w, y + h, r);
    ctx.arcTo(x + w, y + h, x, y + h, r);
    ctx.arcTo(x, y + h, x, y, r);
    ctx.arcTo(x, y, x + w, y, r);
    ctx.closePath();
  }

  // Lane offset toward the block interior (curb / sidewalk side), direction-
  // independent so pedestrians stay on the inner edge whichever way they walk.
  function interiorOffset(ped) {
    const lx = ((ped.tx % B) + B) % B, ly = ((ped.ty % B) + B) % B;
    let ix = 0, iy = 0;
    if (ly < 1) iy = 1; else if (ly > B - 2) iy = -1;
    if (lx < 1) ix = 1; else if (lx > B - 2) ix = -1;
    if (ix && iy) return { x: ix * PED_OFFSET * 0.7071, y: iy * PED_OFFSET * 0.7071 };
    return { x: ix * PED_OFFSET, y: iy * PED_OFFSET };
  }

  function drawPed(ctx, ped, now) {
    const off = interiorOffset(ped);
    const p = C.worldToScreen(ped.tx + 0.5 + off.x, ped.ty + 0.5 + off.y, 0);
    const sz = ped.size, H = ped.h, bw = ped.bw;
    const moving = ped.moving;
    ctx.save();
    ctx.globalAlpha = ped.alpha;

    // ground shadow
    ctx.fillStyle = 'rgba(30,40,50,0.22)';
    ctx.beginPath(); ctx.ellipse(p.x, p.y, 4 * sz, 1.9 * sz, 0, 0, Math.PI * 2); ctx.fill();

    const bob = moving ? Math.abs(Math.sin(ped.walkPhase)) * sz : 0;
    const baseY = p.y - bob;

    // cyclist rides a little 2-wheeler
    if (ped.type === 'cyclist') {
      ctx.strokeStyle = '#2c3138'; ctx.lineWidth = 1;
      for (const wx of [-2.4, 2.4]) {
        ctx.beginPath(); ctx.arc(p.x + wx * sz, baseY - 1.4, 1.7 * sz, 0, Math.PI * 2); ctx.stroke();
      }
      ctx.fillStyle = ped.accent;
      ctx.fillRect(p.x - 2.4 * sz, baseY - 3, 4.8 * sz, 1.1);
    }

    // legs (alternating while walking; cyclists keep feet on pedals)
    ctx.fillStyle = ped.legs;
    if (moving && ped.type !== 'cyclist') {
      const sw = Math.sin(ped.walkPhase) * 1.7 * sz;
      ctx.fillRect(p.x - 1.9 * sz + sw, baseY - 5 * sz, 1.5 * sz, 5 * sz);
      ctx.fillRect(p.x + 0.4 * sz - sw, baseY - 5 * sz, 1.5 * sz, 5 * sz);
    } else if (ped.type !== 'cyclist') {
      ctx.fillRect(p.x - 1.9 * sz, baseY - 5 * sz, 1.5 * sz, 5 * sz);
      ctx.fillRect(p.x + 0.4 * sz, baseY - 5 * sz, 1.5 * sz, 5 * sz);
    }

    // dog on a leash, trotting ahead of a dog-walker
    if (ped.type === 'dogWalker') {
      const dax = p.x + (ped.dirx >= 0 ? 6 : -6) * sz;
      ctx.strokeStyle = 'rgba(60,60,60,0.6)'; ctx.lineWidth = 0.6;
      ctx.beginPath(); ctx.moveTo(p.x, baseY - 4); ctx.lineTo(dax, baseY - 1.5); ctx.stroke();
      ctx.fillStyle = '#6f5235';
      ctx.beginPath(); ctx.ellipse(dax, baseY - 1.2, 2.2 * sz, 1.3 * sz, 0, 0, Math.PI * 2); ctx.fill();
      ctx.fillRect(dax + (ped.dirx >= 0 ? 1.4 : -2.2) * sz, baseY - 3, 1.2 * sz, 1.6 * sz); // head
    }

    // vendor cart beside the stall-keeper
    if (ped.type === 'vendor') {
      ctx.fillStyle = '#9a6b3f';
      ctx.fillRect(p.x + 3 * sz, baseY - 6, 5, 4.5);
      ctx.fillStyle = ped.accent;
      ctx.fillRect(p.x + 3 * sz, baseY - 8.2, 5, 2.2);
    }

    // body
    ctx.fillStyle = ped.cloth;
    roundRect(ctx, p.x - bw / 2, baseY - H + 3, bw, H - 7, 1.6); ctx.fill();
    if (ped.type === 'jogger') { // racing stripe
      ctx.fillStyle = 'rgba(255,255,255,0.6)';
      ctx.fillRect(p.x - bw / 2 + 0.6, baseY - H + 5, bw - 1.2, 0.9);
    }

    // briefcase / camera accessories
    if (ped.type === 'business') {
      ctx.fillStyle = '#5a4632';
      ctx.fillRect(p.x - bw / 2 - 2.4, baseY - 6.5, 2.2, 3);
    } else if (ped.type === 'tourist') {
      ctx.fillStyle = '#222'; ctx.fillRect(p.x - 1.4, baseY - H + 2.5, 2.8, 1.6);
    } else if (ped.type === 'elderly') {
      ctx.strokeStyle = '#7a6a52'; ctx.lineWidth = 0.8;
      ctx.beginPath(); ctx.moveTo(p.x + bw / 2 + 0.6, baseY - 6); ctx.lineTo(p.x + bw / 2 + 1.2, baseY); ctx.stroke();
    }

    // head + optional hat/cap
    const headY = baseY - H + 1;
    ctx.fillStyle = ped.skin;
    ctx.beginPath(); ctx.arc(p.x, headY, 2.1 * sz, 0, Math.PI * 2); ctx.fill();
    if (ped.hat) {
      ctx.fillStyle = ped.hat;
      ctx.beginPath(); ctx.arc(p.x, headY - 0.5, 2.3 * sz, Math.PI, 0); ctx.fill();
    }
    ctx.restore();
  }

  function collectDrawables(list, now, camera) {
    if (peds.size === 0) return;
    const vt = camera ? camera.viewTransform() : null;
    const cw = (canvas && canvas.clientWidth) || 1e5;
    const ch = (canvas && canvas.clientHeight) || 1e5;
    for (const ped of peds.values()) {
      if (ped.tstate === 'riding') continue;   // aboard the train — not on the street
      if (vt) {
        const s = C.worldToScreen(ped.tx + 0.5, ped.ty + 0.5, 0);
        const sx = s.x * vt.zoom + vt.offX, sy = s.y * vt.zoom + vt.offY;
        if (sx < -CULL_MARGIN || sx > cw + CULL_MARGIN || sy < -CULL_MARGIN || sy > ch + CULL_MARGIN) continue;
      }
      list.push({ depth: C.depthKey(ped.tx, ped.ty), draw: (ctx) => drawPed(ctx, ped, now) });
    }
  }

  function reset() {
    peds.clear();
    lastRecalc = -1e9;
    cityPop = 0;
  }

  C.pop = {
    update,
    collectDrawables,
    reset,
    population: function () { return cityPop; },
    breakdown: function () { return breakdown; },
    count: function () { return peds.size; },
  };
})();
