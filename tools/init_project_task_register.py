"""Create the initial management task register once; never reset an existing one."""
from pathlib import Path
import json

ROOT = Path(__file__).resolve().parents[1]
DEST = ROOT / 'docs' / '项目管理' / '项目任务台账.json'
if DEST.exists():
    raise SystemExit('台账已存在，禁止重置真实进度，请编辑现有台账后重新绘图。')
RULE = 'docs/功能逐页梳理_2026-10-30/05_人工确认结果与正式产品规则_v0.2-r1.md'
REUSE = 'docs/旧项目参考资料/旧项目可复用资产评估_2026-10-30.md'
STAGES = ['scope', 'contract', 'implementation', 'module', 'integration', 'acceptance']
owners = [
 ('ROOT','主代理总控','规则 合同 整合 版本'),
 ('A01','云端接入与调度','阿里云 企微 批次 云边任务 恢复'),
 ('A02','主档价格与订单','客户 商品 价格 金额 确认 销售'),
 ('A03','手机业务页面','工作台 核对 电子单 订单 进度'),
 ('A04','APK原生与设备安全','APK 媒体 通知 相册 身份与换机'),
 ('A05','Jetson识别与训练','模型 候选 真实训练 候选评测'),
 ('A06','单据生成与打印','PNG PDF iP110 出纸与重打'),
 ('A07','独立验收','环境信息 固定样本 故障矩阵 同版验收'),
]
tasks = []
def add(id, title, owner, deps, done, next_action, pages='', reuse='', phase='first', status='待方案', blockers=None, aliases=None):
    stages = {k:'not_started' for k in STAGES}
    stages['scope'] = 'passed'
    if id == 'HW-01':
        for key in ['contract','implementation','module','integration']:
            stages[key]='not_applicable'
    if id in ['QA-01','QA-02']:
        stages['implementation']='not_applicable'
    tasks.append({
      'id':id, 'title':title, 'owner':owner, 'assigned_agent':None,
      'phase':phase, 'status':status, 'stages':stages,
      'dependencies':deps.split() if deps else [],
      'page_refs':pages.split() if pages else [],
      'legacy_ids':aliases or [],
      'reuse_candidate':reuse, 'acceptance_criteria':done,
      'next_action':next_action, 'blockers':blockers or [],
      'evidence':{'scope':[RULE]}, 'source_version':None,
      'actual_start':None, 'actual_acceptance':None,
      'updated_on':'2026-10-30', 'handoff_notes':[],
    })

add('PLAN-02','22页产品规则确认留存','ROOT','',
    '用户修改原稿及确认记录、摘要和快照对应，22页确认状态一致。',
    '保留原稿，后续只记录新决定和具体未填细项。',phase='management',status='文档已确认',aliases=['PLAN-01'])
tasks[-1]['stages'].update(contract='passed',implementation='not_applicable',module='not_applicable',integration='not_applicable',acceptance='passed')
tasks[-1]['evidence'].update(contract=[RULE],acceptance=[RULE])
add('PLAN-03','子代理分工 边界 进度体系','ROOT','PLAN-02',
    '工作口、单文件owner、任务依赖、边界和可刷新图表一致，可供用户审阅。',
    '审阅本轮7个工作口分工，之后派发具体任务。',phase='management',status='待审阅')
tasks[-1]['stages'].update(contract='ready_for_review',implementation='not_applicable',module='not_applicable',integration='not_applicable',acceptance='not_started')
tasks[-1]['evidence']['contract']=['docs/项目管理/01_子代理分工与任务交接.md','docs/项目管理/02_项目边界与执行规范.md']
add('BASE-01','旧资产取用及最终基线决策','ROOT','PLAN-03 CONTRACT-01',
    '逐模块来源/差异/资源和迁移依赖可追溯，最终基线有明确决定；旧项目保持不动。',
    '按已归档评估讨论取用，当前不复制或融合源码。',reuse=REUSE,phase='management',status='已盘点 待后续讨论')
add('CONTRACT-01','接口 数据 事件与迁移合同','ROOT','PLAN-02 PLAN-03',
    '来源/批次/候选/价事件/订单/单据/打印尝试/设备ID、金额单位、幂等及错误合同冻结。',
    '先登记共享合同及各口文件所有权。',phase='management')
