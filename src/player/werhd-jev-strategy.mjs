// Ordinary player-side strategy; no engine objects, private map data, or unit-name tables.
const dist = (a, b) => Math.hypot(a.rx - b.rx, a.ry - b.ry);
const hp = u => (u.hitPoints ?? 100) / (u.maxHitPoints || 100);
export const isAirSupport = r => r?.factory === 'AircraftType';
export const ATTACK_FORCE_SIZE = 8;
export const ATTACK_AA_ESCORTS = 2;
// Base defenses to hold once a barracks exists, before the army is large enough to matter. Both
// sides open by raiding, and a bare base loses its miners and its build orders to the first raid.
export const MIN_BASE_DEFENSES = 3;
// Turrets are laid out in this many even sectors around the base, i.e. a triangle for three guns.
export const DEFENSE_SECTORS = 3;
// How many real defence choices the question may offer, walls included. It used to be three
// counter-weapons with the special layer's wall options silently deleted; now that they survive, the
// cap has to cover the whole list, because one multiple-choice question is what the local model reads.
export const DEFENSE_OPTION_CAP = 5;

// Planning and the model share this eligibility set, even before starting cash arrives.
export function vehicleOptions(api, catalog, state) {
  const incomingMiners = state.queues.reduce((n,q)=>n+q.items.reduce((s,i)=>s+
    (catalog[i.name]?.harvester||catalog[i.name]?.refinery ? i.quantity : 0),0),0);
  const aaTarget = Math.min(3,Math.max(2,state.airThreatCount));
  return api.production.available(api.QueueType?.Vehicles ?? 3).flatMap(item=>{
    const r=catalog[item.name];
    if(!r||r.naval||r.engineer||catalog[r.deploysInto]?.yard)return [];
    const economic=r.harvester&&state.harvesters+incomingMiners<(state.economy?.targetMiners??3);
    const combat=!r.harvester&&[r.weapon,r.secondary].some(w=>w?.damage>0&&w.range>=4);
    const antiAir=[r.weapon,r.secondary].some(w=>w?.damage>0&&w.aa);
    const groundPower=antiAir&&r.category==='AFV' ? effectiveness(r,
      [api.ArmorType?.Light??3,api.ArmorType?.Medium??4,api.ArmorType?.Heavy??5].map(armor=>({type:api.ObjectType.Vehicle,armor})),catalog,api):0;
    const airPower=antiAir ? effectiveness(r,
      [api.ArmorType?.None??0,api.ArmorType?.Light??3].map(armor=>({type:api.ObjectType.Aircraft,zone:api.ZoneType?.Air??1,armor})),catalog,api):0;
    const groundCore=groundPower>0&&groundPower>=airPower;
    if(!economic&&!combat)return [];
    if(combat&&state.airThreatCount>0&&state.mobileAntiAirCount<aaTarget&&!antiAir)return [];
    if(combat&&antiAir&&!groundCore&&state.mobileAntiAirCount>=aaTarget)return [];
    if(combat&&state.harvesters<Math.min(2,state.economy?.targetMiners??2)&&!state.baseUnderAttack)return [];
    if(economic&&state.baseUnderAttack&&state.mobileTankCount<5)return [];
    return [{...item,economic,antiAir}];
  });
}

// Reversible deployment selects one slot; ordinary dual-purpose units can use both.
export function activeWeapons(unit, catalog) {
  const rule = catalog[unit.name] ?? {};
  const slots = rule.deployer ? [unit.isDeployed ? 'secondary' : 'weapon'] : ['weapon', 'secondary'];
  return slots.map(slot => {
    const weapon = rule[slot], actual = slot === 'secondary' ? unit.secondaryWeapon : unit.primaryWeapon;
    if (!weapon && !actual) return undefined;
    return { ...weapon, ...(actual ? {
      aa: actual.aa ?? weapon?.aa, ag: actual.ag ?? weapon?.ag,
      range: actual.maxRange ?? actual.range ?? weapon?.range,
      minRange: actual.minRange ?? weapon?.minRange,
    } : {}) };
  }).filter(Boolean);
}

export function currentWeapon(unit, catalog) {
  return activeWeapons(unit, catalog)[0] ?? {};
}

// Can this unit hurt that target, as it stands right now? The predicate this replaces was
// `effectiveness(catalog[unit.name], [target], ...) > 0`, which is wrong in two ways at once: it scans
// BOTH of a rule's weapons regardless of posture, and `activeWeapons` gives a deployable unit only the one
// slot its posture allows. The live rules supply the counterexample: `[GGI]` is mobile with
// `Primary=GuardianPara` (no AA) and deployed with `Secondary=GuardianMissile` (AA), so a moving Guardian GI
// was judged able to shoot down aircraft it cannot fire at. Using the unit's own weapons asks the question
// about the weapon it will actually fire.
export function canUnitHurt(unit, target, catalog, api) {
  return activeWeapons(unit, catalog).some((w) => weaponEffectiveness(w, [target], catalog, api) > 0);
}

export function canFireAt(api, catalog, attacker, target) {
  const weapons = activeWeapons(attacker, catalog).filter(w => weaponEffectiveness(w, [target], catalog, api) > 0);
  if (!weapons.length) return false;
  const actual = api.weaponVs?.(attacker.id, target.id, 'current');
  if (actual) return actual.inRange;
  const d = dist(attacker.tile, target.tile);
  return weapons.some(w => d <= (w.range ?? 0) && d >= (w.minRange ?? 0));
}

// A harvester is a vehicle, not a building, so it never appeared in `buildings` and an enemy shooting
// at one did not make `baseUnderAttack` true. That is the standard opening in Red Alert 2: the
// harvesters are the only income and both sides open by killing them (jev-report 20261008-021015 lost
// its last one with `baseUnderAttack` staying false for 50 of the decisions that followed). A miner
// near the base therefore counts as core infrastructure to defend.
const MINER_DEFENSE_RADIUS = 22;

export function baseThreats(api, catalog, buildings, enemies, harvesters = []) {
  const core = buildings.filter(b => !catalog[b.name]?.wall && !catalog[b.name]?.tickTank && !b.garrison);
  // Only a miner close to the base counts. A harvester working a distant field is doing its job, and
  // treating it as the economic base would move the perimeter out to the ore and leave the base
  // undefended (the forward-garrison rule below).
  const home = core.length ? core[0].tile : undefined;
  const nearMiners = harvesters.filter(h => home && dist(h.tile, home) < MINER_DEFENSE_RADIUS);
  const defended = core.concat(nearMiners);
  return enemies.filter(e => e.primaryWeapon && defended.some(b =>
    weaponEffectiveness(currentWeapon(e, catalog), [b], catalog, api) > 0 &&
    (dist(e.tile, b.tile) < 18 || canFireAt(api, catalog, e, b))));
}

