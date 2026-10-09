// A compact rules catalogue for the scenarios, and the scenarios themselves.
//
// The catalogue is hand-written and small on purpose: it only needs the units a scenario can field, and
// every armour word and weapon figure here was read out of the live overlay rules
// (`C:\ra2web.github.io\res\overlay\rules.ini`) rather than invented, because armour is the index into
// each weapon's 11-value `Verses` row and a wrong word silently mis-scores every counter.
//
// The scenarios are templates, not recordings: a battle report cannot supply a state, because the state
// it archives is a numeric-only summary (see src/replay-state.mjs). They are deterministic and cover the
// situations that change which questions get asked -- opening, economy, mid-game force, a base under
// pressure from standoff fire, an air threat, an infantry wave, and money sitting idle.

const w = (damage, rof, range, versus, extra = {}) => ({ damage, rof, range, versus, ag: true, aa: false, ...extra });
const HE = [1, 0.9, 0.8, 0.7, 0.65, 0.45, 0.75, 0.4, 0.2, 0.8, 1];
const AP = [0.25, 0.25, 0.25, 0.75, 1, 1, 0.65, 0.45, 0.6, 0.6, 1];
const SA = [1, 0.8, 0.7, 0.5, 0.25, 0.25, 0.75, 0.5, 0.25, 1, 1];
const AA = [1, 1, 1, 1, 1, 1, 0, 0, 0, 1, 1];

/**
 * Armour words and figures taken from the live rules file; `category`/`factory` drive group logic.
 * `side` is `'allied'` or `'soviet'` and stands in for the rules' `Owner=` list: without it the build
 * menu would offer a single player both sides' units at once, which is what a scenario must never do --
 * an impossible menu fabricates options that no match could produce, and the benchmark would then be
 * scoring imaginary questions.
 */