add('GIT-01','远程仓库及每版上传记录','ROOT','PLAN-03',
    '仓库目标明确，具体版本人工确认与上传提交一致；上传不触发未经授权部署。',
    '补充远程仓库URL和所属账号，不自动建公开仓库。',phase='management',status='待资料',blockers=['远程仓库URL和所属账号未提供'])
add('RELEASE-01','整版整合 用户确认与交付','ROOT','QA-02 GIT-01',
    '同版源码/云/手机/Jetson及证据清单齐备，用户确认具体版本后才上传。',
    '等待工程与独立验收，不预填上线日期。',phase='management',status='待前置')

add('CLOUD-01','阿里云生产运行与私有持久化','A01','CONTRACT-01 BASE-01',
    '生产适配含持久后台任务及私有对象，重启读回成功；不靠删除isolated限制冒充完成。',
    '核现有部署、数据库和附件方式，提出运行适配。',reuse='旧Node数据库/私有文件适配仅隔离候选')
add('WX-01','企微回调 同步媒体与防重','A01','CLOUD-01 SOURCE-01',
    '真实获准消息保存原来源和媒体，签名/游标/回放防重通过，正式收单常启用。',
    '约定来源授权合同，改造云接点并验证消息同步。','P03 P12 P17',reuse='旧回调验签/AES/同步游标')
add('BATCH-01','客户名开头与60秒组单','A01','WX-01',
    '有效产品消息重置60秒，重复不续时，纯文字/语音/图片均可入组，迟到可待归属。',
    '按新规则替换旧#客户/120秒/必须图片限制。','P03',reuse='旧批次隔离与消息去重')
add('EDGE-01','云边任务 租约与回传协议','A01','CLOUD-01 AUTH-01',
    '领取续租/回传和附件绑定设备，重放/迟到/断线可恢复；打印未知不按识别任务自动重排。',
    '冻结识别与打印不同重试合同。','P03 P16',reuse='旧任务条件领取、租期与UNCERTAIN保护')
add('OPS-01','私有对象闭包 备份与恢复','A01','CLOUD-01 ORDER-01 DOC-01 AUTH-01',
    '隔离恢复数据库/附件/冻结单据及授权关系，来源完整，不修改生产数据。',
    '按最终表与对象清单重设计备份恢复检查。','P17 P18',reuse='旧备份归档与无损整数用例')
add('DIAG-01','云设备健康与安全自检接口','A01','CLOUD-01 EDGE-01',
    '按云、企微同步、Jetson、打印运输分别返回状态/时间/原因，与A04本地权限结果衔接；不改订单不补打。',
    '冻结逐项诊断结果及安全可重试动作，与A03自检页接线。','P17 P18',reuse='旧只读诊断及设备心跳基础')

add('DATA-01','客户 SKU 包装与资料主档','A02','CLOUD-01 BASE-01',
    '稳定ID、同名区分、合法单位/瓶数、启停与历史快照正确，空库不造演示业务。',
    '确认主档字段与脱敏导入边界。','P06 P07',reuse='旧master-data-store与包装主档')
add('PRICE-01','最近确认价及人工调价事件','A02','DATA-01',
    '客户资料改价立即生效，核对改价确认影响以后，无仅本单，旧草稿不无声覆盖新价。',
    '明确调价/撤销事件与价格版本查询。','P06 P19',reuse='旧价版本/来源校验，需要更新业务规则',blockers=['调价步长和撤销规则未给具体值'])
add('MONEY-01','拆箱瓶价与最终应收到角','A02','DATA-01 PRICE-01',
    '100÷24瓶价4.2；先瓶价后行货款，最终应收到角，抵扣/抹零/货款/应收分列。',
    '制定精确金额规则及边界样例。','P19 P22',reuse='旧BigInt行计算；不能复用仅隐藏分位来代替舍入')
add('MATCH-01','主档别名 候选及常购匹配','A02','DATA-01',
    '同名候选有依据且仅既有客户/SKU，模糊不自动确认，模型候选与确定性主档匹配衔接。',
    '定义别名作用范围和候选格式。','P03 P06',reuse='旧客户Top3/商品叫法排名')
add('ORDER-01','冻结确认与同单一次计销','A02','PRICE-01 MONEY-01 AUTH-01 DOC-01',
    '电子正式图片持久保存后确认计销；纸质确认即计销；并发/重放只一销售事件。',
    '拆开旧369纸质验纸与业务确认条件。','P03 P19 P22',reuse='369冻结/统一完成防重，须改纸路线约束')