// A blast weapon reaches beyond the unit it aims at. The rules name that radius differently between builds,
// so several field names are probed, and it is read from the runtime weapon object because the API's type
// for a weapon does not declare it. Zero means "no blast", which is what every non-blast weapon returns.
export function splashOf(w) {
  if (!w) return 0;
  for (const k of ['cellSpread', 'area', 'splash', 'spread', 'blast', 'blastRadius', 'areaRange']) {
    const v = w[k];
    if (Number.isFinite(v) && v > 0) return v;
  }
  return 0;
}
// How many of the OTHER targets a blast centred on `target` would also catch, as a multiplier. Only
// infantry is counted: the flat damage model gives vehicles and buildings one hit each, and "a rocket
// landing among six conscripts" is exactly the case it understates -- which is why an anti-infantry
// specialist used to look worse than a tank whose single shot simply does more damage.
//
// The per-shot damage is unchanged for the unit aimed at; what the multiplier expresses is how much total
// damage the shot delivers to the group. Capped at 6 so one very tight cluster cannot dominate every score.
export function splashReach(weapon, target, targets) {
  const radius = splashOf(weapon);
  if (!radius || !targets || targets.length < 2) return 1;
  const at = target?.tile;
  if (!at) return 1;
  let n = 1;
  for (const other of targets) {
    // Identity alone is not enough to skip the unit being aimed at: a caller that rebuilt the target list
    // (the counter profile copies each summary before scoring) passes an equal-but-distinct object, and
    // counting it again would credit the blast with hitting the unit twice. Same unit, same tile and same
    // type is what identifies it, and only one entry may match.
    if (other === target) continue;
    if (other?.type !== 3 || !other?.tile) continue;
    if (other.tile.rx === at.rx && other.tile.ry === at.ry) continue;
    if (Math.hypot(other.tile.rx - at.rx, other.tile.ry - at.ry) <= radius) n++;
  }
  return Math.min(n, 6);
}
export function weaponEffectiveness(w, targets, catalog, api) {
  if (!w) return 0;
  const samples = targets.length ? targets : [{ type: api.ObjectType.Infantry }, { type: api.ObjectType.Vehicle }];
  return samples.reduce((sum, t) => {
    if (t.zone === (api?.ZoneType?.Air ?? 1) ? !w.aa : w.ag === false) return sum;
    const armor = catalog[t.name]?.armor;
    const index = t.armor ?? Object.entries(api.ArmorType ?? {}).find(([k, v]) => /^\d+$/.test(k) && String(v).toLowerCase() === armor)?.[0]
      ?? (t.type === api.ObjectType.Infantry ? (api.ArmorType?.None ?? 0) : (api.ArmorType?.Heavy ?? 5));
    const verses = w.verses?.[index] ?? w.versus?.[index] ?? 1;
    return sum + (w.damage || 0) * verses * 15 / (w.rof || 30) * Math.max(0.5, (w.range || 4) / 5);
  }, 0) / samples.length;
}

export function effectiveness(rule, targets, catalog, api) {
  const weapons = [rule?.weapon, rule?.secondary].filter(Boolean);
  const samples = targets.length ? targets : [{ type: api.ObjectType.Infantry }, { type: api.ObjectType.Vehicle }];
  return samples.reduce((sum,t) => sum + Math.max(0,...weapons.map(w=>weaponEffectiveness(w,[t],catalog,api))),0)/samples.length;
}

// The 11 armour words in `Verses` index order. They are not in any rules INI (there is no `[ArmorTypes]`
// section in the Red Alert 2 files); the order is the weapon-system dictionary's and matches the `Verses=`
// comment block in the rules. `counter.mjs` indexes with the same order.
const ARMOR_WORDS = ['none', 'flak', 'plate', 'light', 'medium', 'heavy', 'wood', 'steel', 'concrete', 'special_1', 'special_2'];
// The armour table of a weapon, read so that both shapes the codebase actually carries work. The runtime
// API declares `versus` as `Record<number, number>` -- an OBJECT keyed by armour index -- and the catalog
// adds `verses` as an ARRAY copy of it (`Object.assign([], w.versus)`). Reading `versus` first and requiring
// an array therefore finds the object, fails the array test, and silently reports "no table" for every real
// rule; `weaponEffectiveness` had it right by preferring `verses`. Both are accepted here, by index, so no
// caller has to know which one it was handed.
export function versesRow(w) {
  const row = w?.verses ?? w?.versus;
  return row ?? undefined;
}
export function verseAt(w, index) {
  const row = versesRow(w);
  if (row === undefined || index === undefined || index < 0) return undefined;
  const v = Array.isArray(row) ? row[index] : row?.[index];
  return v === undefined || v === null ? undefined : Number(v);
}
// Which of the two written forms a row uses, decided from the row as a whole rather than per entry.
// `Verses=25,25,25,75,100,100,...` cannot be read as proportions (the 100s would be 100x damage), and
// `[0.25, 1]` cannot be read as percentages (1 would mean force-fire-only) -- but both are legal here: the
// API documents no scale, the rules files use percentages and most fixtures use proportions. A row with a
// value above 2 can only be percentages.
export function versesArePercent(w) {
  const row = versesRow(w);
  if (row === undefined) return false;
  const values = Array.isArray(row) ? row : Object.values(row);
  return values.some((v) => Number(v) > 2);
}
// Can this rule's weapons be used on that unit at all? `effectiveness` averages a value over the target
// set, which answers "how good is this on average" and not "how much of this enemy can it touch". For
// choosing what to offer against the enemy that is actually visible, the second question is the one that
// matters: a ground-only tank has a nonzero damage figure against aircraft and a tank with no anti-air
// weapon must not be offered as the answer to Kirovs.
//
// 0 always means "cannot fire". 1 and 2 are flags only in the percentage form: a proportional table writes
// full damage as 1, so there it is an ordinary multiplier.
export function canEngageTarget(rule, target, catalog, api) {
  const weapons = [rule?.weapon, rule?.secondary].filter((w) => w && w.damage > 0);
  if (!weapons.length) return false;
  const isAir = target?.zone === (api?.ZoneType?.Air ?? 1) || catalog[target?.name]?.aircraft;
  return weapons.some((w) => {
    if (isAir ? !w.aa : w.ag === false) return false;
    const armor = target?.armor ?? catalog[target?.name]?.armor;
    if (armor === undefined) return true;
    // The armour is either the index itself (a state summary carries the numeric `ArmorType` value) or the
    // word (the catalog lowercases `ArmorType[rule.armor]`). Resolving a number through the word list would
    // miss and be read as "no table" -- an acceptance, not a refusal -- so a valid index is used directly.
    const asIndex = Number(armor);
    const index = Number.isInteger(asIndex) && asIndex >= 0 && asIndex < ARMOR_WORDS.length
      ? asIndex
      : ARMOR_WORDS.indexOf(String(armor).toLowerCase());
    const v = verseAt(w, index);
    if (v === undefined) return true;
    return versesArePercent(w) ? v > 2 : v > 0;
  });
}
// Can this tower answer anything the enemy is actually showing? A ground-only gun offered against an air
// raid is not a choice, it is a decoy: the model may spend on it and it will never fire at what is coming.
// Both defence layers used to add every affordable tower regardless, and their range gates only compared
// against attackers AT the base -- which is nobody in peacetime.
//
// With nobody visible the question cannot be answered from the enemy, so the answer is yes and the caller
// falls back to its own generic scoring.
export function canAnswerVisible(rule, enemies, catalog, api) {
  if (!enemies?.length) return true;
  // Without a weapon there is nothing to judge, and a stub rule (a fixture, or a build whose rules the API
  // did not describe) must not be filtered as a decoy. Only a rule that HAS a weapon and still cannot reach
  // anything the enemy is showing is excluded.
  const weapons = [rule?.weapon, rule?.secondary].filter((w) => w && w.damage > 0);
  if (!weapons.length) return true;
  return counterValue(rule, enemies, catalog, api) > 0;
}
// What this rule would actually do against the units that are visible: summed over each of them rather
// than averaged, so an option that answers the whole force outranks one that answers a corner of it, and
// an option that can answer nothing scores zero.
//
// With NOBODY visible there is nothing to counter, and zero would be wrong in the other direction: the
// engine still has to pick what to build, and a zero score eliminates every option and freezes the plan
// ("six vehicles stayed below the attack gate", the very case that motivated the mobilize plan). So the
// empty case falls back to the generic score against the default infantry/vehicle samples.
export function counterValue(rule, targets, catalog, api) {
  if (!rule) return 0;
  const weapons = [rule.weapon, rule.secondary].filter((w) => w && w.damage > 0);
  if (!weapons.length) return 0;
  if (!targets?.length) return effectiveness(rule, [], catalog, api);
  // The blast bonus is applied HERE, where the whole target list is in hand. It used to sit inside
  // `weaponEffectiveness`, which every one of these callers invokes one target at a time -- so the list it
  // counted neighbours from always had a single element and the term was always 1, making the feature a
  // silent no-op on the very path it was written for.
  return targets.reduce((sum, t) => {
    if (!canEngageTarget(rule, t, catalog, api)) return sum;
    const best = Math.max(0, ...weapons.map((w) => weaponEffectiveness(w, [t], catalog, api)));
    const reach = Math.max(...weapons.map((w) => splashReach(w, t, targets)));
    return sum + best * reach;
  }, 0);
}

