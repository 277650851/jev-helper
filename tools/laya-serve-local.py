#!/usr/bin/env python3
"""Serve a Laya checkpoint from this project over the Jev /v1/systemone protocol.

Why this exists next to `tools/laya-server.py`
----------------------------------------------
`tools/laya-server.py` runs Laya through `laya_mlx`, which is Apple-silicon only, so the server
it starts cannot run on Windows or on an Intel Mac. The `laya` package on PyPI is the opposite:
plain torch, CPU or CUDA, every platform -- and since 0.3.20 it ships `laya-serve`, which already
speaks the exact wire protocol this extension uses (`POST /v1/systemone`, Jev-shaped answers, an
optional bearer token). So the HTTP surface is not something we need to write.

What is missing is the last inch: `laya-serve` builds its Router from environment variables and
can only name checkpoints by *hub id*, which means `huggingface.co`. On networks where that host
is unreachable the server cannot start at all. This launcher injects a Router that points at a
directory on disk instead (`tools/laya-model-fetch.py` fills it from ModelScope), then hands it to
the official `create_app`. No checkpoint download, no network, same protocol.

The checkpoint is loaded from a local path, so `laya.Agent` never calls `snapshot_download`
(`agent.py`: `model_dir = model_id_or_path; if not os.path.exists(model_dir): ...`), and HF is
forced offline as a second guard.

Usage
-----
    python tools/laya-serve-local.py                     # 127.0.0.1:8742, checkpoint under models/
    python tools/laya-serve-local.py --lan               # all interfaces, bearer token required
    python tools/laya-serve-local.py --model models/laya-multilingual --port 8742 --device cpu

The extension's "Local Laya" source defaults to `http://127.0.0.1:8742/v1`, so the default port
here is 8742 rather than the 8000 `laya-serve` ships with.
"""
from __future__ import annotations

import argparse
import json
import os
import secrets
import sys
import time

# Must be set before `laya` (or huggingface_hub) is imported: a local checkpoint needs no hub
# access, and a stray hub call should fail loudly instead of hanging on a blocked network.
os.environ.setdefault("HF_HUB_OFFLINE", "1")
os.environ.setdefault("TRANSFORMERS_OFFLINE", "1")

# One local checkpoint answers every checkpoint name the router knows. Requests carry whatever the
# extension's "local model name" field holds (the shipped default resolves to `multilingual`), and
# a name that is absent from the router's map would send it to the hub. Pointing all three names at
# the same directory keeps that from ever happening.
ROUTE_NAMES = ("multilingual", "english", "typed-decisions")
# `--dump-states` stops after this many files so a long session cannot fill the disk.
DUMP_LIMIT = 2000
DEFAULT_ROUTE = "multilingual"
TOKEN_FILE = os.path.join(os.path.expanduser("~"), ".laya-server-token")


def lean_state(state):
    """The same state with the fields that carry no information at this tick left out.

    Measured over 280 states from two real matches: the state is ~314 tokens and is repeated inside
    every question, so it is ~62% of each question and the single biggest lever on latency. Three
    things in it are pure overhead:

      * `queues` is empty in 81% of ticks, yet six empty queue objects cost ~66 tokens (21% of the
        state). When nothing is building the whole field collapses to `"idle"`.
      * `hints` is empty in 99% of ticks.
      * `freeCredits` equals `credits` in 81% of ticks; it only differs when credits are committed.

    Empty containers are dropped outright (an empty list and no list carry the same information), and
    nothing is invented: every value that survives is byte-identical to what the page sent. Whether the
    model agrees is measured separately -- see `--lean-state`.
    """
    if not isinstance(state, dict):
        return state
    out = {}
    for key, value in state.items():
        if isinstance(value, (dict, list)) and not value:
            continue
        if key == "queues" and isinstance(value, list):
            busy = [q for q in value if isinstance(q, dict) and q.get("items")]
            out[key] = busy if busy else "idle"
            continue
        if key == "freeCredits" and value == state.get("credits"):
            continue
        out[key] = value
    return out


def _state_transform_active(args) -> bool:
    """True when prepare_state() would return something other than plain compact_state(state)."""
    return bool(args.priority_state or args.slim_state or args.compact_units or args.lean_state)


