/* ===========================================================================
   demo.js — self-contained mock server (?demo=1 or WS unreachable).
   Emits real snapshot/spawn/delta/despawn/aggregates AND city/cityDelta
   messages on timers so every stage, worker animation, foreman promotion,
   incident and topping-out beat is exercised without a server. Never touches
   the real save file.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;

  // Mirrors server tuning (server/city.js) — demo-local on purpose. Building
  // types come from the shared catalog in config.js (C.pickType etc.); the
  // server swaps a rolled park/landfill for a growable type, so the demo does
  // the same so its lots always have something to grow into.
  function requiredFor(n) { return Math.min(400, 30 + 15 * n); }
  // Building types by neighborhood (mirror of server/city.js spatial growth) so
  // the offline demo previews the same metro: a tall downtown core, a dense
  // inner ring, and low-rise suburbs further out.
  const HOOD_W = {
    downtown: { skyscraper: 8, office: 5, apartment: 2, store: 2, restaurant: 1, transit: 1, hospital: 1 }, // CBD: skyscraper-led high-rise
    inner:    { apartment: 5, office: 2, house: 2, shop: 2, restaurant: 1, store: 1, transit: 1, police: 1, prison: 1, fire_station: 1, factory: 1 },
    upper:    { house: 8, apartment: 2, park: 2, shop: 1, restaurant: 1, school: 1, hospital: 1, fire_station: 1 },
    middle:   { house: 7, apartment: 2, shop: 2, restaurant: 1, store: 1, school: 2, park: 1, police: 1, fire_station: 1, hospital: 1 },
    working:  { house: 7, apartment: 2, shop: 1, store: 1, transit: 1, park: 1, police: 1, fire_station: 1, prison: 1, factory: 2 },
    rural:    { house: 5, farm: 6, park: 1, shop: 1, school: 1 }, // homesteads scattered among fields
  };
  function demoTypeForBlock(seed, block) {
    const w = HOOD_W[C.neighborhoodFor(block).klass] || HOOD_W.middle;
    const es = Object.entries(w);
    let tot = 0; for (const [, x] of es) tot += x;
    let r = seed % tot;
    for (const [t, x] of es) { if (r < x) return t; r -= x; }
    return es[0][0];
  }

  function makeMockServer(onMessage) {
    let seq = 1;
    const live = new Map();
    let timers = [];
    let stopped = false;
    let idc = 0;
    const rnd = (n) => Math.floor(Math.random() * n);
    const pick = (a) => a[rnd(a.length)];
    const clone = (o) => JSON.parse(JSON.stringify(o));

    const PROJECTS = [
      { name: 'agent-city', key: '/Users/dev/agent-city' },
      { name: 'dawgz-app', key: '/Users/dev/Dawgz/DawgzApp' },
      { name: 'api-gateway', key: '/srv/api-gateway' },
    ];
    const AGENT_TYPES = ['general-purpose', 'Explore', 'Plan', 'reviewer', null];
    const FAMILIES = ['exec', 'read', 'edit', 'scan', 'delegate', 'generic'];
    const ACTIONS = {
      exec: ['Running npm test', 'Running git status', 'Running make build'],
      read: ['Reading citymodel.js', 'Reading render.js', 'Reading README.md'],
      edit: ['Editing buildings.js', 'Editing main.py', 'Editing index.html'],
      scan: ['Searching "iso math"', 'Fetching example.com'],
      delegate: ['Delegating → Explore', 'Delegating → reviewer'],
      generic: ['Working · TodoWrite', 'Working · status check'],
    };
    const actionFor = (fam) => pick(ACTIONS[fam] || ['Working']);

    function emit(msg) {
      if (stopped) return;
      msg.seq = seq++;
      onMessage(msg);
    }

    // ---- Mock city -----------------------------------------------------------
    // Districts at varied life stages, incl. a t5 [2,2] tower mid-rise (the
    // depth-sorting stress case) and a fresh groundbreak.
    const districts = [];
    const usedSlots = new Set();   // every block slot claimed across the mock city
    function newLot(d, n, progressRatio, complete) {
      // Real entropy (mirrors the server) so the offline demo builds a different
      // city on every load rather than replaying one fixed sequence.
      const seed = (Math.random() * 0x100000000) >>> 0;
      const siteSeed = (Math.random() * 0x100000000) >>> 0;
      const { blockSlot: block, parcel } = C.chooseSite(d, siteSeed, (s) => !usedSlots.has(s));
      usedSlots.add(block);
      const type = demoTypeForBlock(seed, block);
      const floors = C.floorsForType(type, seed >>> 8);
      const required = requiredFor(n);
      return {
        id: 'd' + d.index + ':' + n,
        index: n,
        block,
        parcel,
        state: complete ? 'complete' : 'construction',
        progress: complete ? required : Math.floor(required * progressRatio),
        required,
        building: { seed, type, tier: C.tierForFloors(floors), floors, footprint: C.footprintForType(type, seed >>> 5) },
        startedAt: 0, completedAt: complete ? 1 : null, incidents: 0,
      };
    }
    function makeCity(lotPlan) {
      usedSlots.add(0);
      const d = {
        key: 'city', name: 'city',
        index: 0,
        blocks: [0],
        hue: 210, // client no longer tints by district hue
        totalWork: 0, totalIncidents: 0, completedCount: 0,
        lots: [],
      };
      lotPlan(d);
      d.completedCount = d.lots.filter((l) => l.state === 'complete').length;
      districts.push(d);
      return d;
    }
    // A sizable metro so the demo previews real neighborhood variety. Buildings
    // are sited by chooseSite(), which spreads them across many partially-built
    // blocks — a dense downtown core thinning out to leafy low-density suburbs —
    // rather than packing one block before the next. Plus a tower rising and a
    // fresh groundbreak.
    makeCity((d) => {
      // a metro large enough to sprawl from a downtown core, through suburban
      // subdivisions, out to the first rural ring (farmland + homesteads) — sized
      // so the dense city still frames well rather than drowning in countryside
      for (let n = 0; n < 210; n++) d.lots.push(newLot(d, n, 1, true));
      d.lots.push(newLot(d, 210, 0.6, false));  // tower rising on an annexed block
      d.lots.push(newLot(d, 211, 0.04, false)); // fresh excavation
    });

    function emitCitySnapshot() {
      emit({ type: 'city', city: { version: 1, districts: clone(districts) } });
    }
    function activeLotOf(d) {
      const last = d.lots[d.lots.length - 1];
      return last && last.state === 'construction' ? last : null;
    }
    function cityDelta(d, lot, event) {
      const msg = { type: 'cityDelta', districtKey: d.key, lot: clone(lot), event };
      if (event !== 'progress') {
        const { lots, ...meta } = d;
        msg.district = clone(meta);
      }
      emit(msg);
    }
    function cityWork(d, units) {
      let lot = activeLotOf(d);
      if (!lot) return;
      lot.progress += units;
      d.totalWork += units;
      if (lot.progress >= lot.required) {
        lot.progress = lot.required;
        lot.state = 'complete';
        lot.completedAt = 1;
        d.completedCount++;
        cityDelta(d, lot, 'complete');
        const next = newLot(d, d.lots.length, 0, false);
        d.lots.push(next);
        cityDelta(d, next, 'groundbreak');
      } else {
        cityDelta(d, lot, 'progress');
      }
    }

    // ---- Mock entities (sessions / subagents) ----------------------------------
    function newSession(opts) {
      opts = opts || {};
      const id = 'sess-' + (++idc);
      return {
        id, kind: 'session', agentType: null, parentSessionId: null,
        isOrchestrator: false,
        project: opts.project || pick(PROJECTS),
        status: 'spawning', currentToolFamily: null, currentAction: null,
        errorCount: 0,
        title: pick(['Fix iso depth sort', 'Refactor the persister', 'Ship chirper feed', 'Investigate flaky test', 'Polish HUD styles']),
      };
    }
    function newSubagent(parent) {
      const id = 'agent-' + (++idc);
      return {
        id, kind: 'subagent', agentType: pick(AGENT_TYPES),
        parentSessionId: parent.id, project: parent.project,
        status: 'working', currentToolFamily: pick(FAMILIES), errorCount: 0,
      };
    }

    function initialSnapshot() {
      const ents = [];
      const boss = newSession({ project: PROJECTS[1] });
      boss.status = 'working';
      boss.isOrchestrator = true;
      boss.currentToolFamily = 'delegate';
      boss.currentAction = 'Delegating → Explore';
      live.set(boss.id, boss); ents.push(boss);
      const sub = newSubagent(boss);
      live.set(sub.id, sub); ents.push(sub);
      for (let i = 0; i < 2; i++) {
        const e = newSession({ project: PROJECTS[i] });
        e.status = 'working';
        e.currentToolFamily = pick(FAMILIES);
        e.currentAction = actionFor(e.currentToolFamily);
        live.set(e.id, e); ents.push(e);
      }
      emit({ type: 'snapshot', entities: ents.map(clone), aggregates: aggregates() });
      emitCitySnapshot();
    }

    function aggregates() {
      let active = 0, errs = 0, n = 0, buildings = 0, under = 0;
      for (const e of live.values()) {
        if (e.status === 'working') active++;
        errs += e.errorCount || 0; n++;
      }
      for (const d of districts) {
        for (const l of d.lots) (l.state === 'complete' ? buildings++ : under++);
      }
      return {
        activeCount: active,
        throughput: active + rnd(3),
        errorRate: n ? Math.min(1, errs / (n * 6)) : 0,
        city: { buildings, underConstruction: under, districts: districts.length },
      };
    }

    function districtOf(_project) {
      return districts[0]; // single shared city — sessions are no longer zoned
    }

    function tick() {
      if (stopped) return;
      const r = Math.random();
      const sessions = [...live.values()].filter((x) => x.kind === 'session');

      if (live.size < 8 && r < 0.22) {
        const e = newSession();
        live.set(e.id, e);
        emit({ type: 'spawn', entity: clone(e) });
        schedule(700 + rnd(600), () => {
          if (!live.has(e.id)) return;
          e.status = 'working'; e.currentToolFamily = pick(FAMILIES);
          e.currentAction = actionFor(e.currentToolFamily);
          emit({ type: 'delta', entityId: e.id, changes: { status: 'working', currentToolFamily: e.currentToolFamily, currentAction: e.currentAction, signal: 'tool_start' } });
        });
      } else if (r < 0.38 && sessions.length) {
        // subagent + sticky foreman promotion
        const p = pick(sessions);
        if (!p.isOrchestrator) {
          p.isOrchestrator = true;
          emit({ type: 'delta', entityId: p.id, changes: { isOrchestrator: true, signal: 'orchestrate' } });
        }
        const sub = newSubagent(p);
        live.set(sub.id, sub);
        emit({ type: 'spawn', entity: clone(sub) });
        schedule(3000 + rnd(4000), () => {
          if (!live.has(sub.id)) return;
          live.delete(sub.id);
          emit({ type: 'despawn', entityId: sub.id });
        });
      } else if (r < 0.66 && sessions.length) {
        // tool burst (debounce test) + matching city progress
        const e = pick(sessions);
        const burst = 1 + rnd(4);
        for (let b = 0; b < burst; b++) {
          schedule(b * 80, () => {
            if (!live.has(e.id)) return;
            e.status = 'working'; e.currentToolFamily = pick(FAMILIES);
            e.currentAction = actionFor(e.currentToolFamily);
            emit({ type: 'delta', entityId: e.id, changes: { status: 'working', currentToolFamily: e.currentToolFamily, currentAction: e.currentAction, signal: 'tool_start' } });
          });
        }
        schedule(burst * 80 + 200, () => cityWork(districtOf(e.project), 2 + rnd(4)));
        schedule(burst * 80 + 900 + rnd(900), () => {
          if (!live.has(e.id)) return;
          e.status = 'idle'; e.currentToolFamily = null; e.currentAction = null;
          emit({ type: 'delta', entityId: e.id, changes: { status: 'idle', currentToolFamily: null, currentAction: null, signal: 'tool_end' } });
        });
      } else if (r < 0.76 && sessions.length) {
        // error -> incident smoke
        const e = pick(sessions);
        e.errorCount = (e.errorCount || 0) + 1;
        emit({ type: 'delta', entityId: e.id, changes: { errorCount: e.errorCount, signal: 'error' } });
        const d = districtOf(e.project);
        const lot = activeLotOf(d);
        if (lot) { lot.incidents++; d.totalIncidents++; cityDelta(d, lot, 'incident'); }
      } else if (r < 0.84 && sessions.length > 2) {
        const e = pick(sessions);
        for (const s of [...live.values()]) {
          if (s.parentSessionId === e.id) { live.delete(s.id); emit({ type: 'despawn', entityId: s.id }); }
        }
        live.delete(e.id);
        emit({ type: 'despawn', entityId: e.id });
      }
      emit({ type: 'aggregates', aggregates: aggregates() });
    }

    function schedule(ms, fn) { timers.push(setTimeout(fn, ms)); }

    initialSnapshot();
    const iv = setInterval(tick, 1400);
    timers.push(iv);

    return {
      stop() {
        stopped = true;
        for (const t of timers) { clearTimeout(t); clearInterval(t); }
        timers = [];
      },
    };
  }

  Object.assign(window.CITY, { makeMockServer });
})();
