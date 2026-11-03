"""Validate the single task register and rebuild offline progress documents/images.

No network calls, task execution, status promotion or user-source rewriting.
"""
from pathlib import Path
from collections import Counter
from html import escape
import argparse
import hashlib
import json
import textwrap
from PIL import Image, ImageDraw, ImageFont

ROOT = Path(__file__).resolve().parents[1]
BASE = ROOT / 'docs' / '项目管理'
DATA = BASE / '项目任务台账.json'
STAGES = ['scope','contract','implementation','module','integration','acceptance']
COLORS = {'bg':'#F6F8F7','ink':'#183C35','muted':'#60756F','line':'#DCE5E0',
          'green':'#17674D','green_light':'#DFF1E8','blue':'#245D85','blue_light':'#E7EFF7',
          'amber':'#946215','amber_light':'#FFF0CD','gray':'#E7ECE9','white':'#FFFFFF',
          'red':'#A43838','red_light':'#FBE6E6'}
FONT = Path(r'C:\Windows\Fonts\msyh.ttc')

def validate(data):
    tasks=data['tasks']; owners={o['id'] for o in data['owners']}; by={t['id']:t for t in tasks}
    assert len(by)==len(tasks),'duplicate task IDs'
    assert data['capacity']['max_active_total']==4
    assert data['capacity']['max_parallel_subagents']==3
    allowed=set(data['stage_states'])
    for t in tasks:
        assert t['owner'] in owners,t['id']
        assert t['phase'] in ['first','management','future']
        assert set(t['stages'])==set(STAGES)
        assert t['acceptance_criteria'] and t['next_action']
        for dep in t['dependencies']:
            assert dep in by and dep!=t['id'],(t['id'],dep)
        for stage,state in t['stages'].items():
            assert state in allowed,(t['id'],stage,state)
            if state in ['passed','ready_for_review']:
                evidence=t['evidence'].get(stage,[])
                assert evidence,(t['id'],stage,'evidence missing')
                for item in evidence:
                    target=(ROOT/item.split('#')[0]).resolve()
                    assert target.is_file(),str(target)
            if state=='passed' and stage!='scope' and t['phase']!='management':
                if stage in ['implementation','module','integration','acceptance']:
                    assert t['source_version'],(t['id'],stage,'source version required')
                index=STAGES.index(stage)
                assert all(t['stages'][s] in ['passed','not_applicable'] for s in STAGES[:index]),(t['id'],stage,'prior gate missing')
        if t['phase']!='management' and t['stages']['acceptance']=='passed':
            assert t['actual_acceptance'],(t['id'],'actual acceptance date required')
            assert all(by[dep]['stages']['acceptance']=='passed' for dep in t['dependencies']),(t['id'],'dependency not accepted')
    visiting=set(); done=set()
    def walk(id):
        if id in visiting: raise ValueError('dependency cycle '+id)
        if id in done:return
        visiting.add(id)
        for dep in by[id]['dependencies']:walk(dep)
        visiting.remove(id);done.add(id)
    for id in by:walk(id)
    confirmation=data['confirmed_source']
    user=ROOT/confirmation['path']
    assert hashlib.sha256(user.read_bytes()).hexdigest().upper()==confirmation['sha256'].upper(),'user-confirmed source changed: reread and preserve snapshot before updating its registered hash'