def _write_dump(directory, state, questions, result, prepared=None):
    """Save one request exactly as the extension sent it, for offline tuning.

    The decision log stores `stateSummary(state)` -- a different, flattened schema -- so a state read
    back from a match log is not the state the model saw, and optimising against it measures the wrong
    thing. This captures the real payload. Best effort: a full or unwritable directory never affects
    a decision.

    `prepared` is the state after prepare_state(), recorded separately whenever a transform flag is on.
    Dumping only the raw state made every offline report describe the *full* arm no matter which arm
    the server was running: laya-state-report.py then measured a state the model never read and
    reported 99% of questions pinned at the context cap with `queues` and `forceReadiness` cut 100% of
    the time, which is exactly what --slim-state exists to prevent. Keeping both lets a report describe
    the arm that actually ran and still show what the page emitted.
    """
    try:
        os.makedirs(directory, exist_ok=True)
        existing = sorted(os.listdir(directory))
        if len(existing) >= DUMP_LIMIT:
            return
        payload = {"receivedAt": time.time(), "state": state, "questions": questions,
                   "usage": (result or {}).get("usage"), "answers": (result or {}).get("answers")}
        if prepared is not None:
            payload["preparedState"] = prepared
        with open(os.path.join(directory, "state-%04d.json" % len(existing)), "w", encoding="utf-8") as fh:
            json.dump(payload, fh, ensure_ascii=False)
    except OSError:
        pass


def widen_inference_pool(workers: int) -> None:
    """Make `laya.serve.create_app` build a pool of `workers` instead of its hard-coded one.

    Two sessions hosting at once take turns for their whole duration under a single worker: measured
    with four question groups, one request alone is ~5 s, while a pair came back at 18.0 s and 8.9 s --
    asymmetric, and long enough that the second session's own timeout fires. `create_app` imports the
    class inside its body, so rebinding it here is enough; the pool itself is a local variable in a
    closure and cannot be reached any other way. Pair this with a lower `--threads` so two forwards do
    not oversubscribe the cores.
    """
    import concurrent.futures as futures

    width = max(1, int(workers))
    current = futures.ThreadPoolExecutor
    if getattr(current, "_laya_workers", None) == width:
        return
    # Always subclass the *real* executor. Subclassing a previous shim would work by accident until a
    # second call, when the inner shim's captured width silently wins -- `_WidePool(2)` calling
    # `super().__init__(max_workers=2)` lands in `_WidePool(1)`, which overrides it back to 1.
    base = getattr(current, "_laya_base", current)

    class _WidePool(base):                                # noqa: N801 - stands in for the stdlib class
        _laya_base = base
        _laya_workers = width

        def __init__(self, max_workers=None, *rest, **kwargs):
            super().__init__(max_workers=width, *rest, **kwargs)

    futures.ThreadPoolExecutor = _WidePool


# Lists of per-unit objects. The extension builds them from one `unitSummary`, so each entry repeats
# what the others already say -- and they are the whole reason the state does not fit: measured over
# 150 captured requests, `visibleEnemies` averages 783 tokens and peaks at 1516, `army` 655, `units`
# 434, against a per-question budget of 797 for a 1397-token state. What disappears is only what the
# model cannot act on: the engine's unit id, `name` restating `kind`, `hp` restating `hpFraction`, and
# a nested tile object instead of two numbers.
UNIT_LISTS = ("visibleEnemies", "enemies", "army", "units", "buildings", "garrisons")


def _terse_unit(unit):
    """One unit as a short string: kind, position, and only the qualifiers that change a decision."""
    if not isinstance(unit, dict):
        return unit
    parts = [str(unit.get("kind") or unit.get("name") or "?")]
    tile = unit.get("tile") or {}
    x = tile.get("x", tile.get("rx"))
    y = tile.get("y", tile.get("ry"))
    if x is not None and y is not None:
        parts.append("%s,%s" % (x, y))
    fraction = unit.get("hpFraction")
    if isinstance(fraction, (int, float)) and fraction < 1:
        parts.append("%d%%" % round(float(fraction) * 100))
    if unit.get("idle") is False:
        parts.append("busy")
    if unit.get("canDeploy"):
        parts.append("canDeploy")
    if unit.get("zone"):
        parts.append("zone%s" % unit["zone"])
    return " ".join(parts)


