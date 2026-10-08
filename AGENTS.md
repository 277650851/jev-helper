# AGENTS.md

Chrome MV3 extension (autopilot for the RA2 web client) **plus** a local Laya decision server,
shipped together as an **offline deployment bundle**. Docs and user-facing strings are Chinese.

## Traps that will waste your time

- **`npm test` is a no-op here.** It is `npm run build && node --test test/*.test.mjs`, but the
  `test/` directory is **not in this bundle**. It prints `tests 0` and **exits 0**. Never treat it
  as verification; assert behaviour yourself (preview fixtures, `laya-ctl.cmd test`, or the dump
  tools below).
- **`npm run build` deletes `dist/` first** (`tools/build.mjs` does `fs.rm('dist',{recursive:true})`).
  `dist/` is the shipped, loadable artifact in this offline bundle. Rebuild only when you intend
  to replace it, and check `git status` for unrelated pre-existing untracked files first.
- **Three version numbers, deliberately equal at `0.7.5`:** `package.json` (bundle),
  `public/manifest.json` (Chrome extension), `src/page.mjs` `VERSION` (page-script identity guard for
  hot-reinjection). They used to drift and were pinned together on request — keep them together when
  bumping, and bump all three, or Chrome refuses the update and the page guard stops firing.
- **`.cmd` files must stay ASCII-only.** `cmd.exe` reads batch in the OEM code page; UTF-8 in a
  `rem` line decodes to garbage and can split into commands that then execute (see the comment
  block in `run-baseline.cmd`). The `.ps1` scripts and console output are UTF-8 and render as
  mojibake under a non-UTF-8 code page — that is cosmetic, not a bug.
- **No lint, typecheck, formatter, or CI config exists.** Don't add a "fix typecheck" task; there is
  nothing to run. Node >= 20 (`.mjs` everywhere, `type: module`).

## Commands

```bash
npm run build                 # esbuild -> dist/  (destructive, see above)
npm run package               # build + hand-rolled zip -> artifacts/werhd-jev-extension-<ver>.zip
node tools/preview.mjs        # UI fixtures at http://127.0.0.1:4318/ (no npm script; needs dist/)
node tools/analyze-log.mjs <jev-log.json | laya-decisions.ndjson>
python tools/laya-state-report.py <dumpDir> [--variants]   # only works on --dump-states captures
tools\laya-ctl.cmd status|start|stop|restart|test|logs|fetch   # == npm run laya:win -- <cmd>
```

`npm run laya` (sh, `tools/laya-server.sh`) is the **macOS/Apple-silicon MLX** path and needs a
sibling `../laya-vs-jev` checkout. On this Windows bundle the real path is `laya-ctl.cmd`
(`.laya-venv` + torch CPU + `tools/laya-serve-local.py`).

**Operational gotcha:** `manage-laya.cmd` (the interactive menu) takes the server down with it when
its window closes. `tools\laya-ctl.cmd` and `run-slim.cmd` start a server that survives.

**Play on `run-slim.cmd` (`--slim-state`); there is no full-state mode.** The full state is ~6495
tokens against a 1024-token context, so *every* question is truncated and `army`, `queues`,
`economy`, `strategy`, `forceReadiness` are cut 100% of the time — the model literally cannot see
whether the build queue is empty. `jev-report-20261009-052739` is what that costs: vehicle queue
empty for 20.6 minutes, 4–5k credits, a 750-credit tank on offer, `wait` chosen 29 of 29 times, one
tank built, base lost. Slim is 533 tokens / sequence 744 and keeps `queues` and `forceReadiness`
visible. `--priority-state` and `--compact-units` do **not** substitute — measured alone they stay
pinned at the 1024 cap; only `--slim-state` fits.

**State-capture rule:** `--dump-states` only records `preparedState` when a state-shaping flag is on,
so a capture taken without one describes the *full* arm no matter what the server was running. The
older `.preview/states-armA-full` and `.preview/states-armB-slim` directories predate that fix and
both describe the full arm — do not read them as an A/B. Slim captures go to `.preview/states-slim`.

