# Match reports

Evidence, not source. Nothing here is read at runtime; it is kept because match reports have been
lost three times (214501, 223656 and 002250 were all deleted from `Downloads` mid-investigation) and
every attribution question so far has been answerable only from a report nobody could open again.

A report is a few hundred KB and is written by the dashboard's export button at the end of a match.

What each report is good for:

- `entries[].state` on a `decision` entry carries the **full state as sent to the model**, including
  `credits` and `harvesters`. That makes the credit series recoverable without `--dump-states`, which
  is worth knowing: two of the three capture requests made during the 0.7.5 work would not have been
  needed.
- `entries[].groups.<group>.options` records the option keys and `probabilities`, so "how many options
  did the model actually see" is answerable after the fact. `criteria` is not stored.
- `match.credits` carries only start/end/max/min, never a series.
- Entry kinds are `meta`, `start`, `session`, `decision`, `action`, `camera`, `place`, `observed`,
  `micro`, `outcome`, `stop`. **Orders are not recorded at all** -- an absence of attack actions is
  not evidence that no attack happened, which is a mistake worth not repeating.

## 20261010-005106

18.4 game minutes, defeat, Allied. Credits ended at 5,741 with an army peak of 8 and one Rhino tank
built. This is the match that located the `RICH_SPEND` floor: of 26 vehicles questions, 18 were asked
with the balance below 5,000, and the base declined an affordable 750-credit tank seventeen times
inside that band.

Replay it with `node tools/…` -- or read `moneyIdle` in `src/player/werhd-jev-player.mjs`, whose
comment quotes the numbers.