def release_inference_gate() -> None:
    """Let concurrent requests reach the widened pool instead of queueing on the gate.

    `laya.serve` serialises inference in two places: the single-worker `ThreadPoolExecutor`, and an
    `asyncio.Lock` wrapped around the call (`serve.py:273`, `async with gate:`). Widening the pool alone
    changes nothing -- measured with two concurrent requests on a widened pool, one still took 5.2 s
    while the other took 2.6 s, which is the signature of running one after the other rather than side
    by side. The lock is a `nonlocal` created on the first request, so the class it is built from is the
    only reachable seam. This process exists solely to serve decisions; nothing else in it uses
    `asyncio.Lock`. Only called for `--workers > 1`.
    """
    import asyncio

    class _OpenGate:
        async def __aenter__(self):
            return self

        async def __aexit__(self, *exc):
            return False

    asyncio.Lock = _OpenGate


def compact_units(state):
    """Rewrite the unit lists into that terse form. Nothing else is touched."""
    if not isinstance(state, dict):
        return state
    return {key: ([_terse_unit(u) for u in value] if key in UNIT_LISTS and isinstance(value, list) else value)
            for key, value in state.items()}


def _repo_root() -> str:
    return os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def compact_state(state):
    """Order state so Laya's right-side truncation drops detail before summaries.

    The extension's battlefield state is larger than Laya's context window, and `build_sequence`
    truncates from the right for a dict state, so whatever is written last is what gets cut. Scalars
    and short values (tick, credits, counts, flags) are kept first; long arrays and nested objects
    (unit lists, queues, inventory) follow, so the first tokens to go are the least important ones.
    Nothing is added, renamed or dropped -- the same state, reordered.

    This mirrors `compact_state` in `tools/laya-server.py` (the MLX server, enabled unless
    `--raw-state`), which the official `laya-serve` has no equivalent of. Without it the model sees
    the state in whatever order the page emitted it.
    """
    if not isinstance(state, dict):
        return state
    short, long = {}, {}
    for key, value in state.items():
        target = long if isinstance(value, (list, dict)) else short
        target[key] = value
    return {**short, **long}


# Reading order that puts the fields a decision needs soonest first. Measured on a real state
# (`collectState` on a mid-game world): it serializes to 1775 tokens while each question only has room
# for ~764, so ordering alone decides which 43% the model ever reads. The default order above spends
# that budget on `visibleEnemies` (502 tokens, 77% of it survives) and never reaches `army` (704) or
# `queues` (175) -- so a request asking what to build next cannot see the build queue, even though the
# `wait` option it is choosing between is worded in terms of that queue being occupied.
#
# This alternative moves `queues` and `base` ahead of `inventory`, so the queue is fully visible and
# `visibleEnemies` keeps ~43%. It is a straight trade, not a free win -- roughly the same number of
# tokens move out as move in -- which is why it is opt-in and measured rather than the default.
STATE_PRIORITY = (
    "tick", "gameSeconds", "baseUnderAttack",
    "ownArmyCount", "mobileTankCount", "deployedCombatCount", "antiAirCount", "harvesters",
    "averageArmyHealth", "visibleEnemyCount", "nearbyEnemyCount", "airThreatCount",
    "committedCredits", "uncommittedCredits", "escalation",
    "self", "base", "queues", "inventory",
    "forceReadiness", "combatAssessment", "strategy", "objectiveTarget", "recentChoices",
    "infrastructure", "economy", "hints",
)
# The long unit lists, smallest first: when only one can fit, the cheaper one is the better buy.
STATE_BULK = ("visibleEnemies", "enemies", "army", "units", "buildings")

# --slim-state keeps only these fields, each only if the page sent it. Measured over 150 requests
# captured from real matches: the state is 3501-3597 tokens while each question leaves room for
# only ~797, so 78% of it is never read, and what survives is just inventory/self/base plus a
# truncated visibleEnemies -- 95-100% of forceReadiness/combatAssessment/queues/strategy/economy/
# army is past the cut, so the model is asked "what do I build next" without seeing the build
# queue and "how should my army fight" without seeing the army. This whitelist plus the
# compression in slim_state() is the fix: 489 state tokens, sequence 715 (below the 1024 cap),
# ~30% less compute per question, and the queue and readiness become visible for the first time.
SLIM_SCALARS = (
    "tick", "gameSeconds", "baseUnderAttack", "ownArmyCount", "mobileTankCount",
    "antiAirCount", "mobileAntiAirCount", "harvesters", "averageArmyHealth",
    "visibleEnemyCount", "nearbyEnemyCount", "airThreatCount",
    "committedCredits", "uncommittedCredits",
)
SLIM_KEEP = SLIM_SCALARS + ("self", "base", "forceReadiness", "combatAssessment",
                            "queues", "inventory")
