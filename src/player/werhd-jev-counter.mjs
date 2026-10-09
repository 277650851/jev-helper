// What the enemy is actually made of, and which of our options answers it.
//
// The decision layer used to see the enemy only as a NUMBER: `visibleEnemyCount`, `nearbyEnemyCount`
// and `airThreatCount`. `collectState` does collect `visibleEnemies` as unit summaries with ids,
// names, tiles and health, but nothing read the composition, so every choice that depended on "what
// are we actually facing" had to be reduced to a count. That is why the production groups could only
// ever say "build an effective counter" in the abstract, and why a base facing eight conscripts
// behaved the same as one facing four Rhino tanks.
//
// This module turns the visible enemy list into a compact profile: what archetypes are present, how
// much of the threat each carries, what that implies about enemy intent, and -- using the rules'
// `Verses` tables through `effectiveness` -- which of OUR producible options actually hurts the
// observed mix. The profile is small enough to travel with every question.
//
// Everything numeric comes from `api.rules()` at runtime, never from `docs/`. That matters: the rules
// file checked into `docs/` is an EARLY RED ALERT 2 file, not Yuri's Revenge -- it has no Yuri faction
// and none of the YR units -- and there is no `[ArmorTypes]` section in any RA2 rules file. Two
// armour values also changed between that file and real YR: the Kirov went `light` -> `medium` and the
// Flak Trooper `flak` -> `none`. Reading armour off the live rule (as this module does) is therefore
// the only correct source; a table copied out of `docs/` would be wrong for at least those two.
import { effectiveness, currentWeapon } from './werhd-jev-strategy.mjs';

// The 11 armour words in `Verses` index order: None, Flak, Plate, Light, Medium, Heavy, Wood, Steel,
// Concrete, Special_1, Special_2. The list is NOT in any rules INI (there is no `[ArmorTypes]`
// section in the Red Alert 2 rule files); it is documented in the weapon-system dictionary and is
// consistent with the `Verses=` comment block in the rules file. `strategy.mjs` indexes with the same
// order, and `Verses` values are read live from `api.rules()`, so no counter table is hard-coded here.
const ARMOR_ORDER = ['none', 'flak', 'plate', 'light', 'medium', 'heavy', 'wood', 'steel', 'concrete', 'special_1', 'special_2'];
const AIR_ZONE = 1;

// Expected damage per shot into a specific armour, honouring the warhead's `Verses` row. Both spellings
// of the key appear in the wild (`versus` from the API, `verses` after catalog normalisation) and the
// values arrive either as `0.75` or as `75`, so both forms are read. 0/1/2 are flags rather than
// ratios -- 0% cannot fire, 1% force-fire only -- but they are still the smallest multipliers, which
// is what a threat estimate wants.
const versesOf = (w, armor) => {
  const i = ARMOR_ORDER.indexOf(String(armor ?? '').toLowerCase());
  if (i < 0) return 1;
  const v = w?.versus?.[i] ?? w?.verses?.[i];
  if (v === undefined || v === null) return 1;
  return Number(v) > 1 ? Number(v) / 100 : Number(v);
};
// Rate of fire is in frames at 15 fps, so 60/rof is shots per second.
const sum = (n, v) => n + v;
const dps = (rule, armor) => {
  const w = [rule?.weapon, rule?.secondary].filter((x) => x && x.damage > 0);
  if (!w.length) return 0;
  return w.map((x) => x.damage * versesOf(x, armor) * (x.rof ? 15 / x.rof : 1)).reduce(sum, 0);
};

// Armed, mobile, in the air: only weapons with `aa` can answer it.
export function enemyArchetype(rule, unit) {
  if (!rule) return 'unknown';
  if (unit?.type === 2) return rule.isBaseDefense || rule.wall ? 'defense' : 'building';
  if (unit?.zone === AIR_ZONE || rule.aircraft) return 'air';
  if (rule.harvester) return 'harvester';
  if (rule.engineer) return 'engineer';
  if (rule.naval) return 'naval';
  if (unit?.type === 3) return 'infantry';
  if (rule.category === 'AFV' || unit?.type === 7) return 'vehicle';
  return 'other';
}

