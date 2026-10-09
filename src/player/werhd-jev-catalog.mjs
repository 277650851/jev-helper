/** Player-side interpretation of effective, public match rules. */
export function refreshCatalog(api, catalog) {
  if (!api.rules) return catalog;
  const items = [...api.production.available(), ...api.units('self'), ...api.units('hostile')];
  const pending = [...items];
  const seen = new Set();
  for (let i = 0; i < pending.length; i++) {
    const { name, type } = pending[i];
    if (seen.has(`${type}:${name}`)) continue;
    seen.add(`${type}:${name}`);
    const rule = api.rules(name, type);
    if (!rule) continue;
    const weapon = (w) => w ? { ...w, verses: Object.assign([], w.versus) } : { damage: 0, range: 0, aa: false, ag: false, verses: [] };
    catalog[name] = {
      ...rule,
      factory: api.FactoryType[rule.factory] === 'None' ? undefined : api.FactoryType[rule.factory],
      buildCategory: api.BuildCat[rule.buildCat],
      armor: api.ArmorType[rule.armor].toLowerCase(),
      yard: rule.constructionYard,
      weapon: weapon(rule.primary), secondary: weapon(rule.secondary),
      aircraft: type === api.ObjectType.Aircraft,
      attackDog: SCOUT_DOG.test(name),
      // A spy has no Weapon= entry at all: rules.ini gives it none because infiltrating an enemy
      // building is the game's own mechanic. It is worth having -- it steals money, power and tech --
      // but it contributes nothing to a defensive line, so it must never be counted as combat infantry.
      spy: /^SPY$/.test(name),
    };
    if (rule.deploysInto) pending.push({ name: rule.deploysInto, type: api.ObjectType.Building });
    if (rule.undeploysInto) pending.push({ name: rule.undeploysInto, type: api.ObjectType.Vehicle });
    if (rule.freeUnit) pending.push({ name: rule.freeUnit, type: api.ObjectType.Vehicle });
  }
  return catalog;
}

// Map decorations are owned by a house and look like buildings, but they have no function:
// flags, lamp posts, pipes, fences, signs. They are never worth attacking or capturing, and an
// army sent at one across a broken bridge stays stuck for the rest of the match.
const DECORATION = /\b(flag|light ?post|lamp|pipes?|fence|sign|statue|tree|barrels?|crates?|billboard|mailbox|hydrant|bench|traffic|telephone|phone booth|debris|rubble|monument|fountain)\b/i;
const functional = (r) => !!r && (r.power > 0 || r.refinery || r.factory || r.constructionYard || r.yard || r.isBaseDefense || r.weapon?.damage > 0 || r.canBeOccupied || r.bridgeRepairHut);

// The scout dog, by rules name: ADOG (Allies) / LDOG (Soviet). The public rules expose no ability
// flag for it, and the name is stable across the rules.ini of both sides, so this is the only handle
// available. It matters for two decisions the player gets wrong without it: it is the cheapest thing to
// send scouting and lose, and it is the unit that notices a Crazy Ivan before the bomb goes off --
// which no amount of defensive gunnery replaces, because the bomb is buried and untargetable.
// `attackDog` is deliberately about the dog, not about "fast": a rules entry for any modded unit whose
// name ends in DOG is treated the same way.
const SCOUT_DOG = /^(?:A|L)DOG\b/i;
export const isAttackDog = (rule, name = rule?.name) => !!rule && SCOUT_DOG.test(String(name ?? ''));
export const isDecoration = (rule, name = rule?.name) => !functional(rule) && DECORATION.test(`${rule?.label ?? ''} ${name ?? ''}`);
// Buildings an engineer can actually take: the standard technology buildings plus anything with a
// working function. Decorations and plain civilian props are left out.
const TECH_NAMES = /^CA(OILD|HOSP|MACH|AIRP|POWR|OUTP|SLAB|ARMY|TECH)/i;
const TECH_LABEL = /\b(tech|oil derrick|derrick|hospital|machine shop|airport|outpost|secret lab|laboratory|power plant|reactor)\b/i;
export const isCapturable = (rule, name = rule?.name) => !isDecoration(rule, name) && (TECH_NAMES.test(name ?? '') || TECH_LABEL.test(rule?.label ?? '') || rule?.power > 0 || !!rule?.refinery || !!rule?.factory || !!rule?.constructionYard);
