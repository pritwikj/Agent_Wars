/**
 * city.js — authoritative city growth model.
 *
 * The city is the PERSISTENT layer of the viz. The unit of growth is a Claude
 * Code SESSION (its main agent + all of its subagents — their tool work is
 * attributed to the parent session, so they build together). The first time a
 * session does work it is bound to ONE structure to build: ~50/50 by session-id
 * hash it either breaks ground on a NEW building or RENOVATES an existing
 * finished building in that session's district (falling back to new ground if
 * nothing is renovatable). Once that structure tops out, a still-running session
 * picks a finished building to RENOVATE next (raising its tier / floors) — its
 * OWN counts, so it may keep climbing the same one house->apartment->office->
 * skyscraper, or send the crew to improve a neighbour. So a long session either
 * raises a signature tower or spreads upgrades across the district.
 *
 * Tool KIND is irrelevant — every successful PostToolUse is one unit of work
 * whether the agent was reading or editing. Failures log incidents (smoke/fire
 * cues). The city is a single shared neighbourhood — work is NOT zoned by
 * project; every session builds into the one skyline, which grows permanently
 * across server restarts (see persist.js).
 *
 * Layout model (shared contract with the client layout solver):
 *   - The world is a plane of 8x8-tile BLOCKS placed on a deterministic
 *     spiral walk from the origin (block slot 0 = (0,0), then ring 1, ...).
 *   - Each block: 1-tile perimeter road + 6x6 interior = a 3x3 grid of
 *     2x2-tile PARCELS. One lot per parcel, 9 lots per block, filled in
 *     serpentine order. Building footprints ([1,1]|[1,2]|[2,2]) render
 *     inside their parcel.
 *   - district.blocks[] holds the GLOBAL spiral slot indices the district
 *     occupies; each lot stores its block slot + parcel index, so placement
 *     is fully persisted — the client never re-derives it.
 *
 * WS messages emitted (additive to the entity contract; NEVER replayed from
 * the resync ring — every handshake gets a fresh full city snapshot):
 *   { type:"city",      seq, city:{ version, districts:[...] } }
 *   { type:"cityDelta", seq, districtKey, district?, lot:{...full lot...},
 *     event: "progress"|"groundbreak"|"complete"|"incident" }
 */

import { EventEmitter } from 'node:events';

export const SAVE_VERSION = 1;

// ── Tuning (the whole growth economy lives here) ─────────────────────────────
export const TUNING = {
  WORK_PER_TOOL: 1,        // work units per successful PostToolUse
  WORK_PER_THINK_SEC: 0.15,// work units accrued per second a session spends thinking
                           // (mid-turn, no tool running) — thinking builds too
  BASE_REQUIRED: 30,       // building n needs BASE + STEP*n work units...
  REQUIRED_STEP: 15,
  REQUIRED_CAP: 400,       // ...capped so megatowers stay reachable
  LOTS_PER_BLOCK: 9,       // 3x3 parcels per block (see layout model above)
  // Organic spread (see chooseSite): a BALANCED city — below the density target
  // it's a coin flip between breaking ground on a new frontier block and
  // infilling an existing community, so the footprint grows in step with the
  // neighborhoods filling out. MIRROR of public/citymodel.js.
  SPREAD_TARGET: 3,        // avg buildings/block before infill beats expansion
  EXPAND_PROB: 0.5,        // balanced: ~50/50 new frontier block vs. infill existing community
  INFILL_EXPAND_PROB: 0.12,// once a block is dense, opening a new one is rare
};

// Infill bias toward the denser core so suburbs stay sparse; center-out parcel
// preference inside a block. MIRROR of public/citymodel.js.
// Infill bias: the dense core still infills first, but suburbs infill a little
// more readily than before so a started subdivision FILLS with homes (reads as
// a community) instead of one lonely house per block; the rural ring stays the
// sparsest. MIRROR of public/citymodel.js.
const HOOD_INFILL_W = { downtown: 6, inner: 4, upper: 3, middle: 3, working: 2.5, rural: 0.7 };
const PARCEL_W = [1, 2, 1, 2, 4, 2, 1, 2, 1];
// Multi-nucleus growth: the metro is NOT one contiguous blob spreading
// center-out. It is a downtown CORE plus detached SATELLITE TOWNS — inner
// suburbs and far-flung farm communities — founded across a real GAP and tied
// back to the core by freeways (see public/infra.js connectors). Each town grows
// from its OWN edge toward its OWN centre, so the gaps between towns persist (the
// Southern-California look: a dense core, separate valley towns, open land and
// farmland between them). MIRROR of public/citymodel.js — change both together.
const SATELLITE_PROB = 0.10;     // chance an expansion founds a NEW detached town (lower: grow the towns we have, don't keep spawning lone parcels)
const SATELLITE_GAP = 2;         // empty blocks between a new town and the core's edge
const SATELLITE_MIN_BLOCKS = 4;  // the core needs a footing before it spins off towns
const TOWN_PULL = 1.3;           // pull toward a town's OWN centre -> compact communities
const SUBURB_TARGET = 6;         // blocks a satellite should reach to read as a REAL town (not a lone parcel)
const SUBURB_BOOST = 3;          // how hard expansion favors an under-built satellite, fading to parity at SUBURB_TARGET

