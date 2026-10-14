// What a unit or building is FOR, one line each.
//
// The model is shown a list of what it may produce (the candidate groups are built from
// `production.available()`), and each candidate already carries its cost, speed, count and its
// armour-adjusted score against what is visible. What it did not carry was the thing a player knows
// without reading a manual: this is an anti-air unit, this one is for breaking buildings, this one exists
// to kill miners. `docs/ra2-unit-catalog.md` has that column (特性 / 优点 / 缺点) for every unit in the
// game; this is the part of it that a single decision can use, in the language the rest of the prompt is
// written in.
//
// Deliberately data-only and small: one lookup, no game state, so it can be tested without a match and
// cannot throw on a unit nobody has heard of. An unknown name returns `undefined` and the caller keeps
// whatever text it had -- a missing note is a gap, never a wrong claim.
//
// Only the strengths and the failure mode, not the whole row: the head budget is 512 tokens with every
// option in it (`node tools/laya-ctl.cmd status` prints "option budget: 512 tokens"), so a note that
// doubles the length of each option would crowd out the alternatives it is meant to help rank.
export const UNIT_PURPOSE = {
  // Infantry
  E1: 'deployable rifleman; strong against infantry and light armour once deployed, cannot hit aircraft',
  E2: 'cheap conscript; mass-produced early harassment, fragile against vehicles',
  GGI: 'deployable missile trooper; anti-tank and anti-air once deployed, weak on the move',
  GUARDIANGI: 'deployable missile trooper; anti-tank and anti-air once deployed, weak on the move',
  ADOG: 'attack dog; kills infantry and engineers outright, cannot hurt vehicles or buildings',
  DOG: 'attack dog; kills infantry and engineers outright, cannot hurt vehicles or buildings',
  ENGINEER: 'engineer; captures or repairs buildings, no weapon and very fragile',
  JUMPJET: 'flying infantry; raids power plants and miners behind the lines, thin against anti-air',
  GHOST: 'SEAL; C4 destroys buildings and shreds infantry, almost useless against tanks',
  TANYA: 'hero; C4 demolishes buildings and kills infantry instantly, negligible against tanks',
  IVAN: 'plants a timed bomb on a unit or building; weak in a straight fight and the bomb can be defused',
  CIVAN: 'teleporting Ivan; plants a bomb inside the enemy base, very fragile',
  SNIPE: 'sniper; outranges and one-shots infantry, cannot touch vehicles or buildings',
  FLAKT: 'flak trooper; the anti-air infantry, splashes infantry, poor against ground armour',
  DESO: 'desolator; deploys a radiation field that shreds infantry, and it does not spare our own',
  SHK: 'tesla trooper; heavy damage to tanks and buildings, slow and no anti-air',
  YURI: 'mind control; takes one enemy unit, dies to dogs',
  // Vehicles
  MTNK: 'Grizzly; the Allied main battle tank, good early, outclassed later',
  HTNK: 'Rhino; the Soviet main battle tank, balanced and the mid-game backbone',
  MGTK: 'Mirage; ambushes armour while stationary, needs to stay still and cannot hit aircraft',
  FV: 'multipurpose IFV; weapon follows its passenger, so it can be anti-air, repair or anti-tank',
  TNKD: 'tank destroyer; long-range anti-tank, nearly useless against infantry and buildings',
  SREF: 'prism tank; long range and multiplies in numbers, very fragile up close',
  GATTTANK: 'gattling tank; spins up against infantry and aircraft, weak against heavy armour',
  APOC: 'Apocalypse; heavy dual cannon and anti-air, very slow and very expensive',
  V3: 'V3 launcher; outranges base defences, unarmed itself and its rockets can be intercepted',
  DRON: 'terror drone; fast, eats tanks, and dies to anything that shoots it',
  TTNK: 'tesla tank; chain-lightning against clustered armour, short range and no anti-air',
  IFV: 'multipurpose IFV; weapon follows its passenger, so it can be anti-air, repair or anti-tank',
  CMIN: 'chrono miner; our income, teleports home to a refinery when threatened, unarmed',
  HARV: 'war miner; our income, armed with a machine gun but slow',
  HORV: 'war miner; our income, armed with a machine gun but slow',
  CMON: 'chrono miner; our income, teleports home to a refinery when threatened, unarmed',
  // Buildings
  GAREFN: 'ore refinery; turns mined ore into credits and comes with its first miner',
  NAREFN: 'ore refinery; turns mined ore into credits and comes with its first miner',
  GAPOWR: 'power plant; everything else stops without it',
  NAPOWR: 'power plant; everything else stops without it',
  GAPILE: 'barracks; unlocks and produces infantry',
  NAHAND: 'barracks; unlocks and produces infantry',
  GAWEAP: 'war factory; unlocks and produces vehicles',
  NAWEAP: 'war factory; unlocks and produces vehicles',
  GATECH: 'battle lab; unlocks the top-tier Allied units and upgrades',
  NATECH: 'tech lab; unlocks the top-tier Soviet units and upgrades',
  GAAIRC: 'air force command; unlocks and produces aircraft',
  GAPILL: 'pillbox; cheap anti-infantry defence, cannot hit aircraft',
  NASAM: 'patriot missile; anti-air defence, cannot hit ground',
  GADEPT: 'service depot; repairs vehicles and is where a miner dumps ore',
  GAOREP: 'ore purifier; raises the credits every load of ore is worth',
  INDUSTRIALPLANT: 'industrial plant; every vehicle afterwards costs less',
  CAOILD: 'tech oil derrick; capture it and it pays credits for the rest of the match',
};

/** One line on what this is for, or `undefined` when the catalog doc has no row for it. */
export const unitPurpose = (name) => UNIT_PURPOSE[String(name ?? '').toUpperCase()] ?? undefined;

/** `Role: <one line>` for a prompt, or `''` so a caller can concatenate unconditionally. */
export const purposeLine = (name) => {
  const p = unitPurpose(name);
  return p ? ` Role: ${p}.` : '';
};