export function infantryProfile(rule, api) {
  const infantry = [0,1,2].map(armor=>({type:api.ObjectType.Infantry,armor}));
  const armor = [3,4,5].map(armor=>({type:api.ObjectType.Vehicle,armor}));
  const normal = weaponEffectiveness(rule?.weapon,infantry,{},api);
  const deployed = rule?.deployer ? weaponEffectiveness(rule.secondary,infantry,{},api) : normal;
  const antiInfantry = Math.max(normal,deployed), antiArmor=effectiveness(rule,armor,{},api);
  return {normalInfantry:normal,deployedInfantry:deployed,antiInfantry,antiArmor,
    role:antiArmor>antiInfantry*1.25?'antiArmor':'antiInfantry'};
}

export function scoutScore(rule) {
  return rule && !rule.engineer && rule.category !== 'AirPower' && rule.speed > 0 && rule.cost > 0
    ? rule.speed / Math.sqrt(rule.cost) : 0;
}

const segmentDistance = (p,a,b) => {
  const dx=b.rx-a.rx,dy=b.ry-a.ry,l=dx*dx+dy*dy;
  const t=l?Math.max(0,Math.min(1,((p.rx-a.rx)*dx+(p.ry-a.ry)*dy)/l)):0;
  return Math.hypot(p.rx-a.rx-t*dx,p.ry-a.ry-t*dy);
};

export function trafficClearance(p, buildings, own, catalog) {
  const hubs=buildings.filter(b=>catalog[b.name]?.refinery||catalog[b.name]?.factory==='UnitType');
  if(hubs.some(b=>dist(p,b.tile)<6))return false;
  const refineries=buildings.filter(b=>catalog[b.name]?.refinery);
  for(const miner of own.filter(u=>catalog[u.name]?.harvester)) {
    const refinery=[...refineries].sort((a,b)=>dist(a.tile,miner.tile)-dist(b.tile,miner.tile))[0];
    if(refinery&&dist(refinery.tile,miner.tile)<30&&segmentDistance(p,refinery.tile,miner.tile)<3)return false;
  }
  return true;
}

export function chooseRallySite(api,catalog,own,base,preferred=base?.tile) {
  if(!base)return undefined;
  const buildings=own.filter(u=>u.type===api.ObjectType.Building);
  const points=[];
  for(let dx=-12;dx<=12;dx++)for(let dy=-12;dy<=12;dy++) {
    const p={rx:base.tile.rx+dx,ry:base.tile.ry+dy};
    if(Math.hypot(dx,dy)<6||Math.hypot(dx,dy)>14)continue;
    const tile=api.map.tile(p.rx,p.ry);
    if(!tile||![api.LandType?.Clear??0,api.LandType?.Road??1,api.LandType?.Rough??4].includes(tile.landType))continue;
    if(buildings.some(b=>dist(p,b.tile)<5)||!trafficClearance(p,buildings,own,catalog))continue;
    let inDanger=false;
    for(const e of api.units('enemy') ?? []){
      const r=catalog[e.name] ?? {}, w=[r.weapon,r.secondary].find(x=>x&&(x.damage??0)>0&&x.ag!==false);
      if(w && dist({rx:p.rx,ry:p.ry},e.tile) <= (w.range ?? 0)) inDanger=true;
    }
    points.push({x:p.rx,y:p.ry,score:dist(p,preferred)+dist(p,base.tile)*.1+own.filter(u=>dist(p,u.tile)<3).length,danger:inDanger});
  }
  const safePoints=points.filter(p=>!p.danger);
  return (safePoints.length?safePoints:points).sort((a,b)=>a.score-b.score)[0];
}

export function assessStrategy(api, catalog, snapshot, memory) {
  const { units, buildings, enemies, base } = snapshot.raw;
  const state = snapshot.state, tick = api.tick();
  const core = buildings.filter(b => !catalog[b.name]?.wall && !catalog[b.name]?.tickTank && !b.garrison);
  const threats = baseThreats(api, catalog, core, enemies, units.filter(u => catalog[u.name]?.harvester));
  const defenders = units.filter(u => u.primaryWeapon && !catalog[u.name]?.harvester && base && dist(u.tile, base.tile) < 24);
  memory.pressure ??= { since: tick, lastThreatTick: -10000 };
  const history = memory.pressure;
  if (threats.length) {
    if (tick - history.lastThreatTick > 450) history.since = tick;
    history.lastThreatTick = tick;
    history.approach = { rx: threats.reduce((s, u) => s + u.tile.rx, 0) / threats.length,
      ry: threats.reduce((s, u) => s + u.tile.ry, 0) / threats.length };
  }
  // Each side's weight is the damage its own rule would do to the other side's units. Both calls used to
  // read `effectiveness(catalog[threat.name], threats, ...)` -- the threat's rule scored against the
  // threat list itself, so our power was measured with the ENEMY's weapons and the enemy's was too, and
  // the comparison that decides `suppressed` was between two numbers that both described the enemy.
  const ownPower = defenders.reduce((s, u) => s + effectiveness(catalog[u.name], threats, catalog, api) * hp(u), 0);
  const enemyPower = threats.reduce((s, e) => s + effectiveness(catalog[e.name], defenders, catalog, api) * hp(e), 0);
  const underPressure = threats.length > 0;
  const sustained = underPressure && tick - history.since > 450;
  const suppressed = underPressure && (sustained || threats.length >= 3 && enemyPower > ownPower * 0.8);
  const critical = core.some(b => hp(b) < 0.35 && threats.some(e => dist(e.tile, b.tile) < 8));
  const approach = tick - history.lastThreatTick < 1800 ? history.approach : undefined;
  state.strategy = { underPressure, sustained, suppressed, critical,
    pressureTicks: underPressure ? tick - history.since : 0,
    localStrengthEstimate: Math.round(ownPower), enemyStrengthEstimate: Math.round(enemyPower),
    enemyMix: { infantry: threats.filter(u => u.type === api.ObjectType.Infantry && u.zone !== 1).length,
      vehicles: threats.filter(u => u.type === api.ObjectType.Vehicle && u.zone !== 1).length,
      air: threats.filter(u => u.zone === 1).length },
    approach, reserve: 0, investment: null,
    intent: critical ? '保住核心建筑，紧急反制' : suppressed ? '防御设施稳住阵地，预留科技突破' : '维持经济，推进科技与合成部队' };
  const guns = core.filter(b => catalog[b.name]?.isBaseDefense);
  state.strategy.rangeThreats = threats.filter(e => core.some(b => canFireAt(api, catalog, e, b)) &&
    !guns.some(b => canFireAt(api, catalog, b, e))).map(e => ({ id: e.id, name: e.name,
      range: currentWeapon(e, catalog).range ?? 0, x: e.tile.rx, y: e.tile.ry }));
  memory.strategy = state.strategy;
  return state.strategy;
}

