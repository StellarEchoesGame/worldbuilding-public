# Echo Forge (WB-F1)

Local system that grows the Stellar Echoes canon one scene at a time: gateway writers draft scenes, a mechanical fact gate checks them, four judge CLIs (Codex, Claude Code, Kimi Code, Grok) compare each draft blind against the row champion, and the owner decides in a local UI. Design: epic [#1](https://github.com/StellarEchoesGame/worldbuilding-public/issues/1). Slices so far: prototype [#2](https://github.com/StellarEchoesGame/worldbuilding-public/issues/2), protocol and offline engine core [#4](https://github.com/StellarEchoesGame/worldbuilding-public/issues/4), round orchestrator [#6](https://github.com/StellarEchoesGame/worldbuilding-public/issues/6) (in progress).

The executable rules live in [`PROTOCOL.md`](PROTOCOL.md) (Chinese). Its fenced `json protocol:<name>` blocks are what the engine reads: gate limits, forbidden words, negations, merge constants, maintainer activation classes and bars, calibration and agreement numbers. `judges.json` also names the maintainer and the merge editor (`merge_editor`, a fresh `claude -p` Opus session). `PROTOCOL.md`, `families.json` and `judges.json` form the protocol bundle; `forge protocol hash` prints its hash.

## Setup

```bash
cd world/forge
npm install
cp local.example.json local.json   # then fill in the gateway URL and the env file that holds its key
npm run forge -- doctor            # smoke-tests every judge CLI, the maintainer and the writer model
```

`local.json` is git-ignored. The gateway host and credential paths never go into tracked files; `doctor` checks this. Judge CLIs that reach OpenAI or xAI need the usual proxy environment.

```bash
npm run forge -- canary                     # isolation check for every judge adapter and the maintainer
npm run forge -- canary --only grok         # rerun one adapter; canary/results.json keeps the latest result per adapter
                                            # the exit code follows this run; the summary line also names adapters still failing in results.json
```

The canary plants a fresh token in copies of `PROTOCOL.md`, a sealed plaintext and a champion file under the git-ignored `.sealed/canary/`, gives the adapter only their paths, and invites it to read them, search the web and write out any instructions it received. An adapter fails if its answer or its raw stdout/stderr holds the token (whitespace ignored, also without the `FORGE-CANARY-` prefix) or one of the `private_phrases` listed in `local.json`, or if the call fails. `canary/results.json` records a failure by category only; raw outputs stay in `.runs/canary/`.

`accepted_served` in `judges.json` lists every model id a CLI may report as served. When it is non-empty, a call that reports another model, or none, is void; when a CLI lists auxiliary models too, the listed one counts. An empty list skips the check for CLIs that do not report a served model (Codex, Kimi).

Costs: `prices.json` (owner-maintained, `"currency": "USD"`, price per million input / output tokens per model id) turns reported tokens into cost; Claude and Grok report their own cost. Each round writes `rounds/<ID>/cost.json` with attempts (retries included), tokens and cost per backend.

## Run a prototype round (P rounds)

```bash
npm run forge -- round run P01 --cell cells/R1-mothership.json
npm run forge -- round status P01
```

P01 is frozen: the command only resumes a P round that already has its `brief.json` and refuses new P ids (the prototype runner does not redact adapter errors); new rounds are R rounds. P01's `freeze.json` pins the canon, brief, benchmark file and writer config by content hash together with the protocol bundle hash. A rerun of the same command resumes: finished writer and judge calls are skipped, and the rerun refuses to continue if any pinned input changed. `--benchmark <file>` picks the benchmark version (default `benchmark/v0.json`). Per-call provenance is committed under `rounds/<ID>/calls/`; raw CLI transcripts stay in git-ignored `.runs/`.

## Round orchestrator (F1-03, in progress)

R rounds (`R01`, …) run on the step machine (`engine/runner.ts`, steps in `engine/steps/`). This build registers steps 00-start … 09b-decision: start, topic, brief, baseline, freeze, sealed forecasts, seal, probe mirror, writers and mechanical gate (00–05a), then defect copy, LLM gate, blind resubmission, decoy, champion and aux taste pairs, measures, unseal, surprise, aggregate and the two owner waits (05b–09b). A round of this build ends `done` at 09b; merge, bookkeeping and the benchmark cycle are later slices.

```bash
npm run forge -- round start R01 --cell cells/R1-mothership.json   # 00-start + 01-topic; without --cell the owner picks in the UI (engine default after 24 h)
npm run forge -- round run R01              # resume at the first unmarked step; --until / --from / --redo-from <step>, --quota-budget-min <n>
npm run forge -- round status R01 --verify  # status.json, plus a check of the marker chain (--json for the raw file)
npm run forge -- freeze --check R01         # drift of the freeze pins (bundle, benchmark, skills, marker inputs) against the tree
```

- One round at a time: `round start` refuses while an earlier `forge/rNN` or any local `forge/calib-<set>` branch is not merged into `main`. PRs are squash-merged, so a round counts as merged once local `main` holds its `rounds/RNN/start.json`: pull `main` after merging.
- 00-start waits until the owner approved the current protocol bundle (owner-log `protocol_approved`), runs `doctor`, branches `forge/rNN` from `main` and opens the round sub-issue under the epic named in `github.json`.
- Exit codes: 0 done · 1 usage (config, a live engine lock, another round open, wrong branch with a dirty tree, refused redo) · 2 waiting for the owner (`status.json` names what) · 3 integrity (marker, output or pinned-input drift, an owner file whose hash differs from its owner-log entry) · 4 blocked (probe mirror, public-content scan, quota, calibration, GitHub) · 5 failed (doctor red, void baseline or decoy, no passing submission after resubmission, missing precondition).
- Files: `rounds/RNN/` holds `start.json`, `topic-offer.json`, `topic.json`, `brief.json`, `freeze.json`, `probes.sha256`, `probe.json`, `submissions/`, `gate/`, `tasks/` and `calls/` (per-call provenance; errors redacted), `markers/<step>.json` (done-markers chained by hash; `markers/stale/<n>/` after a rewind or `--redo-from`), and `status.json` + `progress.jsonl` for the UI. Sealed forecasts and the nonce stay in `.sealed/RNN/`, raw transcripts in `.runs/`; the local mirror log `rounds/RNN/mirror.jsonl` and the engine lock `.forge.lock` are git-ignored too.
- The engine commits on `forge/rNN` only at 03c (start, topic, brief, freeze, `probes.sha256`), after a public-content scan of every committed byte, and posts the forecast probe on the round issue before any writer runs. The repository is public, so the engine only accepts marked issues and probe comments whose author is an OWNER, MEMBER or COLLABORATOR of the repository; anyone else's are ignored.
- `--redo-from` a step up to 03c is allowed until `probe.json` exists; 03b then reseals with a fresh nonce. A crash between 03c's `freeze.json.probe_created_at` amendment and its marker resumes normally.
- Writers get tracked skill snapshots from `skills/*.md` (`systemic-worldbuilding`, `metabolic-cultures`); 02c pins their hashes in `freeze.json.skills`.
- 05b–07b (`rounds/RNN/`): 05b writes `gate/defect.json` (one seeded defect copy per round, of one gate-bound submission; a D3 copy targets one of the brief's forbidden moves, which the gate judges see as `X01｜…` rows next to the fact table; a void defect writer only flags that submission `defect_unverified`). 05c runs two gate judges per submission (plus the copy for the defect submission's judges) into `gate/llm.json` and `gate/<sub>.json`; a family that misses the copy loses all its gate verdicts of the round and a reserve family replaces it. 05d gives each failed slot one blind resubmission (`submissions/<slot>-r2.json`, same prompt, no gate feedback) and a fresh gate pass (`gate/resubmit.json`, which also lists every family voided this round); no passing submission fails the round (exit 5). 06a snapshots `champion.json` and writes `decoy.json` + `submissions/DECOY.json`; 06b writes `pairs.json` and `taste/<pair>/<family>-s<k>[r]-<fwd|rev>.json` (a family that prefers the decoy or voids, again in its one rerun, drops out of E for that pair; flagged families judge as shadow and never count); 06c writes `taste/aux/` (sub–sub and anchor pairs, ordering only; a skipping 06c removes an earlier run's aux files); 06d writes `measures/{recall,skin-swap,cold-reader,producer}/<sub>.json`; 07a writes `unseal.json` (seal, nonce, probe comment and call ordering checked; never a forecast value) and 07b `surprise.json` (skipped, and an earlier `surprise.json` removed, when the unseal is invalid). The two matchers are the only calls that see forecast values: their records and raw replies stay under `.sealed/RNN/`.
- 08-aggregate writes `labels.json` (label A/B/C → submission), `tally.json` (the champion's kind from `champion.json`; per champion pair: E after drops, wins by family, bar 7/8 or 8/8 at |E| = 4, 6/6 at |E| = 3, `trial` at |E| ≤ 2; aux ordering; void counts), `cost.json` (from the call records, the sealed forecaster and matcher calls included), `wild-seeds.json` (the writers' wild seeds for F1-04's vote) and `card.json`: one entry per gate-passing submission with its label, wins against the champion, gate outcome and counted families, path-instance notes, the cold reader's protagonist line, the interface card, hook / skin-swap / cold-reader / surprise results and flags (⚑事实门评委不足, ⚑事实门分歧, ⚑缺陷抓取未验证, ⚑试评 (never mergeable), ⚑接口卡未通过, …).
- 09a writes `audit-set.json` (4 pairs seeded from every pair judged this round, split 2 visible / 2 reserve by seed, before any answer) and waits for the owner's `audit.json` (exit 2, `waiting_for: "audit"`); 09b waits for `decision.json` (`waiting_for: "decision"`, again when the decision is superseded). Once `audit.json` exists `--redo-from` refuses steps up to 09b, and once 07a is marked it refuses steps up to 06d.
- The engine never writes owner files (`owner-log.jsonl`, `rounds/*/audit.json`, `rounds/*/decision*.json`, `calibration/owner-answers.json`); only the UI does.

## Review in the UI

Run from your own terminal (the launcher refuses to serve the real data directory from inside an agent session):

```bash
npm run ui
```

It builds the Astro app, starts it on 127.0.0.1:4391 and opens the browser with a one-time token. Order per round: blind audit → results → decision. Owner files (`audit.json`, `decision.json`, `owner-log.jsonl`) are written only by the UI and cannot be overwritten.

## Offline tools

```bash
npm run forge -- protocol hash                          # protocol version + bundle hash
npm run forge -- thinmap --top 20                       # thin-map ranking of rows × layers (map/*.json, fact-status.json, 07 §8)
npm run forge -- thinmap --aliases tests/fixtures/thinmap/aliases.json --tags tests/fixtures/thinmap/tags.json
npm run forge -- bench validate benchmark/v1.json       # maintainer-version checks; the parent is found by version
                                                        # --round <n> --rollbacks <file> applies the rollback hold until the benchmark log lands (F1-04)
npm run forge -- mergecheck --decision merge.json --base main   # checks a canon merge in the working tree
```

- `fact-status.json` maps the core facts F01–F15 (reference 07 §2) to a status and rows. It is a proposal until the owner confirms it; five entries are marked ambiguous.
- `map/rows.json` fixes the 20 thin-map rows. `map/aliases.json`, `map/tags.json` and `map/game-need.json` are optional until the first tagging pass (F1-05); without tags every cell is 0.
- `mergecheck` compares the working tree with `--base`: 09 append-only with one scene built from whole frozen sentences, 07 §8 rows, 01–06 index lines, and nothing else under `world/current/` except the files `assemble_reference.py` regenerates, the engine-updated `reference/manifest.json` and the revision-notes files listed in `protocol:merge` `notesPaths`.

## Checks

```bash
npm test          # node:test for engine and UI logic
npm run typecheck # tsc strict for the engine + astro check for the UI
(cd ../current/reference && python3 -m unittest test_assemble_reference)   # reference bundle reproduces byte for byte
```
