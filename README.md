# Evolve PTC mode (`dsh-evolve-ptc`)

A new DeepSeek Harness mode: `evolve-ptc` / "Evolve PTC mode". It is not another PTC skin — it turns the
three things official PTC leaves to the model's good behaviour into **stateful, observable, escalating**
mechanisms.

| Pillar | Official PTC | Evolve PTC |
| --- | --- | --- |
| Computer operation | "observe before you act" as prose | a write without a successful observation, or a write after a write with no read-back, is detected and corrected |
| Creation mode | keep plugin source in memory, run once | scaffold → static contract check → stub-context smoke test → install → doctor → auto-rollback → lesson stored |
| Self-correction / self-evolution | persona reminders | JSONL task ledger + four detectors + escalation to a hard block + a versioned, revertible rule store shared across sessions |

## What it installs

- Preset **`evolve-ptc`** (display name "进化 PTC 模式", order 7). At load time it reads the **official
  `ptc.patch.yml` shipped with the installed Harness**, inherits every row verbatim, replaces only the persona
  prefix, appends one runtime row, and — when creation mode is on — adds the rows `cordis` has that `ptc` lacks.
  Upgrading DSH upgrades this mode; the plugin does not pin a copy of the official preset.
- Runtime row **`evolve-runtime`** (`dsh-evolve-ptc/runtime`): registers the `evolve` tool, refreshes the
  `[EVOLVE 进程]` system-prompt section each step, runs the detectors and the hard block, registers
  `/evolve-status`. It is scoped to sessions using this preset — switching mode makes it disappear.
- A settings card (Settings → Evolve PTC) and a plugin icon; UI follows the DSH language.

## Install

```bash
plugin_manager({ action: "install_bundle", target: "<absolute path to this directory>" })
# or
dsh plugin --profile <profile> add <absolute path to this directory>
```

A local directory install is a **link**, so edits take effect on reload; replacing an already installed
package requires an app restart. Afterwards check `application: "applied"` and `$DSH_HOME/evolve/status.log`.
Then start a new conversation and pick "进化 PTC 模式" in the mode selector.

Uninstall: `plugin_manager({ action: "remove_bundle", target: "dsh-evolve-ptc" })`.

## The `evolve` tool

| action | What it does | Key args |
| --- | --- | --- |
| `status` | ledger summary, rule count, environment, active block | — |
| `plan` | record / update the plan | `steps: [{id,title,status}]` |
| `note` | record one step's progress with evidence | `step`, `status`(done/failed/blocked/note), `evidence` |
| `phase` | switch the current phase | `text` |
| `check` | run the detectors now, list open steps | — |
| `reflect` | store a lesson as a rule (dedup, version bump) | `lesson: "when X do Y because Z"`, `scope` |
| `rules` | rule store | `op: list\|mark\|revert`, `ruleId`, `outcome: win\|used`, `version` |
| `plugin` | creation mode | `op: new\|validate\|test\|install\|doctor\|rollback\|list`, `name`, `path`, `template: tool\|preset\|bundle` |
| `override` | clear detector counters (escape hatch, not a fix) | `detail` |

Results are capped at 4 KB; failures return one actionable sentence instead of a stack trace.

## Detectors and escalation

Activity comes from the session itself (`tool/call` paired with `tool/result`, plus a listener fallback).

| detector | fires when | expected response |
| --- | --- | --- |
| `repeatFailure` | same tool fails `hardBlockAfter` times in a row | change the hypothesis, not the retry |
| `spin` | ≥3 identical call signatures in the last 10 calls | stop and say why nothing moves |
| `unverifiedWrite` | a write tool (`computer_click/type/key/…`, `browser_actions`, `write`, `edit`) is followed by another write with no observable call in between | take a screenshot / read the file first |
| `softFailures` | ≥3 scattered failures | one `reflect`, then continue |