## Architecture

Four bundles, two output formats, two JS worlds:

| Entry | World | Role |
|---|---|---|
| `src/background.mjs` → `background-core.mjs` | service worker (ESM) | all chrome.* wiring; `createBackground(chrome, {fetchImpl,now,uuid})` is injectable for testing |
| `src/content.mjs` | **ISOLATED** (IIFE) | bridge + overlay + hotkey; talks to background over `chrome.runtime` |
| `src/page.mjs` | **MAIN** (IIFE) | owns the player; talks to the game via `window.werhd` |
| `src/popup.mjs`, `help.mjs`, `dashboard.mjs` | extension pages (ESM) | UI |

- **Do not add `page.js` to `manifest.json`.** It is injected at runtime by
  `chrome.scripting.executeScript({world:'MAIN', files:['page.js']})`, which is why there are no
  `web_accessible_resources`. `content.js` is both declared in the manifest and re-injected.
- **Singleton replacement is deliberate.** `content.mjs` calls
  `globalThis.__werhdJevContent?.dispose?.()` before installing itself, because Chrome never
  re-injects content scripts into already-open documents. `background-core.mjs` probes liveness by
  making the content script do an *outbound* `CONTENT_ALIVE` round trip (an inbound-only ping
  reports a dead bridge as healthy). Preserve `dispose()` when editing these files.
- **`src/player/werhd-jev-player.mjs` (~142 KB) is the engine.** `collectState()` is also reused by
  the read-only `src/observer.mjs`, so it must stay side-effect free. Sibling modules:
  `werhd-jev-strategy.mjs` (scoring/economy), `-commander.mjs` (`buildBrief`), `-special.mjs`,
  `-objective.mjs`, `-catalog.mjs`, `-camera.mjs`.
- Two decision modes (`shared.mjs` `strategyMode`): `choices` (default, any source) and `commander`
  (OpenAI-compatible only — Laya reads ~256 tokens per group and cannot reason). See
  `docs/commander-design.md`.
- Only `docs/README.md`, `docs/local-laya.md`, `docs/commander-design.md`, `docs/ai-decision-porting.md`
  describe ongoing work; `docs/player-console-api.md`, `docs/game-api-requests.md` and
  `werhd-player-api.d.ts` are a **pinned upstream snapshot** (commit `7f6858a`, SHA-256 table in
  `docs/README.md`). Do not edit them locally — re-copy from the upstream repo and update the table.

## Conventions

- **Adding a game domain** requires three edits that are easy to miss: `GAME_HOSTS` in
  `src/shared.mjs`, `host_permissions`, and `content_scripts.matches` in `public/manifest.json`.
- **Local model name must be `laya-multilingual`.** Bare `laya` is an alias for the English
  checkpoint and collapses on Chinese battlefield text. `localModel` unknown to the service means
  auto-route; only a *known* name pins a checkpoint.
- **The `/v1/systemone` contract is strict.** An answer whose `choice` is not a key of that group's
  `criteria` invalidates the *entire* response (see `validateAnswer` in `src/shared.mjs`). Body
  limit 256 000 bytes; timeouts are per-provider and measured, not guessed (8 s Jev, 18 s local,
  30 s local when two tabs share the CPU model, 90 s commander).
- **Laya's context is ~1024 tokens per question group** and truncates from the right. The service
  reorders scalar fields ahead of long arrays so detail gets dropped, not essentials
  (`--raw-state` disables). Any change that grows the state must be checked against that budget —
  `tools/laya-state-report.py` measures field survival from `--dump-states` captures. It must be
  run against a dump, **not** a match log: the log stores a flattened `stateSummary`.
- User-facing strings live in `src/i18n.mjs` as `[zh-CN, en]` pairs — never inline them.
- No secrets in the repo. `models/`, `wheels/`, `.laya-venv/` are large pre-staged binaries;
  `wheels/` is pinned to **cp313 / win_amd64**.