"""Deterministic concept allocation drawings. Not an engineering/certification model."""
import json, math, html
from pathlib import Path
P = Path(__file__).parent
rooms=[]
def room(id, name, deck, box, kind, **extra):
    r=dict(id=id,name=name,deck=deck,box=box,kind=kind,**extra); rooms.append(r); return r
for deck in [0,1]:
    for side,x in [('W',0),('E',54)]:
        room(f'{side}{deck}',f'{side}端交通核',deck,[x,0,6,20],'core')
room('street','公共街廊',0,[6,8,48,4],'public')
for id,name,x,w in [('M','餐厅 · 24席',6,16),('K','备餐',22,6),('D','洗消/回收',28,4),('S','储备',32,6),('L','洗衣',38,6),('C','照护 / 公共卫浴',44,10)]:
    room(id,name,0,[x,2,w,6],'public' if id=='M' else 'service',door=[x+w/2,8])
for id,name,x,w in [('A','共享厅 · 可加24席',6,12),('G','培养舱',18,20),('V','更衣/洗手',38,4),('T','封闭物料交接',42,6),('R','日常修补',48,6)]:
    room(id,name,0,[x,12,w,6],'grow' if id=='G' else 'public',door=None if id=='G' else [x+w/2,12])
for side,y in [('N',0),('S',18)]:
    room(f'service-{side}','后场服务带',0,[6,y,48,2],'service')
    room(f'gallery-{side}','可关闭的安静廊',1,[6,6 if side=='N' else 12,48,2],'quiet')
    x=6
    for i,(typ,w,n) in enumerate([('single',3,1)]*4+[('twin',4,2)]*6+[('family',6,4)]*2,1):
        cy=0 if side=='N' else 14
        r=room(f'{side}{i:02}',f'{n}人舱',1,[x,cy,w,6],'cabin',residents=n,room_type=typ,door=[x+w/2,6 if side=='N' else 14])
        # Each mark is a dedicated bed allocation, not a furnishing clearance proof.
        r['beds']=[[round(x+0.35+j*((w-1.25)/(n-1) if n>1 else 0),3),cy+(2.6 if side=='N' else 1.4),.9,2] for j in range(n)]
        r['wet_cell']=[x+.2,cy+(.2 if side=='N' else 3.8),1.6,2]
        r['storage']=[x+w-.8,cy+(.2 if side=='N' else 4),.6,1.5]
        x+=w
room('void','通高空带 · 不计楼面',1,[6,8,48,4],'void')
layout=dict(version='N48-01',status='concept allocation; local unrolled study, not final clear dimensions',
    envelope_m=[60,20],decks=[{'id':0,'floor_z':0},{'id':1,'floor_z':3.6}],deck_pitch_m=3.6,
    residents=48,local_coordinates={'u':'longitudinal concept axis; not mapped to hull Y','v':'habitat transverse unrolled direction; curvature unresolved','z':'toward rotation axis; local down is -z'},
    rooms=rooms,
    doors=[{'id':'V-public','xy':[40,12],'width_m':1.2,'height_m':2.2,'connects':['street','V']},{'id':'V-grow','xy':[38,15],'width_m':1.2,'height_m':2.2,'connects':['V','G']}],
    pass_hatches=[{'id':'harvest','xy':[34,18],'connects':['G','service-S'],'human_passage':False},{'id':'grow-waste','xy':[22,18],'connects':['G','service-S'],'human_passage':False}],
    core_program={'each_core_m':[6,20],'stairs_reserved_m':[3,6],'lift_shaft_reserved_m':[3,4],'note':'reserve positions, no stair-run/lift-cabin clearance proof; doors at both ends remain within same rotating segment'},
    capacities={'permanent_dining_seats':24,'shared_hall_event_seats':24,'beds':48},
    exclusions=['rotation radius and curvature','fixed/rotating pressure interface','egress certification','medical isolation','food yield and ecological closure','final furniture/door-swing clearances'])
# All horizontal connections used below have an actual opening in the shared boundary.
for r in rooms:
    if r.get('door') and r['id']!='V':
        dest='gallery-'+r['id'][0] if r['kind']=='cabin' else 'street'
        layout['doors'].append(dict(id=r['id']+'-front',deck=r['deck'],xy=r['door'],width_m=1.0,height_m=2.2,connects=[r['id'],dest]))