export function chooseBuildingSite(api, catalog, name, own, memory, limit = 200, targets = []) {
  const buildings = own.filter(u => u.type === api.ObjectType.Building && !catalog[u.name]?.wall);
  const base = buildings.find(u => catalog[u.name]?.yard) ?? buildings[0];
  if (!base) return undefined;
  const r = catalog[name] ?? {}, approach = memory.strategy?.approach;
  const defense = r.isBaseDefense || r.wall;
  // A turret is placed around the base, not piled onto whichever side the first one took. Three
  // even sectors a third of a turn apart make a triangle, so the base is covered all round; the
  // sector holding the observed approach is filled first. Walls keep the approach-facing rule.
  const turret = r.isBaseDefense && !r.wall;
  let desired;
  if (turret) {
    const sectorOf = (p) => {
      const a = Math.atan2(p.ry - base.tile.ry, p.rx - base.tile.rx);
      return Math.floor(((a + Math.PI) / (Math.PI * 2)) * DEFENSE_SECTORS) % DEFENSE_SECTORS;
    };
    const counts = new Array(DEFENSE_SECTORS).fill(0);
    for (const u of buildings) if (catalog[u.name]?.isBaseDefense && !catalog[u.name]?.wall) counts[sectorOf(u.tile)]++;
    const fewest = Math.min(...counts);
    const open = counts.map((c, i) => [c, i]).filter(([c]) => c === fewest).map(([, i]) => i);
    const approachSector = approach ? sectorOf(approach) : -1;
    const sector = open.includes(approachSector) ? approachSector : open[0];
    const angle = ((sector + 0.5) / DEFENSE_SECTORS) * Math.PI * 2 - Math.PI;
    // Stand off far enough to fire across an approach but close enough to cover the base itself.
    const radius = Math.max(4, Math.min(10, (r.weapon?.range ?? 5) * 0.7));
    desired = { rx: base.tile.rx + Math.cos(angle) * radius, ry: base.tile.ry + Math.sin(angle) * radius };
  } else {
    const vector = approach ? { x: approach.rx - base.tile.rx, y: approach.ry - base.tile.ry } : { x: 1, y: 1 };
    const length = Math.hypot(vector.x, vector.y) || 1;
    const offset = defense ? Math.min(6, length * 0.5) : -4;
    desired = { rx: base.tile.rx + vector.x / length * offset, ry: base.tile.ry + vector.y / length * offset };
  }
  const candidates = new Map();
  for (const anchor of buildings.slice(0, 12)) for (let dx = -10; dx <= 10; dx++) for (let dy = -10; dy <= 10; dy++) {
    const x = anchor.tile.rx + dx, y = anchor.tile.ry + dy;
    const tile = api.map.tile(x, y);
    if (!tile) continue;
    const p = { rx: x, ry: y };
    if (defense && targets.length && !targets.some(e =>
      weaponEffectiveness(r.weapon, [e], catalog, api) > 0 &&
      dist(p, e.tile) <= (r.weapon?.range ?? 0) && dist(p, e.tile) >= (r.weapon?.minRange ?? 0))) continue;
    // canPlace answers legality; spacing and access are ordinary player strategy.
    if (buildings.some(b => dist(p,b.tile) < (catalog[b.name]?.yard ? 4 : defense ? 3 : 4)) || !trafficClearance(p,buildings,own,catalog)) continue;
    if (r.wall && buildings.some(b => catalog[b.name]?.factory && dist(b.tile, p) < 4)) continue;
    let score = -dist(p, desired) - dist(p, base.tile) * 0.15;
    if (approach && defense) {
      const range = r.weapon?.range || 4, enemyDistance = dist(p, approach);
      score += enemyDistance <= range + 2 ? 6 : -Math.max(0, enemyDistance - range - 2);
      if (enemyDistance < 2) score -= 12;
    }
    candidates.set(`${x},${y}`, { x, y, score });
  }
  for (const p of [...candidates.values()].sort((a, b) => b.score - a.score).slice(0, limit))
    if (api.canPlace(name, p.x, p.y)) return { x: p.x, y: p.y };
  return undefined;
}