class Canvas:
    def __init__(self,w,h):
        self.w=w;self.h=h
        self.image=Image.new('RGB',(w,h),COLORS['bg']);self.draw=ImageDraw.Draw(self.image)
        self.svg=[f'<svg xmlns="http://www.w3.org/2000/svg" width="{w}" height="{h}" viewBox="0 0 {w} {h}">',f'<rect width="{w}" height="{h}" fill="{COLORS["bg"]}"/>']
    def rect(self,x,y,w,h,fill,rx=0):
        color=COLORS.get(fill,fill)
        if rx:self.draw.rounded_rectangle((x,y,x+w,y+h),radius=rx,fill=color)
        else:self.draw.rectangle((x,y,x+w,y+h),fill=color)
        self.svg.append(f'<rect x="{x}" y="{y}" width="{w}" height="{h}" rx="{rx}" fill="{color}"/>')
    def text(self,x,y,text,size=18,color='ink',center=False):
        font=ImageFont.truetype(str(FONT),size)
        if center:x-=self.draw.textlength(text,font=font)/2
        self.draw.text((x,y),text,font=font,fill=COLORS.get(color,color))
        self.svg.append(f'<text x="{x:.1f}" y="{y+size}" font-family="Microsoft YaHei, sans-serif" font-size="{size}" fill="{COLORS.get(color,color)}">{escape(text)}</text>')
    def save(self,stem):
        charts=BASE/'图表';charts.mkdir(parents=True,exist_ok=True)
        self.image.save(charts/(stem+'.png'))
        (charts/(stem+'.svg')).write_text('\n'.join(self.svg+['</svg>']),encoding='utf-8')

def short(text,limit=29):
    return text if len(text)<=limit else text[:limit-1]+'…'

def marker(c,x,y,state):
    style={
      'passed':('green_light','green','已通过'),
      'ready_for_review':('amber_light','amber','待审阅'),
      'in_progress':('blue_light','blue','进行中'),
      'not_started':('gray','muted','未进入'),
      'not_applicable':('bg','muted','不适用'),
      'blocked':('red_light','red','阻塞'),
    }[state]
    c.rect(x-35,y,70,28,style[0],5)
    c.text(x,y+4,style[2],14,style[1],center=True)

def detail(data,owner_ids,stem,title,future=False):
    owners={o['id']:o for o in data['owners']}
    rows=[]
    if future:
        rows=[('group','后续搭赠  暂不进入首期执行')]+[('task',t) for t in data['tasks'] if t['phase']=='future']
    else:
        for owner in owner_ids:
            ts=[t for t in data['tasks'] if t['owner']==owner and t['phase']!='future']
            rows.append(('group',owner+'  '+owners[owner]['name']))
            rows.extend(('task',t) for t in ts)
    height=190+sum(40 if k=='group' else 60 for k,_ in rows)+90
    c=Canvas(1400,height)
    c.text(30,25,title,30)
    c.text(30,70,'需求确认单列；其余阶段凭对应版本及证据推进。空灰格不代表已做。',17,'muted')
    c.text(30,109,'任务ID',16,'muted');c.text(220,109,'任务与当前状态',16,'muted')
    xs=[855,945,1035,1125,1215,1305]
    for x,stage in zip(xs,STAGES):c.text(x,109,data['stage_labels'][stage].replace('目标环境验收','验收'),16,'muted',center=True)
    y=148
    for kind,item in rows:
        if kind=='group':
            c.rect(24,y,1352,33,'green_light',4);c.text(36,y+4,item,19,'green');y+=40
        else:
            c.rect(24,y,1352,55,'white',4)
            c.text(36,y+7,item['id'],16)
            c.text(220,y+4,short(item['title']),19)
            c.text(220,y+31,item['status']+'  ·  '+('有待补细项/资料' if item['blockers'] else '下一步见任务明细'),13,'muted')
            for x,stage in zip(xs,STAGES):marker(c,x,y+13,item['stages'][stage])
            y+=60
    first=[t for t in data['tasks'] if t['phase']=='first']
    accepted=sum(t['stages']['acceptance']=='passed' for t in first)
    c.text(30,height-67,f'总控文档行验收指文档确认；首期执行目标环境验收 {accepted}/{len(first)} 项，文档及后续任务不计入。',15,'muted')
    c.text(30,height-39,f'数据日期 {data["updated_on"]}   台账摘要 {data["_hash"][:12]}   来源 项目任务台账.json',14,'muted')
    c.save(stem)