add('SALES-01','订单查询及货款应收统计','A02','ORDER-01',
    '按客户/日期/状态查询，货款与应收分列，打印和重打不新增销售。',
    '冻结查询及汇总口径，配合P02列表。','P02 P06',reuse='旧销售查询与金额分项')
add('CORRECTION-01','已确认订单更正及冲回规则','A02','ORDER-01 SALES-01',
    '用户明确更正/作废/零价退货范围，历史留痕，冲回与新单无重复计销。',
    '单独落实未指定业务规则，不能自行开放负数或改历史。','P02 P19',blockers=['更正冲回、零价、退货及具体权限未给定'])

add('UIHOME-01','工作台 菜单 客户与查单页面','A03','CONTRACT-01',
    '工作台/菜单/客户/查单/来源登记/账号与换机页面齐全，调用A04身份原生合同；卡片精简，移除员工角色/日志/开关界面。',
    '登记上述具体页面文件归属；前端不另做身份和业务权威。','P01 P02 P05 P06 P07 P12 P13 P17 P20 P21',reuse='旧移动组件及绿色风格',aliases=['CLEAN-01'])
add('PHONE-01','原文对照与统一人工核对','A03','UIHOME-01 ORDER-01 MATCH-01',
    'P03/P19共用字段，缺客户/价/单位显著，编辑撤销核对，迟到模型不覆盖人工。',
    '按已冻结合同实现草稿与提交状态；P14普通歧义并入核对，不恢复独立冲突中心。','P03 P14 P19',reuse='旧表单、草稿及版本保护')
add('EBILL-01','图片开单 预览与独立纸按钮','A03','PHONE-01 DOC-01 ORDER-01',
    'P04/P19/P22同一流程；正式保存成功显示计销，本页独立纸质打印不再计销。',
    '明确输入/预览/保存/打印按钮各自状态。','P01 P04 P19 P22',reuse='旧图片开单和电子预览组件')
add('PROGRESS-01','手机开发期进度入口','A03','UIHOME-01 PLAN-03',
    '显示任务真实阶段与更新时间，和本地任务台账同源，不混销售统计。',
    '后续决定手机读取任务投影方式，本轮先提供离线图。','P05 P17')
add('UIOPS-01','学习 打印任务与自检页面','A03','UIHOME-01 DIAG-01 TRAIN-01 EVAL-01 PRINT-02 REPRINT-01',
    'P15真实样本/训练/候选状态；P16任务/人工出纸/单份重打；P18逐项诊断与安全重查，空/错/陈旧状态可见。',
    '分别接A05学习状态、A06打印操作、A01诊断及A04本机权限合同。','P15 P16 P18',reuse='旧学习/打印/自检界面仅组件参考')

add('MOBILE-01','Mate60 APK兼容与原生桥底座','A04','HW-01 CONTRACT-01',
    'ALN-AL80实际系统上安装/登录/前后台/原生桥成功，来源白名单与会话绑定正确。',
    '先核HarmonyOS和APK兼容，提出打包与桥合同。','P17 P20',reuse='旧Capacitor壳，需切阿里云与合入候选桥',blockers=['手机当前HarmonyOS/WebView版本未核实'])
add('AUTH-01','长期单手机 云端授权与撤销','A04','MOBILE-01 CLOUD-01',
    '日常长期会话且仅一授权手机，云端撤销生效，不以不可撤销固定令牌实现。',
    '设计服务端身份合同及初次授权。','P13 P20',reuse='旧鉴权/会话基础；移除多员工界面')
add('AUTH-02','系统锁屏改密与扫码换机','A04','AUTH-01',
    '只取系统认证结果；旧手机扫码明确转移，新有效旧失效，二维码不可重放。',
    '明确原生系统认证及设备转移合同，单列失机兜底。','P13 P21',blockers=['旧手机丢失/损坏的恢复办法未定'])
add('SOURCE-01','个人微信号登记及来源授权','A04','AUTH-01',
    '先登记个人微信号并绑定可核验客服稳定来源ID，无站内员工/客服显示名，无手填冒用。',
    '核平台标识可用性和配对方法，供A01调用。','P12 P17',reuse='旧授权来源/身份绑定，只取必要机制')