export const CATALOG = {
  // --- structures ---
  GACNST: { yard: true, cost: 2500, power: 0, label: 'Construction Yard', armor: 'concrete', factory: 'BuildingType', buildCategory: 'Structure', techLevel: 1 },
  GAPOWR: { power: 200, cost: 800, label: 'Power Plant', armor: 'wood', buildCategory: 'Structure', techLevel: 1 },
  GAREFN: { refinery: true, cost: 2000, label: 'Ore Refinery', armor: 'wood', buildCategory: 'Structure', techLevel: 1 },
  GAPILE: { factory: 'InfantryType', cost: 500, label: 'Barracks', armor: 'wood', buildCategory: 'Structure', techLevel: 1 },
  GAWEAP: { factory: 'UnitType', cost: 2000, label: 'War Factory', armor: 'wood', buildCategory: 'Structure', techLevel: 2 },
  GAAIRC: { factory: 'AircraftType', cost: 1000, power: -50, label: 'Airforce Command HQ', armor: 'steel', buildCategory: 'Structure', techLevel: 3 },
  GATECH: { cost: 2000, power: -100, label: 'Battle Lab', armor: 'wood', buildCategory: 'Structure', techLevel: 8 },
  GADEPT: { cost: 800, power: -25, label: 'Service Depot', armor: 'wood', buildCategory: 'Structure', techLevel: 6 },
  GAPILL: { isBaseDefense: true, cost: 500, label: 'Pillbox', armor: 'steel', weapon: w(50, 26, 5.5, SA), buildCategory: 'Defense', techLevel: 1 },
  NASAM: { isBaseDefense: true, cost: 1000, power: -50, label: 'Patriot Missile System', armor: 'steel', weapon: w(75, 55, 12, AA, { ag: false, aa: true }), buildCategory: 'Defense', techLevel: 3 },
  GAWALL: { wall: true, cost: 100, label: 'Allied Wall', armor: 'concrete', buildCategory: 'Defense', techLevel: 1 },
  // --- allied infantry ---
  E1: { cost: 200, label: 'GI', armor: 'none', factory: 'InfantryType', buildCategory: 'Infantry', techLevel: 1, deployer: true, weapon: w(15, 20, 4, SA), secondary: w(15, 15, 5, [1, 1, 0.7, 0.6, 0.6, 0.6, 0.75, 0.5, 0.25, 1, 1]) },
  GGI: { cost: 400, label: 'Guardian GI', armor: 'none', factory: 'InfantryType', buildCategory: 'Infantry', techLevel: 2, deployer: true, weapon: w(20, 20, 5, SA) },
  ADOG: { cost: 200, label: 'Attack Dog', armor: 'none', factory: 'InfantryType', buildCategory: 'Infantry', techLevel: 1, weapon: w(30, 30, 1.5, [1, 1, 1, 0, 0, 0, 0, 0, 0, 0, 0]) },
  ENGINEER: { cost: 500, label: 'Engineer', armor: 'none', engineer: true, factory: 'InfantryType', buildCategory: 'Infantry', techLevel: 1, weapon: w(0, 0, 0, []) },
  JUMPJET: { cost: 600, label: 'Rocketeer', armor: 'none', factory: 'InfantryType', buildCategory: 'Infantry', techLevel: 3, weapon: w(25, 40, 5, SA, { aa: true }) },
  // --- allied vehicles ---
  MTNK: { cost: 750, label: 'Grizzly Battle Tank', armor: 'heavy', category: 'AFV', factory: 'UnitType', buildCategory: 'Vehicle', techLevel: 2, weapon: w(65, 60, 5, AP) },
  FV: { cost: 600, label: 'IFV', armor: 'light', category: 'AFV', factory: 'UnitType', buildCategory: 'Vehicle', techLevel: 2, weapon: w(25, 20, 6, HE, { aa: true }) },
  SREF: { cost: 1200, label: 'Prism Tank', armor: 'light', category: 'AFV', factory: 'UnitType', buildCategory: 'Vehicle', techLevel: 8, weapon: w(100, 100, 10, [1, 1, 1, 0.75, 0.5, 0.5, 2, 2, 2, 1, 1]) },
  MGTK: { cost: 1000, label: 'Mirage Tank', armor: 'light', category: 'AFV', factory: 'UnitType', buildCategory: 'Vehicle', techLevel: 8, weapon: w(100, 70, 7, [1, 1, 1, 1, 1, 1, 0.3, 0.3, 0.3, 1, 1]) },
  CMIN: { cost: 1400, label: 'Chrono Miner', armor: 'medium', harvester: true, factory: 'UnitType', buildCategory: 'Vehicle', techLevel: 1, weapon: w(0, 0, 0, []) },
  // --- enemy-side kinds the scenarios field ---
  HTNK: { cost: 900, label: 'Rhino Heavy Tank', armor: 'heavy', category: 'AFV', factory: 'UnitType', buildCategory: 'Vehicle', techLevel: 2, weapon: w(90, 65, 5.75, AP) },
  APOC: { cost: 1750, label: 'Apocalypse Tank', armor: 'heavy', category: 'AFV', factory: 'UnitType', buildCategory: 'Vehicle', techLevel: 8, weapon: w(100, 80, 5.75, HE), secondary: w(50, 20, 8, AA, { aa: true }) },
  TTNK: { cost: 1200, label: 'Tesla Tank', armor: 'heavy', category: 'AFV', factory: 'UnitType', buildCategory: 'Vehicle', techLevel: 8, weapon: w(135, 60, 4, [1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 2, 1]) },
  V3: { cost: 800, label: 'V3 Rocket Launcher', armor: 'light', category: 'AFV', factory: 'UnitType', buildCategory: 'Vehicle', techLevel: 4, weapon: w(200, 150, 18, [1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1]) },
  DRON: { cost: 500, label: 'Terror Drone', armor: 'special_1', factory: 'UnitType', buildCategory: 'Vehicle', techLevel: 4, weapon: w(50, 30, 1.83, [1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0]) },
  E2: { cost: 100, label: 'Conscript', armor: 'flak', factory: 'InfantryType', buildCategory: 'Infantry', techLevel: 1, weapon: w(15, 25, 4, SA) },
  FLAKT: { cost: 300, label: 'Flak Trooper', armor: 'flak', factory: 'InfantryType', buildCategory: 'Infantry', techLevel: 2, weapon: w(20, 20, 5, SA, { aa: true }), secondary: w(20, 25, 8, SA, { aa: true, ag: false }) },
  SHK: { cost: 400, label: 'Tesla Trooper', armor: 'plate', factory: 'InfantryType', buildCategory: 'Infantry', techLevel: 4, weapon: w(50, 60, 4, [1, 1, 1, 1, 1, 1, 0.5, 0.5, 0.5, 1, 1]) },
  DESO: { cost: 600, label: 'Desolator', armor: 'plate', factory: 'InfantryType', buildCategory: 'Infantry', techLevel: 4, deployer: true, weapon: w(125, 50, 6, [1, 1, 1, 0.2, 0.1, 0.1, 0, 0, 0, 1, 1]) },
  ZEP: { cost: 2000, label: 'Kirov Airship', armor: 'light', aircraft: true, factory: 'AircraftType', buildCategory: 'Aircraft', techLevel: 8, weapon: w(250, 50, 1.5, [1, 0.85, 0.85, 0.75, 0.65, 0.45, 0.85, 0.75, 0.35, 1, 1]) },
  ORCA: { cost: 1200, label: 'Intruder', armor: 'light', aircraft: true, factory: 'AircraftType', buildCategory: 'Aircraft', techLevel: 4, ammo: 1, weapon: w(150, 10, 6, [1, 1, 1, 1, 1, 1, 1, 1, 0.75, 1, 1]) },
  // Enemy structures that matter to the question logic.
  PENTAGON: { cost: 2000, label: 'Pentagon', armor: 'concrete', factory: 'BuildingType', buildCategory: 'Structure', techLevel: 1 },
  NACNST: { yard: true, cost: 2500, label: 'Soviet Construction Yard', armor: 'concrete', factory: 'BuildingType', buildCategory: 'Structure', techLevel: 1 },
  NAWEAP: { factory: 'UnitType', cost: 2000, label: 'Soviet War Factory', armor: 'wood', buildCategory: 'Structure', techLevel: 2 },
  NAREFN: { refinery: true, cost: 2000, label: 'Soviet Refinery', armor: 'wood', buildCategory: 'Structure', techLevel: 1 },
  TESLA: { isBaseDefense: true, cost: 1500, power: -100, label: 'Tesla Coil', armor: 'steel', weapon: w(200, 120, 7, [1, 1, 1, 0.85, 1, 1, 0.5, 0.5, 0.5, 1, 1]), buildCategory: 'Defense', techLevel: 4 },
  NALASR: { isBaseDefense: true, cost: 500, label: 'Sentry Gun', armor: 'steel', weapon: w(50, 26, 5.5, SA), buildCategory: 'Defense', techLevel: 1 },
};

