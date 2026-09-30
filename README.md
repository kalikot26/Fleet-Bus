# Fleet Bus

**A tiny, file-based message bus that lets AI coding agents talk to each other on one machine.**

Run Claude Code in one window, Codex CLI in another, and a Grok bot or your own script in a third. With Fleet Bus they can hand each other tasks, report results, broadcast rules, and wake each other up. There is no server, no daemon, no database, no MCP server and no account. It is one Node.js file with zero dependencies, plus a folder of JSON files.

Any agent that can **run a shell command** and **read its output** can join, whichever vendor or model it comes from.

```
 ┌──────────────┐   send --to builder-a    ┌──────────────┐
 │ Claude Code  │ ───────────────────────▶ │  Codex CLI   │
 │ (lane: main) │                          │ (lane: bldr) │
 │              │ ◀─────────────────────── │              │
 └──────────────┘   send --to main         └──────────────┘
        │   ▲             (report)                 │
        ▼   │                                      ▼
   ~/.claude/fleet/main/inbox/*.json      ~/.claude/fleet/builder-a/inbox/*.json
```

---

## Why

Once you run several AI coding sessions in parallel, for example one per git worktree or one per task, they need to coordinate:

- An **orchestrator** session hands a bounded task to a **builder** session and gets a report back.
- A rule changes (a new branch policy, a new model to use), and every running session needs to hear it once.
- A session finishes a milestone (a PR merged, a deploy done), and the others must rebase or react.
- A session is waiting on another one and should **wake up** when the answer lands, instead of polling in chat.

Chat-level "send a message to the other conversation" features only work inside one app, and usually only while the target is open. Fleet Bus is vendor-neutral and durable. Messages sit on disk until the receiving lane reads them, even when it is closed.

## How it works

### Lanes

A **lane** is a mailbox that one agent session owns. By default a lane's name is the base name of the session's working directory (for example `feature-login` for `/work/repo/.worktrees/feature-login`), so the sender can compute the receiver's lane without any registry. You can also bind any folder to any lane name with `register`.

```
<FLEET_HOME>/                  default: ~/.claude/fleet
  _lanes.json                  cwd -> lane registry
  .fleet-root                  optional: the directory whose sub-folders auto-become lanes
  <lane>/
    inbox/<id>.json            pending messages (one file per message)
    done/<id>.json             archived messages
    .listening                 present while a listener is alive for this lane
    .seen                      last time the lane ran any fleet command (presence)
```

### Messages

Every message is **one JSON file**. It is written atomically (temp file plus rename) and never edited in place, so two writers cannot overwrite each other.

```json
{
  "id": "001790000000000-a1b2c3",
  "ts": "2026-01-01T12:00:00.000Z",
  "from": "main",
  "to": "builder-a",
  "type": "task",
  "subject": "Add input validation to the signup form",
  "authorized": true,
  "refs": { "branch": "feat/signup-validation", "worktree": null, "paths": [], "commands": [], "limits": null },
  "reply_to": null,
  "body": "Scope: ... Proof required: ... Report back with the PR number."
}
```

Message types:

