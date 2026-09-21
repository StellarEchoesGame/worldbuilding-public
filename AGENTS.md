# Repository commands and boundaries

- From the repository root: `npm --prefix wiki ci --no-audit --no-fund`, `npm --prefix wiki run build`, then `npm --prefix wiki run check:public`. The independent build uses the committed lockfile; the verified local toolchain is Node.js 26.7.0 and npm 11.19.0.
- `concepts/` contains canonical original artwork. `wiki/asset-sources.json` pins source and delivery paths plus SHA-256. `wiki/public/art/`, `wiki/public/records/neighborhood/`, and `wiki/public/records/concept-prompts.json` are generated and ignored; edit sources and mappings, not those copies.
- Keep every actual generation prompt and reference record unchanged. Absolute local paths in historical JSON/TXT are provenance, not executable paths to rewrite. Add new steps or versions for new work.
- `wiki/src/data/prompt-records.json` is the public prompt archive. Its full prompt strings must render without truncation; `check:public` verifies the exported JSON, rendered strings, image references and pinned asset bytes.
- World and concept Markdown use current relative links. References to the game repository use `https://github.com/StellarEchoesGame/game/blob/main/…`; Wiki page URLs remain rooted at `https://wiki.stellar-echoes.online`.
- `concepts/mothership/Neighborhood/build_layout.py` writes its local layout JSON, SVGs and check record. Those are concept allocations, not certified engineering dimensions. A layout change requires deliberate asset-manifest updates before the Wiki will build.
- Local build and public checks do not deploy. Cloudflare target configuration is retained; production changes are separate from repository maintenance.