for d in layout['doors']: d.setdefault('deck',0)
for side,x in [('W',6),('E',54)]:
    for deck,links in [(0,[('street',10),('service-N',1),('service-S',19)]),(1,[('gallery-N',7),('gallery-S',13)])]:
        for dest,y in links:
            layout['doors'].append(dict(id=f'{side}{deck}-{dest}',deck=deck,xy=[x,y],width_m=1.6,height_m=2.2,connects=[side+str(deck),dest]))
for id in ['K','D','S','L','C','A','T','R']:
    r=next(r for r in rooms if r['id']==id);x,y,w,h=r['box'];back=2 if y==2 else 18
    layout['doors'].append(dict(id=id+'-service',deck=0,xy=[x+w/2,back],width_m=1.2,height_m=2.2,connects=[id,'service-N' if back==2 else 'service-S']))
layout['vertical_links']=[dict(id=e+'-vertical',connects=[e+'0',e+'1'],mode='stairs and lift reserves, not verified cabin clearance') for e in ['W','E']]
layout['material_routes']=[dict(id='harvest',nodes=['G','service-S','T','street','K'],note='sealed harvest hatch, rear transfer room, sealed cart to kitchen; scheduled common transport'),dict(id='grow-waste',nodes=['G','service-S','W0'],note='separate sealed waste hatch and timed collection; rear belt shared with harvest'),dict(id='dishes',nodes=['M','street','D','service-N','W0'],note='dedicated return recess; closed refuse container after washing; dirty/clean transports separated by schedule')]
(P/'layout.json').write_text(json.dumps(layout,ensure_ascii=False,indent=2)+'\n')

# Check the actual generated spatial allocations, including interiors of all room boxes.
errors=[]
for r in rooms:
    x,y,w,h=r['box']
    if min(x,y)<0 or x+w>60 or y+h>20 or min(w,h)<=0: errors.append('out-of-envelope '+r['id'])
    if r.get('door'):
        a,b=r['door']; boundary=((a==x or a==x+w) and y<=b<=y+h) or ((b==y or b==y+h) and x<=a<=x+w)
        if not boundary: errors.append('door off boundary '+r['id'])
    if r['kind']=='cabin':
        for e in r['beds']+[r['wet_cell'],r['storage']]:
            a,b,c,d=e
            if a<x or b<y or a+c>x+w or b+d>y+h: errors.append('fixture outside '+r['id'])
for i,r in enumerate(rooms):
    x,y,w,h=r['box']
    for q in rooms[i+1:]:
        a,b,c,d=q['box']
        if r['deck']==q['deck'] and min(x+w,a+c)>max(x,a)+1e-8 and min(y+h,b+d)>max(y,b)+1e-8: errors.append('overlap '+r['id']+' '+q['id'])
areas={d:sum(r['box'][2]*r['box'][3] for r in rooms if r['deck']==d and r['kind']!='void') for d in [0,1]}
beds=sum(len(r.get('beds',[])) for r in rooms)
assert beds==48 and areas=={0:1200,1:1008} and not errors,(beds,areas,errors)
# Check door anchors lie on BOTH room boundaries, then derive graph from these same openings.
graph={r['id']:set() for r in rooms}
def edge(a,b): graph[a].add(b);graph[b].add(a)
byid={r['id']:r for r in rooms}
for door in layout['doors']:
    a,b=door['xy']
    for rid in door['connects']:
        r=byid[rid];x,y,w,h=r['box']
        assert r['deck']==door['deck']
        assert ((a==x or a==x+w) and y<=b<=y+h) or ((b==y or b==y+h) and x<=a<=x+w),(door['id'],rid)
    edge(*door['connects'])
for link in layout['vertical_links']:edge(*link['connects'])
def reachable(start,end,blocked=set()):
    seen=set(blocked);pending=[start]
    while pending:
        n=pending.pop()
        if n in seen:continue
        if n==end:return True
        seen.add(n);pending.extend(graph[n]-seen)
    return False
for r in rooms:
    if r['kind']=='cabin':
        for blocked in [set(),{'W0','W1'},{'E0','E1'}]:
            assert reachable(r['id'],'C',blocked),r['id']