const u = (id, kind, type, rx, ry, extra = {}) => ({ id, kind, type, tile: { x: rx, y: ry }, hp: 100, hpFraction: 1, idle: true, ...extra });
const TYPE = { aircraft: 1, building: 2, infantry: 3, vehicle: 7 };

// Which side can build what. There is no naming convention to lean on -- `E2`, `FLAKT`, `SHK`, `DESO`,
// `HTNK` and `V3` are all Soviet without an `N` prefix, while `NACNST` and `NALASR` are Soviet with one --
// so the set is written out, taken from the rules file's `Owner=` lists rather than guessed from the id.
const SOVIET = new Set(['NACNST', 'NAWEAP', 'NAREFN', 'TESLA', 'NALASR', 'HTNK', 'APOC', 'TTNK', 'V3', 'DRON', 'E2', 'FLAKT', 'SHK', 'DESO', 'ZEP']);
for (const name of Object.keys(CATALOG)) CATALOG[name].side = SOVIET.has(name) ? 'soviet' : 'allied';

/** Buildings per kind, as the `inventory` a state summary carries. */
const stock = (pairs) => Object.fromEntries(pairs.map(([kind, count]) => [kind, { name: CATALOG[kind]?.label ?? kind, count, role: '' }]));

/**
 * Scenario templates. Each returns a state summary shaped like the one `collectState` produces, which is
 * what `replayApi` consumes. `side` says which build menu the player has, and `vs` names the opponent --
 * the scenarios are all Allied against a Soviet opponent, which is what the archived matches were.
 */