/** A fresh random 32-bit unsigned value — the entropy source for groundbreaks. */
function rand32() { return (Math.random() * 0x100000000) >>> 0; }

/** Seeded weighted pick over `items`; weightOf(item) -> non-negative weight. */
function weightedPick(items, weightOf, seed) {
  let total = 0;
  for (const it of items) total += weightOf(it);
  if (total <= 0) return items[0];
  let roll = ((seed >>> 0) % 100000) / 100000 * total;
  for (const it of items) {
    roll -= weightOf(it);
    if (roll < 0) return it;
  }
  return items[items.length - 1];
}

/**
 * Partition the built blocks into TOWNS — maximal clusters of 8-connected block
 * cells. The metro CORE is the cluster at the origin; every other cluster is a
 * detached satellite town. Deterministic from the block order (so server +
 * offline-demo client agree). MIRROR of public/citymodel.js clusterTowns().
 */
function clusterTowns(usedSlots) {
  const pts = [];
  const idx = new Map();
  for (const s of usedSlots) {
    const { bx, by } = spiralSlot(s);
    idx.set(bx + ',' + by, pts.length);
    pts.push({ bx, by });
  }
  const parent = pts.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i];
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const j = idx.get((p.bx + dx) + ',' + (p.by + dy));
      if (j !== undefined) { const a = find(i), b = find(j); if (a !== b) parent[a] = b; }
    }
  }
  const towns = new Map();
  for (let i = 0; i < pts.length; i++) {
    const r = find(i);
    let t = towns.get(r);
    if (!t) { t = { cells: [], sx: 0, sy: 0 }; towns.set(r, t); }
    t.cells.push(pts[i]); t.sx += pts[i].bx; t.sy += pts[i].by;
  }
  const out = [];
  for (const t of towns.values()) {
    out.push({ cells: t.cells, cx: t.sx / t.cells.length, cy: t.sy / t.cells.length, size: t.cells.length });
  }
  return out;
}

/** Empty, free 8-neighbour block cells around a town's built cells. */
function frontierOf(town, usedPos, isFree) {
  const list = [];
  const seen = new Set();
  for (const c of town.cells) {
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
      if (!dx && !dy) continue;
      const nx = c.bx + dx, ny = c.by + dy, k = nx + ',' + ny;
      if (usedPos.has(k) || seen.has(k)) continue;
      seen.add(k);
      const slot = slotForPos(nx, ny);
      if (isFree(slot)) list.push({ slot, bx: nx, by: ny });
    }
  }
  return list;
}

/**
 * Found a NEW detached town: step out along a seeded compass corridor to a block
 * a real GAP beyond the core's edge, requiring a clear 3x3 around it so it lands
 * as a SEPARATE settlement. Returns a slot, or -1 when no corridor has room (the
 * satellite ring is full -> the caller grows an existing town instead).
 */
function foundSatellite(usedPos, coreRing, seed, isFree) {
  const DIRS = [[1, 0], [1, 1], [0, 1], [-1, 1], [-1, 0], [-1, -1], [0, -1], [1, -1]];
  const dist = coreRing + SATELLITE_GAP + (seed % 3);
  for (let a = 0; a < DIRS.length; a++) {
    const di = (((seed >>> 5) % DIRS.length) + a) % DIRS.length;
    const bx = DIRS[di][0] * dist, by = DIRS[di][1] * dist;
    let blocked = false;
    for (let ex = -1; ex <= 1 && !blocked; ex++) for (let ey = -1; ey <= 1; ey++) {
      if (usedPos.has((bx + ex) + ',' + (by + ey))) blocked = true;
    }
    if (blocked) continue;
    const slot = slotForPos(bx, by);
    if (isFree(slot)) return slot;
  }
  return -1;
}

/**
 * Pick a NEW (empty) block for the city to grow onto. The metro grows as MANY
 * towns, not one blob: with probability SATELLITE_PROB a groundbreak founds a
 * fresh detached town out past the core; otherwise it extends an existing town
 * from its own edge, pulled toward that town's centre so each stays a compact
 * community and the gaps between towns persist. A town's distance from the
 * centre decides its character (neighborhoodFor): near = suburb, far = farmland.
 * `isFree(slot)` guards against reusing a claimed slot. MIRROR of
 * public/citymodel.js pickExpansionSlot().
 */
