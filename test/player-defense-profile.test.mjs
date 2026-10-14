import test from 'node:test';
import assert from 'node:assert/strict';
import { defenseProfile } from '../src/player/werhd-jev-strategy.mjs';

// Every base defense used to reach the model under a label that said nothing about what it did: the
// special layer wrote the same "Build a defensive strongpoint" for a pillbox, a prism tower, a cannon
// and a patriot, and the strategy layer wrote only an effectiveness number. Two options that differ
// solely in a number are not a choice a model can reason about, so it took whichever came first -- the
// cheapest. That is the wrong answer to an armour push and cannot answer an air raid at all.

const pct = (s) => Object.fromEntries(s.split(',').map((v, i) => [i, parseFloat(v) / 100]));
// Rows copied verbatim from docs/rules-规则文件.ini, the rules file vendored into this repository.
const PILLBOX = '100%,100%,100%,100%,80%,80%,100%,60%,60%,100%,100%';
const PRISM = '90%,90%,90%,80%,60%,25%,100%,50%,10%,90%,100%';

test('a defense says what it can hit, how far it reaches, and what it is weak against', () => {
  const prism = defenseProfile({ weapon: { range: 8, aa: false, verses: pct(PRISM) } });
  assert.match(prism, /range 8/, 'the range is stated, so long and short guns can be told apart');
  assert.match(prism, /cannot shoot aircraft/, 'and whether it answers an air raid at all');
  assert.match(prism, /hits .* hard/, 'what it is good against');
  assert.match(prism, /weak vs .*heavy tanks/, 'and what it cannot answer');
  assert.match(prism, /covers the approach from a distance/);
});

test('the pill box and the prism tower are told apart, which is the whole point', () => {
  const pill = defenseProfile({ weapon: { range: 4, aa: false, verses: pct(PILLBOX) } });
  const prism = defenseProfile({ weapon: { range: 8, aa: false, verses: pct(PRISM) } });
  assert.notEqual(pill, prism, 'two different towers must not get the same description');
  assert.match(pill, /range 4/);
  assert.match(prism, /range 8/);
  // The pill box is short and anti-infantry; the prism tower reaches and struggles with armour. Those
  // are opposite answers to the two situations that actually come up.
  assert.match(pill, /must be built next to what it shoots/);
  assert.match(prism, /weak vs .*heavy tanks/);
  assert.ok(!/heavy tanks/.test(pill), 'a pillbox is not described as weak against heavy armour it never meets');
});

test('hard and weak are relative to the weapon own row, because no verse in the rules file exceeds 100%', () => {
  // An absolute threshold cannot work here: the vendored rules file writes percentages topped out at
  // 100, so "above 1.5x" never fires and every tower reads the same. Normalising by the row's own
  // maximum is what separates a flat row from a peaked one.
  const flat = defenseProfile({ weapon: { range: 6, aa: false, verses: pct('100%,100%,100%,100%,100%,100%,100%,100%,100%,100%,100%') } });
  assert.match(flat, /no marked preference/, 'a row with no spread says so instead of inventing a preference');
  assert.ok(!/weak vs/.test(flat));

  const peaked = defenseProfile({ weapon: { range: 8, aa: false, verses: pct(PRISM) } });
  assert.ok(!/no marked preference/.test(peaked), 'a row that varies does not claim to be flat');
});

test('both written shapes of Verses and both of its scales are read', () => {
  // The rules file writes "100%,100%,..." and fixtures write [1,1,...]. verseAt/versesArePercent
  // already handle both; the profile has to go through them rather than reaching into the row, which
  // is the reading error that cost a whole review section once.
  const fromPercent = defenseProfile({ weapon: { range: 8, aa: false, verses: pct(PRISM) } });
  const fromProportion = defenseProfile({ weapon: { range: 8, aa: false, verses: { 0: 0.9, 1: 0.9, 5: 0.25, 8: 0.1 } } });
  assert.match(fromPercent, /heavy tanks/);
  assert.match(fromProportion, /weak vs/, 'the object form parses as well as the percentage string');
});

test('a defense that can shoot aircraft says so, and one that cannot is not left ambiguous', () => {
  assert.match(defenseProfile({ weapon: { range: 7, aa: true, verses: pct(PRISM) } }), /can shoot aircraft/);
  assert.match(defenseProfile({ weapon: { range: 7, aa: false, verses: pct(PRISM) } }), /cannot shoot aircraft/);
});

test('a missing or verseless weapon describes itself instead of throwing', () => {
  assert.doesNotThrow(() => defenseProfile({}));
  assert.doesNotThrow(() => defenseProfile({ weapon: {} }));
  assert.match(defenseProfile({ weapon: { range: 6 } }), /no marked preference/);
});