export const SCENARIOS = {
  // Opening: a yard, one power plant, nothing else. The construction group should be asking about the
  // next essential building.
  opening: () => ({
    tick: 900, gameSeconds: 60, credits: 5000,
    power: { total: 200, drain: 0 }, harvesters: 0, base: { x: 20, y: 20 },
    inventory: stock([['GACNST', 1], ['GAPOWR', 1]]),
    army: [], visibleEnemies: [], queues: [],
  }),
  // Economy running: refinery plus two miners, no army yet.
  economy: () => ({
    tick: 2400, gameSeconds: 160, credits: 1800,
    power: { total: 300, drain: 25 }, harvesters: 2, base: { x: 20, y: 20 },
    inventory: stock([['GACNST', 1], ['GAPOWR', 2], ['GAREFN', 1], ['GAPILE', 1], ['GAWEAP', 1]]),
    army: [
      u(11, 'CMIN', TYPE.vehicle, 26, 24), u(12, 'CMIN', TYPE.vehicle, 27, 25),
      u(13, 'ADOG', TYPE.infantry, 22, 22),
    ],
    visibleEnemies: [], queues: [],
  }),
  // Mid game with a small force and a few enemy tanks in sight: the counter profile has something to do.
  midgame_armour: () => ({
    tick: 6000, gameSeconds: 400, credits: 3200,
    power: { total: 400, drain: 100 }, harvesters: 3, base: { x: 20, y: 20 },
    inventory: stock([['GACNST', 1], ['GAPOWR', 3], ['GAREFN', 1], ['GAPILE', 1], ['GAWEAP', 1], ['GAPILL', 2]]),
    army: [
      u(11, 'CMIN', TYPE.vehicle, 26, 24), u(12, 'CMIN', TYPE.vehicle, 27, 25), u(13, 'CMIN', TYPE.vehicle, 28, 24),
      u(20, 'MTNK', TYPE.vehicle, 30, 30), u(21, 'MTNK', TYPE.vehicle, 31, 30), u(22, 'MTNK', TYPE.vehicle, 32, 31),
      u(30, 'E1', TYPE.infantry, 24, 28), u(31, 'E1', TYPE.infantry, 25, 28),
    ],
    visibleEnemies: [u(100, 'HTNK', TYPE.vehicle, 40, 30), u(101, 'HTNK', TYPE.vehicle, 41, 30), u(102, 'HTNK', TYPE.vehicle, 42, 31)],
    queues: [],
  }),
  // A base under standoff fire: V3 launchers are out of reach of everything we own.
  under_standoff: () => ({
    tick: 7000, gameSeconds: 466, credits: 2500,
    power: { total: 400, drain: 150 }, harvesters: 2, base: { x: 20, y: 20 },
    inventory: stock([['GACNST', 1], ['GAPOWR', 3], ['GAREFN', 1], ['GAPILE', 1], ['GAWEAP', 1], ['GAPILL', 1]]),
    army: [
      u(11, 'CMIN', TYPE.vehicle, 26, 24), u(12, 'CMIN', TYPE.vehicle, 27, 25),
      u(20, 'MTNK', TYPE.vehicle, 30, 30), u(30, 'E1', TYPE.infantry, 24, 28),
    ],
    visibleEnemies: [u(100, 'V3', TYPE.vehicle, 34, 30), u(101, 'V3', TYPE.vehicle, 35, 31), u(102, 'HTNK', TYPE.vehicle, 33, 29)],
    queues: [],
  }),
  // An air threat with no mobile anti-air on the field.
  air_threat: () => ({
    tick: 8000, gameSeconds: 533, credits: 4000,
    power: { total: 500, drain: 150 }, harvesters: 3, base: { x: 20, y: 20 },
    inventory: stock([['GACNST', 1], ['GAPOWR', 3], ['GAREFN', 1], ['GAPILE', 1], ['GAWEAP', 1], ['GAPILL', 3]]),
    army: [
      u(11, 'CMIN', TYPE.vehicle, 26, 24), u(12, 'CMIN', TYPE.vehicle, 27, 25), u(13, 'CMIN', TYPE.vehicle, 28, 24),
      u(20, 'MTNK', TYPE.vehicle, 30, 30), u(21, 'MTNK', TYPE.vehicle, 31, 30),
      u(22, 'MTNK', TYPE.vehicle, 32, 30), u(23, 'MTNK', TYPE.vehicle, 33, 30),
    ],
    visibleEnemies: [u(100, 'ZEP', TYPE.aircraft, 38, 30, { zone: 1 }), u(101, 'ZEP', TYPE.aircraft, 39, 31, { zone: 1 })],
    queues: [],
  }),
  // An infantry wave: splash and anti-infantry should outrank anti-armour here.
  infantry_wave: () => ({
    tick: 5000, gameSeconds: 333, credits: 2000,
    power: { total: 300, drain: 100 }, harvesters: 2, base: { x: 20, y: 20 },
    inventory: stock([['GACNST', 1], ['GAPOWR', 2], ['GAREFN', 1], ['GAPILE', 1], ['GAWEAP', 1]]),
    army: [u(11, 'CMIN', TYPE.vehicle, 26, 24), u(12, 'CMIN', TYPE.vehicle, 27, 25), u(20, 'MTNK', TYPE.vehicle, 30, 30)],
    visibleEnemies: [
      u(100, 'E2', TYPE.infantry, 36, 29), u(101, 'E2', TYPE.infantry, 37, 29), u(102, 'E2', TYPE.infantry, 38, 29),
      u(103, 'E2', TYPE.infantry, 36, 30), u(104, 'E2', TYPE.infantry, 37, 30), u(105, 'E2', TYPE.infantry, 38, 30),
      u(106, 'FLAKT', TYPE.infantry, 39, 30),
    ],
    queues: [],
  }),
  // A barracks stands but the base is below its defensive floor, with no threat in sight and only the
  // cheapest tower affordable -- so the defence question is reduced to a single real option. That is the
  // situation two real matches refused 11 times out of 11 and 16 out of 16, and the one where the floor is
  // meant to stop being a question at all. An infantry-only base, which is exactly where a bare base has
  // no other way to hold.
  defense_floor: () => ({
    tick: 4000, gameSeconds: 266, credits: 850,
    power: { total: 300, drain: 25 }, harvesters: 2, base: { x: 20, y: 20 },
    inventory: stock([['GACNST', 1], ['GAPOWR', 2], ['GAREFN', 1], ['GAPILE', 1]]),
    army: [u(11, 'CMIN', TYPE.vehicle, 26, 24), u(12, 'CMIN', TYPE.vehicle, 27, 25), u(20, 'E1', TYPE.infantry, 24, 28)],
    visibleEnemies: [], queues: [],
  }),
  // A campaign objective with the force already at strength: the player asked for a specific building to
  // go down, and the readiness gate is satisfied. Committing to it is the engine's conclusion, not a
  // question -- the objective path used to wait for two model refusals before acting on it.
  objective_ready: () => ({
    tick: 12000, gameSeconds: 800, credits: 4000,
    objective: '摧毁五角大楼',
    power: { total: 600, drain: 150 }, harvesters: 3, base: { x: 20, y: 20 },
    inventory: stock([['GACNST', 1], ['GAPOWR', 4], ['GAREFN', 1], ['GAPILE', 1], ['GAWEAP', 2]]),
    army: [
      u(11, 'CMIN', TYPE.vehicle, 26, 24), u(12, 'CMIN', TYPE.vehicle, 27, 25), u(13, 'CMIN', TYPE.vehicle, 28, 24),
      ...Array.from({ length: 10 }, (_, i) => u(20 + i, 'MTNK', TYPE.vehicle, 30 + (i % 5), 30 + Math.floor(i / 5))),
      u(60, 'E1', TYPE.infantry, 24, 28),
    ],
    visibleEnemies: [u(700, 'PENTAGON', TYPE.building, 48, 48), u(701, 'NALASR', TYPE.building, 47, 48)],
    queues: [],
  }),
  // Money idle with production available and no force at all: the case the money-idle takeover exists for.
  idle_money: () => ({
    tick: 9000, gameSeconds: 600, credits: 12000,
    power: { total: 400, drain: 75 }, harvesters: 3, base: { x: 20, y: 20 },
    inventory: stock([['GACNST', 1], ['GAPOWR', 2], ['GAREFN', 1], ['GAPILE', 1], ['GAWEAP', 1]]),
    army: [u(11, 'CMIN', TYPE.vehicle, 26, 24), u(12, 'CMIN', TYPE.vehicle, 27, 25), u(13, 'CMIN', TYPE.vehicle, 28, 24)],
    visibleEnemies: [], queues: [],
  }),
  // Late game against a fortified Soviet base, with armour and air on our side.
  late_fortified: () => ({
    tick: 14000, gameSeconds: 933, credits: 6000,
    power: { total: 800, drain: 250 }, harvesters: 3, base: { x: 20, y: 20 },
    inventory: stock([['GACNST', 1], ['GAPOWR', 4], ['GAREFN', 1], ['GAPILE', 1], ['GAWEAP', 2], ['GATECH', 1], ['GAAIRC', 1], ['GAPILL', 3], ['NASAM', 2]]),
    army: [
      u(11, 'CMIN', TYPE.vehicle, 26, 24), u(12, 'CMIN', TYPE.vehicle, 27, 25), u(13, 'CMIN', TYPE.vehicle, 28, 24),
      ...Array.from({ length: 8 }, (_, i) => u(20 + i, 'MTNK', TYPE.vehicle, 30 + (i % 4), 30 + Math.floor(i / 4))),
      u(40, 'SREF', TYPE.vehicle, 32, 34), u(41, 'SREF', TYPE.vehicle, 33, 34),
      u(50, 'ORCA', TYPE.aircraft, 28, 36, { zone: 1 }), u(51, 'ORCA', TYPE.aircraft, 29, 36, { zone: 1 }),
      u(60, 'E1', TYPE.infantry, 24, 28), u(61, 'E1', TYPE.infantry, 25, 28),
    ],
    visibleEnemies: [
      u(100, 'NACNST', TYPE.building, 50, 50), u(101, 'NAWEAP', TYPE.building, 52, 50), u(102, 'NAREFN', TYPE.building, 50, 52),
      u(103, 'TESLA', TYPE.building, 48, 50), u(104, 'NALASR', TYPE.building, 49, 51),
      u(110, 'HTNK', TYPE.vehicle, 46, 50), u(111, 'HTNK', TYPE.vehicle, 47, 50), u(112, 'APOC', TYPE.vehicle, 48, 49),
      u(120, 'E2', TYPE.infantry, 47, 52), u(121, 'E2', TYPE.infantry, 48, 52),
    ],
    queues: [],
  }),
};

/** Scenario names in a stable order. */
export const SCENARIO_NAMES = Object.keys(SCENARIOS);
