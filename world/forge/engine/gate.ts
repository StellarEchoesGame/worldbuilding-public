import { charCount, ruleSentenceRatio, stripMarkdown } from './text.ts';
import type { WriterOutput } from './writer-output.ts';

export const LIMITS = {
  maxChars: 2500,
  maxNewProperNouns: 3,
  maxRegistered: 6,
  maxWithoutExtends: 3,
  maxRuleRatio: 0.15,
};

export interface GateCheck {
  name: string;
  ok: boolean;
  detail: string;
}

export interface GateResult {
  pass: boolean;
  checks: GateCheck[];
}

export function mechanicalGate(out: WriterOutput, opts: { baseline: boolean }): GateResult {
  const checks: GateCheck[] = [];
  const add = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
  };
  const chars = charCount(out.submission);
  add('length', chars <= LIMITS.maxChars, `${chars} / ${LIMITS.maxChars} 字`);
  add('new_proper_nouns', out.delta.newProperNouns.length <= LIMITS.maxNewProperNouns, `${out.delta.newProperNouns.length} 个：${out.delta.newProperNouns.join('、') || '无'}`);
  const facts = out.delta.claims.filter((c) => c.kind === 'author_fact');
  const registered = facts.filter((c) => c.register);
  add('registered_facts', registered.length <= LIMITS.maxRegistered, `${registered.length} 条登记`);
  const plain = stripMarkdown(out.submission);
  const badQuotes = out.delta.claims.filter((c) => !(out.submission.includes(c.sourceQuote) || plain.includes(c.sourceQuote)) || c.sourceQuote.trim() === '');
  add('source_quotes', badQuotes.length === 0, badQuotes.length === 0 ? '全部逐字出自正文' : `未在正文找到：${badQuotes.map((c) => c.id).join('、')}`);
  const noExtends = facts.filter((c) => c.extends.trim() === '');
  add('facts_without_extends', noExtends.length <= LIMITS.maxWithoutExtends, `${noExtends.length} 条无延伸依据`);
  const ratio = ruleSentenceRatio(out.submission);
  add('rule_sentences', ratio <= LIMITS.maxRuleRatio, `规则句占比 ${(ratio * 100).toFixed(1)}%`);
  const ifaceOk = out.iface.shots.length === 3 && out.iface.object !== null && out.iface.hook !== null;
  add('interface', ifaceOk, `${out.iface.shots.length} 个镜头，物件${out.iface.object === null ? '缺' : '有'}，钩子${out.iface.hook === null ? '缺' : '有'}`);
  if (opts.baseline) add('baseline_no_new_facts', facts.length === 0 && out.delta.newProperNouns.length === 0, `${facts.length} 条作者事实`);
  return { pass: checks.every((c) => c.ok), checks };
}