# --slim-state-units adds these, which compact_units() rewrites into 'KIND x,y hp%' strings, so
# "where is the enemy and where are my units" stays inside the budget: 732 state tokens,
# sequence 902 -- still below the cap and still a third less compute than the full state.
SLIM_UNIT_LISTS = ("visibleEnemies", "army")


def priority_state(state):
    """`compact_state` with the fields ranked by how soon a decision needs them."""
    if not isinstance(state, dict):
        return state
    rank = {key: i for i, key in enumerate(STATE_PRIORITY)}
    bulk = {key: i for i, key in enumerate(STATE_BULK)}
    front, middle, back, rest = {}, {}, {}, {}
    for key, value in state.items():
        if key in rank:
            front[key] = value
        elif key in bulk:
            back[key] = value
        elif isinstance(value, (list, dict)):
            middle[key] = value
        else:
            rest[key] = value
    return {**rest,
            **{k: front[k] for k in sorted(front, key=lambda k: rank[k])},
            **middle,
            **{k: back[k] for k in sorted(back, key=lambda k: (bulk[k], len(json.dumps(back[k], ensure_ascii=False))))}}


def slim_state(state, with_units=False):
    """`--slim-state`: keep only the fields a decision can act on, compressing the wordy ones.

    `inventory` maps kind -> {name, role, count, ...}; only `count` changes a decision, so it
    collapses to kind -> count (measured 847 -> 670 state tokens). `queues` keeps every queue and
    compresses each item to name/quantity/progress (670 -> 489). `with_units` additionally keeps
    visibleEnemies/army, which compact_units() then rewrites into terse strings; that variant
    measures 732 tokens but keeps unit positions visible. Every surviving value is byte-identical
    to what the page sent except the two compressed fields, and a field is kept only if present --
    nothing is invented.

    An *empty* queue used to be dropped, on the reasoning that it carries no information. It carries
    the most information there is: an idle queue is the whole difference between "build this now" and
    "wait for the queue to drain", and the waiting option in the construction and production groups
    is defined in exactly those terms. Emitting `queues: []` made "every queue is idle" and "nothing
    is known about the queues" indistinguishable, and jev-report-20261009-055438 is what that cost:
    86 real questions of "build the refinery vs wait", the queue idle and 2,450-8,900 credits against
    a 2,000 refinery, and wait chosen 83 times. An idle queue now survives as `{"t": 0}` -- the queue
    type with no items, which costs a few tokens and states the fact.

    This mirrors the offline accounting in .preview/minimal-state.py (same whitelist, same
    compression), which is where the measured numbers come from.
    """
    if not isinstance(state, dict):
        return state
    keys = SLIM_KEEP + (SLIM_UNIT_LISTS if with_units else ())
    out = {}
    for key in keys:
        if key not in state:
            continue
        value = state[key]
        if key == "inventory" and isinstance(value, dict):
            out[key] = {k: (v or {}).get("count", 0) for k, v in value.items()}
        elif key == "queues" and isinstance(value, list):
            out[key] = [{"t": q.get("type"),
                         **({"items": [{"n": i.get("name"), "q": i.get("quantity"),
                                        "p": round(float(i.get("progress") or 0), 2)}
                                       for i in q["items"]]} if q.get("items") else {})}
                        for q in value]
        else:
            out[key] = value
    return out


def prepare_state(state, args):
    """The transform chain `LocalRouter.predict` applies to every request, in a fixed order.

    Order matters because `build_sequence` truncates the state from the right: whatever is written
    last is what gets cut. So the chain runs --priority-state first (if given, it decides which
    fields are even worth keeping near the front), then the --slim-state whitelist, then
    --compact-units' terse rewriting of whatever unit lists survived (under --slim-state-units
    exactly visibleEnemies/army), then --lean-state's empty-field drops, and finally
    compact_state's scalars-first ordering. With no flags this is exactly `compact_state(state)`,
    byte-identical to what the server sent before any of these knobs existed.
    """
    ordered = priority_state(state) if args.priority_state else state
    if args.slim_state:
        ordered = slim_state(ordered, with_units=args.slim_state_units)
    if args.compact_units or (args.slim_state and args.slim_state_units):
        ordered = compact_units(ordered)
    cooked = lean_state(ordered) if args.lean_state else ordered
    return compact_state(cooked)


