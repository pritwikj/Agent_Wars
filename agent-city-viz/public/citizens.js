/* ===========================================================================
   citizens.js — live agents as construction workers.

   Sessions = workers (hard hat + district-hue vest), orchestrator sessions =
   foreman (white hat + clipboard), subagents = crew members beside their
   parent. Workers live ONLY on a block's perimeter ring (28 ordered road
   tiles) — never inside parcels — so depth sorting stays correct.

   State machine: arriving -> idle (home post) -> walking -> working (at the
   post nearest the active construction lot, playing the tool family's
   animation + effects) -> idle ... -> leaving (fade out).

   The server sends INTENT (status / currentToolFamily); this file owns all
   motion. Rapid PreToolUse/PostToolUse flips are debounced (350ms) and a
   worker stays pinned at the site at least 700ms — the proven pattern from
   the old Death Star renderer, ported as-is.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;

  const STATE_DEBOUNCE_MS = 350;
  const WORK_MIN_MS = 700;
  const WALK_SPEED = 2.6;     // ring tiles per second
  const FX_INTERVAL_MS = 650; // work-effect cadence

  const citizens = new Map(); // id -> citizen
  let agg = { activeCount: 0, throughput: 0, errorRate: 0, city: null };

  // ---- Home post claiming (per block ring) ----------------------------------
  const ringClaims = new Map(); // blockSlot -> Set(ringIndex)
  function claimHome(blockSlot, seed) {
    let claims = ringClaims.get(blockSlot);
    if (!claims) { claims = new Set(); ringClaims.set(blockSlot, claims); }
    const ringLen = C.ringTiles(blockSlot).length;
    const start = seed % ringLen;
    for (let i = 0; i < ringLen; i++) {
      const pos = (start + i * 2) % ringLen; // spread by 2 so workers don't bunch
      if (!claims.has(pos)) { claims.add(pos); return pos; }
    }
    return start; // ring saturated -> share
  }
  function freeHome(blockSlot, pos) {
    const claims = ringClaims.get(blockSlot);
    if (claims) claims.delete(pos);
  }

  // ---- Server state -> logical state -----------------------------------------
  function deriveState(entity) {
    const st = entity.status;
    if (st === 'finished') return 'leaving';
    if (st === 'spawning') return 'arriving';
    if (st === 'working') return 'working';
    // Mid-turn reasoning between tool calls: keep the crew building on-site.
    if (st === 'thinking') return 'working';
    return 'idle';
  }

  function cleanTitle(text) {
    if (typeof text !== 'string') return '';
    return text.replace(/\s+/g, ' ').trim();
  }
  function isUuidLike(text) {
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(String(text || '').trim());
  }
  const LOADING_LABELS = [
    'Reviewing the blueprints…', 'Unloading materials…', 'Pouring the slab…',
    'Reading the site plan…', 'Clocking in…', 'Grabbing a hard hat…',
  ];
  function titleFor(cz) {
    const t = cleanTitle(cz.title);
    if (t && !isUuidLike(t)) return t;
    return LOADING_LABELS[C.hash32(cz.id) % LOADING_LABELS.length];
  }

  // ---- Placement helpers ---------------------------------------------------------
  /**
   * The city lot this worker builds: its session's bound building. Crew members
   * (subagents) build alongside their parent session, so they use the parent's
   * lot. Falls back to the district's newest lot, then the origin block.
   */
  function buildingLotFor(cz) {
    let lotId = cz.buildingLotId;
    if (cz.kind === 'subagent' && cz.parentSessionId) {
      const p = citizens.get(cz.parentSessionId);
      if (p && p.buildingLotId) lotId = p.buildingLotId;
    }
    const lot = lotId ? C.lotById(lotId) : null;
    if (lot) return lot;
    // Fallback until the building binding arrives: the district's newest lot.
    const d = C.districtByKey(cz.districtKey);
    if (d) return C.activeLot(d) || (d.lots && d.lots[d.lots.length - 1]) || null;
    return null;
  }

  function homeBlockFor(cz) {
    const lot = buildingLotFor(cz);
    if (lot) return lot.block;
    const d = C.districtByKey(cz.districtKey);
    if (d && d.blocks && d.blocks.length) return d.blocks[d.blocks.length - 1];
    return 0; // district not built yet -> hang out on the origin block
  }

  function workRingPos(cz) {
    const lot = buildingLotFor(cz);
    if (!lot || lot.block !== cz.blockSlot) return cz.homePos;
    const pl = C.lotPlacement(lot);
    return C.ringIndexNearest(cz.blockSlot, pl.tx + pl.w / 2, pl.ty + pl.d / 2);
  }

  function rehome(cz) {
    const block = homeBlockFor(cz);
    if (block === cz.blockSlot && cz.homePos != null) return;
    if (cz.homePos != null) freeHome(cz.blockSlot, cz.homePos);
    // keep continuity: enter the new ring at the index nearest our current tile
    const cur = tileOf(cz);
    cz.blockSlot = block;
    cz.homePos = claimHome(block, C.hash32(cz.id));
    cz.ringPos = cur ? C.ringIndexNearest(block, cur.tx, cur.ty) : cz.homePos;
    cz.targetPos = cz.homePos;
  }

  /** Current continuous tile position from ringPos. */
  function tileOf(cz) {
    if (cz.blockSlot == null || cz.ringPos == null) return null;
    const ring = C.ringTiles(cz.blockSlot);
    const len = ring.length;
    const pos = ((cz.ringPos % len) + len) % len;
    const i = Math.floor(pos);
    const f = pos - i;
    const a = ring[i % len], b = ring[(i + 1) % len];
    return { tx: C.lerp(a.tx, b.tx, f) + 0.5, ty: C.lerp(a.ty, b.ty, f) + 0.5 };
  }

  // ---- Spawn / update / remove ------------------------------------------------------
  function spawnCitizen(entity, animateWalkOn) {
    if (citizens.has(entity.id)) { updateCitizen(entity); return; }
    const isSub = entity.kind === 'subagent';
    const cz = {
      id: entity.id,
      kind: entity.kind || 'session',
      agentType: entity.agentType || null,
      parentSessionId: entity.parentSessionId || null,
      isOrchestrator: !!entity.isOrchestrator,
      districtKey: C.projectKey(entity.project),
      districtName: C.projectName(entity.project),
      status: entity.status || 'idle',
      currentToolFamily: entity.currentToolFamily || null,
      currentAction: entity.currentAction || null,
      // the city building this session is bound to (set once it does work)
      buildingLotId: entity.buildingLotId || null,
      buildingDistrictKey: entity.buildingDistrictKey || null,
      dimmed: !!entity.dimmed,
      title: cleanTitle(entity.title || ''),
      // motion
      blockSlot: null, homePos: null, ringPos: null, targetPos: null,
      motionState: 'idle',
      stateChangedAt: 0,
      workingSince: 0,
      walkPhase: Math.random() * Math.PI * 2,
      alpha: animateWalkOn ? 0 : 1,
      leaving: false,
      nextFxAt: 0,
      errorFlashUntil: 0,
    };
    // crew members inherit their parent's district
    if (isSub && entity.parentSessionId) {
      const parent = citizens.get(entity.parentSessionId);
      if (parent) {
        cz.districtKey = parent.districtKey;
        cz.districtName = parent.districtName;
      }
    }
    cz.blockSlot = homeBlockFor(cz);
    cz.homePos = claimHome(cz.blockSlot, C.hash32(cz.id));
    const ringLen = C.ringTiles(cz.blockSlot).length;
    cz.ringPos = animateWalkOn ? (cz.homePos + ringLen / 2) % ringLen : cz.homePos;
    cz.targetPos = cz.homePos;
    cz.motionState = animateWalkOn ? 'arriving' : 'idle';
    citizens.set(entity.id, cz);
    updateCitizen(entity);
  }

  function updateCitizen(entity) {
    const cz = citizens.get(entity.id);
    if (!cz) { spawnCitizen(entity, true); return; }
    if ('status' in entity && entity.status) cz.status = entity.status;
    if ('currentToolFamily' in entity) cz.currentToolFamily = entity.currentToolFamily;
    if ('currentAction' in entity) cz.currentAction = entity.currentAction;
    if ('buildingLotId' in entity) cz.buildingLotId = entity.buildingLotId || null;
    if ('buildingDistrictKey' in entity) cz.buildingDistrictKey = entity.buildingDistrictKey || null;
    if ('dimmed' in entity) cz.dimmed = !!entity.dimmed;
    if (entity.isOrchestrator) cz.isOrchestrator = true; // sticky foreman promotion
    if (typeof entity.title === 'string' && cleanTitle(entity.title)) cz.title = cleanTitle(entity.title);
    if (entity.project) {
      cz.districtKey = C.projectKey(entity.project);
      cz.districtName = C.projectName(entity.project);
    }
    if (entity.signal === 'error') cz.errorFlashUntil = performance.now() + 1200;

    const desired = deriveState(entity);
    if (desired !== cz.desiredState) {
      cz.desiredState = desired;
      cz.desiredSince = performance.now();
    }
  }

  function removeCitizen(id) {
    const cz = citizens.get(id);
    if (!cz) return;
    cz.leaving = true; // fades out in the update loop, then destroyed
  }

  function destroyCitizen(cz) {
    if (cz.homePos != null) freeHome(cz.blockSlot, cz.homePos);
    citizens.delete(cz.id);
  }

  function applySnapshot(entities) {
    for (const cz of citizens.values()) {
      if (cz.homePos != null) freeHome(cz.blockSlot, cz.homePos);
    }
    citizens.clear();
    ringClaims.clear();
    for (const e of entities || []) spawnCitizen(e, false);
  }

  function setAggregates(a) { agg = a || agg; }

  // ---- Per-frame update -----------------------------------------------------------
  function updateAll(dt, now) {
    for (const cz of [...citizens.values()]) {
      // leaving: fade and remove
      if (cz.leaving) {
        cz.alpha -= dt * 1.4;
        if (cz.alpha <= 0) destroyCitizen(cz);
        continue;
      }
      if (cz.alpha < 1) cz.alpha = Math.min(1, cz.alpha + dt * 2);

      rehome(cz); // adopt new block if the district grew / appeared

      // Debounced adoption of the desired state (the 350ms anti-ping-pong).
      const desired = cz.desiredState || 'idle';
      if (desired !== cz.motionState) {
        const stable = now - (cz.desiredSince || 0) >= STATE_DEBOUNCE_MS;
        const minWork = cz.motionState !== 'working' || now - cz.workingSince >= WORK_MIN_MS;
        if ((stable && minWork) || desired === 'leaving') {
          cz.motionState = desired;
          if (desired === 'working') cz.workingSince = now;
          if (desired === 'leaving') cz.leaving = true;
        }
      }

      // choose target ring position
      cz.targetPos = cz.motionState === 'working' ? workRingPos(cz) : cz.homePos;
      // crew members shadow their parent's work post, offset to the side
      if (cz.kind === 'subagent' && cz.parentSessionId) {
        const p = citizens.get(cz.parentSessionId);
        if (p && p.blockSlot === cz.blockSlot) {
          const off = 1 + (C.hash32(cz.id) % 3);
          cz.targetPos = (p.targetPos + off) % C.ringTiles(cz.blockSlot).length;
        }
      }

      // move along the ring (shortest direction, wraparound)
      const len = C.ringTiles(cz.blockSlot).length;
      let delta = ((cz.targetPos - cz.ringPos) % len + len) % len;
      if (delta > len / 2) delta -= len;
      const step = WALK_SPEED * dt * (cz.dimmed ? 0.4 : 1);
      if (Math.abs(delta) <= step) {
        cz.ringPos = cz.targetPos;
        cz.moving = false;
      } else {
        cz.ringPos = (cz.ringPos + Math.sign(delta) * step + len) % len;
        cz.moving = true;
        cz.walkPhase += dt * 11;
      }

      // work effects at the construction site. The city reflects the VOLUME of
      // work, not its kind: it must not matter whether the agent is reading or
      // editing — construction looks identical either way. The dust/sparks mix
      // is keyed off the BUILDING (its seed), never the agent's tool family.
      if (cz.motionState === 'working' && !cz.moving && now >= cz.nextFxAt) {
        cz.nextFxAt = now + FX_INTERVAL_MS + Math.random() * 300;
        const active = buildingLotFor(cz);
        if (active && active.state === 'construction' && active.block === cz.blockSlot) {
          const pl = C.lotPlacement(active);
          const seed = (active.building && active.building.seed) || 0;
          if (seed & 1) {
            const stage = C.stageOf(active);
            const zTop = (stage.built || 0) * C.FLOOR_H;
            C.fx.spawnSparks(pl.tx + pl.w / 2, pl.ty + pl.d / 2, zTop);
          } else {
            C.fx.spawnDust(pl.tx + pl.w / 2, pl.ty + pl.d / 2);
          }
        }
      }
    }
  }

  // ---- Drawing ---------------------------------------------------------------------
  function vestColor(cz) {
    if (cz.isOrchestrator) return '#f5f7fa';
    if (cz.kind === 'subagent') {
      const h = C.hash32(cz.agentType || cz.id) % 360;
      return 'hsl(' + h + ',60%,55%)';
    }
    const d = C.districtByKey(cz.districtKey);
    const hue = d ? d.hue : C.hueFor(cz.districtKey);
    return C.districtColor(hue, 65, 52);
  }

  function drawCitizen(ctx, cz, now) {
    const t = tileOf(cz);
    if (!t) return;
    const p = C.worldToScreen(t.tx, t.ty, 0);
    const H = 17; // worker height in world px
    ctx.save();
    ctx.globalAlpha = cz.alpha * (cz.dimmed ? 0.55 : 1);

    // shadow
    ctx.fillStyle = 'rgba(30,40,50,0.25)';
    ctx.beginPath();
    ctx.ellipse(p.x, p.y, 5.5, 2.6, 0, 0, Math.PI * 2);
    ctx.fill();

    const err = now < cz.errorFlashUntil;
    const sitting = cz.dimmed && !cz.moving;
    const bodyH = sitting ? H * 0.7 : H;
    const bob = cz.moving ? Math.abs(Math.sin(cz.walkPhase)) * 1.2 : 0;
    const baseY = p.y - bob;

    // legs (dark trousers, alternate while walking)
    ctx.fillStyle = '#3a4450';
    if (cz.moving) {
      const sw = Math.sin(cz.walkPhase) * 2.2;
      ctx.fillRect(p.x - 2.6 + sw, baseY - 6, 2.1, 6);
      ctx.fillRect(p.x + 0.6 - sw, baseY - 6, 2.1, 6);
    } else {
      ctx.fillRect(p.x - 2.6, baseY - 6, 2.1, 6);
      ctx.fillRect(p.x + 0.6, baseY - 6, 2.1, 6);
    }

    // body / hi-vis vest
    ctx.fillStyle = err ? '#e05252' : vestColor(cz);
    const bw = cz.isOrchestrator ? 7.5 : 6.5;
    roundRect(ctx, p.x - bw / 2, baseY - bodyH + 4, bw, bodyH - 9, 2);
    ctx.fill();
    // vest stripe
    ctx.fillStyle = 'rgba(255,255,255,0.55)';
    ctx.fillRect(p.x - bw / 2 + 1, baseY - bodyH + 7, bw - 2, 1.2);

    // working pose: raised tool arm. One construction tool colour for everyone —
    // the crew is just building; it must not read as "reading" vs "editing".
    if (cz.motionState === 'working' && !cz.moving) {
      const swing = Math.sin(now / 120) * 2;
      ctx.strokeStyle = err ? '#e05252' : C.PAL.crane;
      ctx.lineWidth = 1.8;
      ctx.beginPath();
      ctx.moveTo(p.x + bw / 2 - 1, baseY - bodyH + 8);
      ctx.lineTo(p.x + bw / 2 + 3, baseY - bodyH + 4 + swing);
      ctx.stroke();
    }
    // foreman clipboard
    if (cz.isOrchestrator) {
      ctx.fillStyle = '#caa468';
      ctx.fillRect(p.x - bw / 2 - 3, baseY - bodyH + 8, 3, 4);
    }

    // head + hard hat
    const headY = baseY - bodyH + 1;
    ctx.fillStyle = '#e8b88f';
    ctx.beginPath();
    ctx.arc(p.x, headY, 2.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = cz.isOrchestrator ? '#f2f2f0' : '#ffb400';
    ctx.beginPath();
    ctx.arc(p.x, headY - 0.8, 2.8, Math.PI, 0);
    ctx.fill();
    ctx.fillRect(p.x - 3.4, headY - 1.2, 6.8, 1.1);

    ctx.restore();
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

  /** Push citizens into the frame's depth-sorted draw list. */
  function collectDrawables(list, now) {
    for (const cz of citizens.values()) {
      const t = tileOf(cz);
      if (!t) continue;
      list.push({
        depth: C.depthKey(t.tx, t.ty),
        draw: (ctx) => drawCitizen(ctx, cz, now),
      });
    }
  }

  /** Screen-space anchor (pre-camera world px) for DOM bubbles/labels. */
  function anchorOf(id) {
    const cz = citizens.get(id);
    if (!cz) return null;
    const t = tileOf(cz);
    if (!t) return null;
    const p = C.worldToScreen(t.tx, t.ty, 0);
    return { x: p.x, y: p.y - 20, citizen: cz };
  }

  /**
   * Lot ids that have a LIVE crew on them right now — i.e. a Claude Code
   * session (or one of its subagents) is currently bound to and working that
   * building. Construction sites NOT in this set are left as empty work zones
   * (props but no workers) per the design rule: only staff a site when a
   * session is actually building it.
   */
  function activeBuildLots() {
    const ids = new Set();
    for (const cz of citizens.values()) {
      if (cz.leaving) continue;
      const lot = buildingLotFor(cz);
      if (lot) ids.add(lot.id);
    }
    return ids;
  }

  function counts() {
    let sessions = 0, crews = 0;
    for (const cz of citizens.values()) {
      if (cz.leaving) continue;
      if (cz.kind === 'subagent') crews++;
      else sessions++;
    }
    return {
      sessions, crews,
      throughput: agg.throughput || 0,
      errorRate: agg.errorRate || 0,
      city: agg.city || null,
    };
  }

  Object.assign(window.CITY, {
    citizens,
    spawnCitizen, updateCitizen, removeCitizen, applyCitizenSnapshot: applySnapshot,
    setAggregates, updateCitizens: updateAll, collectCitizenDrawables: collectDrawables,
    citizenAnchor: anchorOf, citizenCounts: counts, citizenTitle: titleFor,
    activeBuildLots,
  });
})();
