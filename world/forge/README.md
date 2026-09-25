# Echo Forge (WB-F1)

Local system that grows the Stellar Echoes canon one scene at a time: gateway writers draft scenes, a mechanical fact gate checks them, four judge CLIs (Codex, Claude Code, Kimi Code, Grok) compare each draft blind against the row champion, and the owner decides in a local UI. Design: epic [#1](https://github.com/StellarEchoesGame/worldbuilding-public/issues/1). Slices so far: prototype [#2](https://github.com/StellarEchoesGame/worldbuilding-public/issues/2), protocol and offline engine core [#4](https://github.com/StellarEchoesGame/worldbuilding-public/issues/4).

The executable rules live in [`PROTOCOL.md`](PROTOCOL.md) (Chinese). Its fenced `json protocol:<name>` blocks are what the engine reads: gate limits, forbidden words, negations, merge constants, maintainer activation classes and bars. `PROTOCOL.md`, `families.json` and `judges.json` form the protocol bundle; `forge protocol hash` prints its hash.

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

## Run a round

```bash
npm run forge -- round run P01 --cell cells/R1-mothership.json
npm run forge -- round status P01
```

A new round writes `freeze.json`, which pins the canon, brief, benchmark file and writer config by content hash together with the protocol bundle hash. A rerun of the same command resumes: finished writer and judge calls are skipped, and the rerun refuses to continue if any pinned input changed. `--benchmark <file>` picks the benchmark version (default `benchmark/v0.json`). Per-call provenance is committed under `rounds/<ID>/calls/`; raw CLI transcripts stay in git-ignored `.runs/`.

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
- `mergecheck` compares the working tree with `--base`: 09 append-only with one scene built from whole frozen sentences, 07 §8 rows, 01–06 index lines, and nothing else under `world/current/` except the files `assemble_reference.py` regenerates.

## Checks

```bash
npm test          # node:test for engine and UI logic
npm run typecheck # tsc strict for the engine + astro check for the UI
(cd ../current/reference && python3 -m unittest test_assemble_reference)   # reference bundle reproduces byte for byte
```