def _parse_args(argv=None):
    root = _repo_root()
    parser = argparse.ArgumentParser(
        description="Run Laya over the Jev /v1/systemone protocol from a checkpoint on disk.")
    parser.add_argument("--model", default=os.path.join(root, "models", "laya-multilingual"),
                        help="checkpoint directory (default: %(default)s)")
    parser.add_argument("--host", default=None,
                        help="bind address (default: 127.0.0.1, or 0.0.0.0 with --lan)")
    parser.add_argument("--port", type=int, default=8742,
                        help="bind port (default: %(default)s; the extension expects 8742)")
    parser.add_argument("--device", default="cpu",
                        help="torch device: cpu, cuda, or auto (default: %(default)s)")
    parser.add_argument("--threads", type=int, default=0,
                        help="cap torch CPU threads; 0 = torch default. Oversubscribing logical "
                             "cores is a large regression on CPU inference.")
    parser.add_argument("--lan", action="store_true",
                        help="listen on all interfaces; requires a bearer token")
    parser.add_argument("--token", default=None,
                        help="bearer token clients must send (implies --lan semantics)")
    parser.add_argument("--route-name", default=DEFAULT_ROUTE, choices=ROUTE_NAMES,
                        help="checkpoint the router defaults to (default: %(default)s)")
    parser.add_argument("--max-state-chars", type=int, default=0,
                        help="raise laya-serve's per-request state guard (0 = package default, "
                             "50000). The extension sends the whole visible battlefield, which can "
                             "be longer; the model still truncates at its own context length.")
    parser.add_argument("--raw-state", action="store_true",
                        help="send the state exactly as the page emitted it, without the "
                             "scalars-first reordering that keeps truncation away from summaries")
    parser.add_argument("--lean-state", action="store_true",
                        help="also drop fields that carry no information at this tick (empty queue "
                             "lists, empty containers, freeCredits when it equals credits); measured "
                             "at roughly a quarter fewer state tokens. NOT a default: the model is "
                             "fully deterministic and removing those fields changes its choice in "
                             "~31%% of groups, so it trades a known policy for a faster unknown one")
    parser.add_argument("--workers", type=int, default=1, metavar="N",
                        help="inference pool size. The package hard-codes 1, which makes concurrent "
                             "sessions take turns for their whole duration (a second tab's request "
                             "waits for the first to finish). Raise it to let concurrent sessions "
                             "share the CPU instead of queueing; pair it with a lower --threads so two "
                             "forwards do not oversubscribe the cores")
    parser.add_argument("--compact-units", action="store_true",
                        help="rewrite the per-unit lists (visibleEnemies/army/units) as short strings "
                             "such as 'HTNK 45,70 74%%'. The state is 1397 tokens against a 797-token "
                             "budget, so the model currently never reads readiness, threat assessment, "
                             "strategy or the build queue; compacting the unit lists is what makes the "
                             "rest fit")
    parser.add_argument("--priority-state", action="store_true",
                        help="order the state by how soon a decision needs each field instead of "
                             "scalars-first (see STATE_PRIORITY). Brings `queues` into view at the cost "
                             "of about a third of `visibleEnemies`; a trade, so it is opt-in")
    parser.add_argument("--slim-state", action="store_true",
                         help="keep only the fields a decision can act on (the decision scalars plus "
                              "self/base/forceReadiness/combatAssessment/queues/inventory), with "
                              "inventory compressed to {kind: count} and queues to non-empty "
                              "{t, items:[{n,q,p}]}. Measured over 150 real requests: state ~3500 -> "
                              "489 tokens, sequence 1024 -> 715, ~30%% less compute per question, and "
                              "the build queue and readiness are visible for the first time instead "
                              "of being truncated away")
    parser.add_argument("--slim-state-units", action="store_true",
                         help="with --slim-state, also keep visibleEnemies and army, rewritten in the "
                              "terse 'KIND x,y hp%%' form (see --compact-units). Costs ~243 more state "
                              "tokens (732 vs 489) but keeps 'where are the enemy and my units' "
                              "inside the budget; has no effect without --slim-state")
    parser.add_argument("--dump-states", default=None, metavar="DIR",
                        help="save every request payload (the exact state and questions the extension "
                             "sent) into DIR, up to %d files, for offline tuning" % DUMP_LIMIT)
    parser.add_argument("--quiet", action="store_true", help="less uvicorn logging")
    return parser.parse_args(argv)


