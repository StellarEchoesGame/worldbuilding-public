#!/usr/bin/env python3
"""Verify frozen artifacts, score arithmetic and evidence substrings, not literary quality."""
from pathlib import Path
from fractions import Fraction
import hashlib,json,sys
B=Path(__file__).resolve().parent
def read(p):return json.loads((B/p).read_text())
def sha(p):return hashlib.sha256((B/p).read_bytes()).hexdigest()
def need(condition,message):
    if not condition:raise ValueError(message)
def evidence(items,where,manifest):
    need(bool(items),f'{where}: evidence missing')
    for e in items:
        need(e['source'] in manifest['files'],f'{where}: unknown source')
        need(e['quote'] and e['quote'] in (B/e['source']).read_text(),f'{where}: quote not found in {e["source"]}')
        need(bool(e.get('section')),f'{where}: section missing')
def main():
    lock=read('freeze.json')
    for p,h in lock['files'].items():need(sha(p)==h,f'frozen file changed: {p}')
    m=read('input-manifest.json')
    for p,h in m['files'].items():need(sha(p)==h,f'input changed: {p}')
    cfg=read('config.json'); cases=read('questions/public.json')+read('questions/fresh.json')
    ids={c['id']:c for c in cases};dims={d['id']:d for d in cfg['dimensions']}
    need(len(ids)==24 and len(cases)==24,'24 unique cases required')
    need(sum(d['weight'] for d in dims.values())==100,'weights must sum to 100')
    for d in dims:need(sum(c['dimension']==d for c in cases)==3,f'{d} requires three cases')
    keys=read('method/control-key.json'); summaries=[];raw=[]
    for name in ['judge-a','judge-b']:
        r=read(f'runs/initial/{name}.json');raw.append(r)
        need(r['judge_id']==name,'judge identity mismatch')
        need(r['input_manifest_sha256']==sha('input-manifest.json'),'wrong input manifest')
        need(r['protocol_sha256']==sha('PROTOCOL.md'),'wrong protocol')
        rows={c['id']:c for c in r['cases']}
        need(len(r['cases'])==24 and set(rows)==set(ids),f'{name}: coverage error')
        for cid,c in rows.items():
            need(c['dimension']==ids[cid]['dimension'],f'{cid}: dimension mismatch')
            need(type(c['score']) is int and 0<=c['score']<=4,f'{cid}: invalid score')
            for field in ['answer','counterevidence','inference_boundary']:need(bool(c.get(field)),f'{cid}: missing {field}')
            evidence(c['evidence'],f'{name}/{cid}',m)
        by={d:Fraction(sum(c['score'] for c in rows.values() if c['dimension']==d),3) for d in dims}
        total=sum(by[d]*dims[d]['weight']/4 for d in dims)
        controls={c['id']:c for c in r['controls']}
        need(len(r['controls'])==4 and set(controls)==set(keys),'control coverage mismatch')
        control_pass={}
        for cid,k in keys.items():
            c=controls[cid];need(type(c['score']) is int and 0<=c['score']<=4 and c.get('answer'),'invalid control')
            control_pass[cid]=c['score']<=k.get('max_score',4) and c['score']>=k.get('min_score',0)
        need(set(r['gates'])=={'H1','H2','H3','H4'},'gate coverage error')
        for gid,g in r['gates'].items():
            need(g['status'] in ['pass','fail','unresolved'] and g.get('reason'),'gate status error')
            evidence(g['evidence'],f'{name}/{gid}',m)
        zero=[c['id'] for c in rows.values() if c['score']==0]
        weak=[d for d,v in by.items() if v<Fraction(str(cfg['minimum_dimension_per_judge']))]
        preliminary=(total>=cfg['minimum_total_per_judge'] and not weak and not zero and all(control_pass.values()) and all(g['status']=='pass' for g in r['gates'].values()))
        summaries.append({'judge':name,'raw_sha256':sha(f'runs/initial/{name}.json'),'total_exact':str(total),'total':round(float(total),2),'dimensions':{d:round(float(v),4) for d,v in by.items()},'zero_cases':zero,'below_minimum_dimensions':weak,'control_numeric_checks':control_pass,'gates':{d:g['status'] for d,g in r['gates'].items()},'numeric_candidate_pass':preliminary})
    a={c['id']:c for c in raw[0]['cases']};bb={c['id']:c for c in raw[1]['cases']}
    disputes={'cases':[i for i in ids if abs(a[i]['score']-bb[i]['score'])>=cfg['disagreement_case_delta']],
      'dimensions':[d for d in dims if abs(Fraction(sum(c['score'] for c in a.values() if c['dimension']==d),3)-Fraction(sum(c['score'] for c in bb.values() if c['dimension']==d),3))>=cfg['disagreement_dimension_delta']],
      'total':abs(Fraction(summaries[0]['total_exact'])-Fraction(summaries[1]['total_exact']))>cfg['disagreement_total_delta'],
      'gates':[g for g in raw[0]['gates'] if raw[0]['gates'][g]['status']!=raw[1]['gates'][g]['status']]}
    out={'benchmark':'WB-B1','input_manifest_sha256':sha('input-manifest.json'),'frozen_hashes_match':True,'case_coverage':24,'control_coverage':4,'evidence_quotes_match':True,'judges':summaries,'required_adjudication':disputes,'limits':'Arithmetic and quotation checks only. Gate reasoning, controls and subjective quality require independent content review. No automatic acceptance.'}
    (B/'runs/initial/calculation.json').write_text(json.dumps(out,ensure_ascii=False,indent=2)+'\n')
    print(json.dumps(out,ensure_ascii=False,indent=2))
if __name__=='__main__':
    try:main()
    except (ValueError,KeyError,FileNotFoundError,json.JSONDecodeError) as e:print(f'VALIDATION ERROR: {e}',file=sys.stderr);sys.exit(1)
