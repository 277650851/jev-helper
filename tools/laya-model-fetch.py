#!/usr/bin/env python3
"""Fetch a Laya checkpoint into this project, from ModelScope.

Why this exists
---------------
`docs/local-laya.md` downloads the weights from Hugging Face. On networks where
`huggingface.co` is unreachable (and `hf-mirror.com` too), that step cannot run at all.
ModelScope mirrors the official Laya checkpoints, so this script pulls exactly the files
`laya.Agent` needs -- `model.safetensors`, `encoder/`, `tokenizer/`, `rl_agent_config.json` --
and nothing else (no benchmark images, no eval notebooks).

It is stdlib only: no `modelscope`, no `huggingface_hub`, no `torch`. It only speaks HTTP.

`laya.Agent` accepts a local directory instead of a hub id (`agent.py`: `model_dir =
model_id_or_path; if not os.path.exists(model_dir): ... snapshot_download(...)`), so a
directory produced here loads with no network access at all.

Usage
-----
    python tools/laya-model-fetch.py                       # laya-multilingual -> models/laya-multilingual
    python tools/laya-model-fetch.py --repo convaiinnovations/laya --sub multilingual
    python tools/laya-model-fetch.py --list                # show what would be downloaded
    python tools/laya-model-fetch.py --all                 # every blob in the repo

Exit codes: 0 ok, 1 usage/network error, 2 incomplete download.
"""
from __future__ import annotations

import argparse
import json
import os
import sys
import urllib.error
import urllib.parse
import urllib.request

API = "https://www.modelscope.cn/api/v1/models/{repo}/repo/files?Revision={rev}&Recursive=true"
BLOB = "https://www.modelscope.cn/api/v1/models/{repo}/repo?Revision={rev}&FilePath={path}"

# The subset `laya.Agent` reads. Mirrors the `allow_patterns` the package passes to
# snapshot_download, plus `configuration.json`, which the hub copy also carries.
KEEP_FILES = {"rl_agent_config.json", "model.safetensors", "configuration.json"}
KEEP_DIRS = ("encoder/", "tokenizer/")
CHUNK = 1 << 20


def _human(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB"):
        if abs(n) < 1024 or unit == "GB":
            return "%.1f %s" % (n, unit)
        n /= 1024
    return "%.1f GB" % n


def _get_json(url: str, timeout: int = 60):
    req = urllib.request.Request(url, headers={"User-Agent": "jev-helper-laya-fetch"})
    with urllib.request.urlopen(req, timeout=timeout) as response:
        return json.loads(response.read().decode("utf-8", "replace"))


def list_files(repo: str, rev: str, wanted_only: bool = True):
    """Blobs in the repo as [(path, size)], filtered to what a checkpoint needs."""
    payload = _get_json(API.format(repo=repo, rev=rev))
    files = ((payload.get("Data") or {}).get("Files")) or []
    out = []
    for entry in files:
        if entry.get("Type") != "blob":
            continue
        path = str(entry.get("Path") or "")
        if not path or path.startswith("."):
            continue
        if wanted_only:
            if os.path.basename(path) not in KEEP_FILES and not path.startswith(KEEP_DIRS):
                continue
        out.append((path, int(entry.get("Size") or 0)))
    return out


def download(repo: str, rev: str, path: str, dest: str, size: int) -> str:
    """Download one blob. Returns 'skip', 'done' or raises."""
    target = os.path.join(dest, *path.split("/"))
    if os.path.exists(target) and (size <= 0 or os.path.getsize(target) == size):
        return "skip"
    os.makedirs(os.path.dirname(target) or ".", exist_ok=True)
    url = BLOB.format(repo=repo, rev=rev, path=urllib.parse.quote(path))
    req = urllib.request.Request(url, headers={"User-Agent": "jev-helper-laya-fetch"})
    tmp = target + ".part"
    got = 0
    with urllib.request.urlopen(req, timeout=300) as response, open(tmp, "wb") as fh:
        while True:
            chunk = response.read(CHUNK)
            if not chunk:
                break
            fh.write(chunk)
            got += len(chunk)
            if size > 0:
                pct = got * 100.0 / size
                sys.stderr.write("\r  %-46s %5.1f%%  %s" % (path, pct, _human(got)))
                sys.stderr.flush()
    sys.stderr.write("\r  %-46s 100.0%%  %s\n" % (path, _human(got)))
    if size > 0 and got != size:
        raise OSError("size mismatch for %s: got %d, expected %d" % (path, got, size))
    os.replace(tmp, target)
    return "done"


def main(argv=None) -> int:
    here = os.path.dirname(os.path.abspath(__file__))
    root = os.path.dirname(here)
    parser = argparse.ArgumentParser(description="Fetch a Laya checkpoint from ModelScope.")
    parser.add_argument("--repo", default="convaiinnovations/laya-multilingual",
                        help="ModelScope model id (default: %(default)s)")
    parser.add_argument("--dir", dest="dest", default=None,
                        help="target directory (default: models/<repo name>)")
    parser.add_argument("--revision", default="master", help="revision/branch (default: master)")
    parser.add_argument("--all", action="store_true", help="download every blob, not only the checkpoint files")
    parser.add_argument("--list", action="store_true", help="list files and exit")
    args = parser.parse_args(argv)

    dest = args.dest or os.path.join(root, "models", args.repo.split("/")[-1])
    dest = os.path.abspath(dest)

    try:
        files = list_files(args.repo, args.revision, wanted_only=not args.all)
    except urllib.error.HTTPError as exc:
        print("ModelScope refused %s (HTTP %s). Check the repo id." % (args.repo, exc.code), file=sys.stderr)
        return 1
    except Exception as exc:  # noqa: BLE001 - network stack varies by platform
        print("Could not reach ModelScope: %s" % exc, file=sys.stderr)
        return 1

    if not files:
        print("No matching files in %s@%s." % (args.repo, args.revision), file=sys.stderr)
        return 1

    total = sum(size for _, size in files)
    print("%s@%s -> %s" % (args.repo, args.revision, dest))
    for path, size in files:
        print("  %12s  %s" % (_human(size), path))
    print("  %12s  %d file(s)" % (_human(total), len(files)))
    if args.list:
        return 0

    done = skipped = 0
    for path, size in files:
        try:
            if download(args.repo, args.revision, path, dest, size) == "done":
                done += 1
            else:
                skipped += 1
        except Exception as exc:  # noqa: BLE001 - keep going, report at the end
            print("\nFailed on %s: %s" % (path, exc), file=sys.stderr)
    print("Downloaded %d, already present %d." % (done, skipped))

    required = ["rl_agent_config.json", "model.safetensors",
                os.path.join("encoder", "config.json"),
                os.path.join("tokenizer", "tokenizer.json"),
                os.path.join("tokenizer", "tokenizer_config.json")]
    missing = [r for r in required if not os.path.exists(os.path.join(dest, r))]
    if missing:
        print("Checkpoint incomplete, missing: %s" % ", ".join(missing), file=sys.stderr)
        return 2
    print("Checkpoint ready: %s" % dest)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