add('NOTIFY-01','真实锁屏提醒及点击待办','A04','MOBILE-01 BATCH-01',
    'ALN-AL80锁屏/后台收到真实待核提醒，权限/省电/离线有诊断，通知去重。',
    '选择可用原生通道并约定云端投递状态。','P01 P03 P17',reuse='旧前台轮询仅作前台提示，不能当锁屏实现')
add('ALBUM-01','正式电子单原生相册保存','A04','MOBILE-01 DOC-01',
    '真实图库文件持久写入可重启读回，拒绝权限/取消/失败不报成功，保存不计销。',
    '取用原生MediaStore候选并对新域名会话适配。','P22 P17',reuse='旧NativePhotoChannel分块/防重/MediaStore')
add('MEDIA-01','手机拍照选图与录音输入','A04','MOBILE-01',
    '拍照/选图/录音/播放/取消和拒绝权限可用，原媒体与识别请求绑定。',
    '补图片数/大小/录音时长参数并与A03衔接。','P04 P19',reuse='旧照片原生桥候选',blockers=['图片数量/大小及语音时长上限未填写'])

add('MODEL-01','Jetson内存模型与训练可行性','A05','HW-01',
    '在准确设备上记录模型、环境、峰值内存、速度和可行训练方案；不凭标签宣称可用。',
    '核准确系列/JetPack与空闲资源，比较旧模型适配。','P15 P17',reuse='旧模型profile/ASR/VL工具，仅参考',blockers=['Jetson准确系列/系统/JetPack和可用资源未核实'])
add('INFER-01','真实文字图片语音识别回传','A05','MODEL-01 EDGE-01 MATCH-01 MEDIA-01',
    '三种真实输入输出候选/字段依据与失败状态，纯文字语音不受必须图片限制，候选不含权威改价。',
    '按候选合同接通实际模型与云任务。','P03 P04 P19',reuse='旧recognition适配和格式工具，需补生产接线')
add('TRAIN-01','已确认纠错自动样本与训练','A05','INFER-01 ORDER-01',
    '确认纠错自动生成去重数据集并闲时真实训练，产物与失败可追溯，不挤占打印/识别。',
    '明确样本阈值、资源和调度；不以记录日志代替真实产物。','P15',reuse='旧治理记录结构，自动执行器待建',blockers=['训练频率/样本数/资源上限未填写'])
add('EVAL-01','候选模型固定评测与版本回退','A05','TRAIN-01 QA-01',
    '固定集不参与训练，新旧结果可比，候选版本可回退；生产切换按明确策略。',
    '与A07登记独立数据集，落实上线方式。','P15',reuse='旧候选/评测/部署记录结构',blockers=['自动上线或人工上线方式未选择'])

add('DOC-01','冻结单据 中文PNG与变量PDF','A06','CONTRACT-01 DATA-01',
    '同一冻结内容生成正式PNG和130×190变量PDF，私有持久读回/摘要可验，含单子总合计。',
    '取用369渲染候选和字体资源，对新模板重定坐标。','P19 P22 P17',reuse='369中文PNG/快照投影、旧PDF',blockers=['数量列、抵扣/合计位置及超行分页细项待明确'])
add('PRINT-01','佳能iP110驱动及真实套打','A06','HW-01 DOC-01',
    '准确连接/ARM64驱动实测，130×190实纸中文与变量格对齐，固定底图不重印。',
    '核连接方式及纸张进纸/偏移，先非业务校准。','P16 P17',reuse='旧130×190 PDF/CUPS适配不等本次模板通过',blockers=['iP110连接方式、驱动及真实进纸未验证'])
add('PRINT-02','打印持久日志 未知与重启对账','A06','PRINT-01 EDGE-01',
    '提交前后留任务/队列ID及outbox，回传失败不丢，断电/未知不自动重印，真实错误可展示。',
    '补旧jobs finally清目录前缺失的持久提交记录。','P16',reuse='旧打印UNCERTAIN/attempt基础，需补outbox')
add('REPRINT-01','打印人验纸及单次1份重打','A06','PRINT-02 ORDER-01 PHONE-01',
    '人工已出纸/未出纸各留痕，同一重打请求防重，每次1份且不新增销售。',
    '定义人工确认和重打尝试API，与A03订单详情衔接。','P16 P22',reuse='旧补打序号原因/人工确认基础，需验并发')