def overview(data):
    ts=data['tasks'];first=[t for t in ts if t['phase']=='first'];future=[t for t in ts if t['phase']=='future']
    accepted=sum(t['stages']['acceptance']=='passed' for t in first)
    c=Canvas(1400,1000)
    c.text(32,28,'店内打单项目进度',36)
    c.text(32,82,'产品规则   →   共享合同   →   实现和模块验证   →   联调   →   目标环境验收   →   用户版本确认',20,'muted')
    for x,value,label in [(32,str(len(first)),'首期执行任务'),(470,str(accepted),'目标环境验收通过'),(908,str(len(future)),'后续搭赠任务')]:
        c.rect(x,137,410,110,'white',8);c.text(x+20,149,value,36);c.text(x+20,205,label,18,'muted')
    c.text(32,278,'工作口及当前阶段',23)
    xs=[855,945,1035,1125,1215,1305]
    for x,stage in zip(xs,STAGES):c.text(x,319,data['stage_labels'][stage].replace('目标环境验收','验收'),16,'muted',center=True)
    y=350
    for owner in data['owners']:
        group=[t for t in ts if t['owner']==owner['id'] and t['phase']!='future']
        c.rect(24,y,1352,56,'white',4)
        c.text(36,y+5,owner['id'],18);c.text(117,y+5,owner['name'],20)
        status_counts=Counter(t['status'] for t in group)
        summary='；'.join(f'{status} {number}项' for status,number in status_counts.most_common(2))
        c.text(117,y+32,str(len(group))+'项 · '+summary,13,'muted')
        for x,stage in zip(xs,STAGES):
            applicable=[t for t in group if t['stages'][stage]!='not_applicable']
            passed=sum(t['stages'][stage]=='passed' for t in applicable)
            value=f'{passed}/{len(applicable)}' if applicable else '不适用'
            c.text(x,y+16,value,17,'green' if passed else 'muted',center=True)
        y+=62
    c.text(32,865,'并行上限  主代理1个 + 子代理最多3个；7个工作口按依赖轮换',19)
    c.text(32,905,'需求列的通过数不折算开发完成率。旧代码、历史测试和“已部署”声明不算新版本验收。',17,'muted')
    c.text(32,947,f'数据日期 {data["updated_on"]}   台账摘要 {data["_hash"][:12]}   无自动后台执行或状态推进',15,'muted')
    c.save('01_项目总览')

