#!/usr/bin/env python3
"""Check that a local Laya server answers the extension's decision protocol.

Runs two things against a server started by `tools/laya-serve-local.py` (or the Mac MLX server):

  1. `GET /health` -- is something listening?
  2. `POST /v1/systemone` with a request shaped exactly like the extension's, and asserts that every
     answer names a candidate that was actually offered. The extension refuses a reply whose
     `choice` is not one of its criteria keys (`validateAnswer` in `src/shared.mjs`), so a server
     that answers wrongly looks identical to a server that is down -- this catches the difference.

Stdlib only, so it runs with the venv's python or the system one.

    python tools/laya-check.py                                  # 127.0.0.1:8742, no token
    python tools/laya-check.py --url http://10.0.0.5:8742/v1 --token <token>
"""
from __future__ import annotations

import argparse
import json
import sys
import time
import urllib.error
import urllib.request

# Deliberately mixed Chinese/English instructions with Chinese criteria labels: this is the shape
# the extension actually sends for a Chinese-language match, and it is what routes Laya to the
# multilingual checkpoint rather than the English one.
REQUEST = {
    "model": "laya-multilingual",
    "state": {
        "tick": 1200,
        "gameSeconds": 96.0,
        "credits": 3500,
        "self": {"power": {"total": 200, "drain": 120}},
        "ownArmyCount": 9,
        "harvesters": 3,
        "visibleEnemyCount": 4,
        "nearbyEnemyCount": 1,
        "baseUnderAttack": False,
        "ledger": {"ownUnits": 9, "ownBuildings": 12, "enemyUnits": 4, "enemyBuildings": 2,
                   "ownBuilt": 6, "ownUnitsLost": 1, "ownBuildingsLost": 0,
                   "enemyUnitsDestroyed": 3, "enemyBuildingsDestroyed": 0},
        "units": [
            {"name": "Grizzly Battle Tank", "count": 4},
            {"name": "Ore Miner", "count": 3},
            {"name": "G.I.", "count": 5},
        ],
    },
    "questions": {
        "vehicles": {
            "type": "choice",
            "instructions": "选择下一个要生产的载具。",
            "criteria": {
                "wait": "先不生产，攒钱",
                "build_mtnk": "生产灰熊坦克，加强正面装甲",
                "build_harv": "生产采矿车，增加收入",
            },
        },
        "tactics": {
            "type": "choice",
            "instructions": "选择当前部队姿态。",
            "criteria": {
                "hold": "留在基地附近防守",
                "attack": "直接进攻敌方基地",
            },
        },
    },
}


def _post(url: str, body: dict, token: str, timeout: float):
    data = json.dumps(body).encode("utf-8")
    headers = {"Content-Type": "application/json"}
    if token:
        headers["Authorization"] = "Bearer " + token
    req = urllib.request.Request(url, data=data, headers=headers, method="POST")
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return response.status, json.loads(response.read().decode("utf-8", "replace"))


def main(argv=None) -> int:
    parser = argparse.ArgumentParser(description="Check a local Laya decision server.")
    parser.add_argument("--url", default="http://127.0.0.1:8742/v1",
                        help="server base, up to /v1 (default: %(default)s)")
    parser.add_argument("--token", default="", help="bearer token, if the server needs one")
    parser.add_argument("--timeout", type=float, default=60.0, help="seconds (default: %(default)s)")
    args = parser.parse_args(argv)

    base = args.url.rstrip("/")
    if base.endswith("/systemone"):
        base = base[: -len("/systemone")]
    root = base[: -len("/v1")] if base.endswith("/v1") else base

    # 1. health
    try:
        with urllib.request.urlopen(root + "/health", timeout=min(args.timeout, 15)) as response:
            health = json.loads(response.read().decode("utf-8", "replace"))
        print("health  OK   %s" % json.dumps(health, ensure_ascii=False)[:200])
    except Exception as exc:  # noqa: BLE001 - report, do not traceback
        print("health  FAIL %s" % exc, file=sys.stderr)
        print("Is the server running?  python tools/laya-serve-local.py", file=sys.stderr)
        return 1

    # 2. one decision round trip
    url = base + "/systemone"
    started = time.monotonic()
    try:
        status, body = _post(url, REQUEST, args.token, args.timeout)
    except urllib.error.HTTPError as exc:
        detail = exc.read().decode("utf-8", "replace")[:300]
        print("decide  FAIL HTTP %s %s" % (exc.code, detail), file=sys.stderr)
        if exc.code == 401:
            print("The server wants a token: pass --token (see the startup log).", file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001
        print("decide  FAIL %s" % exc, file=sys.stderr)
        return 1
    elapsed_ms = (time.monotonic() - started) * 1000.0

    answers = body.get("answers")
    if not isinstance(answers, dict):
        print("decide  FAIL no 'answers' object: %s" % json.dumps(body, ensure_ascii=False)[:300],
              file=sys.stderr)
        return 1

    ok = True
    for group, question in REQUEST["questions"].items():
        answer = answers.get(group)
        if not isinstance(answer, dict) or answer.get("type") != "choice":
            print("decide  FAIL %s: no choice answer (%s)" % (group, json.dumps(answer, ensure_ascii=False)))
            ok = False
            continue
        choice = answer.get("choice")
        if choice not in question["criteria"]:
            print("decide  FAIL %s: choice %r is not one of %s"
                  % (group, choice, list(question["criteria"])))
            ok = False
            continue
        # The criteria label is deliberately not echoed: it is Chinese here, and a console that is
        # not UTF-8 turns it into noise that hides the result. The choice key is ASCII and is what
        # the extension actually acts on.
        best = answer.get("probabilities") or {}
        top = max(best.items(), key=lambda kv: kv[1])[1] if best else None
        print("decide  OK   %-9s -> %-11s confidence=%s%s"
              % (group, choice, answer.get("confidence"),
                 "" if top is None else "  top_p=%.4f" % top))

    usage = body.get("usage") or {}
    print("model   %s   usage=input %s output %s   round trip=%.0f ms"
          % (body.get("model"), usage.get("input_tokens"), usage.get("output_tokens"), elapsed_ms))
    print("RESULT  %s" % ("the extension will accept these answers" if ok else "the extension would reject this reply"))
    return 0 if ok else 2


if __name__ == "__main__":
    raise SystemExit(main())
