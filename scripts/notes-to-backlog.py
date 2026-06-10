#!/usr/bin/env python3
"""Parse raw notes into a Taskwarrior backlog using a coding agent.

The agent only *parses* your notes into structured tasks; it does not do any
engineering work. Tasks are created in a staging state (default: `triage`) that
Symphony deliberately ignores, so you review the backlog and promote the ones you
want before any agent runs them:

    triage  --(you review & release)-->  todo  --(Symphony picks up)-->  ...

Usage:
    ./scripts/notes-to-backlog.py notes.md
    pbpaste | ./scripts/notes-to-backlog.py
    PROJECT=webapp DRY_RUN=1 ./scripts/notes-to-backlog.py notes.md

Environment:
    PROJECT         project: tag applied to every created task
    AGENT           parser agent: codex (default) | claude
    TASK_AGENT      agent: UDA on created tasks (default: codex)
    BACKLOG_STATE   staging state for created tasks (default: triage)
    DRY_RUN=1       print what would be created, but don't touch Taskwarrior
"""
import json
import os
import re
import shutil
import subprocess
import sys

PROMPT = """You are triaging raw engineering notes into a task backlog.
From the notes below, extract each distinct, actionable task.
Output ONLY a JSON array (no prose, no markdown code fences) of objects with keys:
  "title":    short imperative summary, <= 80 chars
  "priority": "H" | "M" | "L"
  "tags":     array of short lowercase labels (may be empty)
  "notes":    optional one-line extra context (may be omitted)

NOTES:
---
{notes}
---
"""


def run_agent(prompt: str, agent: str) -> str:
    """Run the parser agent and return its final text answer."""
    if agent == "codex":
        proc = subprocess.run(
            ["codex", "exec", "--json", "--sandbox", "read-only", "--skip-git-repo-check"],
            input=prompt, capture_output=True, text=True,
        )
        text = None
        for line in proc.stdout.splitlines():
            line = line.strip()
            if not line:
                continue
            try:
                obj = json.loads(line)
            except json.JSONDecodeError:
                continue
            item = obj.get("item") or {}
            if obj.get("type") == "item.completed" and item.get("type") == "agent_message":
                text = item.get("text")
        if text is None:
            sys.exit(f"codex produced no agent_message.\nstderr: {proc.stderr[:600]}")
        return text

    if agent == "claude":
        proc = subprocess.run(
            ["claude", "-p", "--output-format", "json"],
            input=prompt, capture_output=True, text=True,
        )
        try:
            return json.loads(proc.stdout)["result"]
        except Exception:
            sys.exit(f"claude output not parseable.\nstdout: {proc.stdout[:600]}\nstderr: {proc.stderr[:600]}")

    sys.exit(f"unknown AGENT={agent!r} (use codex or claude)")


def extract_json_array(text: str):
    start, end = text.find("["), text.rfind("]")
    if start < 0 or end <= start:
        sys.exit(f"no JSON array found in agent output:\n{text[:600]}")
    try:
        return json.loads(text[start:end + 1])
    except json.JSONDecodeError as e:
        sys.exit(f"agent output was not valid JSON: {e}\n{text[start:end + 1][:600]}")


def main() -> None:
    if len(sys.argv) > 1:
        with open(sys.argv[1], encoding="utf-8") as fh:
            notes = fh.read()
    elif not sys.stdin.isatty():
        notes = sys.stdin.read()
    else:
        sys.exit(__doc__)

    if not notes.strip():
        sys.exit("no notes provided")
    if not shutil.which("task"):
        sys.exit("`task` (Taskwarrior) not found on PATH")

    agent = os.environ.get("AGENT", "codex")
    project = os.environ.get("PROJECT", "")
    task_agent = os.environ.get("TASK_AGENT", "codex")
    state = os.environ.get("BACKLOG_STATE", "triage")
    dry = os.environ.get("DRY_RUN") == "1"

    print(f"Parsing notes with {agent}…", file=sys.stderr)
    tasks = extract_json_array(run_agent(PROMPT.format(notes=notes), agent))
    if not isinstance(tasks, list):
        sys.exit("agent did not return a JSON array of tasks")
    print(f"Extracted {len(tasks)} task(s){' (dry run)' if dry else ''}:\n", file=sys.stderr)

    created = 0
    for t in tasks:
        if not isinstance(t, dict):
            continue
        title = str(t.get("title", "")).strip()
        if not title:
            continue
        add_args = ["task", "rc.confirmation=off", "rc.verbose=new-id", "add", title,
                    f"state:{state}", f"agent:{task_agent}"]
        if project:
            add_args.append(f"project:{project}")
        if t.get("priority") in ("H", "M", "L"):
            add_args.append(f"priority:{t['priority']}")
        for tag in t.get("tags") or []:
            tag = str(tag).strip().replace(" ", "_")
            if tag:
                add_args.append("+" + tag)

        print(f"  + [{t.get('priority', '-')}] {title}"
              + (f"  +{','.join(t['tags'])}" if t.get("tags") else ""))
        if dry:
            continue

        res = subprocess.run(add_args, capture_output=True, text=True)
        if res.returncode != 0:
            print(f"    ! failed: {res.stderr.strip()}", file=sys.stderr)
            continue
        created += 1
        note = str(t.get("notes", "")).strip()
        m = re.search(r"Created task (\d+)", res.stdout)
        if note and m:
            subprocess.run(["task", "rc.confirmation=off", m.group(1), "annotate", note],
                           capture_output=True, text=True)

    print(f"\n{'Would create' if dry else 'Created'} {created if not dry else len(tasks)} task(s) "
          f"in state:{state}.", file=sys.stderr)
    print(f"Review:  task state:{state} list", file=sys.stderr)
    print(f"Release: task <id> modify state:todo", file=sys.stderr)


if __name__ == "__main__":
    main()