// One line per archetype present: how many, how much threat, and how tough the toughest sample is.
// `armor` reports the armour word seen most often for a sample unit, which is what the counters are
// matched against.
export function buildEnemyProfile(api, catalog, state, produceOptions = []) {
  const seen = state?.visibleEnemies ?? [];
  const buckets = new Map();
  for (const e of seen) {
    // `name` on a state unit is the localised label; the internal id is `kind`, and that is the
    // catalog key. Looking the rule up by `name` silently classified every unit as unknown.
    const rule = catalog[e?.kind ?? e?.name];
    const kind = enemyArchetype(rule, e);
    const b = buckets.get(kind) ?? { kind, count: 0, names: new Map(), armor: new Map(), threat: 0, maxRange: 0, aa: 0, ag: 0, near: 0 };
    b.count++;
    if (e?.kind) b.names.set(e.kind, (b.names.get(e.kind) ?? 0) + 1);
    // The summary already carries the armour word it was built with; fall back to the rule.
    const armor = e?.armor ?? rule?.armor;
    if (armor) b.armor.set(armor, (b.armor.get(armor) ?? 0) + 1);
    // Threat is measured against the armour this unit actually wears: a weapon's `Verses` row can
    // differ tenfold between armours, so a flat damage-per-second would misrank a base threat.
    const t = dps(rule, armor);
    b.threat += t;
    const w = rule?.weapon;
    if (w?.range > b.maxRange) b.maxRange = w.range;
    if ([rule?.weapon, rule?.secondary].some((x) => x?.aa)) b.aa++;
    if ([rule?.weapon, rule?.secondary].some((x) => x?.ag)) b.ag++;
    buckets.set(kind, b);
  }
  const top = (m) => [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  const groups = [...buckets.values()]
    .map((b) => ({ kind: b.kind, count: b.count, threat: Math.round(b.threat), maxRange: b.maxRange, antiAir: b.aa > 0, antiGround: b.ag > 0, armor: top(b.armor) ?? null,
      names: [...b.names.entries()].sort((a, b) => b[1] - a[1]).slice(0, 4).map(([n, c]) => (c > 1 ? `${n}×${c}` : n)) }))
    .sort((a, b) => b.threat - a.threat || b.count - a.count);

  const airCount = buckets.get('air')?.count ?? 0;
  const infantryCount = buckets.get('infantry')?.count ?? 0;
  const vehicleCount = buckets.get('vehicle')?.count ?? 0;
  const defenseCount = buckets.get('defense')?.count ?? 0;
  const standoff = Math.max(0, ...groups.map((g) => g.maxRange));
  // Our own reach, taken from the rules rather than from the unit objects: a state unit summary keeps
  // the internal id in `kind`, and `currentWeapon` resolves through the catalog.
  const ownRanges = (state?.army ?? []).map((u) => currentWeapon({ name: u?.kind }, catalog)?.range ?? 0);
  const ownMaxRange = ownRanges.length ? Math.max(...ownRanges) : 0;

  // Intent from what is visible, stated as a plain sentence the model can act on. Each branch names
  // the number that produced it, per the rule that numbers in instructions changed behaviour where
  // prose alone did not.
  const intents = [];
  if (airCount) intents.push(`${airCount} enemy aircraft are visible: ground weapons cannot answer them`);
  if (vehicleCount >= 3) intents.push(`${vehicleCount} enemy ground vehicles: anti-armour fire is needed, not riflemen`);
  if (infantryCount >= 4) intents.push(`${infantryCount} enemy infantry: anti-infantry fire and splash damage pay off`);
  if (defenseCount) intents.push(`${defenseCount} enemy defences are in sight: static guns must be out-ranged or bypassed`);
  if (standoff > ownMaxRange && ownMaxRange > 0) intents.push(`enemy weapons reach ${standoff} tiles, ours reach ${ownMaxRange}: we are out-ranged, so close in or answer from beyond`);

  // Which of our producible options actually hurts what is visible. `effectiveness` already applies
  // the rules' Verses table, so this needs no hard-coded counter table.
  const targets = groups.length ? seen : [];
  const counters = produceOptions
    .map((option) => {
      const rule = catalog[option.name];
      if (!rule) return null;
      const value = targets.length ? effectiveness(rule, targets, catalog, api) : 0;
      return value > 0 ? { name: option.name, label: rule.label ?? option.name, value: Math.round(value) } : null;
    })
    .filter(Boolean)
    .sort((a, b) => b.value - a.value)
    .slice(0, 4);

  const kinds = new Set(groups.map((g) => g.kind));
  const label = !groups.length ? 'nothing visible'
    : [...kinds].filter((k) => k !== 'unknown' && k !== 'building').join('+') || 'buildings only';

  return {
    label,
    total: seen.length,
    groups,
    intent: intents.slice(0, 3),
    counters,
    air: airCount, vehicles: vehicleCount, infantry: infantryCount, defenses: defenseCount,
    standoff,
  };
}

// The sentence the production and defence questions carry. Keep it short: the local model reads the
// first part of a question and the state is already the largest thing in it.
export function counterBrief(profile, { includeCounters = true } = {}) {
  if (!profile || !profile.total) return '';
  const parts = [`Opposing force: ${profile.groups.map((g) => `${g.count} ${g.kind}${g.armor ? ` (${g.armor})` : ''}`).join(', ')}.`];
  if (profile.intent.length) parts.push(profile.intent.join('; ') + '.');
  if (includeCounters && profile.counters.length) parts.push(`Best answered with: ${profile.counters.map((c) => `${c.name} (${c.value})`).join(', ')}.`);
  return parts.join(' ');
}