export function investmentGroups(api, catalog, snapshot, memory, groups) {
  if (!api.QueueType || !api.canPlace) return;
  const { units, buildings, enemies } = snapshot.raw, s = snapshot.state, strategy = s.strategy;
  const available = api.production.available();
  const ownNames = new Set(buildings.map(u => u.name));
  const queue = type => s.queues.find(q => q.type === type);
  const free = type => { const q = queue(type); return q && !q.size && q.maxSize !== 0; };
  const group = (id, instructions) => groups[id] ??= { instructions, criteria: { wait: 'Wait only if the offered investment is unnecessary or unaffordable.' }, actions: { wait: { type: 'wait' } } };
  const add = (g, item, purpose, minCredits, placement) => {
    const r = catalog[item.name], key = `produce_${item.name}`;
    g.criteria[key] = `${purpose}: ${r.label}; cost ${r.cost}, technology level ${r.techLevel ?? 0}, power ${r.power ?? 0}, weapon range ${r.weapon?.range ?? 0}.`;
    g.actions[key] = { type: 'produce', name: item.name, queue: item.queue, cost: r.cost, minCredits, placement };
  };
  // Add counter-weapons and a firing position to the defence question. This used to REPLACE the
  // group outright (`groups.defenses = {…}`), which silently threw away everything the special layer
  // had put there a moment earlier -- `specialGroups` runs first and offers walls and strongpoints
  // through the same group id. The intent was only to replace generic wall-first *choices*, but a
  // wholesale reassignment also discarded that layer's instructions and criteria, so those options
  // could never reach the model. Attach to the existing group and add to it instead.
  const existingDefenses = groups.defenses;
  const dg = groups.defenses = existingDefenses ?? { instructions: '', criteria: {}, actions: {} };
  // The special layer's text stays: it carries the wall/exits caveat this one does not repeat.
  dg.instructions = 'Counter attackers only with static weapons that can reach them from the supplied legal site. Compare enemy and friendly range: a shorter-range tower is not a counter to a standoff attacker. Use mobile interception or technology when no static counter can reach. Reserve power; walls do not solve a range disadvantage.'
    + (existingDefenses?.instructions ? ` ${existingDefenses.instructions}` : '');
  dg.criteria.wait ??= 'Wait when existing defenses cover the threat or when no effective defense can reach it.';
  dg.actions.wait ??= { type: 'wait' };
  const defenseUnits = buildings.filter(u => catalog[u.name]?.isBaseDefense && !catalog[u.name]?.wall);
  // Once a barracks stands, the base holds a floor of defences whether or not it is under attack:
  // jev-report-20261008-054847 answered wait 82 of 83 defensive turns and built one pillbox, so the
  // first raid met a bare base. The floor only applies while the barracks is up, so power and the
  // opening still come first.
  const hasBarracks = buildings.some(b => catalog[b.name]?.factory === 'InfantryType');
  const defenseFloor = hasBarracks && defenseUnits.length < MIN_BASE_DEFENSES;
  const attackers = baseThreats(api, catalog, buildings, enemies, units.filter(u => catalog[u.name]?.harvester));
  const defenseTargets = strategy.underPressure ? attackers : [];
  const targetDefenses = strategy.underPressure ? (strategy.suppressed ? 6 : 3) : defenseFloor ? MIN_BASE_DEFENSES : 1;
  // What the tower CHOICE is ranked against, which is a different question from what the base is currently
  // defending against. Gating on `underPressure` meant that with no attacker at the walls the ranking fell
  // back to a generic infantry/vehicle average and the visible enemy was ignored -- so a base watching
  // Kirovs approach picked a pillbox, and one watching tanks could pick the anti-air tower. The floor path
  // is exactly this situation: it builds before the raid arrives, which is the point of having a floor.
  //
  // Coverage and placement keep using `defenseTargets`: counting a tower as "covering" an enemy across the
  // map would make the base look defended, and placing against a distant enemy would try to build outside
  // the base.
  const defenseRanking = defenseTargets.length ? defenseTargets : enemies;
  let defensePlan, coverage = 0, floorTagged = false;
  if (s.harvesters >= Math.min(2, s.economy?.targetMiners ?? 2, strategy.underPressure ? 1 : 2) && free(api.QueueType.Armory)) {
    const options = api.production.available(api.QueueType.Armory).filter(i => catalog[i.name]?.isBaseDefense && !catalog[i.name]?.wall)
      // Scored against the attackers that are actually in range, summed rather than averaged, and zero for
      // a tower that cannot engage them. This is what makes the answer to an air raid differ from the
      // answer to a tank push: an anti-air tower holds a nonzero damage figure against tanks and used to
      // outrank or lose to a pillbox by an average that ignored which of them can actually shoot.
      .map(i => ({ ...i, queue: api.QueueType.Armory, value: counterValue(catalog[i.name], defenseRanking, catalog, api) }));
    // "Are we covered?" has to be measured against the same enemy the tower choice is ranked against. The
    // peacetime branch used `counterValue(tower, []) > 0`, which is the GENERIC score -- positive for any
    // armed tower -- so three pillboxes read as COVERED while three Kirovs flew overhead, and the logic that
    // tops up the defences concluded there was nothing to top up. Counting against the visible enemy makes a
    // tower that cannot reach it not count, which is the truth the question needs to carry.
    coverage = defenseUnits.filter(u => defenseRanking.length
      ? defenseRanking.some(e => canFireAt(api, catalog, u, e))
      : counterValue(catalog[u.name], [], catalog, api) > 0).length;
    if (coverage < targetDefenses && (defenseUnits.length < 8 || strategy.underPressure && coverage < 2)) for (const item of options.sort((a, b) => b.value / Math.sqrt(catalog[b.name].cost) - a.value / Math.sqrt(catalog[a.name].cost))) {
      // Cap the whole question, not just this layer's share: the special layer's wall and strongpoint
      // options are already in the group, and the local model reads one multiple-choice list, so the
      // total number of real choices is what has to stay small. Counter-weapons are added first, so a
      // crowded group drops the walls rather than the guns.
      if (Object.keys(dg.actions).filter(k => k !== 'wait').length >= DEFENSE_OPTION_CAP) break;
      if (item.value <= 0) continue;
      // A tower that cannot engage the visible enemy at all is not an option, it is a decoy: offering it
      // invites the model to spend on something that will never fire at what is coming. The gates below
      // compare only against attackers AT the base, and those are empty in peacetime -- so a ground-only
      // pillbox used to be offered as the answer to an air raid it cannot touch.
      if (enemies.length && counterValue(catalog[item.name], enemies, catalog, api) <= 0) continue;
      const r = catalog[item.name];
      if (r.power < 0 && (s.economy?.powerMargin ?? 0) < -r.power) continue;
      // A nearby short-range escort must not disguise an uncovered siege threat.
      if (defenseTargets.some(e => strategy.rangeThreats.some(t => t.id === e.id) &&
        weaponEffectiveness(r.weapon, [e], catalog, api) > 0 &&
        (currentWeapon(e, catalog).range ?? 0) > (r.weapon?.range ?? 0))) continue;
      const reachableThreats = defenseTargets.filter(e => weaponEffectiveness(r.weapon, [e], catalog, api) > 0 &&
        (r.weapon?.range ?? 0) >= (currentWeapon(e, catalog).range ?? 0));
      if (defenseTargets.length && !reachableThreats.length) continue;
      const placement = chooseBuildingSite(api, catalog, item.name, units, memory, 200, reachableThreats);
      if (!placement || s.self.credits < Math.min(200, r.cost)) continue;
      add(dg, item, `${strategy.underPressure ? 'URGENT' : 'PREPARE'}: counter-fire at (${placement.x},${placement.y}), estimated effectiveness ${Math.round(item.value)}; enemy ranges ${reachableThreats.map(e=>currentWeapon(e,catalog).range).join(',') || 'no local target'}`, Math.min(200, r.cost), placement);
      // Below the floor the first one is not a judgement call: the base has a barracks, it is short of the
      // minimum defences, and this tower is affordable -- so the engine builds it rather than asking. It
      // used to be `auto: 2`, i.e. ask, be refused, ask, be refused, then build anyway; two real matches
      // refused the only offered defence 11 times out of 11 and 16 out of 16, which is the same story the
      // money-idle path told. The floor is bounded by MIN_BASE_DEFENSES, so this cannot spend without end.
      // An option another layer already owns is left alone -- it carries its own takeover rule.
      if (defenseFloor && !floorTagged && dg.actions[`produce_${item.name}`]?.engineOwned !== true) { dg.actions[`produce_${item.name}`].engineOwned = true; floorTagged = true; }
      if (strategy.underPressure) defensePlan ??= { name: item.name, cost: r.cost, queue: item.queue };
    }
  }
  // Without a threat this question was answered "wait" every time and cost about a quarter of the
  // tokens of each turn, so it is only asked while the base is under pressure -- or while the base is
  // still below its defensive floor and has a barracks to build from.
  //
  // The one exception is the admission added above: when nothing can be offered, that note IS the answer,
  // and deleting the group would throw it away and leave the model reading a silence as "nothing to worry
  // about".
  const hasOptions = Object.keys(dg.actions).some((k) => k !== 'wait');
  if (!strategy.underPressure && !defenseFloor && !hasOptions) { delete groups.defenses; defensePlan = undefined; }
  const cg = group('construction', 'Restore core infrastructure, then unlock higher technology. During suppression, build a firing line and develop a counter instead of spending forever on basic tanks. Aircraft factories and higher-tech buildings unlock new options. A repair dock is not an airfield.');
  // Keep the technology options this layer rebuilds from rule categories, plus the ones the special
  // layer and the opening plan offer: power, refineries, walls/strongpoints and air support. The filter
  // used to drop everything whose factory was not one of the three ground types, and that silently
  // deleted `isAirSupport` -- which is exactly the `AircraftType` factory -- so the special layer's
  // air-support option could never reach the model even though it carried `auto: 2` and a comment
  // promising it would be queued when the model waited. Two bugs cancelling out: the tag was dead
  // because the option was gone. The option is now kept, so the takeover tag is gone instead, and the
  // model gets the choice.
  for (const [key, a] of Object.entries(cg.actions)) {
    if (a.type !== 'produce') continue;
    const r = catalog[a.name];
    const groundTech = !r?.naval && ['InfantryType', 'UnitType', 'BuildingType'].includes(r?.factory);
    if (!groundTech && !(r?.power > 0) && !r?.refinery && !r?.wall && !r?.isBaseDefense && !isAirSupport(r)) { delete cg.actions[key]; delete cg.criteria[key]; }
  }
  const armorCount = units.filter(u => u.type === api.ObjectType.Vehicle && catalog[u.name]?.category === 'AFV' && !catalog[u.name]?.harvester).length;
  const incomingMiners = s.queues.reduce((n, q) => n + q.items.reduce((sum, i) => sum + (catalog[i.name]?.harvester || catalog[i.name]?.refinery ? i.quantity : 0), 0), 0);
  const economyDeficit = Math.max(0, (s.economy?.targetMiners ?? 3) - s.harvesters - incomingMiners);
  // A missing miner outranks everything else, including fighting back: the harvesters are the only
  // income, so without one the credits can never rise again and nothing built afterwards can be paid
  // for. jev-report 20261008-021015 is what the alternative looks like — credits fell to 0 with
  // HOWI/BGGY/CHAR filling the vehicle queue, and the match then ended with 21,065 credits that
  // could not be spent and no way to earn more.
  const minerUrgent = s.harvesters === 0 && economyDeficit > 0;
  // While the base is contested the usual target is relaxed, but with no miner at all the economy
  // plan is the defence: an army that cannot be paid for cannot hold anything.
  const miner = economyDeficit && (minerUrgent || !strategy.underPressure) && s.economy?.factories && free(api.QueueType.Vehicles)
    ? api.production.available(api.QueueType.Vehicles).find(i => catalog[i.name]?.harvester) : undefined;
  const economyPlan = miner && { name: miner.name, cost: catalog[miner.name].cost, queue: api.QueueType.Vehicles };
  // Enough to pay for the miner is enough. The old floor of 500 was read as "save up to 500 first",
  // which meant that a harvester costing more than the credits on hand was never queued at all.
  if (economyPlan && s.self.credits >= economyPlan.cost) {
    add(groups.vehicles, { ...miner, queue: api.QueueType.Vehicles },
      `ECONOMY FIRST: ${s.harvesters} miners present against a target of ${s.economy?.targetMiners ?? 3}. Harvesters are the only income, so complete this before any other production`,
      economyPlan.cost);
  }
  const standoff = attackers.filter(e => strategy.rangeThreats.some(t => t.id === e.id));
  const mobileCount = units.filter(u => u.type === api.ObjectType.Vehicle && u.primaryWeapon && !catalog[u.name]?.harvester && !catalog[u.name]?.naval && catalog[u.name]?.category !== 'AirPower').length;
  const escortNeeded = s.airThreatCount>0 && s.mobileAntiAirCount<ATTACK_AA_ESCORTS;
  const incompleteForce = mobileCount<ATTACK_FORCE_SIZE || escortNeeded;
  const mobileDefenseNeeded = strategy.underPressure && incompleteForce;
  const forceNeeded = incompleteForce && s.harvesters >= Math.min(2, s.economy?.targetMiners ?? 2) && !economyPlan;
  const groundRole = name => !catalog[name]?.naval && !catalog[name]?.aircraft && catalog[name]?.category !== 'AirPower';
  const mobileOptions = vehicleOptions(api,catalog,s).filter(i=>!i.economic && groundRole(i.name))
    .map(i=>({...i,cost:catalog[i.name].cost,queue:api.QueueType.Vehicles}));
  const counterTargets = standoff.length ? standoff : attackers;
  const counterPurpose = standoff.length ? 'counter_range' : 'counter_pressure';
  let counterPlan;
  if ((standoff.length || mobileDefenseNeeded) && s.harvesters && free(api.QueueType.Vehicles)) {
    const options = mobileOptions
      // Scored against the enemy that is actually visible, summed rather than averaged, and only for the
      // options that can engage it at all. Previously an average over the target set: with one air target
      // in the mix every ground unit lost most of its score, and the ordering came out the same for a tank
      // wave and a conscript wave -- which is the opposite of what a counter planner is for.
      .map(a => ({ ...a, value: counterValue(catalog[a.name], counterTargets, catalog, api) /
        Math.sqrt(catalog[a.name].cost) * ((catalog[a.name].weapon?.range ?? 0) >= Math.max(...counterTargets.map(e=>currentWeapon(e,catalog).range??0)) ? 1.75 : 1) }))
      .filter(a => a.value > 0).sort((a,b) => b.value-a.value);
    const counter = options[0];
    if (counter) {
      counterPlan = { name: counter.name, cost: counter.cost, queue: api.QueueType.Vehicles, category: 'vehicles', purpose: counterPurpose };
      if(s.self.credits>=Math.min(250,counter.cost)) add(groups.vehicles, counter, standoff.length ? 'RANGE COUNTER: intercept exposed base attackers with a mobile counter; close the range gap or return fire at equal range' : 'MOBILE DEFENSE: build the missing mobile response; static guns cannot follow flanking attackers', Math.min(250, counter.cost));
    }
  }
  let forcePlan;
  if(forceNeeded&&!counterPlan&&free(api.QueueType.Vehicles)) {
    const localTargets=attackers.filter(e=>e.zone!==(api.ZoneType?.Air??1));
    const fortifications=armorCount>=4 ? enemies.filter(e=>e.type===api.ObjectType.Building &&
      catalog[e.name]?.isBaseDefense && activeWeapons(e,catalog).some(w=>w.damage>0&&w.ag!==false)) : [];
    const targets=localTargets.length ? localTargets : fortifications;
    const siege=targets===fortifications&&fortifications.length>0;
    const enemyRange=Math.max(0,...fortifications.flatMap(e=>activeWeapons(e,catalog)
      .filter(w=>w.damage>0&&w.ag!==false).map(w=>w.range??0)));
    const item=mobileOptions.map(i=>{
      const rule=catalog[i.name],range=Math.max(0,...[rule.weapon,rule.secondary]
        .filter(w=>w&&w.ag!==false&&weaponEffectiveness(w,targets,catalog,api)>0).map(w=>w.range??0));
      // Same reasoning as the counter plan above: summed over the visible enemy, so what the model is
      // offered to mobilize with follows the force it will meet.
      return {...i,value:counterValue(rule,targets,catalog,api)/Math.sqrt(i.cost)*(siege&&range>enemyRange?1.75:1)};
    })
      .filter(i=>i.value>0).sort((a,b)=>b.value-a.value)[0];
    if(item) {
      forcePlan={name:item.name,cost:item.cost,queue:item.queue,category:'vehicles',purpose:'mobilize',...(siege?{targetRole:'fortifications'}:{})};
      if(s.self.credits>=Math.min(250,item.cost)) add(groups.vehicles,item,`FORM THE ATTACK FORCE: ${mobileCount}/${ATTACK_FORCE_SIZE} mobile combat vehicles; ${escortNeeded?`only ${s.mobileAntiAirCount}/${ATTACK_AA_ESCORTS} required anti-air escorts against observed air threats; `:''}${siege?'counter the visible enemy fortifications using building armor and weapon range; ':''}complete the group before more discretionary towers or technology`,Math.min(250,item.cost));
    }
  }
  const queuedCounter = (strategy.underPressure||forceNeeded) && queue(api.QueueType.Vehicles)?.items.find(i=>groundRole(i.name) && !catalog[i.name]?.harvester && catalog[i.name]?.weapon?.damage>0);
  if (!counterPlan && queuedCounter) counterPlan = { name:queuedCounter.name,
    cost:Math.max(0,queuedCounter.creditsEach*queuedCounter.quantity-queuedCounter.creditsSpent),
    queue:api.QueueType.Vehicles,category:'vehicles',purpose:strategy.underPressure?counterPurpose:'mobilize',pending:true };
  const coreReady = !economyPlan && !forcePlan && !((mobileDefenseNeeded||forceNeeded) && counterPlan) && s.harvesters >= Math.min(2, s.economy?.targetMiners ?? 2) && s.economy?.factories > 0 && (armorCount >= 4 || strategy.suppressed && coverage >= 2 || standoff.length > 0);
  const candidates = available.filter(i => i.type === api.ObjectType.Building && !ownNames.has(i.name))
    .filter(i => { const r = catalog[i.name]; return r && !r.naval && !r.yard && !r.refinery && !r.isBaseDefense && !r.wall && !(r.power > 0) && (isAirSupport(r) || r.buildCategory === 'Tech' && !r.factory); })
    .sort((a, b) => Number(isAirSupport(catalog[b.name])) - Number(isAirSupport(catalog[a.name])) || (catalog[b.name].techLevel ?? 0) - (catalog[a.name].techLevel ?? 0));
  let techPlan;
  if (coreReady && free(api.QueueType.Structures) && !strategy.critical) {
    const item = candidates[0];
    if (item) {
      const r = catalog[item.name];
      techPlan = { name: item.name, cost: r.cost, queue: api.QueueType.Structures };
      if ((s.economy.powerMargin ?? 0) >= Math.max(0, -r.power) && s.self.credits >= Math.min(600, r.cost)) {
        add(cg, { ...item, queue: api.QueueType.Structures }, `${strategy.suppressed ? 'BREAK THE STALEMATE' : 'TECH ADVANCE'}: unlock stronger units, support and defenses; prerequisites ${r.prerequisite?.join(',') || 'already met'}`, Math.min(600, r.cost));
        cg.instructions += ' Prioritize the offered TECH ADVANCE/BREAK THE STALEMATE before duplicating a vehicle factory.';
      } else if ((s.economy.powerMargin ?? 0) < Math.max(0, -r.power)) {
        const power = api.production.available(api.QueueType.Structures).filter(i => catalog[i.name]?.power > 0).sort((a,b) => catalog[a.name].cost-catalog[b.name].cost)[0];
        if (power && s.self.credits >= 300) { techPlan = { name: power.name, cost: catalog[power.name].cost, queue: api.QueueType.Structures }; add(cg, {...power, queue:api.QueueType.Structures}, 'POWER FOR TECH: supply the planned technology and defenses',300); }
      }
    }
  }
  const urgentDefense = strategy.underPressure && coverage < (strategy.critical ? 6 : 2) && defensePlan;
  const mobileFirst = defenseUnits.length >= 2 && (counterPlan || forcePlan);
  const plan = mobileFirst || urgentDefense || counterPlan || economyPlan || forcePlan || techPlan || defensePlan;
  strategy.investment = plan;
  strategy.reserve = plan ? plan.cost + (strategy.critical ? 0 : 250) : 0;
  strategy.hasAirSupport = buildings.some(u => isAirSupport(catalog[u.name]));
  strategy.techChoices = candidates.map(i => i.name);
  strategy.economyDeficit = economyDeficit;
  strategy.escortDeficit = escortNeeded ? ATTACK_AA_ESCORTS-s.mobileAntiAirCount : 0;
  if (economyPlan) strategy.intent = '补足矿车，支撑科技、扩军和海军发展';
  if (plan === counterPlan && counterPlan) strategy.intent = standoff.length ? '机动部队接敌，反制射程外攻击基地的敌人' : '补足机动防守部队，阻止敌军绕过固定炮塔';
  if (plan?.purpose === 'mobilize') strategy.intent = `${plan.targetRole==='fortifications'?'补充攻坚反制':'补齐可出击编队'}：${mobileCount}/${ATTACK_FORCE_SIZE} 辆机动作战单位`;
  if (plan?.purpose === 'mobilize' && escortNeeded) strategy.intent = `补齐随军防空：${s.mobileAntiAirCount}/${ATTACK_AA_ESCORTS}，满足出击条件`;
  memory.strategy = strategy;
  // The separate choice groups share one wallet. Protect the chosen capital budget.
  for (const [id, g] of Object.entries(groups)) for (const [key, a] of Object.entries(g.actions)) {
    if (a.type !== 'produce' || a.name === plan?.name) continue;
    const r = catalog[a.name] ?? {};
    // Income and refining are infrastructure, not a competing combat investment: a miner does not
    // trade off against the reserved tank, it pays for it. Today this cannot be reached -- the plans
    // whose purpose triggers the queue deletion below are the vehicle ones, and they only exist while
    // the base is under pressure, which is also when the miner above is not offered. It is kept as a
    // guard because that coincidence is what makes it safe: the two conditions live in different files.
    const infrastructure = (r.harvester || r.refinery) && !s.strategy.recovery;
    // One queue cannot build the reserved ground reinforcement and an optional
    // helicopter/carrier simultaneously, even when both are affordable.
    if (!infrastructure && ['mobilize','counter_range','counter_pressure'].includes(plan?.purpose) && a.queue === plan.queue) {
      delete g.actions[key]; delete g.criteria[key]; continue;
    }
    // A missing barracks belongs here with power, the first refinery and the first factory: it is
    // the opening's defence, and the reserve must not hold it back.
    const essential = id === 'construction' && (r.power > 0
      || r.factory === 'InfantryType' && !buildings.some(b => catalog[b.name]?.factory === 'InfantryType')
      || r.refinery && !s.economy.refineries
      || r.factory === 'UnitType' && !r.naval && !s.economy.factories);
    if (!essential && s.uncommittedCredits - a.cost < strategy.reserve) { delete g.actions[key]; delete g.criteria[key]; }
  }
  // Now that the shared wallet has had its say, say so if the defence question was emptied. Placing this
  // BEFORE the reserve filter was wrong and looked right: the tower was still present at that point and
  // was removed a moment later for cost, so the check never fired and the group was left as a bare `wait`
  // -- which the model reads as "nothing to defend against". That is the opposite of the truth when the
  // only tower that can answer what is visible is one the base cannot pay for.
  {
    const dg = groups.defenses;
    if (dg && !Object.keys(dg.actions).some((k) => k !== 'wait') && enemies.length && !/No available defence|not affordable yet/.test(dg.instructions)) {
      const towers = api.production.available(api.QueueType.Armory).filter((i) => catalog[i.name]?.isBaseDefense && !catalog[i.name]?.wall);
      if (towers.length) {
        const usable = towers.filter((i) => counterValue(catalog[i.name], enemies, catalog, api) > 0);
        const label = (i) => catalog[i.name]?.label ?? i.name;
        // Two different truths, which the model acts on differently: either nothing on the menu can engage
        // what is visible (so more static guns will never help), or something can but the base cannot pay
        // for it yet (so holding the funds is the answer).
        const note = !usable.length
          ? ` None of the available defences can engage what is visible (${towers.map(label).join(', ')} cannot reach it). Do not wait for these towers: the answer is technology or mobile anti-air, not another static gun.`
          : ` The defence that answers what is visible is not affordable yet (${usable.map((i) => `${label(i)} costs ${catalog[i.name]?.cost}`).join(', ')}; the base holds ${s.self.credits}). Hold the funds for it rather than buying a tower that cannot reach the threat.`;
        dg.instructions += note;
        dg.criteria.wait = `WAIT FOR NOW:${note} Choose wait, and let the production questions answer the threat instead.`;
      }
    }
  }
  // Explain upgraded unit advantages to the model using current target armor, range and rules.
  for (const id of ['vehicles', 'infantry', 'aircraft', 'navy']) {
    const g = groups[id]; if (!g) continue;
    g.instructions += ' Compare effective damage against the current enemy mix, range and technology level. Use newly unlocked counters instead of repeating the cheapest basic unit.';
    // The number printed here has to be the one the choices were ranked with. It used to be
    // `effectiveness`, which averages over the target set and gives credit for targets the unit cannot
    // engage -- so the briefing could rate an option that cannot touch the enemy above one that can, while
    // the engine offered the opposite. A briefing that disagrees with the choice is worse than none.
    for (const [key,a] of Object.entries(g.actions)) if (a.type === 'produce') g.criteria[key] += ` Tech ${catalog[a.name]?.techLevel ?? 0}; effect against the visible enemy ${Math.round(counterValue(catalog[a.name], enemies, catalog, api))}.`;
  }
  if (groups.vehicles && s.harvesters >= Math.min(2, s.economy?.targetMiners ?? 2) && armorCount < 4 && !strategy.investment) {
    groups.vehicles.instructions += ' URGENT: the base has fewer than four mobile armored units. Build the offered combat reinforcement now when affordable; do not wait for an unplanned future technology investment.';
    groups.vehicles.criteria.wait = 'Wait only while the queue is busy or none of these reinforcements is affordable. There is no reserved capital project now; an idle affordable queue leaves the base exposed.';
  }
  recoveryGroups(api, catalog, snapshot, groups, memory);
  operationalGoals(api, catalog, snapshot, groups, memory);
}