assert reachable('T','service-S') and reachable('service-N','W0') and reachable('service-S','E0')
assert not reachable('street','G',{'V'}),'public access must pass V'
report=dict(status='PASS',scope='allocation boxes, door anchors on both room boundaries, declared vertical reserves and counted fixture marks',rooms=len(rooms),door_anchors_checked=len(layout['doors']),residents=48,cabins=24,bed_marks=beds,allocated_floor_area_m2=areas,void_excluded_m2=192,bedroom_allocation_m2=576,graph_paths_to_care=72,notes=['Door anchors and graph connectivity do not validate door swings, lift capacity or evacuation time.','Furniture marks reserve area; no independent plumbing/clearance validation.'])
(P/'layout-check.json').write_text(json.dumps(report,ensure_ascii=False,indent=2)+'\n')

COLORS={'core':'#d9e0e5','public':'#eee3cf','service':'#e0e4e2','grow':'#dbe6d1','quiet':'#d7e4e8','cabin':'#f4eee2','void':'#fbfaf6'}
def text(x,y,t,size=13,color='#273c49',anchor='start'):
    return f'<text x="{x}" y="{y}" font-size="{size}" fill="{color}" text-anchor="{anchor}">{html.escape(str(t))}</text>'
def rect(x,y,w,h,fill,stroke='#647783',sw=1):
    return f'<rect x="{x}" y="{y}" width="{w}" height="{h}" fill="{fill}" stroke="{stroke}" stroke-width="{sw}"/>'
def line(x,y,x2,y2,col='#6c7f88',sw=1,dash=''):
    return f'<line x1="{x}" y1="{y}" x2="{x2}" y2="{y2}" stroke="{col}" stroke-width="{sw}" stroke-dasharray="{dash}"/>'
def doc(w,h,items):return f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {w} {h}" role="img"><style>text{{font-family:system-ui,-apple-system,"PingFang SC",sans-serif}}</style><rect width="100%" height="100%" fill="#fbfaf6"/>'+''.join(items)+'</svg>'
S=16;ox=70; rows=[145,615];items=[]
items += [text(60,48,'归航号 / N48 邻里单元',28),text(60,78,'48人 · 24住舱 · 局部展开尺度候选 N48-01',16),text(60,104,'同一数据源绘制：尺寸为分配包络，未扣隔墙与门框；非三维精确投影或规范认证。',13)]
for d,oy in enumerate(rows):
    items.append(text(60,oy-18,'D0 公共生活层 / 地坪 0.0m' if d==0 else 'D1 安静居住层 / 地坪 +3.6m',19))
    for r in rooms:
        if r['deck']!=d:continue
        x,y,w,h=r['box'];xx=ox+x*S;yy=oy+y*S
        items.append(rect(xx,yy,w*S,h*S,COLORS[r['kind']]))
        if r['kind']=='cabin':
            for a,b,c,e in r['beds']: items.append(rect(ox+a*S,oy+b*S,c*S,e*S,'#9aaeb9',sw=.6))
            for fld,fill in [('wet_cell','#b8d3d9'),('storage','#cabb9e')]:
                a,b,c,e=r[fld];items.append(rect(ox+a*S,oy+b*S,c*S,e*S,fill,sw=.5))
            items.append(text(xx+w*S/2,yy+(5.7 if y==0 else 3.3)*S,r['id']+' / '+str(r['residents']),10,anchor='middle'))
        elif r['kind']=='core':
            items+= [text(xx+w*S/2,yy+145,r['id'],16,anchor='middle'),text(xx+w*S/2,yy+166,'楼梯+升降',11,anchor='middle')]
            items.append(rect(xx+20,yy+20,3*S,6*S,'#c2cdd3'))
            for a in range(12):items.append(line(xx+20,yy+20+a*8,xx+68,yy+20+a*8,'#869aa5'))
            items.append(rect(xx+20,yy+230,3*S,4*S,'#c2cdd3'))
        else:
            label=r['name'] if w>=10 or h<=2 else r['id']
            items.append(text(xx+w*S/2,yy+h*S/2+4,label,12 if w>=10 else 11,anchor='middle'))
        if r.get('door'):
            a,b=r['door'];items.append(line(ox+(a-.45)*S,oy+b*S,ox+(a+.45)*S,oy+b*S,'#fbfaf6',4))
    if d==0:
        # Cultivation enclosure: glazing and L-shaped access have consistent coordinates.
        items.append(line(ox+18*S,oy+12*S,ox+38*S,oy+12*S,'#4c8299',5))
        for door in layout['doors'][:2]:
            a,b=door['xy'];vert=door['id']=='V-grow';dx=0 if vert else .6;dy=.6 if vert else 0
            items.append(line(ox+(a-dx)*S,oy+(b-dy)*S,ox+(a+dx)*S,oy+(b+dy)*S,'#fbfaf6',5))
        items.append(f'<path d="M {ox+40*S} {oy+10*S} V {oy+15*S} H {ox+36*S}" fill="none" stroke="#a6513e" stroke-width="3"/>')
        for h in layout['pass_hatches']:
            a,b=h['xy'];items.append(rect(ox+(a-.4)*S,oy+b*S-4,.8*S,8,'#cf9c52'))
        # Six four-seat table allocations, kept within the mess block.
        for tx in [8,12,16]:
            for ty in [3.5,6]:
                items.append(rect(ox+tx*S,oy+ty*S,1.5*S,.7*S,'#c6ad8f',sw=.6))
                for dx in [.25,1.0]:
                    for dy in [-.5,.9]:items.append(rect(ox+(tx+dx)*S,oy+(ty+dy)*S,.4*S,.4*S,'#6e828d',sw=.5))
        # A-A crosses grow/public/gallery/private banks; section shares v coordinates.
        items.append(line(ox+24*S,oy-8,ox+24*S,oy+20*S+8,'#a6513e',1.5,'6 5'))
        items.append(text(ox+24*S+6,oy-1,'A',13,'#a6513e'))
    else:
        for v in [8,12]:items.append(line(ox+6*S,oy+v*S,ox+54*S,oy+v*S,'#3d7f93',3))
    for door in layout['doors']:
        if door['deck']!=d:continue
        a,b=door['xy'];r=byid[door['connects'][0]];x,y,w,h=r['box'];vert=a==x or a==x+w
        half=door['width_m']/2;dx=0 if vert else half;dy=half if vert else 0
        items.append(line(ox+(a-dx)*S,oy+(b-dy)*S,ox+(a+dx)*S,oy+(b+dy)*S,'#fbfaf6',5))
        items.append(line(ox+(a-dx)*S,oy+(b-dy)*S,ox+(a+dx)*S,oy+(b+dy)*S,'#53748a',1,'2 2'))
    items += [line(ox,oy+338,ox+60*S,oy+338),text(ox+30*S,oy+358,'60m（6 + 48 + 6）',13,anchor='middle'),text(ox+60*S+12,oy+10*S,'20m',13)]
    items.append(text(60,oy+391,'D0：1,200m² 分配楼面；培养120m²仅为邻里补充，不证明粮食自给。' if d==0 else 'D1：1,008m² 分配楼面 + 192m²通高空带；住舱576m²，侧廊192m²，端核240m²。',13))
