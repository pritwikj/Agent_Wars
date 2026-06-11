/* ===========================================================================
   config.js — CITY namespace bootstrap: palette, tile metrics, hashing,
   shared tuning mirrors.

   The client renders an isometric "agent city": districts (one per project)
   of city blocks whose buildings are erected by Claude Code tool activity.
   Sessions appear as construction workers, subagents as crew members.
   =========================================================================== */
(function () {
  'use strict';

  // ---- Isometric tile metrics (world-space pixels) -------------------------
  const TILE_W = 64;            // 2:1 diamond
  const TILE_H = 32;
  const FLOOR_H = 14;           // pixels of building height per story
  const BLOCK_TILES = 8;        // a city block is 8x8 tiles
  const PARCEL_GRID = 3;        // 3x3 parcels of 2x2 tiles inside each block
  const LOTS_PER_BLOCK = 9;     // mirrors server TUNING.LOTS_PER_BLOCK

  // ---- Palette — clean, sunny Cities Skylines look --------------------------
  const PAL = {
    skyTop: '#bfe6f7',
    skyBottom: '#eaf6ef',
    grass: '#84c56e',
    grassHi: '#9bd683',
    grassEdge: '#69ab57',
    plaza: '#e8e0cd',
    road: '#4e565f',
    roadEdge: '#3f464e',
    roadLine: '#e6c14d',     // warm centre-line (kept subtle via alpha)
    curb: '#cfd5db',
    sidewalk: '#c3cad1',
    sidewalkEdge: '#a9b2bb',
    dirt: '#c39a6a',
    dirtDark: '#a07a4f',
    foundation: '#a3aab1',
    roofSlab: '#5f656e',     // flat-roof membrane (neutral)
    roofGravel: '#787e87',
    scaffold: '#e8ad3c',
    crane: '#ecbe4c',
    shadow: '20,26,34',      // rgb for cast shadows (used with alpha)
  };

  // Light direction (sun from upper-NE). Shadows fall toward screen SW.
  // Cast-shadow screen offset per pixel of building height (kept moderate so
  // supertall towers don't sling a shadow clear off their block).
  const SUN = { shadowDX: -0.33, shadowDY: 0.22 };

  // ---- Deterministic hashing (FNV-1a 32-bit; identical to server) ----------
  function hash32(str) {
    let h = 0x811c9dc5;
    str = String(str == null ? '' : str);
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
    }
    return h >>> 0;
  }

  // ---- Project identity (defensive: accept string or {key,name,path}) ------
  function projectKey(project) {
    if (project == null) return 'unknown';
    if (typeof project === 'string') return project;
    return String(project.key || project.path || project.name || 'unknown');
  }
  function projectName(project) {
    if (project == null) return 'unknown';
    if (typeof project === 'string') {
      const seg = project.replace(/[\\/]+$/, '').split(/[\\/]/);
      return seg[seg.length - 1] || project;
    }
    return String(project.name || project.key || project.path || 'unknown');
  }

  // ---- District hue helpers -------------------------------------------------
  function hueFor(key) { return hash32(key) % 360; }
  function districtColor(hue, s, l) {
    return 'hsl(' + hue + ',' + (s == null ? 55 : s) + '%,' + (l == null ? 55 : l) + '%)';
  }

  // NOTE: tool family deliberately does NOT influence the city. Construction
  // reflects the VOLUME of work, not its kind — reading and editing look the
  // same on site — so there is no tool-family -> activity/colour mapping here.

  // ---- Building types --------------------------------------------------------
  // MIRROR of server/city.js BUILDING_TYPES + TYPE_WEIGHTS (no shared module in
  // a build-step-free project). Real lots arrive with `type` baked in by the
  // server; the client needs the table to map type -> render category, and the
  // demo uses the weighted draw to synthesize the same varied skyline offline.
  // (park/landfill CAN be a real lot now — a session that builds one then hops
  // off to renovate a neighbour; they also appear as ambient zoning on empty
  // parcels, see render.js.)
  const BUILDING_TYPES = {
    house:         { category: 'res',     floors: [1, 2],   foot: [[1, 1]] },
    apartment:     { category: 'res',     floors: [3, 6],   foot: [[1, 1], [1, 2]] },
    office:        { category: 'com',     floors: [7, 14],   foot: [[1, 2]] },
    skyscraper:    { category: 'com',     floors: [20, 110], foot: [[2, 2]] },
    // ── retail (Cities-Skylines commercial: low-rise storefronts that stay
    //    storefronts — off the density chain, so they grow within their own
    //    floor band rather than redeveloping into towers) ──
    shop:          { category: 'retail',  floors: [1, 2],   foot: [[1, 1], [1, 2]] },  // corner store / boutique
    store:         { category: 'retail',  floors: [1, 3],   foot: [[1, 2], [2, 2]] },  // supermarket / big-box
    restaurant:    { category: 'retail',  floors: [1, 2],   foot: [[1, 1], [1, 2]] },  // diner / cafe
    school:        { category: 'school',  floors: [2, 4],   foot: [[1, 2], [2, 2]] },
    // industry: a low production hall (sawtooth roof + smokestacks); off the
    // density chain like the civic types, grows within its own floor band.
    factory:       { category: 'industrial', floors: [2, 3], foot: [[2, 2]] },
    power_station: { category: 'power',   floors: [3, 4],   foot: [[2, 2]] },
    transit:       { category: 'transit', floors: [2, 3],   foot: [[1, 2], [2, 2]] },
    police:        { category: 'police',   floors: [2, 4],  foot: [[1, 2], [2, 2]] },
    hospital:      { category: 'hospital',  floors: [4, 9],  foot: [[2, 2]] },
    fire_station:  { category: 'fire',      floors: [2, 3],  foot: [[1, 2], [2, 2]] },
    prison:        { category: 'prison',    floors: [2, 3],  foot: [[2, 2]] },
    farm:          { category: 'farm',    floors: [0, 0],   foot: [[2, 2]] },  // rural tilled field + homestead
    park:          { category: 'park',    floors: [0, 0],   foot: [[2, 2]] },
    landfill:      { category: 'landfill', floors: [0, 0],  foot: [[2, 2]] },
  };
  const TYPE_WEIGHTS = [
    { until: 4,        w: { house: 5, park: 3, apartment: 2, shop: 1, landfill: 1, school: 1 } },
    { until: 10,       w: { apartment: 4, office: 3, shop: 2, restaurant: 1, store: 1, school: 2, transit: 2, house: 2, park: 2, power_station: 1, factory: 1, police: 1, fire_station: 1, hospital: 1 } },
    { until: Infinity, w: { office: 4, skyscraper: 3, store: 2, restaurant: 1, power_station: 2, factory: 2, transit: 2, school: 1, park: 1, police: 1, fire_station: 1, hospital: 1, prison: 1 } },
  ];
  function pickType(seed, n) {
    const pool = TYPE_WEIGHTS.find((b) => n < b.until) || TYPE_WEIGHTS[TYPE_WEIGHTS.length - 1];
    const entries = Object.entries(pool.w);
    let total = 0;
    for (const [, wt] of entries) total += wt;
    let roll = seed % total;
    for (const [type, wt] of entries) {
      if (roll < wt) return type;
      roll -= wt;
    }
    return entries[0][0];
  }
  // Skewed height draw (mirror of server) — biased low with a long tail; the
  // steeper skyscraper skew keeps most mid-rise and a rare few near the cap.
  function floorsForType(type, seed) {
    const [lo, hi] = (BUILDING_TYPES[type] || BUILDING_TYPES.office).floors;
    if (hi <= lo) return lo;
    const r = ((seed >>> 0) % 100000) / 100000;
    const skew = type === 'skyscraper' ? 3 : 1.5;
    return lo + Math.round((hi - lo) * Math.pow(r, skew));
  }
  function footprintForType(type, seed) {
    const fps = (BUILDING_TYPES[type] || BUILDING_TYPES.office).foot;
    return fps[seed % fps.length].slice();
  }
  function tierForFloors(floors) {
    if (floors >= 20) return 5;
    if (floors >= 12) return 4;
    if (floors >= 7) return 3;
    if (floors >= 3) return 2;
    return 1;
  }
  function buildingCategory(type) {
    return (BUILDING_TYPES[type] || BUILDING_TYPES.office).category;
  }

  // ---- Neighborhoods (concentric Burgess + sector Hoyt + seeded jitter) ------
  // A real-metro layout derived purely from a block's spiral position, so it is
  // deterministic and needs no server round-trip: an expensive tall DOWNTOWN
  // core at the center, a poorer INNER-city ring hugging it, then SUBURBS whose
  // wealth (upper / middle / working) varies by compass sector with per-block
  // jitter — like the wealthy vs. working sides of an LA/Chicago/NYC.
  //   MIRROR: server/city.js carries an identical neighborhoodFor() when the
  //   optional spatial-growth model is enabled. Change both together.
  const NB = { DOWNTOWN_R: 2, INNER_R: 3, RURAL_R: 6 };  // core (0-2), inner ring (3), suburbs (4-5), countryside (6+)
  const SUBURB_TIERS = ['working', 'middle', 'upper']; // wealthScore 0..2
  const hoodCache = new Map();
  function neighborhoodFor(blockSlot) {
    let h = hoodCache.get(blockSlot);
    if (h) return h;
    const C = window.CITY;
    const { bx, by } = C.spiralSlot(blockSlot);            // (0,0) = city center
    const ring = Math.max(Math.abs(bx), Math.abs(by));      // Chebyshev ring
    const jit = hash32('hood:' + bx + ',' + by);
    const effRing = Math.max(0, ring + ((jit & 3) === 0 ? 1 : (jit & 7) === 1 ? -1 : 0));
    let klass;
    if (effRing <= NB.DOWNTOWN_R) klass = 'downtown';
    else if (effRing <= NB.INNER_R) klass = 'inner';
    else if (effRing >= NB.RURAL_R) klass = 'rural'; // outermost ring: farmland + homesteads
    else {
      // sector gives the town a wealthy side and a working side; jitter + the
      // outer-ring "exurb" drift keep adjacent blocks from cloning.
      const sector = ((Math.round(Math.atan2(by, bx) / (Math.PI / 4)) % 8) + 8) % 8;
      let score = hash32('sector:' + sector) % 3;
      if (effRing >= 5) score -= ((jit >>> 6) & 1);
      const j2 = (jit >>> 8) % 5;
      if (j2 === 0) score += 1; else if (j2 === 1) score -= 1;
      klass = SUBURB_TIERS[clamp(score, 0, 2)];
    }
    const base = { downtown: 3, upper: 3, middle: 2, working: 1, inner: 0, rural: 1 }[klass];
    const wealth = clamp(base + (((jit >>> 4) % 100) / 100) * 0.5 - 0.25, 0, 3);
    h = { klass, wealth, ring };
    hoodCache.set(blockSlot, h);
    return h;
  }

  // Per-class theming + spawn knobs — the single source of truth for ground
  // tint, foliage/landmark bias, building cleanliness, and the people/vehicle
  // mix. Tints are HSL deltas applied to the base palette via tintHex().
  const NEIGHBORHOODS = {
    downtown: {
      label: 'Downtown', swatch: '#8a93a6',
      grass: { dh: -4, ds: -14, dl: -3 }, sidewalk: { dh: 0, ds: -2, dl: 5 },
      buildingTint: { dl: 3, ds: -2 },
      foliage: 0.45, landmarkProb: 0.85, wornProb: 0.0,
      pedDensity: 1.35, carDensity: 1.4, taxiProb: 0.5, carQuality: 0.85,
      pedMix: { business: 5, resident: 2, tourist: 2, cyclist: 2, jogger: 1, vendor: 2 },
    },
    upper: {
      label: 'Uptown', swatch: '#5fae5a',
      grass: { dh: 4, ds: 14, dl: 4 }, sidewalk: { dh: 0, ds: 0, dl: 3 },
      buildingTint: { dl: 4, ds: 0 },
      foliage: 1.0, landmarkProb: 0.7, wornProb: 0.0,
      pedDensity: 0.8, carDensity: 1.0, taxiProb: 0.05, carQuality: 1.0,
      pedMix: { resident: 4, dogWalker: 3, jogger: 3, kid: 2, cyclist: 2 },
    },
    middle: {
      label: 'Midtown', swatch: '#86c56e',
      grass: { dh: 0, ds: 0, dl: 0 }, sidewalk: { dh: 0, ds: 0, dl: 0 },
      buildingTint: { dl: 0, ds: 0 },
      foliage: 0.6, landmarkProb: 0.4, wornProb: 0.08,
      pedDensity: 0.9, carDensity: 0.9, taxiProb: 0.1, carQuality: 0.6,
      pedMix: { resident: 5, kid: 3, dogWalker: 2, cyclist: 2, jogger: 1 },
    },
    working: {
      label: 'Working-class', swatch: '#b6b061',
      grass: { dh: -8, ds: -16, dl: -3 }, sidewalk: { dh: 0, ds: -4, dl: -6 },
      buildingTint: { dl: -2, ds: -6 },
      foliage: 0.4, landmarkProb: 0.15, wornProb: 0.25,
      pedDensity: 1.0, carDensity: 0.7, taxiProb: 0.08, carQuality: 0.35,
      pedMix: { resident: 5, kid: 3, vendor: 2, cyclist: 1, dogWalker: 1 },
    },
    inner: {
      label: 'Inner city', swatch: '#8f8a80',
      grass: { dh: -12, ds: -26, dl: -6 }, sidewalk: { dh: 0, ds: -6, dl: -11 },
      buildingTint: { dl: -5, ds: -10 },
      foliage: 0.2, landmarkProb: 0.08, wornProb: 0.45,
      pedDensity: 1.2, carDensity: 0.5, taxiProb: 0.15, carQuality: 0.2,
      pedMix: { resident: 4, kid: 3, vendor: 3, cyclist: 1 },
    },
    rural: {
      label: 'Countryside', swatch: '#7bbf57',
      grass: { dh: 6, ds: 18, dl: 2 }, sidewalk: { dh: 8, ds: 6, dl: -2 },
      buildingTint: { dl: 2, ds: -2 },
      foliage: 1.1, landmarkProb: 0.2, wornProb: 0.05,
      pedDensity: 0.35, carDensity: 0.45, taxiProb: 0.0, carQuality: 0.5,
      pedMix: { resident: 4, dogWalker: 2, kid: 2, cyclist: 1 },
    },
  };

  // hex -> HSL(deltas) -> 'hsl(...)' string, memoized (ground rebuild is rare).
  const tintCache = new Map();
  function tintHex(hex, d) {
    const key = hex + '|' + d.dh + '|' + d.ds + '|' + d.dl;
    let out = tintCache.get(key);
    if (out) return out;
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    let r = 0.5, g = 0.5, b = 0.5;
    if (m) { r = parseInt(m[1], 16) / 255; g = parseInt(m[2], 16) / 255; b = parseInt(m[3], 16) / 255; }
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), l0 = (mx + mn) / 2;
    let hh = 0, ss = 0;
    if (mx !== mn) {
      const dd = mx - mn;
      ss = l0 > 0.5 ? dd / (2 - mx - mn) : dd / (mx + mn);
      if (mx === r) hh = (g - b) / dd + (g < b ? 6 : 0);
      else if (mx === g) hh = (b - r) / dd + 2;
      else hh = (r - g) / dd + 4;
      hh /= 6;
    }
    const H = (((hh * 360 + (d.dh || 0)) % 360) + 360) % 360;
    const S = clamp(ss * 100 + (d.ds || 0), 0, 100);
    const L = clamp(l0 * 100 + (d.dl || 0), 0, 100);
    out = 'hsl(' + H.toFixed(1) + ',' + S.toFixed(1) + '%,' + L.toFixed(1) + '%)';
    tintCache.set(key, out);
    return out;
  }

  // ---- Shared utils ----------------------------------------------------------
  function esc(s) {
    return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  }
  function clamp(v, lo, hi) { return v < lo ? lo : v > hi ? hi : v; }
  function lerp(a, b, t) { return a + (b - a) * t; }

  // ---- Export ----------------------------------------------------------------
  window.CITY = window.CITY || {};
  Object.assign(window.CITY, {
    TILE_W, TILE_H, FLOOR_H, BLOCK_TILES, PARCEL_GRID, LOTS_PER_BLOCK,
    PAL, SUN,
    BUILDING_TYPES,
    hash32, projectKey, projectName, hueFor, districtColor,
    pickType, floorsForType, footprintForType, tierForFloors, buildingCategory,
    neighborhoodFor, NEIGHBORHOODS, tintHex,
    esc, clamp, lerp,
  });
})();