def write_docs(data):
    by={o['id']:o for o in data['owners']};first=[t for t in data['tasks'] if t['phase']=='first']
    accepted=sum(t['stages']['acceptance']=='passed' for t in first)
    counts=Counter(t['phase'] for t in data['tasks'])
    open_info=[(t['id'],b) for t in data['tasks'] if t['phase']!='future' for b in t['blockers']]
    open_info_text='\n'.join('- '+id+'：'+b for id,b in open_info) or '当前台账未登记外部资料阻碍，仍按合同、依赖和证据推进。'
    dashboard=f'''# 项目进度看板

更新日期：{data['updated_on']}；方案{data['plan_version']}；台账摘要`{data['_hash'][:12]}`。

当前：{data['plan_status']}。**首期执行验收通过 {accepted}/{len(first)}项**。需求确认不折算开发完成率，旧工程只作为参考，真实任务状态以下图及台账为准。

![项目总览](图表/01_项目总览.png)

## 常用入口

- [子代理分工和批次](01_子代理分工与任务交接.md)
- [项目边界](02_项目边界与执行规范.md)
- [完整任务明细](03_完整任务明细.md)
- [依赖关系图](05_任务依赖关系.md)
- [交接模板](04_任务交接模板.md)
- [唯一状态源 JSON](项目任务台账.json)

## 每项任务的阶段图

每行一个任务，列为需求、合同、实现、模块验证、联调、目标环境验收。灰色未进入，绿色有证据通过，黄色待审阅；不适用的阶段单独标明。文档类与后续任务不计入首期执行分母。

### 总控 云端及业务

![总控云端及业务任务](图表/02_总控云端与业务.png)

### 手机页面 原生及安全

![手机任务](图表/03_手机页面与原生.png)

### Jetson 单据打印及验收

![边缘打印验收任务](图表/04_边缘打印与验收.png)

### 后续搭赠

![后续费用任务](图表/05_后续搭赠.png)

## 当前待补信息

{open_info_text}

以上按台账登记，资料解决后由ROOT清除对应blockers并刷新；不要求重批整套页面。

## 谁来更新 怎么刷新

ROOT在子任务回交时读取证据，更新台账的status、各stage、evidence、source_version、日期和next_action，再运行项目工具`tools/render_project_progress.py`。它只校验台账和重建Markdown/SVG/PNG，不执行任务、不联网、不自动把状态变通过。用户可直接查看这个文件和图，无需启动服务器。

台账是单一来源，不直接编辑生成图片或另维护完成率。通过阶段要有实际证据；实现及之后阶段还须源码版本。状态改变或证据撤回后重新绘图即可。没有截止期不画虚构日期甘特图，也不创建定时自动运行。
'''
    (BASE/'00_项目进度看板.md').write_text(dashboard,encoding='utf-8')
    lines=['# 完整任务明细','',f'更新 {data["updated_on"]}；数据源摘要 `{data["_hash"][:12]}`。由台账生成，不直接编辑本文件改状态。','',
           f'共{len(data["tasks"])}项：首期执行{counts["first"]}、总控管理{counts["management"]}、后续{counts["future"]}。每项有唯一owner；实际执行代理按台账记录，未派发的不算开工。', '',
           '依赖是最终联调/验收前置；合同明确后可先做独立设计或脱敏模拟，但不能冒充真实联调。','']
    for phase,label in [('management','总控管理'),('first','首期执行'),('future','后续阶段')]:
        lines+=['## '+label,'']
        for t in [x for x in data['tasks'] if x['phase']==phase]:
            stage=' → '.join(data['stage_labels'][s]+data['stage_states'][t['stages'][s]] for s in STAGES)
            lines += ['### '+t['id']+' '+t['title'],'',
              f'- 责任：{t["owner"]} {by[t["owner"]]["name"]}；当前状态：{t["status"]}；实际代理：{t["assigned_agent"] or "未派发"}。',
              '- 阶段：'+stage,
              '- 依赖：'+('、'.join(t['dependencies']) or '无'),
              '- 对应页面：'+('、'.join(t['page_refs']) or '全局或验收'),
              '- 验收条件：'+t['acceptance_criteria'],
              '- 下一步：'+t['next_action'],
              '- 待补：'+('；'.join(t['blockers']) or '未登记外部资料阻碍；具体依赖见上'),
              '- 旧资产：'+(t['reuse_candidate'] or '不以旧记录代替新实现'),
              '- 已有证据：'+('；'.join(k+'：'+','.join(v) for k,v in t['evidence'].items()) or '无'),
              '- 源码版本：'+(t['source_version'] or '尚无新业务实现版本'), '']
    (BASE/'03_完整任务明细.md').write_text('\n'.join(lines),encoding='utf-8')

def main():
    parser=argparse.ArgumentParser();parser.add_argument('--validate-only',action='store_true');args=parser.parse_args()
    raw=DATA.read_bytes();data=json.loads(raw);validate(data)
    data['_hash']=hashlib.sha256(raw).hexdigest()
    if not args.validate_only:
        overview(data)
        detail(data,['ROOT','A01','A02'],'02_总控云端与业务','总控 云端及业务任务阶段')
        detail(data,['A03','A04'],'03_手机页面与原生','手机业务与原生安全任务阶段')
        detail(data,['A05','A06','A07'],'04_边缘打印与验收','Jetson 单据打印及验收任务阶段')
        detail(data,[],'05_后续搭赠','后续搭赠任务阶段',future=True)
        write_docs(data)
    print(json.dumps({'tasks':len(data['tasks']),'first_phase':sum(t['phase']=='first' for t in data['tasks']),
      'verified_first_phase':sum(t['phase']=='first' and t['stages']['acceptance']=='passed' for t in data['tasks']),
      'dependency_graph':'acyclic','user_source':'preserved','source_sha256':data['_hash']},ensure_ascii=False))

if __name__=='__main__':main()