function pickExpansionSlot(usedSlots, seed, isFree) {
  const usedPos = new Set();
  for (const s of usedSlots) { const { bx, by } = spiralSlot(s); usedPos.add(bx + ',' + by); }
  const towns = clusterTowns(usedSlots);
  // the metro core = the town containing the origin, else the largest cluster.
  let core = null;
  for (const t of towns) if (t.cells.some((c) => c.bx === 0 && c.by === 0)) { core = t; break; }
  if (!core) for (const t of towns) if (!core || t.size > core.size) core = t;
  let coreRing = 0;
  if (core) for (const c of core.cells) coreRing = Math.max(coreRing, Math.abs(c.bx), Math.abs(c.by));

  if (usedSlots.length >= SATELLITE_MIN_BLOCKS && (seed % 1000) / 1000 < SATELLITE_PROB) {
    const slot = foundSatellite(usedPos, coreRing, seed, isFree);
    if (slot >= 0) return slot;
  }

  // extend a town. Weight grows with size but SUBLINEARLY (sqrt), so the core
  // still leads — BUT an under-built satellite gets a catch-up boost so it
  // accretes into a real multi-block town instead of freezing at a lone parcel.
  // The boost fades linearly to nothing as the town nears SUBURB_TARGET blocks,
  // so once a suburb has grown up it falls back to plain sqrt parity.
  const town = weightedPick(towns, (t) => {
    const base = 0.5 + Math.sqrt(t.size);
    if (t === core) return base;
    const deficit = Math.max(0, SUBURB_TARGET - t.size) / SUBURB_TARGET;
    return base * (1 + SUBURB_BOOST * deficit);
  }, seed >>> 9);
  let list = frontierOf(town, usedPos, isFree);
  if (!list.length) {
    for (const t of towns) for (const c of frontierOf(t, usedPos, isFree)) list.push(c);
  }
  if (!list.length) { let s = 0; while (!isFree(s)) s++; return s; }
  return weightedPick(list, (c) => {
    const d = Math.hypot(c.bx - town.cx, c.by - town.cy);
    const pull = 1 + TOWN_PULL / (1 + d);
    const jit = 0.35 + ((hash32('exp:' + c.bx + ',' + c.by + ':' + seed) % 1000) / 1000) * 0.65;
    return pull * jit;
  }, seed >>> 3).slot;
}

// FNV-1a 32-bit — identical to the client's hash32 so seeds/hues agree.
export function hash32(str) {
  let h = 0x811c9dc5;
  str = String(str == null ? '' : str);
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return h >>> 0;
}

// ── Neighborhoods (concentric Burgess + sector Hoyt + seeded jitter) ─────────
// A block's spiral position decides its metro character: a tall DOWNTOWN core
// at the center, a poorer INNER-city ring, then SUBURBS (upper/middle/working)
// that vary by compass sector. MIRROR of public/config.js neighborhoodFor()
// (klass derivation must stay byte-identical) — change both together.
const _spiralCache = [{ bx: 0, by: 0 }];
const _posToSlot = new Map([['0,0', 0]]); // "bx,by" -> slot (reverse of _spiralCache)
const _SPIRAL_DIRS = [[1, 0], [0, 1], [-1, 0], [0, -1]];
const _spiralState = { x: 0, y: 0, dir: 0, run: 1, stepInRun: 0, legInRun: 0 };
function spiralSlot(s) {
  while (_spiralCache.length <= s) {
    const st = _spiralState;
    st.x += _SPIRAL_DIRS[st.dir][0];
    st.y += _SPIRAL_DIRS[st.dir][1];
    st.stepInRun++;
    if (st.stepInRun >= st.run) {
      st.stepInRun = 0;
      st.dir = (st.dir + 1) % 4;
      st.legInRun++;
      if (st.legInRun >= 2) { st.legInRun = 0; st.run++; }
    }
    _spiralCache.push({ bx: st.x, by: st.y });
    _posToSlot.set(st.x + ',' + st.y, _spiralCache.length - 1);
  }
  return _spiralCache[s];
}

/** Reverse of spiralSlot: block grid coords -> global slot index. */
function slotForPos(bx, by) {
  const key = bx + ',' + by;
  let s = _posToSlot.get(key);
  if (s !== undefined) return s;
  const ring = Math.max(Math.abs(bx), Math.abs(by));
  const need = (2 * ring + 1) * (2 * ring + 1);
  while (_spiralCache.length < need) spiralSlot(_spiralCache.length);
  return _posToSlot.get(key);
}

const NB = { DOWNTOWN_R: 2, INNER_R: 3, RURAL_R: 6 };  // core (0-2), inner (3), suburbs (4-5), countryside (6+)
const SUBURB_TIERS = ['working', 'middle', 'upper'];
const _hoodCache = new Map();
export function neighborhoodFor(blockSlot) {
  let h = _hoodCache.get(blockSlot);
  if (h) return h;
  const { bx, by } = spiralSlot(blockSlot);
  const ring = Math.max(Math.abs(bx), Math.abs(by));
  const jit = hash32('hood:' + bx + ',' + by);
  const effRing = Math.max(0, ring + ((jit & 3) === 0 ? 1 : (jit & 7) === 1 ? -1 : 0));
  let klass;
  if (effRing <= NB.DOWNTOWN_R) klass = 'downtown';
  else if (effRing <= NB.INNER_R) klass = 'inner';
  else if (effRing >= NB.RURAL_R) klass = 'rural'; // outermost ring: farmland + homesteads
  else {
    const sector = ((Math.round(Math.atan2(by, bx) / (Math.PI / 4)) % 8) + 8) % 8;
    let score = hash32('sector:' + sector) % 3;
    if (effRing >= 5) score -= ((jit >>> 6) & 1);
    const j2 = (jit >>> 8) % 5;
    if (j2 === 0) score += 1; else if (j2 === 1) score -= 1;
    klass = SUBURB_TIERS[Math.max(0, Math.min(2, score))];
  }
  h = { klass, ring };
  _hoodCache.set(blockSlot, h);
  return h;
}

