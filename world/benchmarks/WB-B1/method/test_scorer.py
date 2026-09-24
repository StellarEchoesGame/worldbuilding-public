"""Small synthetic checks of arithmetic and failure preservation; no world quality scoring."""
from pathlib import Path
import tempfile,hashlib,json,importlib.util,contextlib,io
base=Path(__file__).resolve().parents[1]
spec=importlib.util.spec_from_file_location('scorer',base/'score.py'); mod=importlib.util.module_from_spec(spec);spec.loader.exec_module(mod)
def dump(p,obj):p.parent.mkdir(parents=True,exist_ok=True);p.write_text(json.dumps(obj,ensure_ascii=False)+'\n')
def sha(p):return hashlib.sha256(p.read_bytes()).hexdigest()
checks=[]
with tempfile.TemporaryDirectory(prefix='wb-b1-scorer-') as temp:
    t=Path(temp);mod.B=t
    public=json.loads((base/'questions/public.json').read_text())
    fresh=[dict(id=f'N{i:02}',dimension=f'D{i}',prompt='synthetic fixture') for i in range(1,9)]
    cfg=json.loads((base/'config.json').read_text());key=json.loads((base/'method/control-key.json').read_text())
    dump(t/'questions/public.json',public);dump(t/'questions/fresh.json',fresh);dump(t/'config.json',cfg);dump(t/'method/control-key.json',key)
    (t/'input').mkdir();(t/'input/test.md').write_text('Known synthetic statement.');(t/'PROTOCOL.md').write_text('Synthetic protocol.')
    dump(t/'input-manifest.json',{'files':{'input/test.md':sha(t/'input/test.md')}})
    names=['questions/public.json','questions/fresh.json','config.json','method/control-key.json','input-manifest.json','PROTOCOL.md'];dump(t/'freeze.json',{'files':{n:sha(t/n) for n in names}})
    ev=[{'source':'input/test.md','section':'test','quote':'Known synthetic statement.'}]
    def report(name,score):return {'judge_id':name,'input_manifest_sha256':sha(t/'input-manifest.json'),'protocol_sha256':sha(t/'PROTOCOL.md'),'cases':[{'id':c['id'],'dimension':c['dimension'],'score':score,'answer':'test','counterevidence':'test','inference_boundary':'test','evidence':ev} for c in public+fresh],'controls':[{'id':c,'score':k.get('min_score',0),'answer':'test'} for c,k in key.items()],'gates':{h:{'status':'pass','reason':'test','evidence':ev} for h in ['H1','H2','H3','H4']}}
    def run():
        with contextlib.redirect_stdout(io.StringIO()):mod.main()
        return json.loads((t/'runs/initial/calculation.json').read_text())
    for n in ['judge-a','judge-b']:dump(t/f'runs/initial/{n}.json',report(n,4))
    r=run();assert all(j['total']==100 and j['numeric_candidate_pass'] for j in r['judges']);checks.append('all 4 scores = 100')
    dump(t/'runs/initial/judge-b.json',report('judge-b',3));r=run();assert r['judges'][1]['total']==75 and not r['judges'][1]['numeric_candidate_pass'];checks.append('one 75-point judge cannot be averaged into a pass')
    a=report('judge-a',4);a['cases'][0]['score']=0;dump(t/'runs/initial/judge-a.json',a);r=run();assert r['judges'][0]['total']==95 and not r['judges'][0]['numeric_candidate_pass'];checks.append('a 0-score case blocks a 95-point result')
    a=report('judge-a',4);a['cases'][0]['evidence']=[{'source':'input/test.md','section':'test','quote':'invented'}];dump(t/'runs/initial/judge-a.json',a)
    try:run();raise AssertionError('invented quote accepted')
    except ValueError as e:assert 'quote not found' in str(e)
    checks.append('invented quotation rejected')
    (t/'input/test.md').write_text('Modified after freeze.')
    try:run();raise AssertionError('changed input accepted')
    except ValueError as e:assert 'input changed' in str(e)
    checks.append('input mutation rejected')
dump(base/'method/scorer-checks.json',{'synthetic_checks':checks,'passed':True,'scope':'arithmetic and integrity only'})
print(json.dumps(checks,ensure_ascii=False,indent=2))