items += [text(60,1054,'读图',18),text(60,1081,'K备餐  D洗消  S储备  L洗衣  C照护  V更衣洗手  T物料交接  R修补',13),text(60,1107,'浅蓝住舱小格＝卫浴预留；棕色＝储物；蓝灰长格＝固定床位（共48）。床门家具净空仍待深化。',13),text(60,1133,'D1通高侧为完整隔声界面，端核设置可关闭入口。端核连接同一旋转段；不能直接接固定轴心。',13),text(60,1159,'后场带运输使用封闭容器与错时制度；本图尚未证明全程清污物理分流。',13),text(60,1185,'0',12),line(80,1180,240,1180,'#273c49',4),text(245,1185,'10m',12),text(1060,1185,'2026.09 / CONCEPT',12,anchor='end')]
(P/'01-neighborhood-plan.svg').write_text(doc(1120,1220,items))

# A-A unfolded cross section at u=24, from the same row bounds and deck levels.
items=[text(60,48,'归航号 / A—A 局部展开剖面',28),text(60,78,'剖切位置见平面 u=24m；向纵向看。上下层按同一 v 坐标对齐。',15)]
sx=90;sc=42;base=480
def rz(z):return base-z*sc
for z in [0,3.6,7.2]:
    if z==3.6:
        for a,b in [(0,8),(12,20)]:items.append(rect(sx+a*sc,rz(z), (b-a)*sc,.4*sc,'#617887'))
    else:items.append(rect(sx,rz(z),20*sc,.4*sc,'#617887'))