add('HW-01','准确设备及现有部署信息核对','A07','PLAN-02',
    '记录Jetson准确系列/系统、手机系统、打印连接和阿里云当前运行事实，区分用户声明与实测。',
    '按设备分项补资料，不把旧历史记录写成当前事实。',status='待资料',blockers=['Jetson系统、手机系统、iP110连接和当前云运行信息待核实'])
add('QA-01','脱敏固定集与需求故障矩阵','A07','CONTRACT-01',
    '正式规则对应正负场景、数据版本和证据要求，固定集独立于训练，覆盖价格/重放/断线/权限。',
    '建立版本化验收场景及固定样本保管范围。')
add('QA-02','同版本云边手机实纸独立验收','A07','WX-01 BATCH-01 EDGE-01 OPS-01 DIAG-01 PRICE-01 MONEY-01 MATCH-01 ORDER-01 SALES-01 CORRECTION-01 EBILL-01 UIOPS-01 PROGRESS-01 AUTH-01 AUTH-02 SOURCE-01 NOTIFY-01 ALBUM-01 MEDIA-01 INFER-01 TRAIN-01 EVAL-01 PRINT-01 PRINT-02 REPRINT-01 QA-01',
    '同版端到端、断网断电未知/补打、图库锁屏、模型训练、单设备转移、备份恢复及一次计销有独立证据。',
    '等待可验版本，缺陷回原owner；不代填通过。',status='待前置')

add('EXTRA-01','搭赠数量自动账及品牌门店映射','A02','DATA-01 BATCH-01',
    '只记明确实物数量，品牌/月度政策/业务员门店映射可追溯，不扩成金额或出纳。',
    '保留后续范围，先落实映射和月份细则。','P08 P11',reuse='旧实物费用台账',phase='future',status='后续待启用')
add('EXTRA-02','跨客户多选补回及逐条核销','A02','EXTRA-01',
    '跨客户多选、每条数量/单位/剩余量防重防超核，保留批次凭证和更正。',
    '后续明确分配/部分补回/凭证规则。','P09 P10',reuse='旧补回核销结构',phase='future',status='后续待启用')
add('EXTRA-03','费用详情及多选补回手机页面','A03','EXTRA-01 EXTRA-02 UIHOME-01',
    '只显示实物数量业务，多选跨客户补回与后端一致；不进入首期菜单。',
    '待后续阶段启用，再按P08-P11设计。','P08 P09 P10 P11',reuse='旧费用/补回页面',phase='future',status='后续待启用')

for task in tasks:
    if task['phase']=='management':
        task['stages'].update(implementation='not_applicable',module='not_applicable',integration='not_applicable')

payload = {
 'schema_version':1,'plan_version':'mgmt-v0.1','updated_on':'2026-10-30',
 'plan_status':'分工及边界方案已整理 待审阅；业务代码未开工',
 'confirmed_source':{'path':'docs/功能逐页梳理_2026-10-30/02_22张页面逐项解析.md','sha256':'6D588F44411F95B82C17568CDD8210209AF24CCE74D08AE3965FAEA90FBC6495'},
 'capacity':{'primary_agents':1,'specialist_roles':7,'max_parallel_subagents':3,'max_active_total':4},
 'stage_labels':{'scope':'需求','contract':'合同','implementation':'实现','module':'模块验证','integration':'联调','acceptance':'目标环境验收'},
 'owners':[{'id':a,'name':b,'focus':c} for a,b,c in owners],
 'stage_states':{'passed':'已通过','ready_for_review':'待审阅','in_progress':'进行中','not_started':'未进入','not_applicable':'不适用','blocked':'阻塞'},
 'dependencies_meaning':'依赖表示最终联调/验收前置；合同明确后可先做独立设计或脱敏模拟，不能冒充真实集成。',
 'truth_rules':['需求确认不折算代码完成率','旧源码及历史局部测试不是新版本验收','每个通过阶段均须证据','后续不计首期执行分母','没有截止期不编造日期','只有ROOT整合状态并重新生成图'],
 'tasks':tasks,
}
DEST.parent.mkdir(parents=True,exist_ok=True)
DEST.write_text(json.dumps(payload,ensure_ascii=False,indent=2),encoding='utf-8')
print(f'created {len(tasks)} tasks: {sum(t["phase"]=="first" for t in tasks)} first, {sum(t["phase"]=="management" for t in tasks)} management, {sum(t["phase"]=="future" for t in tasks)} future')