def _load_or_create_token() -> str:
    """Reuse the token the project's own local server keeps, so both share one secret."""
    try:
        with open(TOKEN_FILE, encoding="utf-8") as fh:
            existing = fh.read().strip()
        if existing:
            return existing
    except OSError:
        pass
    token = secrets.token_urlsafe(24)
    try:
        with open(TOKEN_FILE, "w", encoding="utf-8") as fh:
            fh.write(token)
    except OSError:
        pass
    return token


def main(argv=None) -> int:
    args = _parse_args(argv)
    model_dir = os.path.abspath(args.model)
    if not os.path.isdir(model_dir):
        print("Checkpoint not found: %s" % model_dir, file=sys.stderr)
        print("Fetch it first:  python tools/laya-model-fetch.py", file=sys.stderr)
        return 2
    for required in ("model.safetensors", "rl_agent_config.json",
                     os.path.join("encoder", "config.json"),
                     os.path.join("tokenizer", "tokenizer.json")):
        if not os.path.exists(os.path.join(model_dir, required)):
            print("Checkpoint incomplete (%s missing): %s" % (required, model_dir), file=sys.stderr)
            print("Re-run:  python tools/laya-model-fetch.py", file=sys.stderr)
            return 2

    host = args.host or ("0.0.0.0" if args.lan else "127.0.0.1")
    lan = args.lan or host not in ("127.0.0.1", "localhost", "::1")
    token = args.token or (_load_or_create_token() if lan else "")

    if args.threads > 0:
        try:
            import torch
            torch.set_num_threads(args.threads)
        except Exception as exc:  # noqa: BLE001 - a thread cap is a tuning knob, never fatal
            print("Could not cap torch threads: %s" % exc, file=sys.stderr)

    # `laya.serve.create_app` reads the token from the environment; that is the official check, so
    # the launcher sets it rather than reimplementing auth.
    if token:
        os.environ["LAYA_API_KEY"] = token
    else:
        os.environ.pop("LAYA_API_KEY", None)
    os.environ["LAYA_DEVICE"] = args.device

    try:
        from laya.router import Router
        from laya.serve import create_app
        import uvicorn
    except ImportError as exc:
        print("The 'laya' package is not importable (%s)." % exc, file=sys.stderr)
        print("Install it:  python -m venv .laya-venv", file=sys.stderr)
        print("             .laya-venv\\Scripts\\python -m pip install \"laya[serve]\"", file=sys.stderr)
        return 2

    print("Loading Laya checkpoint %s (device=%s)..." % (model_dir, args.device))

    class LocalRouter(Router):
        """Router that compacts each request's state before the model tokenizes it.

        Subclassing is the seam here because `laya.serve.create_app` only ever calls
        `router.predict(state, questions, model=...)`; the HTTP surface, auth and limits all stay
        the package's own code.
        """

        def predict(self, *call_args, **call_kwargs):
            if call_args:
                state, rest = call_args[0], call_args[1:]
                questions = call_args[1] if len(call_args) > 1 else call_kwargs.get("questions")
            else:
                state, rest = call_kwargs.pop("state", None), ()
                questions = call_kwargs.get("questions")
            prepared = prepare_state(state, args)
            result = super().predict(prepared, *rest, **call_kwargs)
            if args.dump_states:
                _write_dump(args.dump_states, state, questions, result,
                            prepared=prepared if _state_transform_active(args) else None)
            return result

    router_cls = Router if args.raw_state else LocalRouter
    # max_loaded=1: every route name points at the same directory, and three resident Agents would
    # be three copies of the same 322M-parameter model. One is enough; a name change evicts it.
    router = router_cls(models={name: model_dir for name in ROUTE_NAMES},
                        device=args.device, default=args.route_name, max_loaded=1)
    router.preload([args.route_name])

    # `laya.serve.create_app` hard-codes a single inference worker, which makes two sessions take turns.
    if args.workers != 1:
        widen_inference_pool(args.workers)
        release_inference_gate()

    scheme = "http"
    print("Laya decision server listening on %s://%s:%d/v1/systemone" % (scheme, host, args.port))
    print("Extension setting: model source = Local Laya, local server URL = %s://%s:%d/v1"
          % (scheme, "127.0.0.1" if host == "0.0.0.0" else host, args.port))
    print("Extension setting: local model name = %s" % args.route_name)
    if token:
        print("Extension setting: local access token = %s" % token)
    print("Health check: %s://%s:%d/health" % (scheme, "127.0.0.1" if host == "0.0.0.0" else host, args.port))

    uvicorn.run(create_app(router), host=host, port=args.port,
                log_level="warning" if args.quiet else "info")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