function operationalGoals(api, catalog, snapshot, groups, memory = {}) {
  const { units } = snapshot.raw, s = snapshot.state;
  const ground = units.filter(u => u.type === api.ObjectType.Vehicle && u.primaryWeapon && !catalog[u.name]?.harvester && !catalog[u.name]?.naval && catalog[u.name]?.category !== 'AirPower');
  const aircraft = units.filter(u => catalog[u.name]?.aircraft && u.type !== api.ObjectType.Building);
  const escalation = s.combatAssessment?.level ?? 0;
  const target = Math.min(24, Math.max(12, Math.ceil((s.nearbyEnemyCount ?? 0) * 1.5)) + 4 * escalation);
  s.objective = memory.objective ? `Mission objective: ${memory.objective}. Find and destroy what the objective names; do not merely survive near our own base.` : 'Win this skirmish by finding and destroying the enemy base, not merely surviving near our own base.';
  s.forceGoal = { groundCombatVehicles: { current:ground.length, target }, aircraft:{current:aircraft.length,target:4},
    attackThreshold:s.forceReadiness?.threshold ?? ATTACK_FORCE_SIZE, ready:s.forceReadiness?.ready ?? false, mobileAntiAir:{current:s.mobileAntiAirCount,attackMinimum:s.airThreatCount>0&&(s.forceReadiness?.aaProducible??true)?ATTACK_AA_ESCORTS:0},
    enemyBaseKnown:!!s.knownEnemyBuildings?.length, reserve:s.strategy.reserve };
  s.decisionReadiness = {};
  for (const [id, queueType, current, desired] of [
    ['vehicles',api.QueueType.Vehicles,ground.length,target],['aircraft',api.QueueType.Aircrafts,aircraft.length,4],
  ]) {
    const g=groups[id]; if (!g) continue;
    if (escalation) g.instructions += ` REINFORCE (escalation ${escalation}): attacks are failing; build toward ${desired} before the next assault and prefer units effective against the observed enemy mix over more of the same.`;
    const q=s.queues.find(q=>q.type===queueType);
    const candidates=Object.values(g.actions).filter(a=>a.type==='produce');
    const affordable=candidates.filter(a=>s.uncommittedCredits-a.cost>=s.strategy.reserve);
    const needed=current<desired;
    if (id === 'vehicles' && ['counter_range','counter_pressure','mobilize'].includes(s.strategy.investment?.purpose)) {
      const plan = s.strategy.investment;
      s.decisionReadiness[id] = { queueIdle: !q?.size, priority: plan.purpose, target: plan.name,
        minimumStartingCredits: Math.min(250, plan.cost), waitingSupported: !!q?.size || s.self.credits < Math.min(250,plan.cost) };
      g.instructions += ` MOBILE COUNTER FIRST: ${plan.name} is the reserved investment. Complete the ${ATTACK_FORCE_SIZE}-vehicle force and, when air threats are visible, at least ${ATTACK_AA_ESCORTS} mobile anti-air escorts so it can defend and then attack. Static guns cannot pursue flanking troops. Start it at the supplied minimum budget; protect any counter already in production and do not divert this reserve to more towers or technology.`;
      g.criteria.wait = 'Wait only if the counter is queued, unavailable, or its minimum starting credits are missing.';
      continue;
    }
    if (id === 'vehicles' && catalog[s.strategy.investment?.name]?.harvester) {
      const plan = s.strategy.investment;
      s.decisionReadiness[id] = { queueIdle: !q?.size, current: s.harvesters, target: s.economy?.targetMiners ?? 3,
        deficit: s.strategy.economyDeficit, priority: 'economy', affordableCandidates: candidates.filter(a => a.name === plan.name && s.uncommittedCredits >= a.cost).map(a => a.name),
        waitingSupported: !!q?.size || !candidates.some(a => a.name === plan.name) };
      g.instructions += ` ECONOMY FIRST: ${s.harvesters} miners are present; the target is ${s.economy?.targetMiners ?? 3}. The reserved investment is ${plan.name}, not a combat unit. Produce the offered miner now; defer discretionary army expansion until this economic deficit is filled.`;
      g.criteria.wait = 'Wait only if the miner is already queued or unavailable, or its minimum starting budget is unavailable. Do not reserve this miner budget forever without starting the miner.';
      continue;
    }
    const blocked=s.strategy.recovery || s.harvesters<Math.min(2,s.economy?.targetMiners??2) || q?.size>0 || !affordable.length;
    s.decisionReadiness[id]={queueIdle:!q?.size,current,target:desired,deficit:Math.max(0,desired-current),
      credits:s.self.credits,committedCredits:s.committedCredits,reserve:s.strategy.reserve,
      affordableCandidates:affordable.map(a=>a.name),waitingSupported:!needed||!!blocked};
    if (!needed || blocked) continue;
    g.instructions += id==='vehicles'
      ? ` Choose the next vehicle to win by destroying the enemy base. Our attack force target is ${desired} ground combat vehicles, but only ${current} are present. The factory is idle and the listed affordableCandidates can be paid for after preserving ${s.strategy.reserve} credits for capital projects. Build a useful combat vehicle now to reach the force target. Prefer effective newly unlocked weapons and range; keep anti-air escorts. Waiting has no benefit while the army is below target and funds are plentiful.`
      : ` Prepare a ${desired}-aircraft wing for scouting and concentrated strikes to find and destroy the enemy base. Only ${current} aircraft exist; the queue is idle and production is affordable after reservations. Build an offered aircraft now, even when enemies are out of sight. Use ready aircraft to scout or strike, and let empty aircraft rearm.`;
    g.criteria.wait=`Wait only if the queue is busy, no useful unit is affordable after the ${s.strategy.reserve}-credit reservation, or the ${desired}-unit force is already assembled. Current count ${current}, uncommitted credits ${s.uncommittedCredits}.`;
    for(const [key,a] of Object.entries(g.actions)) if(a.type==='produce' && !catalog[a.name]?.harvester)g.criteria[key]+=` Build-up deficit: ${desired-current}; this production advances the winning force, even without a currently visible enemy.`;
  }
}