Every hit is written to the ledger and injects a correction block. Only `repeatFailure` escalates to a
**hard block** (`hardBlockAfter` hits, default 3): `tools.guard` rejects **write tools only** — reads,
screenshots, searches and `evolve` always pass, because a blocked agent that cannot gather evidence is
just stuck. The block lifts itself after 120 s, and `reflect` / `override` clear it immediately. Strikes
are deduplicated by evidence fingerprint, so one batch of failures seen again on later steps counts once,
and any successful action resets the counters. The guard degrades to a plain hint if the host's signature does not match — it never takes the
host down.

## Creation mode

`evolve({action:"plugin", ...})` runs a fixed pipeline; any failed step stops the rest:

1. **`new`** — scaffold from the `tool` / `preset` / `bundle` template inside the plugin workspace
   (default `$DSH_HOME/evolve/workspace`).
2. **`validate`** — static contract check: manifest keys, patch YAML, `exports` targets, locale JSON, client shape.
   Nothing is written if it fails.
3. **`test`** — run `apply` for real against a stub context (the module under test is not mocked).
4. **`install`** — snapshot the profile (`package.json` + `cordis.patch.yml`), then install through the host's
   `pluginManager` service. **If that service is not reachable it says "⚠ not executed" and returns the exact
   `plugin_manager` call to make — it never claims success.**
5. **`doctor`** — health check against the profile entry.
6. **`rollback`** — restore the snapshot and re-check.

With `autoRollback` on, a failing doctor runs step 6 automatically. Nothing ever writes into the profile's
`node_modules` (a local install is a link — writing there means editing the repo).

## Rule store

`$DSH_HOME/evolve/rules/<scope>.json`, where `scope` is a hash of the working directory, so sessions in the same
project share rules. Each rule carries `evidence`, `uses`, `wins`; the file keeps a `version` and the last 8
snapshots. New sessions inject up to `maxRules` rules ranked by wins, under-use and freshness. Revert with
`evolve({action:"rules", op:"revert", version: N})`. Writes go through a temp file + rename.

Ledgers live in `$DSH_HOME/evolve/ledgers/<sessionId>.jsonl`, trimmed to the last 400 lines past 512 KB, kept for
`ledgerRetentionDays`.

## Configuration

Row `evolve-ptc-settings` in `cordis.patch.yml`, or the settings card. Every value is clamped; bad values fall
back to defaults.

`environment` (`auto|wsl|powershell|zsh|bash`) · `wslDistribution` · `shellExecutable` ·
`foregroundSeconds` (30, 5–600) · `processInjection` (true) · `injectionEvery` (1) · `stallSeconds` (240) ·
`correctiveBlocks` (true) · `hardBlockAfter` (3, 2–8) · `rulesInjection` (true) · `maxRules` (8) ·
`creationMode` (true) · `pluginWorkspace` · `autoRollback` (true) · `ledgerRetentionDays` (14) ·
`snapshotBeforeInstall` (true)

## Self-check

```bash
node scripts/check.mjs     # or: npm test
```

Seven sections: manifest contract / patch YAML / **real derivation against the installed upstream preset**
(asserts id, order, row completeness, persona contract, runtime row, creation rows) / state layer and all four
detectors with negative cases / client shape / creation mode end-to-end (scaffold → validate → smoke → list) /
runtime smoke in a stub context (tool, injected section, escalation, hard block, rule store, switches, command).

Outside Electron the derivation falls back to `test/fixtures/*.patch.yml` (a copy that can go stale — the check
prints its source); point `EVOLVE_PTC_UPSTREAM` / `EVOLVE_PTC_CORDIS` at the real files in CI.

## Known limitations

- Client-side changes need a page refresh; replacing an installed version needs an app restart.
- Preset rows run in an isolate realm, so the `pluginManager` service may be unreachable — `install` then
  degrades to an explicit instruction instead of a silent failure.
- v1 does not rewrite the official shell rows (no executor-group isolation); `environment` is guidance only.
- Rules are scoped per working directory and not shared across machines; rule quality is whatever `reflect` wrote.
