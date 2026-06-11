/* ===========================================================================
   projects.js — left-rail list of CURRENT CONSTRUCTION PROJECTS.

   Scans the city mirror for lots in the 'construction' state and renders each
   as a small card. Clicking a card flies the camera to that building's lot and
   zooms in, then the camera's own 30s idle timer resumes the whole-metro view.

   Cards are reconciled by lot id (not rebuilt each tick) so hover/click state
   survives the periodic refresh and the progress bars animate smoothly.
   =========================================================================== */
(function () {
  'use strict';
  const C = window.CITY;

  // Human-readable names for the server's building `type` ids.
  const TYPE_LABEL = {
    house: 'House', apartment: 'Apartment Block', office: 'Office Building',
    skyscraper: 'Skyscraper', shop: 'Corner Store', store: 'Supermarket',
    restaurant: 'Restaurant', school: 'School', factory: 'Factory',
    power_station: 'Power Station', transit: 'Transit Hub', police: 'Police Station',
    hospital: 'Hospital', fire_station: 'Fire Station', prison: 'Prison',
    farm: 'Farm', park: 'Park', landfill: 'Landfill',
  };
  function typeLabel(t) { return TYPE_LABEL[t] || (t ? t.replace(/_/g, ' ') : 'Building'); }

  const ZOOM_TO_SITE = 1.6; // how far in a click pulls the camera

  // ---- DOM scaffolding ------------------------------------------------------
  const panel = document.createElement('div');
  panel.id = 'projects-panel';
  panel.className = 'panel';
  panel.innerHTML =
    '<div class="proj-head">CONSTRUCTION' +
    '<span id="proj-count" class="proj-count">0</span></div>' +
    '<div id="proj-list" class="proj-list"></div>';
  document.body.appendChild(panel);
  const listEl = panel.querySelector('#proj-list');
  const countEl = panel.querySelector('#proj-count');

  const cards = new Map(); // lot.id -> { el, fill, meta }

  // ---- Zoom-out button: snap back to the default whole-metro view ------------
  const zoomBtn = document.createElement('button');
  zoomBtn.id = 'zoom-out-btn';
  zoomBtn.type = 'button';
  zoomBtn.title = 'Zoom out to full city';
  zoomBtn.innerHTML = '<span class="zob-icon">⤢</span><span>FULL CITY</span>';
  zoomBtn.addEventListener('click', () => {
    const cam = C.render && C.render.camera;
    if (cam) cam.resetView();
  });
  document.body.appendChild(zoomBtn);

  // ---- Geometry: lot id -> world point (pre-camera screen px) ----------------
  function lotFocusPoint(lot) {
    const pl = C.lotPlacement(lot);
    // centre of the building footprint, on the ground plane
    return C.worldToScreen(pl.tx + pl.w / 2, pl.ty + pl.d / 2, 0);
  }

  function focusLot(lot) {
    const cam = C.render && C.render.camera;
    if (!cam) return;
    const p = lotFocusPoint(lot);
    cam.focusOn(p.x, p.y, ZOOM_TO_SITE);
  }

  // ---- Card creation / update ----------------------------------------------
  function makeCard(lot) {
    const el = document.createElement('button');
    el.type = 'button';
    el.className = 'proj-card';
    el.innerHTML =
      '<div class="proj-row"><span class="proj-name"></span></div>' +
      '<div class="proj-sub"></div>' +
      '<div class="proj-bar"><div class="proj-fill"></div></div>';
    el.addEventListener('click', () => focusLot(cards.get(lot.id) ? cards.get(lot.id).lot : lot));
    const entry = {
      el,
      lot,
      name: el.querySelector('.proj-name'),
      sub: el.querySelector('.proj-sub'),
      fill: el.querySelector('.proj-fill'),
    };
    return entry;
  }

  function updateCard(entry, lot) {
    entry.lot = lot;
    const b = lot.building || {};
    const name = typeLabel(b.type);
    if (entry.name.textContent !== name) entry.name.textContent = name;
    const renovation = lot.everCompleted || (lot.upgrades || 0) > 0;
    const sub = renovation ? 'Renovation · ' + (b.tier ? 'tier ' + b.tier : '') : 'New build';
    if (entry.sub.textContent !== sub) entry.sub.textContent = sub;
    const pct = lot.required > 0
      ? Math.max(0, Math.min(100, Math.round((lot.progress / lot.required) * 100)))
      : 0;
    entry.fill.style.width = pct + '%';
  }

  // ---- Periodic reconcile ---------------------------------------------------
  function collect() {
    const out = [];
    for (const d of C.districts.values()) {
      for (const lot of d.lots || []) {
        if (lot && lot.state === 'construction') out.push(lot);
      }
    }
    // most-progressed first so near-finished towers sit at the top
    out.sort((a, b) => (b.progress || 0) - (a.progress || 0));
    return out;
  }

  function refresh() {
    const active = collect();
    const seen = new Set();
    for (let i = 0; i < active.length; i++) {
      const lot = active[i];
      seen.add(lot.id);
      let entry = cards.get(lot.id);
      if (!entry) { entry = makeCard(lot); cards.set(lot.id, entry); }
      updateCard(entry, lot);
      // keep DOM order matching the sorted list
      if (listEl.children[i] !== entry.el) listEl.insertBefore(entry.el, listEl.children[i] || null);
    }
    // drop cards whose lot finished / vanished
    for (const [id, entry] of cards) {
      if (!seen.has(id)) { entry.el.remove(); cards.delete(id); }
    }
    countEl.textContent = active.length;
    panel.classList.toggle('is-empty', active.length === 0);
  }

  setInterval(refresh, 600);
  refresh();
})();
