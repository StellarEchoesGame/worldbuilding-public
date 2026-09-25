# Echo Forge (WB-F1) — prototype F1-00

Local system that grows the Stellar Echoes canon one scene at a time: gateway writers draft scenes, a mechanical fact gate checks them, four judge CLIs (Codex, Claude Code, Kimi Code, Grok) compare each draft blind against the row champion, and the owner decides in a local UI. Design: epic [#1](https://github.com/StellarEchoesGame/worldbuilding-public/issues/1); this slice: [#2](https://github.com/StellarEchoesGame/worldbuilding-public/issues/2).

## Setup

```bash
cd world/forge
npm install
cp local.example.json local.json   # then fill in the gateway URL and the env file that holds its key
npm run forge -- doctor            # smoke-tests every judge CLI, the maintainer and the writer model
```

`local.json` is git-ignored. The gateway host and credential paths never go into tracked files; `doctor` checks this. Judge CLIs that reach OpenAI or xAI need the usual proxy environment.

## Run a round

```bash
npm run forge -- round run P01 --cell cells/R1-mothership.json
npm run forge -- round status P01
```

A rerun of the same command resumes: finished writer and judge calls are skipped. Per-call provenance is committed under `rounds/<ID>/calls/`; raw CLI transcripts stay in git-ignored `.runs/`.

## Review in the UI

Run from your own terminal (the launcher refuses to serve the real data directory from inside an agent session):

```bash
npm run ui
```

It builds the Astro app, starts it on 127.0.0.1:4391 and opens the browser with a one-time token. Order per round: blind audit → results → decision. Owner files (`audit.json`, `decision.json`, `owner-log.jsonl`) are written only by the UI and cannot be overwritten.

## Checks

```bash
npm test          # node:test for engine and UI logic
npm run typecheck # tsc strict for the engine + astro check for the UI
```
