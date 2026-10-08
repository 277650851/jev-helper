"""Report on real request payloads captured with `--dump-states`.

     python tools/laya-state-report.py <dumpDir> [--model models/laya-multilingual] [--variants]

For every captured request it rebuilds the sequence exactly as Laya will (`build_sequence`) and reports
where the 1024-token budget per question goes: question text, option texts, and how much of the state
survives. The useful output is the field-survival table: the state is written after the options and cut
from the right, so whatever sits past the budget is never seen by the model. Reordering the state (see
`compact_state` in tools/laya-serve-local.py) is only worth anything if the fields that matter are the
ones being cut -- this measures that instead of guessing.

Run it against a dump, not against a match log: the log stores `stateSummary(state)`, a flattened
schema, so a state read back from a log is not the state the model saw.

`--variants` adds a comparison of candidate state encodings (as-is, `compact_units`, `priority_state`,
`slim_state`, and their combinations) over the same captured requests. Each candidate is probed with
`getattr` so a function T1 has not landed yet is skipped with a note instead of crashing the run.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import statistics
import sys
from collections import Counter

MAX_LEN = 1024
HEAD_MAX = 256
OPTION_MAX = 48


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Report on captured Laya request payloads.")
    parser.add_argument("dump_dir", help="directory written by tools/laya-serve-local.py --dump-states")
    parser.add_argument("--model", default=None, help="checkpoint dir holding the tokenizer")
    parser.add_argument("--limit", type=int, default=0, help="analyse at most this many payloads")
    parser.add_argument("--show-cut", type=int, default=12, help="how many cut fields to list per example")
    parser.add_argument("--variants", action="store_true",
                        help="also compare candidate state encodings over the same requests")
    args = parser.parse_args(argv)
    if not args.model:
        root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
        args.model = os.path.join(root, "models", "laya-multilingual")
    return args


def main(argv=None) -> int:
    args = parse_args(argv)
    paths = sorted(glob.glob(os.path.join(args.dump_dir, "state-*.json")))
    if args.limit:
        paths = paths[: args.limit]
    if not paths:
        print("no payloads in %s -- start the server with --dump-states and play a decision" % args.dump_dir)
        return 1

    from transformers import AutoTokenizer
    from laya.common import build_sequence, render_options, serialize_state

    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from importlib import util as _util
    tools_dir = os.path.dirname(os.path.abspath(__file__))
    spec = _util.spec_from_file_location("laya_serve_local", os.path.join(tools_dir, "laya-serve-local.py"))
    server = _util.module_from_spec(spec)
    spec.loader.exec_module(server)

    tok = AutoTokenizer.from_pretrained(os.path.join(args.model, "tokenizer"))

    def ntok(text):
        return len(tok(text, add_special_tokens=False)["input_ids"])

    # Load every payload once so the default report and --variants analyse the same requests. A file
    # that is not JSON, not an object, or carries no usable state/questions is counted as unusable with
    # a human-readable note instead of crashing the whole run on one bad capture.
    #
    # `preparedState` is what the model actually read: the server records it whenever a transform flag
    # is on. Without it every report describes the *full* arm, because the raw state is what a page
    # emits and compact_state only reorders it. Reading a raw capture as if it were the running arm is
    # how a --slim-state server got reported as "99% of questions at the cap, queues cut 100% of the
    # time" - a measurement of the arm that was not running. Captures taken before the field existed
    # still work: they fall back to compact_state(raw), which is exactly what the server sends when no
    # flag is set, and the count is reported so a mixed directory is never mistaken for one arm.
    payloads = []
    unusable = 0
    prepared_count = 0
    for path in paths:
        try:
            with open(path, encoding="utf-8") as fh:
                payload = json.load(fh)
        except (OSError, ValueError):
            unusable += 1
            continue
        if not isinstance(payload, dict):
            unusable += 1
            continue
        questions = payload.get("questions") or {}
        state = payload.get("preparedState")
        if isinstance(state, dict):
            prepared_count += 1
        else:
            state = payload.get("state")
        if not isinstance(state, dict) or not questions:
            unusable += 1
            continue
        payloads.append((state, questions))

    def choice_questions(questions):
        for _qid, q in questions.items():
            if (q or {}).get("type") != "choice" or not q.get("criteria"):
                continue
            yield {"t": "choice", "ins": q.get("instructions") or "", "crit": q["criteria"]}

    def head_options(question):
        # Mirrors build_sequence's head/option budget: each option is [mask]+tokens and the head is
        # capped to leave room for them. Kept identical to the default report so both modes agree on
        # how much room the state gets.
        options = sum(ntok(" " + o) + 1 for o in render_options(question))
        head = min(ntok("choice question: %s" % question["ins"]), max(8, HEAD_MAX - options))
        return head, options

    # ---- default report ---------------------------------------------------------------
    per_question, at_cap, cut_position = [], 0, []
    seen = Counter()
    cut = Counter()
    field_tokens = Counter()
    for state, questions in payloads:
        # Already what the model read when the capture carries preparedState; with no transform flag
        # the server sends exactly compact_state(state), so applying it here is not an approximation.
        ordered = state if prepared_count == len(payloads) else server.compact_state(state)
        # Token count of each top-level field, in the order the model will read them.
        pieces = [(key, ntok(json.dumps({key: value}, ensure_ascii=False)) - 1)
                  for key, value in ordered.items()]
        for question in choice_questions(questions):
            seq, _ = build_sequence(tok, ordered, question, MAX_LEN, HEAD_MAX)
            head, options = head_options(question)
            per_question.append(len(seq))
            if len(seq) >= MAX_LEN:
                at_cap += 1
            # Truncation is a prefix, not a knapsack: `build_sequence` keeps `state_ids[:room]`, so the
            # first field that does not fit takes every field after it with it. Walking the whole list
            # and testing each field independently reported small late fields as visible when nothing
            # past the cut can ever be read.
            room = len(seq) - head - options - 3
            used = 0
            blocked = False
            for key, cost in pieces:
                seen[key] += 1
                field_tokens[key] += cost
                if not blocked and used + cost <= room:
                    used += cost
                else:
                    blocked = True
                    cut[key] += 1
            cut_position.append(room)

    if not per_question:
        print("no usable choice questions in %d payloads" % len(paths))
        return 1

    print("payloads          %d (%d unusable)" % (len(paths), unusable))
    print("choice questions  %d" % len(per_question))
    print("state analysed    %s" % (
        "preparedState (what the model read)" if prepared_count == len(payloads)
        else "raw state + compact_state (%d/%d payloads carried no preparedState)" % (
            len(payloads) - prepared_count, len(payloads))))
    print("tokens/question   mean %.0f  median %.0f  min %d  max %d" % (
        statistics.mean(per_question), statistics.median(per_question), min(per_question), max(per_question)))
    print("at the %d cap     %d (%.0f%%)" % (MAX_LEN, at_cap, 100.0 * at_cap / len(per_question)))
    print("state budget      mean %d tokens (this is how much of the state the model can read)" % (
        statistics.mean(cut_position)))
    print()
    print("state fields, by how often they are cut off before the model reads them:")
    print("  %-20s %8s %8s" % ("field", "present", "cut"))
    for key, present in sorted(seen.items(), key=lambda kv: -cut[kv[0]] / max(1, kv[1])):
        share = 100.0 * cut[key] / max(1, present)
        if share:
            print("  %-20s %8d %7.0f%%" % (key, present, share))

    # ---- droppable-fields analysis -----------------------------------------------------
    # A field is only *provably* free to drop when it is cut in 100% of the samples that carry it:
    # dropping a field the model sometimes reads changes those sequences, so "almost always cut" is a
    # trade, not a free win. When no field reaches 100% the honest answer is that there is no provably
    # side-effect-free droppable field -- reporting an empty set as "validated" would be a tautology.
    print()
    print("可白丢字段（只有在 100% 的样本里都落在截断点之外，才能证明丢掉它没有副作用）：")
    droppable = [key for key, present in seen.items() if present and cut[key] >= present]
    near = [(key, cut[key] / present) for key, present in seen.items()
            if present and 0.95 <= cut[key] / present < 1.0]
    if droppable:
        print("  可证明无副作用的白丢字段：")
        for key in sorted(droppable, key=lambda k: -field_tokens[k] / seen[k]):
            print("    %-20s 100%%   能省 %4.0f token   丢掉后 0 份样本序列变化" % (
                key, field_tokens[key] / seen[key]))
    else:
        print("  不存在可证明无副作用的白丢字段。")
    if near:
        print("  接近的候选（≥95% 频率，但丢掉会改变部分样本的序列，不能算白丢）：")
        for key, share in sorted(near, key=lambda kv: -kv[1]):
            print("    %-20s %3.0f%%   能省 %4.0f token   丢掉后 %d 份样本序列会变化" % (
                key, 100 * share, field_tokens[key] / seen[key], seen[key] - cut[key]))

    # ---- variants ----------------------------------------------------------------------
    if args.variants:
        print()
        print("编码候选对比（同一批 %d 份采集请求）：" % len(payloads))
        # Each variant is a pipeline of transforms applied to the raw state in order. "现状" is the
        # encoding the tool (and the server's predict path) uses today -- `compact_state` -- and is the
        # baseline the relative-compute column is measured against. "原样" is the state exactly as the
        # page emitted it. Combinations compose the candidate transforms; a missing function (T1 still
        # landing) is probed with getattr and skipped with a note rather than crashing.
        variants = [
            ("现状 compact_state", ("compact_state",)),
            ("原样", ()),
            ("compact_units", ("compact_units",)),
            ("priority_state", ("priority_state",)),
            ("slim_state", ("slim_state",)),
            ("compact_units+priority_state", ("compact_units", "priority_state")),
            ("compact_units+slim_state", ("compact_units", "slim_state")),
            ("priority_state+slim_state", ("priority_state", "slim_state")),
            ("compact_units+priority_state+slim_state", ("compact_units", "priority_state", "slim_state")),
        ]

        def apply_fns(state, fns):
            for fn in fns:
                state = fn(state)
            return state

        def variant_stats(fns):
            state_tokens, seq_lens = [], []
            field_present, field_visible = Counter(), Counter()
            for state, questions in payloads:
                ordered = apply_fns(state, fns)
                state_tokens.append(ntok(serialize_state(ordered)))
                pieces = [(key, ntok(json.dumps({key: value}, ensure_ascii=False)) - 1)
                          for key, value in ordered.items()]
                # Tokenize the state once per payload and reuse it across its questions. This is the
                # same tokenization build_sequence does internally; passing state_ids is just a cache,
                # so the rebuilt sequence is identical to re-serializing every time.
                state_ids = tok(serialize_state(ordered).replace(tok.mask_token, " "),
                               add_special_tokens=False)["input_ids"]
                for question in choice_questions(questions):
                    seq, _ = build_sequence(tok, ordered, question, MAX_LEN, HEAD_MAX,
                                            state_ids=state_ids)
                    head, options = head_options(question)
                    seq_lens.append(len(seq))
                    # Same continuous-prefix walk as the default report: a field is visible only if it
                    # fits before the first field that does not.
                    room = len(seq) - head - options - 3
                    used = 0
                    blocked = False
                    for key, cost in pieces:
                        field_present[key] += 1
                        if not blocked and used + cost <= room:
                            used += cost
                            field_visible[key] += 1
                        else:
                            blocked = True
            return {
                "state_tokens": statistics.mean(state_tokens),
                "seq_len": statistics.mean(seq_lens),
                "field_present": field_present,
                "field_visible": field_visible,
            }

        stats, skipped = {}, []
        for label, pipeline in variants:
            fns, missing = [], None
            for name in pipeline:
                fn = getattr(server, name, None)
                if fn is None:
                    missing = name
                    break
                fns.append(fn)
            if missing:
                skipped.append((label, missing))
            else:
                stats[label] = variant_stats(fns)

        for label, missing in skipped:
            print("  跳过 %s：laya-serve-local.py 尚未实现 %s" % (label, missing))

        current = stats.get("现状 compact_state")
        print("  %-40s %10s %10s %9s  %s" % ("编码", "战况token", "序列长度", "相对计算量", "可见字段（命中率）"))
        for label, _pipeline in variants:
            if label not in stats:
                continue
            st = stats[label]
            rel = (st["seq_len"] / current["seq_len"]) if current else 0.0
            fields = []
            for key, present in st["field_present"].items():
                rate = 100.0 * st["field_visible"].get(key, 0) / present
                if rate > 0:
                    fields.append((key, rate))
            fields.sort(key=lambda kv: (-kv[1], kv[0]))
            cell = ", ".join("%s:%.0f%%" % (k, r) for k, r in fields[:12])
            if len(fields) > 12:
                cell += ", …"
            print("  %-40s %10.0f %10.0f %8.2fx  %s" % (
                label, st["state_tokens"], st["seq_len"], rel, cell))

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