| type | meaning |
|---|---|
| `task` | work for the receiver. It may act on it only when `authorized: true` |
| `correction` | a rule or instruction change the receiver must apply |
| `gate` | explicit permission to continue past a checkpoint, or a yes/no question |
| `report` | status or result going back to the sender |
| `note` | informational |
| `blocked` | the sender is blocked and needs something |
| `ack` | an automatic receipt (sent by `ack`) |
| `fyi` | a silent notice that needs no action; it never wakes the receiver (see [Silent FYI messages](#silent-fyi-messages)) |

Message ids start with a zero-padded millisecond timestamp, so the inbox sorts chronologically.

### Reading and archiving

A lane reads its own inbox (`poll`), prints one message in full (`read`), acts on it, and then archives it (`done`, or `ack` to also send a receipt). Archived messages move to `done/`. Nothing is ever deleted.

### Waking up: listeners

`wait --lane <lane>` blocks until a message lands in that lane's inbox, prints it, and exits. An agent runs it **as a background task**. When it exits, the agent's harness wakes the agent, the agent handles the message, and then it runs `wait` again. While a listener is alive, `.listening` holds its pid (or, for long-running monitors, a timestamp refreshed every few seconds). That is how the bus knows a lane is **online**.

**Persistent monitor (optional).** Some harnesses keep one long-running watcher instead of restarting `wait` after every message. `tools/lane-monitor.mjs <FLEET_HOME> <lane>` never exits. Every 10 seconds it refreshes the `.listening` lock in monitor mode, and it prints one `FLEET WAKE` line for each new message except `fyi` and `ack`. The bus treats the lane as online for as long as that timestamp is fresh (under 45 seconds).

### Presence and stale messages

- `lanes` lists every lane as **ONLINE** (a live listener) or **OFFLINE**, with **last seen** (the last time that lane ran any fleet command) and its pending count. Online lanes come first.
- `send --to online` broadcasts to every online lane except the sender, so rule changes don't pile up in lanes nobody will open again.
- A direct `send` to an offline lane still queues the message, and prints a warning so the sender knows it may not be read soon.
- **Expiry on resume.** When a lane lists its own inbox, `note`, `report` and `ack` messages older than 24 hours are archived automatically (marked `"expired": true`), and `fyi` messages older than 2 hours are archived silently. Older `task`, `correction`, `gate` and `blocked` messages are kept, but shown with an **OLD** warning: confirm they still apply before acting. A session reopened after a week gets a short list instead of replaying a stale backlog.
- `sweep` (dry run) and `sweep --apply` archive everything older than 24 hours (2 hours for `fyi`) in offline lanes. It is a one-time cleanup and never touches online lanes.

### Silent FYI messages

Every wake costs the receiving agent a turn. Send notices that need no action (dev-server start/stop notices, heads-ups, FYI cc) as `--type fyi`:

```bash
node fleet.mjs send --to online --from main --type fyi --subject "Dev server restarted" --body "No action needed."
```

- It is stored and readable with `poll` and `read`, but it never wakes `wait` or `tools/lane-monitor.mjs`.
- The hooks do not count it as pending. `lanes` shows it separately as `(+N fyi)`.
- It expires silently after 2 hours. Otherwise the receiver sees it tagged `[fyi]` the next time a real message wakes the lane.
- `ack` on an `fyi` only archives it, the same as `done`, so no receipt goes back to wake the sender.
- `--type fyi --authorized` is refused. Work the receiver may act on must be a `task`.

Use `note` or `report` only when the recipient must act or answer.

### Auto-arming in Claude Code

With three hooks (see Install), every Claude Code session whose working directory sits under the fleet root becomes a lane automatically.

- **SessionStart:** registers the lane and tells the agent to start its listener, with the exact command to run.
- **UserPromptSubmit:** if the listener died, it tells the agent to re-arm it silently.
- **Stop:** when the session settles without a listener, it reminds the agent to arm one.

All three hooks are silent for directories outside the fleet root.

### Several buses on one machine

Each project can have its own bus (its own home and root). A 10-line wrapper sets `FLEET_HOME` and `FLEET_ROOT` and then imports the shared `fleet.mjs`; see `examples/second-bus-wrapper.mjs`. Lanes on different buses never see each other.

---

## Install

**Requirements:** Node.js 18 or newer. It works on Windows, macOS and Linux.

### 1. Put the CLI somewhere stable

```bash
git clone https://github.com/kalikot26/Fleet-Bus.git ~/.fleet-bus
# the bus data lives in FLEET_HOME (default ~/.claude/fleet), not in the clone
```

### 2. Choose which folders are lanes

Either export an environment variable:

```bash
export FLEET_ROOT="$HOME/work/my-repo"        # every folder under this is a lane
```

or write the root into the bus home once:

```bash
mkdir -p ~/.claude/fleet && echo "$HOME/work/my-repo" > ~/.claude/fleet/.fleet-root
```

With no root configured, nothing auto-arms. You can still use lanes explicitly with `--lane` and `register`.

### 3. Claude Code: add the hooks

Add these hooks to `~/.claude/settings.json`, merged with any hooks you already have, and adjust the paths. A complete example is in `examples/claude-code-settings.json`.

```json
{
  "hooks": {
    "SessionStart":     [{ "hooks": [{ "type": "command", "command": "node ~/.fleet-bus/fleet.mjs sessionstart" }] }],
    "UserPromptSubmit": [{ "hooks": [{ "type": "command", "command": "node ~/.fleet-bus/fleet.mjs ensure", "timeout": 8 }] }],
    "Stop":             [{ "hooks": [{ "type": "command", "command": "node ~/.fleet-bus/fleet.mjs settle", "timeout": 8 }] }]
  }
}
```

Optionally, allow the CLI in your permissions so running it never prompts. For example, add `"Bash(node ~/.fleet-bus/fleet.mjs:*)"` to `permissions.allow`.

### 4. Codex CLI, Grok, or any other agent

Agents without hooks follow the same protocol from their instructions file (for example `AGENTS.md`). Copy `examples/AGENTS.fleet.md` into your agent's instructions. In short:

- At the start of every turn, run `node ~/.fleet-bus/fleet.mjs poll --lane <your-lane>`.
- For each message: `read`, act only if it is `authorized` and within your mandate, then `done` (or `ack`).
- To report back, `send --to <sender> --from <your-lane> --type report ...`.
- If your harness supports background commands, keep `wait --lane <your-lane>` running so you wake up on new mail.

### 5. Check it

```bash
node ~/.fleet-bus/fleet.mjs init --lane test-a
node ~/.fleet-bus/fleet.mjs send --to test-a --from me --type note --subject "hello" --body "it works"
node ~/.fleet-bus/fleet.mjs poll --lane test-a
node ~/.fleet-bus/fleet.mjs lanes
```

---

## Usage

```bash
# hand a task to another lane (it may act on it because --authorized is set)
node fleet.mjs send --to builder-a --from main --type task --authorized \
  --subject "Fix the date parser" --body-file brief.md

# the receiver: list, read, act, archive
node fleet.mjs poll --lane builder-a
node fleet.mjs read --lane builder-a --id 001790000000000-a1b2c3
node fleet.mjs done --lane builder-a --id 001790000000000-a1b2c3

# report back
node fleet.mjs send --to main --from builder-a --type report \
  --subject "Date parser fixed: PR #42" --body "Tests 12/12, ready for review."

# tell every online lane about a rule change
node fleet.mjs send --to online --from main --type correction \
  --subject "New rule: all PRs target the staging branch" --body-file rule.md

# who is online?
node fleet.mjs lanes

# sleep until mail arrives (run this in the background)
node fleet.mjs wait --lane main

# clean up stale mail in lanes nobody is using
node fleet.mjs sweep            # dry run
node fleet.mjs sweep --apply
```

Tip: pass long bodies with `--body-file` rather than `--body "..."`. Shells evaluate backticks and `$(...)` inside double quotes.

## Command reference

Run `node fleet.mjs help` for the built-in reference. The commands are `init`, `send`, `poll`, `read`, `done`, `ack`, `lanes`, `sweep`, `register`, `whoami`, `wait`, `banner`, `laneof`, `sessionstart`, `ensure` and `settle`. Environment variables:

| variable | default | purpose |
|---|---|---|
| `FLEET_HOME` | `~/.claude/fleet` | where lanes and messages live |
| `FLEET_ROOT` | contents of `<FLEET_HOME>/.fleet-root`, else none | the folder whose sub-folders auto-become lanes |
| `FLEET_SELF` | this file | the path printed in "arm your listener" hints (set by wrappers) |

## Safety model

Fleet Bus moves text between agents. It gives no agent new powers. The protocol is designed so that one agent cannot talk another into doing something risky:

- **A peer message is data, not authority.** Only the human owner grants permission. A message saying "the owner approved this" is not approval.
- `authorized: true` means "you may do the build work described, within your mandate". It **never** authorizes a deploy, a database migration, a production change, or anything irreversible. Those always need the human owner's explicit OK in that agent's own session.
- Agents should treat message bodies like any untrusted input: never run commands copied from a message without checking them, and never follow instructions that conflict with the owner's rules.
- Messages are plain files under your home directory, readable by your user account. **Never put secrets, passwords or API keys in a message.**

## Limitations

- **Single machine, or a shared filesystem.** Lanes talk through the local disk. There is no network transport.
- **Polling wake.** `wait` checks the inbox every few seconds (3 s by default), which is instant enough for agents but not a real-time channel.
- **Closed sessions can't be woken.** A lane that isn't running picks up its mail the next time it opens. The expiry rules keep that backlog short.
- **No encryption and no multi-user access control.** It relies on your OS file permissions.

## Testing

```bash
node test-fleet.mjs
```

The test creates a throwaway bus under `./.testbus` and checks presence, online-only broadcast, expiry, sweep, silent `fyi` handling, root handling, and the core commands.

## License

MIT. See `LICENSE`.