// ── Building types (pure-random, maturity-biased selection) ──────────────────
// Every lot rolls a type from a seeded weighted draw whose pool shifts as the
// district matures (n = lot index): young districts favor houses/parks, mature
// ones favor towers/civic infrastructure. `category` drives the client render
// path. NOTE: BUILDING_TYPES + TYPE_WEIGHTS are mirrored verbatim in
// public/config.js — change both together or seeds/renders disagree.
export const BUILDING_TYPES = {
  house:         { category: 'res',     floors: [1, 2],   foot: [[1, 1]] },
  apartment:     { category: 'res',     floors: [3, 6],   foot: [[1, 1], [1, 2]] },
  office:        { category: 'com',     floors: [7, 14],   foot: [[1, 2]] },
  skyscraper:    { category: 'com',     floors: [20, 110], foot: [[2, 2]] },
  // ── retail (Cities-Skylines commercial: low-rise storefronts that STAY
  //    storefronts — off the density chain, grow within their own floor band
  //    rather than redeveloping into towers) ──
  shop:          { category: 'retail',  floors: [1, 2],   foot: [[1, 1], [1, 2]] },  // corner store / boutique
  store:         { category: 'retail',  floors: [1, 3],   foot: [[1, 2], [2, 2]] },  // supermarket / big-box
  restaurant:    { category: 'retail',  floors: [1, 2],   foot: [[1, 1], [1, 2]] },  // diner / cafe
  school:        { category: 'school',  floors: [2, 4],   foot: [[1, 2], [2, 2]] },
  // ── industry: a low production hall (sawtooth roof + smokestacks); off the
  //    density chain like the civic types, grows within its own floor band ──
  factory:       { category: 'industrial', floors: [2, 3], foot: [[2, 2]] },
  power_station: { category: 'power',   floors: [3, 4],   foot: [[2, 2]] },
  transit:       { category: 'transit', floors: [2, 3],   foot: [[1, 2], [2, 2]] },
  // ── civic services (Cities-Skylines style; off the density chain like the
  //    other civic types — they grow within their own floor band, never into a
  //    tower) ──
  police:        { category: 'police',   floors: [2, 4],  foot: [[1, 2], [2, 2]] },
  hospital:      { category: 'hospital',  floors: [4, 9],  foot: [[2, 2]] },
  fire_station:  { category: 'fire',      floors: [2, 3],  foot: [[1, 2], [2, 2]] },
  prison:        { category: 'prison',    floors: [2, 3],  foot: [[2, 2]] },
  // ── rural (countryside ring): a tilled field with a small homestead; like
  //    park/landfill it is a 0-floor ground feature, never grows ──
  farm:          { category: 'farm',    floors: [0, 0],   foot: [[2, 2]] },
  park:          { category: 'park',    floors: [0, 0],   foot: [[2, 2]] },
  landfill:      { category: 'landfill', floors: [0, 0],  foot: [[2, 2]] },
};

// Weighted pools by maturity band; first band whose `until` exceeds n wins.
export const TYPE_WEIGHTS = [
  { until: 4,        w: { house: 5, park: 3, apartment: 2, shop: 1, landfill: 1, school: 1 } },
  { until: 10,       w: { apartment: 4, office: 3, shop: 2, restaurant: 1, store: 1, school: 2, transit: 2, house: 2, park: 2, power_station: 1, factory: 1, police: 1, fire_station: 1, hospital: 1 } },
  { until: Infinity, w: { office: 4, skyscraper: 3, store: 2, restaurant: 1, power_station: 2, factory: 2, transit: 2, school: 1, park: 1, police: 1, fire_station: 1, hospital: 1, prison: 1 } },
];