function recoveryGroups(api, catalog, snapshot, groups, memory) {
  const { units, buildings } = snapshot.raw, s = snapshot.state;
  const hasYard = buildings.some(u => catalog[u.name]?.yard);
  const refineryCount = buildings.filter(u => catalog[u.name]?.refinery).length;
  const miners = units.filter(u => catalog[u.name]?.harvester).length;
  // A base that never had a refinery is starting, not recovering. The opening is power, barracks,
  // refinery — the game's own AI order — and forcing the refinery first deleted the power plant and
  // barracks options every turn, so the base opened with income and no way to defend it.
  // Recovery applies to a refinery that was lost, which is what `seenRefinery` records.
  if (refineryCount > 0 && memory) memory.seenRefinery = true;
  const lostRefinery = !!memory?.seenRefinery;
  if (hasYard && refineryCount && miners || !buildings.length) return;
  const builder = units.find(u => catalog[catalog[u.name]?.deploysInto]?.yard);
  const miner = refineryCount && !miners && api.production.available(api.QueueType.Vehicles).find(i => catalog[i.name]?.harvester);
  if (!hasYard && builder && !miner) return;
  // Nothing to rebuild: no miner missed and no refinery lost. A missing yard (or a deployable
  // construction vehicle) still falls through, because that is the base itself.
  if (!miner && hasYard && !lostRefinery) return;
  const queue = miner ? api.QueueType.Vehicles : hasYard ? api.QueueType.Structures : api.QueueType.Vehicles;
  const candidate = miner || api.production.available(queue).find(i => hasYard ? catalog[i.name]?.refinery : catalog[catalog[i.name]?.deploysInto]?.yard);
  if (!candidate) return;
  const r = catalog[candidate.name];
  const category = queue === api.QueueType.Structures ? 'construction' : 'vehicles';
  const targetQueue = s.queues.find(q=>q.type===queue);
  const pending = targetQueue?.items.find(i=>i.name===candidate.name);
  const required = pending ? Math.max(0,pending.creditsEach-pending.creditsSpent) : r.cost;
  s.strategy.intent = miner ? '恢复矿车，解除收入中断' : hasYard ? '恢复矿场，解除收入中断' : '重建基地车，恢复建造能力';
  s.strategy.recovery = true;
  s.strategy.investment = {name:candidate.name,cost:required,queue,category};
  s.strategy.reserve = required;
  for (const g of Object.values(groups)) for (const [key,a] of Object.entries(g.actions)) if (a.type==='produce' && a.name!==candidate.name) {
    delete g.actions[key]; delete g.criteria[key];
  }
  if (!targetQueue?.size && s.self.credits >= Math.min(500,required)) {
    const key=`recover_${candidate.name}`;
    groups[category].criteria[key]=`SURVIVAL: rebuild ${r.label} to restore ${miner || hasYard?'ore income':'construction'}. Cost ${r.cost}; stop discretionary investment until recovery completes.`;
    // Survival rebuilds are never optional: after two declined turns the executor builds it anyway.
    groups[category].actions[key]={type:'produce',name:candidate.name,queue,cost:r.cost,minCredits:Math.min(500,required),auto:2};
  }
  if (s.self.credits >= required) return;
  const g=groups.salvage ??= {instructions:'Recover a destroyed economy or construction capability. Cancel discretionary spending and sell expendable technology to fund recovery. Preserve the factory and all prerequisites needed to rebuild.',criteria:{wait:'Wait only when no safe liquidation is available.'},actions:{wait:{type:'wait'}}};
  g.instructions='URGENT ECONOMIC RECOVERY: income or construction is gone and recovery is underfunded. Cancel optional spending or sell a nonessential technology building. Keeping unused high technology without a functioning miner-and-refinery chain will lose the match. Preserve recovery prerequisites.';
  for (const q of s.queues) for (const item of q.items) if (item.name!==candidate.name && item.creditsSpent>0) {
    const key=`cancel_${item.name}`;
    g.criteria[key]=`Cancel ${item.name}, releasing its ${item.creditsSpent} paid credits to fund ${candidate.name}.`;
    g.actions[key]={type:'cancel',name:item.name,queue:q.type};
  }
  for (const b of buildings) {
    const rule=catalog[b.name];
    if (!rule || rule.unsellable || rule.yard || rule.refinery || rule.power>0 || rule.factory==='UnitType' || r.prerequisite?.includes(b.name) || b.garrison?.count) continue;
    const key=`recover_sell_${b.id}`;
    g.criteria[key]=`Sell expendable ${rule.label} #${b.id} to finance ${candidate.name}; original cost ${rule.cost}.`;
    // Same automatic fallback as the rebuild this pays for. With income already at zero the sell is
    // the only way back, so leaving it entirely to a model that answers "wait" at near-zero
    // confidence is how a match is lost with money unspent and units idle.
    g.actions[key]={type:'sell',objectId:b.id,auto:2};
  }
}
