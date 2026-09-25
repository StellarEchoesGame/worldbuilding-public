import { clockSkewed, probeFiles, probeMirror } from '../probe.ts';
import type { StepDef } from '../runner.ts';
import { IntegrityError } from '../task.ts';

/**
 * 03c: blocking probe mirror (probe.ts probeMirror); blocked → exit 4 with detail probe_mirror:<stage> (the redacted
 * error goes to the log and progress.jsonl); a foreign probe comment → integrity (exit 3). The marker lists probe.json
 * and the amended freeze.json (ALLOWED_AMENDMENTS); mirror.jsonl is an unlisted engine log.
 */
export const probeMirrorStep: StepDef = {
  id: '03c-probe-mirror',
  run: async (ctx) => {
    const r = await probeMirror(ctx);
    if (r.status === 'conflict') throw new IntegrityError(`probe_mirror:conflict: ${r.error}`);
    if (r.status === 'blocked') {
      ctx.log(`03c-probe-mirror blocked at ${r.stage}: ${r.error}`);
      ctx.progress('03c-probe-mirror', 'error', `${r.stage}: ${r.error}`);
      return { kind: 'blocked', detail: `probe_mirror:${r.stage}` };
    }
    if (clockSkewed(r.record)) ctx.log(`03c-probe-mirror: clock_skew (mirrored_at ${r.record.mirrored_at}, created_at ${r.record.created_at})`);
    const files = probeFiles(ctx.paths);
    return { kind: 'done', inputs: [ctx.files.rel(files.probes)], outputs: [ctx.files.rel(files.probe), ctx.files.rel(ctx.paths.freeze)], external: [] };
  },
};