export function pickType(seed, n) {
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

// Height is a deterministic but skewed draw across the type's [lo, hi] band:
// biasing toward the low end gives many short buildings and a long tail of tall
// ones — a realistic skyline. Skyscrapers get the steepest skew so most are
// mid-rise while a rare few spike toward the cap.
export function floorsForType(type, seed) {
  const [lo, hi] = (BUILDING_TYPES[type] || BUILDING_TYPES.office).floors;
  if (hi <= lo) return lo;
  const r = ((seed >>> 0) % 100000) / 100000;        // deterministic [0,1)
  const skew = type === 'skyscraper' ? 3 : 1.5;      // higher = longer tail
  return lo + Math.round((hi - lo) * Math.pow(r, skew));
}

export function footprintForType(type, seed) {
  const fps = (BUILDING_TYPES[type] || BUILDING_TYPES.office).foot;
  return fps[seed % fps.length].slice();
}

// ── Zoning ───────────────────────────────────────────────────────────────────
// Each lot gets a FIXED zone (weighted random, like real parcel zoning) that
// CAPS how dense/tall its building can ever become — most of a city is low-rise
// and only a small downtown can ever reach skyscrapers. A building redevelops up
// the density chain (house -> apartment -> office -> skyscraper) only as far as
// its zone allows, then tops out (and sessions move on to other growable lots).
export const DENSITY_CHAIN = ['house', 'apartment', 'office', 'skyscraper'];
export const ZONES = [
  { zone: 'residential', weight: 6, cap: 'apartment' },  // low-rise homes / flats
  { zone: 'commercial',  weight: 3, cap: 'office' },      // mid-rise commercial
  { zone: 'downtown',    weight: 1, cap: 'skyscraper' },  // rare high-rise core
];
const ZONE_CAP = Object.fromEntries(ZONES.map((z) => [z.zone, z.cap]));

/** Weighted pick of a zone from a seed (deterministic). */
export function pickZone(seed) {
  let total = 0;
  for (const z of ZONES) total += z.weight;
  let roll = seed % total;
  for (const z of ZONES) {
    if (roll < z.weight) return z.zone;
    roll -= z.weight;
  }
  return ZONES[0].zone;
}

function densityRank(type) { return DENSITY_CHAIN.indexOf(type); } // -1 if off-chain
function zoneCapType(zone) { return ZONE_CAP[zone] || 'office'; }
function maxFloorsForType(type) { return (BUILDING_TYPES[type] || BUILDING_TYPES.office).floors[1]; }

// ── Spatial growth: type + zone by neighborhood (not maturity) ───────────────
// The zone still CAPS density (so the renovation engine is unchanged) — these
// just decide the STARTING type and cap per neighborhood, so a downtown lot can
// climb into a tower while a suburban lot tops out at houses/flats.
// Each neighborhood's STARTING-type mix. Suburbs (upper/middle/working) are
// dominated by houses with a sprinkle of local retail (corner store, cafe) and
// parks so they read as planned residential COMMUNITIES; downtown/inner carry
// the bigger stores and offices; the rural ring is farmland + homesteads.
const HOOD_TYPE_WEIGHTS = {
  downtown: { skyscraper: 8, office: 5, apartment: 2, store: 2, restaurant: 1, transit: 1, hospital: 1 }, // CBD: skyscraper-led high-rise
  inner:    { apartment: 5, office: 2, house: 2, shop: 2, restaurant: 1, store: 1, transit: 1, police: 1, prison: 1, fire_station: 1, factory: 1 },
  upper:    { house: 8, apartment: 2, park: 2, shop: 1, restaurant: 1, school: 1, hospital: 1, fire_station: 1 },
  middle:   { house: 7, apartment: 2, shop: 2, restaurant: 1, store: 1, school: 2, park: 1, police: 1, fire_station: 1, hospital: 1 },
  working:  { house: 7, apartment: 2, shop: 1, store: 1, transit: 1, park: 1, police: 1, fire_station: 1, prison: 1, factory: 2 },
  rural:    { house: 5, farm: 6, park: 1, shop: 1, school: 1 }, // homesteads scattered among fields
};
function pickTypeForHood(seed, hood) {
  const w = HOOD_TYPE_WEIGHTS[hood.klass] || HOOD_TYPE_WEIGHTS.middle;
  const entries = Object.entries(w);
  let total = 0;
  for (const [, wt] of entries) total += wt;
  let roll = seed % total;
  for (const [type, wt] of entries) {
    if (roll < wt) return type;
    roll -= wt;
  }
  return entries[0][0];
}
function zoneForHood(hood, seed) {
  const r = seed % 10;
  switch (hood.klass) {
    case 'downtown': return r < 7 ? 'downtown' : 'commercial';
    case 'inner':    return r < 5 ? 'commercial' : 'residential';
    case 'upper':    return r < 2 ? 'commercial' : 'residential';
    case 'middle':   return r < 3 ? 'commercial' : 'residential';
    case 'rural':    return 'residential'; // countryside: low-density only
    default:         return 'residential'; // working-class
  }
}

// Tier survives only as a coarse "bigness" hint for client roof furniture.
export function tierForFloors(floors) {
  if (floors >= 20) return 5;
  if (floors >= 12) return 4;
  if (floors >= 7) return 3;
  if (floors >= 3) return 2;
  return 1;
}

export function requiredFor(n) {
  return Math.min(TUNING.REQUIRED_CAP, TUNING.BASE_REQUIRED + TUNING.REQUIRED_STEP * n);
}

export class CityModel extends EventEmitter {
  /**
   * @param {{ nextSeq: () => number }} seqSource — usually the WorldModel, so
   *   city messages share the same monotonic seq space as entity messages.
   */
  constructor(seqSource) {
    super();
    this.seqSource = seqSource;
    /** @type {Map<string, object>} project key -> district */
    this.districts = new Map();
    /** global spiral block slots already occupied (across all districts) */
    this.usedBlocks = new Set();
    /** @type {Map<string, object>} sessionId -> the lot it is bound to (runtime only) */
    this.sessionLot = new Map();
  }

  // ── persistence interop ────────────────────────────────────────────────────

  /** Hydrate from a parsed save file (validated by persist.loadCity). */
  loadFrom(save) {
    this.districts.clear();
    this.usedBlocks.clear();
    this.sessionLot.clear();
    for (const d of save.districts ?? []) {
      if (!d || typeof d.key !== 'string' || !Array.isArray(d.lots)) continue;
      for (const lot of d.lots) this.normalizeLoadedLot(lot);
      // Preserve state across restarts: nothing is auto-completed or deleted.
      // A lot left mid-build stays an under-construction site — a future crew
      // can pick it up and finish it (see pickResumable).
      d.completedCount = d.lots.filter(
        (l) => l.everCompleted || l.state === 'complete'
      ).length;
      this.districts.set(d.key, d);
      for (const b of d.blocks ?? []) this.usedBlocks.add(b);
    }
  }

  /** Backfill fields older saves (or the legacy model) may lack. */
  normalizeLoadedLot(lot) {
    if (!lot || !lot.building) return;
    if (typeof lot.upgrades !== 'number') lot.upgrades = 0;
    if (typeof lot.everCompleted !== 'boolean') lot.everCompleted = lot.state === 'complete';
    if (typeof lot.zone !== 'string') {
      // Infer a zone consistent with the building already standing there.
      const f = lot.building.floors || 0;
      lot.zone = f >= 16 ? 'downtown' : f >= 7 ? 'commercial' : 'residential';
    }
    lot.sessionId = null; // owners from a previous run are gone
  }

  toJSON() {
    return {
      version: SAVE_VERSION,
      savedAt: Date.now(),
      districts: Array.from(this.districts.values()),
    };
  }

  stats() {
    let buildings = 0;
    let underConstruction = 0;
    for (const d of this.districts.values()) {
      for (const lot of d.lots) {
        // An ever-completed lot is a real building even while it is being
        // renovated (state flips back to 'construction' during an upgrade).
        if (lot.everCompleted || lot.state === 'complete') buildings += 1;
        else underConstruction += 1;
      }
    }
    return { buildings, underConstruction, districts: this.districts.size };
  }

  /** Full city snapshot — sent on EVERY WS handshake (never ring-replayed). */
  snapshotCity() {
    return {
      type: 'city',
      seq: this.seqSource.seq ?? 0, // current-as-of; do not advance
      city: {
        version: SAVE_VERSION,
        districts: Array.from(this.districts.values()),
      },
    };
  }

  // ── growth ─────────────────────────────────────────────────────────────────

  /** Smallest spiral block slot not yet occupied by any district. */
  nextFreeBlock() {
    let s = 0;
    while (this.usedBlocks.has(s)) s += 1;
    return s;
  }

  // The city is NO LONGER zoned by project. Every session's work — whatever
  // cwd it came from — funnels into one shared, continuously-growing city, so
  // there is a single district. `project` is still accepted (ingest contract)
  // but no longer places or colours anything; building colour is per-building
  // on the client (see buildingStyle).
  ensureDistrict(_project) {
    const key = 'city';
    let d = this.districts.get(key);
    if (d) return d;
    const block = this.nextFreeBlock();
    this.usedBlocks.add(block);
    d = {
      key,
      name: 'city',
      index: 0,
      blocks: [block],
      hue: 210, // kept for back-compat; the client no longer tints by it
      totalWork: 0,
      totalIncidents: 0,
      completedCount: 0,
      lots: [],
    };
    this.districts.set(key, d);
    // No auto-groundbreak: the first building appears when the first session is
    // bound to a lot (see lotForSession).
    return d;
  }

  /**
   * Decide where the next building breaks ground so the city SPREADS organically
   * instead of packing one block before annexing the next: the frontier opens
   * new blocks while they're still mostly empty, and infill prefers the denser
   * core (downtown/inner) so suburbs stay sparse. Returns { blockSlot, parcel }
   * and annexes a frontier block when expanding. MIRROR of public/citymodel.js
   * chooseSite() — change both together. Reads district.lots, so call it BEFORE
   * pushing the new lot.
   */
  chooseSite(district, seed) {
    const n = district.lots.length;
    const used = new Map(); // blockSlot -> Set(parcel)
    for (const lot of district.lots) {
      let s = used.get(lot.block);
      if (!s) { s = new Set(); used.set(lot.block, s); }
      s.add(lot.parcel);
    }
    const infill = district.blocks.filter((b) => (used.get(b)?.size || 0) < TUNING.LOTS_PER_BLOCK);
    const avgOcc = n / Math.max(1, district.blocks.length);
    const r = (seed % 1000) / 1000;
    const expandProb = avgOcc < TUNING.SPREAD_TARGET ? TUNING.EXPAND_PROB : TUNING.INFILL_EXPAND_PROB;
    let blockSlot;
    if (infill.length === 0 || r < expandProb) {
      blockSlot = pickExpansionSlot(district.blocks, seed, (s) => !this.usedBlocks.has(s));
      this.usedBlocks.add(blockSlot);
      district.blocks.push(blockSlot);
    } else {
      blockSlot = weightedPick(infill, (b) => HOOD_INFILL_W[neighborhoodFor(b).klass] || 1, seed >>> 7);
    }
    const taken = used.get(blockSlot);
    const free = [];
    for (let p = 0; p < TUNING.LOTS_PER_BLOCK; p++) if (!taken || !taken.has(p)) free.push(p);
    const parcel = weightedPick(free, (p) => PARCEL_W[p] || 1, seed >>> 13);
    return { blockSlot, parcel };
  }

  /** Start construction on district's next lot; spread across blocks organically. */
  breakGround(district) {
    const n = district.lots.length;
    // Real entropy (not a function of n): placement, type and facade differ every
    // run, so no two cities build out the same way. Each lot is decided ONCE here
    // and persisted/streamed verbatim — clients render the stored record and never
    // recompute it, so randomness costs nothing in replay/agreement.
    const seed = rand32();
    const { blockSlot, parcel } = this.chooseSite(district, rand32());
    // Spatial growth: the block's place in the metro decides its character — a
    // tall DOWNTOWN core, a denser/poorer INNER ring, low-rise SUBURBS — so type
    // and zone derive from the neighborhood rather than from maturity. The zone
    // still CAPS density, so renovations climb a downtown lot into a tower while
    // a suburban lot tops out at houses/flats (a park/landfill just won't grow).
    const hood = neighborhoodFor(blockSlot);
    const zone = zoneForHood(hood, seed >>> 11);
    let type = pickTypeForHood(seed, hood);
    if (densityRank(type) > densityRank(zoneCapType(zone))) type = zoneCapType(zone);
    const floors = Math.min(floorsForType(type, seed >>> 8), maxFloorsForType(type));
    const lot = {
      id: `d${district.index}:${n}`,
      index: n,
      block: blockSlot,
      parcel,
      zone,
      state: 'construction',
      progress: 0,
      required: requiredFor(n),
      building: {
        seed,
        type,
        tier: tierForFloors(floors),
        floors,
        footprint: footprintForType(type, seed >>> 5),
      },
      sessionId: null,
      upgrades: 0,
      everCompleted: false,
      startedAt: Date.now(),
      completedAt: null,
      incidents: 0,
    };
    district.lots.push(lot);
    this.emitDelta(district, lot, 'groundbreak');
    return lot;
  }

  /**
   * The lot a session is bound to. The first time a session works in a district
   * it is assigned one for life: ~50/50 by hash it renovates a finished building
   * or breaks new ground (falling back to new ground if nothing is renovatable).
   */
  lotForSession(district, sessionId) {
    const key = sessionId || `_anon:${district.key}`;
    const existing = this.sessionLot.get(key);
    if (existing && district.lots[existing.index] === existing) return existing;

    let lot = null;
    if ((hash32(key) & 1) === 1) {
      // Renovate half: 70/30 split favouring abandoned half-built sites over
      // renovating a standing building (whichever is empty falls back to the
      // other).
      const preferResume = (hash32(`${key}:mix`) % 10) < 7;
      lot = preferResume
        ? this.pickResumable(district, key) || this.pickUpgradeable(district, key)
        : this.pickUpgradeable(district, key) || this.pickResumable(district, key);
    }
    // Either half: before opening fresh ground, adopt any abandoned half-built
    // site so it gets finished rather than left standing as scaffolding forever.
    if (!lot) lot = this.pickResumable(district, key);
    if (!lot) lot = this.breakGround(district);
    lot.sessionId = key;
    this.sessionLot.set(key, lot);
    this.emit('assign', { sessionId: key, districtKey: district.key, lotId: lot.id });
    return lot;
  }

  /**
   * A finished, growable building in the district to renovate. The session's own
   * just-topped-out building is a valid pick, so repeated passes can climb it
   * house->apartment->office->skyscraper rather than capping it.
   */
  pickUpgradeable(district, key) {
    const candidates = district.lots.filter(
      (l) => l.state === 'complete' && this.canGrow(l)
    );
    if (!candidates.length) return null;
    return candidates[hash32(`${key}:up`) % candidates.length];
  }

  /**
   * An abandoned, mid-construction lot in the district with no live session
   * bound to it — a half-built site a new/hopping crew can move onto and finish.
   * This is what keeps released sites from becoming permanent ghost scaffolding
   * now that restarts no longer auto-complete them.
   */
  pickResumable(district, key) {
    const bound = new Set(this.sessionLot.values());
    const candidates = district.lots.filter(
      (l) => l.state !== 'complete' && !bound.has(l)
    );
    if (!candidates.length) return null;
    return candidates[hash32(`${key}:res`) % candidates.length];
  }

  /** Move a session (and its crew) onto a different building to renovate. */
  rebindSession(district, sessionId, lot) {
    const key = sessionId || `_anon:${district.key}`;
    lot.sessionId = key;
    this.sessionLot.set(key, lot);
    this.emit('assign', { sessionId: key, districtKey: district.key, lotId: lot.id });
    return lot;
  }

  /** Whether a building can still be made denser/taller within its zone. */
  canGrow(lot) {
    const b = lot.building || {};
    if (b.type === 'park' || b.type === 'landfill' || b.type === 'farm') return false;
    const zone = lot.zone || 'commercial';
    const curRank = densityRank(b.type);
    if (curRank >= 0) {
      // Density-chain building: redevelop denser until the zone cap, then add
      // floors until the cap type's ceiling.
      if (curRank < densityRank(zoneCapType(zone))) return true;
      return (b.floors ?? 0) < maxFloorsForType(zoneCapType(zone));
    }
    // Off-chain civic types (school/power/transit) grow within their own band.
    return (b.floors ?? 0) < maxFloorsForType(b.type);
  }

  /**
   * Begin a renovation pass on a finished building: redevelop it one step denser
   * (house->apartment->office->skyscraper) and/or taller. Civic types keep their
   * type but gain floors. The site re-scaffolds until the new height is reached.
   */
  startUpgrade(district, lot, sessionId) {
    const b = lot.building;
    const oldFloors = b.floors || 1;
    lot.upgrades = (lot.upgrades || 0) + 1;
    const seed = b.seed || 1;
    const zone = lot.zone || 'commercial';
    const curRank = densityRank(b.type);
    // Redevelop one density step toward the zone cap; off-chain civic types and
    // already-capped buildings keep their type and just gain floors.
    const nextType = curRank >= 0 && curRank < densityRank(zoneCapType(zone))
      ? DENSITY_CHAIN[curRank + 1]
      : b.type;
    b.type = nextType;
    const ceil = maxFloorsForType(nextType); // each type tops out at its own band
    const typedFloors = floorsForType(nextType, (seed >>> 8) + lot.upgrades);
    b.floors = Math.min(ceil, Math.max(oldFloors + 1, typedFloors));
    b.footprint = footprintForType(nextType, (seed >>> 5) + lot.upgrades);
    b.tier = tierForFloors(b.floors);
    lot.required = requiredFor(b.floors);
    lot.state = 'construction';
    lot.completedAt = null;
    // Resume near the current height so the tower grows rather than resetting.
    lot.progress = Math.min(
      lot.required - 1,
      Math.round((lot.required * oldFloors) / Math.max(1, b.floors))
    );
    if (sessionId) lot.sessionId = sessionId;
    this.emitDelta(district, lot, 'groundbreak');
  }

  /** Top a lot out. Only counts as a new building the first time it completes. */
  finishLot(district, lot) {
    lot.progress = lot.required;
    lot.state = 'complete';
    lot.completedAt = Date.now();
    if (!lot.everCompleted) {
      lot.everCompleted = true;
      district.completedCount += 1;
    }
    this.emitDelta(district, lot, 'complete');
  }

  /**
   * Add work to a session's building. Default is +1 unit from a successful tool
   * use (tool kind is irrelevant); thinking time passes a smaller fractional
   * `amount`. Either way it's pure VOLUME of work — same code path, same growth.
   */
  recordWork({ project, sessionId, amount }) {
    const inc = typeof amount === 'number' && amount > 0 ? amount : TUNING.WORK_PER_TOOL;
    const d = this.ensureDistrict(project);
    let lot = this.lotForSession(d, sessionId);
    // A finished structure + a still-running session: pick a finished, growable
    // building to RENOVATE next (at random). A growable lot's OWN building is a
    // candidate, so a session can keep raising the same one into a skyscraper; a
    // finished park/landfill can't grow, so the crew always moves to a neighbour.
    // If nothing standing can still grow, break new ground so work never vanishes.
    if (lot.state === 'complete') {
      // Prefer finishing an abandoned site, then renovating a finished one,
      // and only break new ground if neither exists — work never vanishes.
      const resume = this.pickResumable(d, `${sessionId}:res:${lot.id}`);
      const target = resume || this.pickUpgradeable(d, `${sessionId}:hop:${lot.id}`);
      if (target) {
        lot = this.rebindSession(d, sessionId, target);
        // A finished building re-scaffolds for a renovation pass; an abandoned
        // mid-build site just keeps accruing work until it tops out.
        if (!resume) this.startUpgrade(d, lot, lot.sessionId);
      } else {
        lot = this.breakGround(d);
        this.rebindSession(d, sessionId, lot);
      }
    }
    lot.progress += inc;
    d.totalWork += inc;
    if (lot.progress >= lot.required) this.finishLot(d, lot);
    else this.emitDelta(d, lot, 'progress');
    this.emit('dirty');
  }

  /** A tool failure — smoke/fire on the session's construction site. */
  recordIncident({ project, sessionId }) {
    const d = this.ensureDistrict(project);
    const lot = this.lotForSession(d, sessionId);
    lot.incidents = (lot.incidents || 0) + 1;
    d.totalIncidents += 1;
    this.emitDelta(d, lot, 'incident');
    this.emit('dirty');
  }

  /** Forget a session's binding once it ends (keeps the map from growing). */
  releaseSession(sessionId) {
    if (sessionId) this.sessionLot.delete(sessionId);
  }

  // ── emit ───────────────────────────────────────────────────────────────────

  /**
   * cityDelta carries the FULL lot record (idempotent apply on the client).
   * District meta (sans lots) rides along on lifecycle events so new
   * districts / annexed blocks reach clients without a snapshot.
   */
  emitDelta(district, lot, event) {
    const msg = {
      type: 'cityDelta',
      seq: this.seqSource.nextSeq(),
      districtKey: district.key,
      lot: { ...lot, building: { ...lot.building } },
      event,
    };
    if (event !== 'progress') {
      const { lots, ...meta } = district;
      msg.district = { ...meta, blocks: [...district.blocks] };
    }
    this.emit('message', msg);
  }
}