for a,b,name,fill in [(0,6,'住舱 / N06','#f4eee2'),(6,8,'安静廊','#d7e4e8'),(12,14,'安静廊','#d7e4e8'),(14,20,'住舱 / S06','#f4eee2')]:
    items.append(rect(sx+a*sc,rz(6.8),(b-a)*sc,3.2*sc,fill));items.append(text(sx+(a+b)/2*sc,rz(5.1),name,13,anchor='middle'))
for a,b,name,fill in [(0,2,'后场','#e0e4e2'),(2,8,'备餐 K','#eee3cf'),(8,12,'公共街廊','#eee3cf'),(12,18,'培养 G','#dbe6d1'),(18,20,'后场','#e0e4e2')]:
    items.append(rect(sx+a*sc,rz(3.2),(b-a)*sc,3.2*sc,fill));items.append(text(sx+(a+b)/2*sc,rz(1.4),name,13,anchor='middle'))
items.append(text(sx+10*sc,rz(5.1),'通高',15,anchor='middle'))
for v in [8,12]:items.append(line(sx+v*sc,rz(3.6),sx+v*sc,rz(6.8),'#3d7f93',4))
for v in [6,14]:
    items.append(line(sx+v*sc,rz(3.6),sx+v*sc,rz(5.8),'#fbfaf6',7))
    items.append(line(sx+v*sc,rz(3.6),sx+v*sc,rz(5.8),'#a6513e',2,'4 3'))
    items.append(text(sx+v*sc,rz(6.1),'门高2.2',10,anchor='middle'))
items.append(line(sx+12*sc,rz(0),sx+12*sc,rz(3.2),'#3d7f93',4))
# Person shown on local street floor; no exterior gravity claim.
px=sx+10*sc;py=rz(1.55)
items.append(f'<circle cx="{px}" cy="{py}" r="5" fill="#354e5f"/>')
items += [line(px,py+6,px,rz(.6),'#354e5f',4),line(px,rz(.6),px-10,rz(0),'#354e5f',3),line(px,rz(.6),px+10,rz(0),'#354e5f',3)]
items += [text(960,rz(7.2),'7.2m',14),text(960,rz(3.6),'+3.6m',14),text(960,rz(0),'0.0m',14),text(60,541,'两层地坪间距 3.6m；每层0.4m作为楼板/设备厚度候选，3.2m为装修前高度预算。',14),text(60,569,'本剖面横跨20m展开带；曲率、半径与重力梯度尚未确定，不能直接据此制造平直旋转舱。',14),text(60,597,'蓝色界面：楼上隔声廊墙 / 楼下培养观察隔断。公共活动声的控制仍需门、风管和结构设计。',14),text(60,640,'培养入口 V / 4×6m 局部平面（与总图同向）',19)]
bx=150;by=680;bs=46
items.append(rect(bx,by,4*bs,6*bs,'#e5e7e1'))
items.append(text(bx+2*bs,by-12,'公共街廊 / v=12',13,anchor='middle'))
items.append(text(bx-15,by+3*bs,'培养',13,anchor='end'))
items.append(line(bx+1.4*bs,by,bx+2.6*bs,by,'#fbfaf6',6))
items.append(line(bx,by+2.4*bs,bx,by+3.6*bs,'#fbfaf6',6))
items.append(rect(bx+1*bs,by+5.2*bs,1.3*bs,.6*bs,'#bad2d8'))
items.append(rect(bx+3.1*bs,by+1.5*bs,.6*bs,2.5*bs,'#cbbda5'))
items.append(f'<path d="M {bx+2*bs} {by-14} V {by+3*bs} H {bx-20}" fill="none" stroke="#a6513e" stroke-width="3"/>')
items += [text(390,714,'V-public：公共侧完整门',16),text(390,743,'V-grow：左侧培养完整门',16),text(390,772,'两门工作尺寸：宽1.2m × 高2.2m',14),text(390,801,'前门 → 转身 → 左门；后墙洗手，右墙更衣。',14),text(390,830,'剖去顶盖与右前墙时，仍保留完整门框和门高参照。',14),text(390,859,'图示人员通道；收获/废物经背面的封闭物料窗。',14),text(390,888,'此处是卫生缓冲，不是太空气闸、压力转换或隔离病房。',14),text(60,997,'当地“下方”指向外缘；左/右是展开关系，不代表船体全局上下。半径、固定轴接口和压力分区留待总体研究。',13)]
(P/'02-neighborhood-section.svg').write_text(doc(1120,1030,items))
print(json.dumps(report,ensure_ascii=False))
