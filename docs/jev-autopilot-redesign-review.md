# AI 托管逻辑：问题分析与重写方案（评审稿）

> 评审对象：本仓库 `wip/reserved-counter-auto`，基线 `2edea60`（工作树当时另有 1 个未提交的
> `RICH_SPEND` 相对化改动，见第 2 节）。
> 对照来源：[ra2web/jev-helper](https://github.com/ra2web/jev-helper) 线上 `main`（我拉取时即
> `a0412dc2`）。本文只做分析，不改动策略代码（另有 AI 正在改）。
> 实测数据：`.reports/jev-report-20261010-005106.json`（Laya 本地模型、choices 模式、18.4 分钟战败）
> 与一次针对 `attachJevPlayer` 的确定性离线探针（虚拟时钟 + 永远回答 wait 的假模型）。
> 行号指向上述基线；`werhd-jev-player.mjs` 正在被其他 AI 修改，行号可能已经漂移。

---

## 0. 一句话结论

**当前托管不是「AI 在打」，而是「引擎写好的剧本在打，模型负责给剧本盖章」。**
决定性判断绝大多数已经由引擎在提问之前算完（队列空不空、买不买得起、还差几个），模型拿到的
是一道只有一个合理答案的二选一题；而它在本地 Laya 上几乎恒定回答 `wait`。于是整套系统靠
24 处 `auto:` 兜底和若干绝对阈值在维持运转，每次「模型不听话」都靠再加一条兜底解决——
`docs/jev-player-flow.md` 第 12 节的 A1/B1/B2/D1 建议，本质上都是同一个问题的不同侧面。

重写的目标不是把规则写得更准，而是**换掉分工**：
把「引擎算得出答案的事」从提问里彻底移出，把省下来的预算花在真正需要判断的事上，
并且让「引擎接管」这件事变成显式、可审计、单调的设计，而不是散落在 24 个 `auto:` 上的涌现行为。

---

## 1. 先澄清版本关系（重要，避免重复劳动）

线上仓库**不是**另一份更新的实现，而是本仓库的**祖先**：

```
git merge-base HEAD a0412dc2  →  a0412dc2   （线上 main 就是 merge base）
git rev-list --count a0412dc2..HEAD  →  31
```

- 本地 `wip/reserved-counter-auto` 比线上 `main` **领先 31 个提交**，线上 0.7.5 的
  指挥官模式、`openai.mjs`、数据面板、`test/` 全套都在本地存在。
- 本地相对线上新增的主要是：离线部署件（`install.ps1`、`run-slim.cmd`、`tools/laya-serve-local.py`
  等 8 个工具）、`--slim-state` 状态压缩、`docs/ra2-unit-catalog.md` 与词典（25124 行的 `.ini`）、
  `src/player/*` 的 1261 行策略改动（`--numstat`：strategy +368/-37、special +202/-20、
  background-core +134/-28、shared +29/-6）。
- 线上唯一明显「本地没有」的是 `docs/examples/jev/` 之外的历史接入文档与
  `docs/ai-decision-porting.md` 的对应上游版本；本地把它们演进成了自己的设计文档。
- 测试文件层面两线各有独占项：线上有 `player-bridge`、`player-capture`、`player-loop-naval`、
  `player-roles-traffic`、`player-siege`、`player-range-defense`、`player-campaign` 等；
  本地有 `player-crates`、`player-techchain`、`player-home-guard`、`player-p0-balance`、
  `player-opening-auto` 等。**两边都值得互抄**，这是「线上还有价值」的具体形态。
- 线上版本锚点已核实：`main` HEAD == tag `v0.7.5` == `a0412dc2`（2026-09-27），
  `package.json` / `public/manifest.json` / `src/page.mjs` 三处版本号一致。
- **`auto:N` 这个机制本身来自线上**（线上已验证的落点：占领目标 auto 1/3、训练工程师 auto 1、
  中立占领 auto 2、生存性重建 auto 2、`objective_<id>` auto 2、钱闲补兵 auto 2，
  拒绝计数「按组、统计最近 8 次回答」）。本地把它扩到 24 处并引入 `auto:1` 的绝对阈值，
  事实 B（同组取最小 N、`auto:1` 每轮开火）是**本地演进引入的，不是线上原有的缺陷**——
  重写时不要把责任记到线上，也不要指望从线上合并能修掉它。
- **线上是「全部组一次请求」**（所有 12 个组进同一个 `questions`，响应必须覆盖每一组，
  否则 `validateAnswer` 整包作废）；本地加了「按 4 个固定组优先 + 取前 8」的裁剪
  （`player.mjs:2326-2338`）与 `prepareQuestions` 的 1–8 组上限。**这是本地的改进，保留。**

**结论：不需要「搬迁线上逻辑」**。线上可用的最大价值是**回归测试清单**（`test/*.test.mjs` 的
行为断言），本地同样有 31 个测试文件、`node --test` 在基线上 **203 项全绿**。

### 1.1 两线独立收敛的机制（重写时必须原样保留）

下列机制在本地与线上**各自独立存在且语义一致**，说明它们是踩过坑之后收敛的结论，
不是某一版的临时补丁。重写时它们是「必须保住的行为」，不是可以顺手简化的复杂度：

| 机制 | 两线一致的形态 |
|---|---|
| 安静降频 | `QUIET_TURNS = 5`、`QUIET_INTERVAL_MS = 3000`（连续 5 轮全 wait 且无动作、基地未被打 → 约 3 s 一问） |
| 失败熔断 | 连续 5 次失败 → `repeated_errors` 停止 |
| 过期双重判据（指挥官） | 同时超过 900 tick **且** 实际等待超过 60 s 才算过期，游戏加速时不误判 |
| 攻击目标数量 | `MAX_ASSAULTS = 6`，有本局目标时 4；防御名额被保留（防空塔排最后） |
| 建筑优先级 | `建造厂 0 → 工厂 1 → 精炼厂 2 → 发电厂 3 → 其他 4 → 只防空的塔 5` |
| 经济规则 | 1800 tick 收入窗口；余额 ≥4000 且不降 → 维持；矿车闲置无矿 → 不再买；余额 <1500 且下降 → 每精炼厂 2 辆、上限 3；无精炼厂先建精炼厂、不买矿车 |
| 出击迟滞 | `READY_HOLD = 0.75`（跌破门槛 75% 才回到集结），升级等级变化会清掉 latch |
| 反添油 | `MIN_ATTACK_UNITS = 4`；有生产能力时少于 4 个不进攻 |
| 升级机制 | 1800 tick 交换窗口、损失 ≥4 且击杀不到一半、或同一目标 2700 tick 无进展（重复下令不重置计时）→ 升级（上限 3） |
| 任务锁 | `MISSION_LOCK_TICKS = 450`；同一目标不重置停滞计时 |
| 受击反应 | `THREAT_REPLY_TICKS = 60` 每单位冷却、`ENGAGE_RADIUS = 15` 格、撤退后约 450 tick 不派回 |

### 1.2 测试即契约：重写最容易踩的回归面

线上 177 项测试（0.6.0 起：121 → 150 → 172 → 176 → 177）与本地 203 项测试共同把下面这些东西
钉死了。**改动这些等于制造回归**：

- **导出名**：`collectState`、`candidateGroups`、`forceReadiness`、`respondToThreats`、
  `maintainBattle`、`acceptMission`、`missionGate`、`RICH_SPEND`、`parseObjective`、
  `matchesCapture`、`isGuardedByObjective`、`buildBrief`、`executeProduction`、`executeEngineer`、
  `attachJevPlayer` 的 options 形状；
- **选项 key 的字面形状**：`objective_<id>`、`assault_<id>`、`engage_visible`、`defend_base`、
  `produce_<name>`、`capture_<id>`、`recover_<name>`、`cancel_<name>`、`recover_sell_<id>`；
- **`auto` 的具体数字**（1/2/3），以及「哪些选项允许被撤下」；
- **顺序断言**：objective 必须排第一；基地受威胁时 `defend_base` 在 objective 之前；
  `assault_1467` 在 `assault_1434` 之前；
- **指令文案的正则**：`MISSION OBJECTIVE…`、`CAPTURE target … never attack it`、
  `Force READY`、`STALE ×N`、`still above 75% of the threshold`、升级句式。

**这就是 5.7 节「先做重放闸门」的现实理由**：真正的风险不是策略想错，而是改结构时
无意破坏这些被测试锁住的行为，而 `test/player-opening-auto.test.mjs` 已经证明——
一条被关掉的红用例会让下一个人继续在错误的假设上工作。

---

## 2. 已经落地、不必重复提的修改

写本文期间，另一个 AI 已把 `docs/jev-player-flow.md` 的 **D1（RICH_SPEND 相对化）** 落地到工作树：

- `RICH_SPEND` 5000 → **1500**，新增 `RICH_SPEND_MULTIPLE = 2` 与
  `moneyIdle(credits, cheapestCombatCost)`（`player.mjs:131-140` 附近）。
- 矿车分支脱离 `moneyIdle` 判断并增加支付力检查；`vehicles`/`infantry` 的兜底扫描不再整体
  被 5000 挡住。
- 提交信息与注释都直接引用 `jev-report-20261010-005106`，也就是本文第 3 节用的同一份战报。

**这意味着第 3 节的量化证据已经在被消费，下面第 4 节的五项建议刻意避开 D1。**

---

## 3. 现状：数据流与实测事实

### 3.1 数据流（choices 模式）

```
微循环 micro()  每 150 ms（player.mjs:2239-2312）
  胜负判定 → maintainBattle → spreadInfantry → placeReadyBuilding → updateCamera
  每 60 tick 输出一次 observation
决策循环 decide()  每 600 ms，或安静 5 轮后 3 s（player.mjs:2313-2458, 2511）
  collectState() → candidateGroups()（最多 13 组）
  → 过滤掉只有 wait 的组 → 按“4 个固定组优先 + 最久没问优先”排序 → 取 8 组
  → requestDecision({state, groups})   ← **整份 state 随每个问题重复发送**
  → 答案过期则整包丢弃 → 逐组执行（missionGate → executeCandidate）
  → auto: 兜底扫描 → quietTurns 统计
```

节奏由页面定时器与 `api.onTick` 唤醒共同驱动（隐藏标签页场景），`status.busy` 保证
同一时刻只有一个请求在飞。

### 3.2 实测：`jev-report-20261010-005106`（build `d083381-dirty`，Laya）

| 指标 | 值 |
|---|---|
| 时长 / 结果 | 1103.5 游戏秒（18.4 分钟）/ **战败** |
| 决策轮数 / 请求数 | 63 / 64（0 次失败、0 次过期丢弃） |
| 提问的「组-问题」总数 | **129**（平均每轮 2.05 组） |
| 回答 `wait` | **70 / 129 = 54%** |
| 引擎兜底动作 | 20 次（`auto_explore` 5、`auto_infantry` 5、`auto_defenses` 4、`auto_construction` 3、`auto_vehicles` 3） |
| 累计输入 token | 106,019（≈1,683/轮） |
| 延迟 | 平均 3,469 ms，最大 9,875 ms |
| 兵力峰值 / 结束余额 | 8 个单位 / 5,741 信用点（起始 10,000） |

分组等待率（这是最关键的一张表）：

| 组 | 提问次数 | wait | 每次提问的平均候选数 |
|---|---|---|---|
| **vehicles** | 26 | **24（92%）** | **2.0** |
| **defenses** | 11 | **11（100%）** | 2.0 |
| scouting | 15 | 13（87%） | 4.0 |
| infantry | 21 | 12（57%） | 3.2 |
| construction | 8 | 4（50%） | 2.1 |
| deployment | 18 | 3（17%） | 2.1 |
| tactics | 24 | **0（0%）** | 2.0 |
| engineering | 3 | 0 | 2.3 |
| salvage | 3 | 3（100%） | 2.0 |

### 3.3 传输层的本地偏离（有意为之，不要"改回线上"）

| 项 | 线上 0.7.5 | 本地 |
|---|---|---|
| 本地模型超时 | 8 s | **18 s**（`background-core.mjs` `LOCAL_TIMEOUT`） |
| 过期预算 | 180 tick 起 | local 基线 **1200**、openai **900**，再按实测年龄翻倍（上限 3600） |
| 请求体上限 | 按**字符**计 | 按 **UTF-8 字节**计（`BODY_MAX_BYTES=256000`，与 Python 服务 `MAX_BODY` 对齐） |
| 决策预算 | `maxDecisions ?? 600` | 默认 **2000**（`shared.mjs` DEFAULTS，双层校验） |

这四项本地都更合理，属于应当保留的偏离；重写时不要顺手"对齐线上"。

### 3.4 三个可直接引用的事实

**事实 A：46% 的提问在问一个「引擎已经知道答案」的问题。**
`vehicles + defenses + salvage` 三组共提出 40 个组-问题，其中 38 次（95%）回答 `wait`。
而 vehicles 组的题目长这样（取自战报原文，tick 5730）：

```
选项 produce_MTNK => "FORM THE ATTACK FORCE: 0/8 mobile combat vehicles; complete the group
                      before more discretionary towers or technology: Grizzly Battle Tank;
                      cost 750 ..."
选项 wait         => "Wait only if this unit is already in production in the vehicle queue,
                      or the factory cannot produce it at all. **Affordability has already been
                      checked, so do not hold back to accumulate more credits.**"
模型选择：wait（置信度 0.33）
```

`wait` 的两个前提（队列里有、造不了）在 750/2715 信用点、队列空闲的条件下都是**假的**，
这句「Affordability has already been checked」正是引擎自己承认：**答案不是选择题**。
这类问题的 token 有 90% 以上（1,683/轮 × 2.05 = 整份 state 重复发送）花在了模型读不到的
上下文上——本地服务实测：「state 在每个问题里重复，占每个问题约 62%」
（`tools/laya-serve-local.py:56-71`）。

**事实 B：兜底计数是「按组」而不是「按选项」，`auto:1` 的选项会每轮开火。**
离线探针（虚拟时钟 + 永远 wait 的模型，见文末附录）观测到：

```
tick=1000 q=vehicles choice=produce_CMIN auto=YES reason=auto_vehicles
tick=1030 q=vehicles choice=produce_CMIN auto=YES reason=auto_vehicles
tick=1060 q=vehicles choice=produce_CMIN auto=YES reason=auto_vehicles
...（每轮一次，连续 12 次以上）
```

原因在 `player.mjs:2424-2439`：兜底循环只取「该组里 `auto` 数值最小的那个选项」
（`autos[0]`），而矿车选项是 `auto:1`、坦克是 `auto:2`；一旦矿车选项存在，
**坦克的兜底永远不会被选中**，而矿车每轮被直接下单。战报里只看到 3 次
`auto_vehicles`，是因为真实对局的队列会占满、执行被 `queue_changed` 拒掉。

同一个机制反过来就是事实 C 的另一面。

**事实 C：绝对阈值让兜底「该来时不来」。**
战报中 vehicles 组连续 14 轮回答 wait（tick 5670→10036，约 4.4 分钟），
直到 tick 10036 才第一次触发 `auto_vehicles`。此前 `RICH_SPEND=5000` 是硬门槛，
而该局余额长期在 2,000–4,900 之间——`auto` 根本没被打上。这是 D1 修的那个问题。

---

## 4. 结构性问题（按修复收益排序）

### P1. 「引擎直管」与「模型决定」没有边界，靠 24 个散落的 `auto:` 打补丁

现状：

- 全仓 **24 处** `auto:` 标记（`docs/jev-player-flow.md` 第 9 节仍写 11 处，已过期）。
  分布：`player.mjs` 11 处、`special.mjs` 8 处、`strategy.mjs` 5 处（subagent 逐行核对）。
- 三套并存的「谁有权生产」：开局 `auto:1`（`player.mjs:607`）、`RICH_SPEND` 扫描
  （`player.mjs:1219-1245`）、`investmentGroups` 的 reserve 删除（`strategy.mjs:635-657`）。
  三者可以互相增删对方刚加的选项。
- `defenses` 组被构造两次，**第一次被丢弃**：`specialGroups` 用 `??=` 建它（`special.mjs:382`），
  随后 `investmentGroups` 用 `groups.defenses = {...}` **整体覆盖**（`strategy.mjs:378`）。
  结果 special 里的围墙/据点候选在真实管线里从不出现，只在直接调用该模块的单测里存在。
- `floorTagged` 是每轮局部变量（`strategy.mjs:389`），所以「底线第一座塔 auto:2」
  实际语义是「每轮都把第一个塔标成 auto:2」——一轮就建成，注释里的「拒两次才建」不成立。

**这就是「重写」而不是「继续调参」的根本理由**：没有一个地方能回答
「这一步到底谁说了算」。每次模型不听话，就再加一条兜底；每条兜底又和其他兜底打架。

### P2. 信息层：整份 state 随每个问题重复，且右侧截断是前缀截断

- choices 请求体是 `{state: snap.state, groups}`（`player.mjs:2345`），
  `snap.state` 到这一步已被 `candidateGroups` 追加了 `economy / strategy / forceReadiness /
  combatAssessment / objectiveTarget / recentChoices / infrastructure / ...`（十多个字段）。
- 本地服务的处理链是 `priority_state → slim_state → compact_units → compact_state`
  （`tools/laya-serve-local.py:357-374`），**只存在于 Python 侧**；`src/` 里没有任何
  slim 逻辑（grep 无命中）。
- 截断规则是**前缀保留**：`build_sequence` 取 `state_ids[:room]`，
  「第一个放不下的字段会把它后面所有字段一起带走」（`tools/laya-state-report.py:140-143`）。
- 三处公布过的预算互相不一致：`tools/laya-serve-local.py:264-271` 写全量 3501–3597 token /
  每题约 797；`run-slim.cmd` A/B 写 1022→712；`AGENTS.md` 写全量约 6495 / slim 533。
  三者都进了文档，但没人能说清当前用的是哪个。
- 后果很具体：`tools/laya-serve-local.py:326-331` 记录 `jev-report-20261009-055438`
  里 86 道「造精炼厂 vs 等待」的题，队列空、余额 2,450–8,900、精炼厂价 2,000，
  模型 **83 次选 wait**；而本地模型对这类题型的先验本身就是 wait（`test/player-opening-auto.test.mjs:6-24`
  实测：改选项顺序 wait 0.65→0.94、改文案 0.89、清空文案 0.98，五种 wait 同义词里它照样挑 wait）。

**换句话说：不是模型「看不到状态所以答错」，而是这个 checkpoint 对二选一题型几乎不读状态。**
把上下文做大对它有边际收益（`--head-max-len 512` 让等待 18/20→4/20），但改变不了性质。

### P3. 时间维度：没有计划，只有每轮重算 + 局部锁

- 唯一的跨轮记忆是 `missionLock`（`MISSION_LOCK_TICKS=450`）、`autoDeclines`、
  `memory.recentChoices` / `historyHints` 的 `STALE ×N` 文案，以及 commander 模式的 `lastPlan`。
- 没有「已承诺的计划 + 前置条件 + 放弃条件」，所以振荡只能靠补丁压制：
  `MISSION_LOCK_TICKS`、`READY_HOLD=0.75` 迟滞、`RALLY_HOLD_TICKS=1800`、
  `ATTACK_GRACE_TICKS=300`、`AUTO_LOCK_TICKS=600`、`HOLD_DRIFT=4`……
  这些常数每一个都对应一次线上事故，彼此之间没有统一解释。
- 决策节奏与状态变化解耦：每 600 ms 无条件组题，状态没变也照问
  （`QUIET_TURNS=5` 之后放宽到 3 s，是唯一的抑制）。

### P4. 三层状态压缩、无 provenance、无法离线复现

- 压缩分三处：页面 `collectState` 产原始 state；Laya 服务按启动参数改写
  （`inventory`→`{kind:count}`、`queues`→`{t,items:[{n,q,p}]}`，空队列变 `{"t":0}`）；
  OpenAI 路径另有一套 `compactState`（`src/openai.mjs:7,18-28`，48k **字符**上限、数组砍到 24/8/2）。
- 日志只记扁平化的 `stateSummary`（`src/logbook.mjs:12-32`），不记真正发出去的 payload，
  也没有字段说明这一次用的是 full 还是 slim；只有开 `--dump-states` 才有 `preparedState`。
- 结果：`docs/jev-player-flow.md` 自己记了教训——`jev-report-20261009-214501` 因为
  「不知道是哪版代码跑的」被误读两次，后来才加了 BUILD_STAMP 指纹。**状态编码至今没有同样的指纹。**
- `.preview/` 下有 4,220 个 state 快照与 `states-slim / states-slim2` 分组
  （注意 `AGENTS.md` 已声明 `states-armA-full` / `states-armB-slim` 是修复前采集、不能当 A/B），
  但没有任何「拿策略离线跑一遍并出对比报告」的工具。

### P5. 验证资产被低估：203 项测试 + 一个「待查」的红用例

- 基线上 `node --test` **203 项全绿**，测试文件 31 个（`AGENTS.md` 里
  「`test/` 不在离线部署件里、`npm test` 是 no-op」说的是**部署件**，不是本工作区——
  本工作区 `npm test` 会真的跑测试）。
- `test/player-opening-auto.test.mjs:93-130` 是一个**被 `if (false)` 关掉的待查断言**：
  完整基地（含科技建筑在菜单上）时 `groups.construction.actions` 只剩 wait，
  排查者已排除 catalog、`wantsConstruction`、电力、队列、余额、`strategy.investment`，
  结论写在注释里：「找不到删除点之前先不红」。
- 这是重写前必须解决的**已知未定位缺陷**：`strategy.mjs:635-657` 的 reserve 删除配合
  `decide()` 的 `Object.keys(g.criteria).length > 1` 过滤（`player.mjs:2328`），
  完全可以让一个组整体消失——而组消失意味着模型整局看不到它。

### P6. 指挥官模式其实是第二套完整架构，两个模式不能一起重写

`src/player/werhd-jev-commander.mjs` + `openai.mjs` 的 `issue_orders` 是一套**独立**的
决策路径：简报（≤6000 token）→ 大模型给每支小队下意图 + 生产 + 工程师任务 →
扩展校验编号、执行、在两轮之间维持意图（只给新加入/空闲成员补令）、保留本能层。
它**刻意不用**选择题的候选、`auto:` 兜底、任务锁和出击门槛。

也就是说仓库里现在有两套架构：一套「规则出题 + 小模型选择 + 24 处兜底」，
一套「简报 + 大模型规划 + 引擎维持」。本次重写建议**只动前者**（本地 Laya 是主战场），
把 P1–P5 的改动限制在 choices 路径内；commander 路径保持原样，
但 P2（问题切片）与 P4（provenance）的成果应当能被它复用（例如同一份状态编码与日志字段）。
两套一起改会让回归面翻倍，而 commander 的验证成本高得多（每轮 30–50 s、需要付费模型）。

---

## 5. 重写方案

### 5.1 设计原则（四条，其余都是推论）

1. **可计算的事不问模型。** 若某选项的前提在提问前已被引擎证明，它就不该出现在选项表里；
   要么引擎直接执行，要么该组本轮不提问。
2. **每次提问自带最小上下文切片，不重发整份 state。** 事实用短键、紧凑形式表达，
   问题自包含；模型不需要「读全图」，只需要「读这道题」。
3. **接管必须是显式的、单向的、可审计的。** 引擎接管写进决策记录（谁接管、为什么、
   依据哪个前提），不是散落的 `auto:N` 涌现行为。
4. **一切改动必须能被离线重放验证。** 没有 replay 指标，任何重写都是换一种方式猜。

### 5.2 提议 A（最高优先）：把「确定性问题」从提问层移除

**改法**：`candidateGroups` 给每个 action 除了 `auto` 之外，再标一个来源：

- `decided: true`（引擎已证明前提成立）→ 不出现在给模型的 `criteria` 里，由引擎执行，
  记 `reason: engine_decided`；
- `gated: true`（引擎知道该做，但有一个需要判断的开关，例如「现在补兵还是先补塔」）
  → 出现为**一个选项**，等待条件由引擎给出；
- 其余为纯判断题。

**依据**：事实 A（40 个组-问题里 38 次 wait）、事实 C（`wait` 文案自己承认答案已知）。
**收益估算**：按战报口径，vehicles/defenses/salvage 三组可减少约 40/129 ≈ **31% 的
组-问题**，以及对应的重复 state token；同时把 `auto:N` 计数器的语义换成「引擎决定」，
消除事实 B 那类「最低 N 每轮开火」。

### 5.3 提议 B：按问题切片上下文（Question Slice）

**改法**：把 `requestDecision({state, groups})` 改为
`requestDecision({common, questions})`：

- `common`：只放所有问题都需要的少量标量（tick、credits、power、baseUnderAttack、
  forceReadiness 摘要），目标 ≤120 token；
- 每个 question 自带 `facts`：该问题真正需要的数字与短列表（例如 vehicles 组的
  `{ miners:1, target:2, queue:[], cheapest:{MTNK:750}, credits:2715, deficit:8 }`），
  目标 ≤80 token（约 15 个键值对）；
- 单位用短键：`MTNK 45,70 74%`（`compact_units` 已有实现，`tools/laya-serve-local.py:163-182`）。

**依据**：`laya-serve-local.py:56-71`（state 占每题 62%）、`:140-143`（前缀截断会连锁丢字段）、
`:243-247`（1755 token 的中局 state 里只有约 764 可读，**排序决定 43%**）。
**收益**：同样 8 个问题上，可读 token 从「state 的后半段永远看不到」变成「每题都完整可读」；
实测等价于 `--head-max-len 512` 的效果（等待 18/20→4/20），但不需要更大的上下文。

**同时修**：把压缩链从 Python 侧搬回 `src/`（或至少在 `src/` 保留一份等价实现），
让页面发出的 payload 就是模型看到的东西，并给它一个 schema 版本号写进日志——
这样 P4 的 provenance 问题一并解决，任何 provider（Jev / Laya / OpenAI）收到同一份切片。

### 5.4 提议 C：统一「兜底」为一套显式接管规则

**改法**：

- 删除 `auto:` 数值标记，改为每组的 `takeover` 契约：
  `{ afterDeclines: N, accept: (answer, ctx) => boolean, why: string }`，
  并且**每个选项独立计数**，而不是每组取最小 N（修事实 B）。
- 计数器只在「该选项被**成功执行**」时清零，被 `executeCandidate` 拒绝不清零
  （现状：任何非 wait 回答都清零，`player.mjs:2429`，即使该回答随后被拒）。
- 阈值一律相对化：不要 `credits >= 5000`，要 `credits >= f(该组最便宜可造单位成本, 收入趋势)`。
- 把 `floorTagged` 改成真正的持久状态（memory 级），使「底线塔」确实由引擎直管，
  并在日志里明确写「引擎接管：底线不足」。
- **必须消除双构造**：`defenses` 组只允许一个 owner（建议 `investmentGroups` 用
  `??=`/追加，而不是整体赋值），否则 special 的候选永远进不了真实管线。

### 5.5 提议 D：给决策加时间维度（计划对象）

**改法**：引入 `memory.plan = { intent, target, committedAt, expiresAt, preconditions, abortIf }`，
模型的选择转化为「接受/修改/放弃当前计划」，而不是每轮从零选一个 mode。
题面附上「当前计划、已执行多久、进展如何、上次命令结果」，commander 模式的
`lastPlan`/`lastPlanReport`（`commander.mjs`）已经是这个形状，把它下沉到 choices 模式即可。

**收益**：可以成批删掉为压制振荡而加的常数（`MISSION_LOCK_TICKS`、`RALLY_HOLD_TICKS`、
`HOLD_DRIFT`、`AUTO_LOCK_TICKS` 的一部分），并且让 `escalation` 变成计划的一个字段
而不是另一套全局状态机。

### 5.6 提议 E：请求节奏与事件驱动

**改法**：只在「某组输入的哈希变化」或「距上次提问超过 T」时提问；
`candidateGroups` 每轮照常计算（供微循环使用），但只有变化的组进入请求。
紧急事件（基地受击、发现敌基地、目标摧毁、兵力掉 50%）沿用现有的
`urgent()` 机制提前唤醒（commander 模式已有 `URGENT_MIN_TICKS` 的成熟实现）。

### 5.7 提议 F：离线重放闸门（先做这个）

**改法**：写一个 `tools/replay-decisions.mjs`：

```
输入：一组 state 快照（.preview/states-slim*）+ 一个策略版本 + 一个假模型（always-wait /
      always-first / 录制回放）
输出：每组提问次数、wait 率、引擎接管次数与理由、被拒原因分布、每题 payload token 数、
      与旧策略的逐轮差异（同一 state 下选项集合与最终动作的 diff）
```

`.preview/` 已有 4,220 个快照可直接当语料；`tools/laya-state-report.py` 已有
token 统计的骨架。**在任何 `src/` 改动之前先有这个闸门**，重写才有验收标准；
否则又会回到「改完看下一局战报猜」的循环。

**验收指标建议**（以 `005106` 为基线）：

| 指标 | 当前 | 目标 |
|---|---|---|
| 确定性问题占比（引擎可判定却被提问） | ~31% | < 5% |
| vehicles 组 wait 率 | 92% | 不作要求（模型先验如此），但**首次有效生产动作时间**要显著前移 |
| 每题 payload token | 1,683/轮 | < 500/轮 |
| 首次战斗单位出厂时间 | tick 10036（≈11 分钟） | 开局 5 分钟内 |
| 战败局兵力峰值 | 8 | 不作为硬指标，但要有基线对比 |

---

## 6. 分阶段落地顺序（每步可独立验收）

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **0** | `tools/replay-decisions.mjs` + payload token 统计 + 把 state schema 版本写进日志 | 无 | 能用 4,220 份快照跑出基线报告 |
| **1** | 提议 A（确定性问题移出提问）+ 修事实 B（选项级计数） | 阶段 0 | `auto_*` 不再每轮开火；确定性问题占比 <5%；203 项测试仍全绿 |
| **2** | 提议 B（Question Slice）+ 压缩链收归 `src/`、版本化 | 阶段 1 | 每题 payload <500 token；同一 state 下模型选择分布不劣化 |
| **3** | 提议 C（统一接管契约）+ 消除 `defenses` 双构造 + `floorTagged` 持久化 | 阶段 1 | 决策日志能回答「这一步谁决定的」；无同一决策双实现 |
| **4** | 提议 D（计划对象）+ 提议 E（事件驱动提问） | 阶段 3 | 振荡类常数可从 6 个减到 2 个；请求次数下降 ≥40% |
| **5** | 打开 `test/player-opening-auto.test.mjs` 的待查断言并修掉根因 | 阶段 3 | 该测试变红→变绿，无 `if (false)` 残留 |

---

## 7. 已知缺陷清单（重写时的 checkpoint，均可定位）

| 编号 | 缺陷 | 证据 |
|---|---|---|
| D-1 | 兜底按「组内最小 auto」选择，`auto:1` 选项每轮开火，同组 `auto:2` 选项永不被选中 | `player.mjs:2424-2439` + 离线探针输出 |
| D-2 | 兜底计数器在任何非 wait 回答时清零，即使该回答随后被 `executeCandidate` 拒绝 | `player.mjs:2429` |
| D-3 | `defenses` 组双构造，special 侧候选被整体覆盖丢弃 | `special.mjs:382` vs `strategy.mjs:378` |
| D-4 | `floorTagged` 每轮重置 → 底线塔实际每轮都可被 auto 建 | `strategy.mjs:389,453` |
| D-5 | 完整基地时 `construction.actions` 只剩 wait（根因未定位，测试被 `if (false)` 关闭） | `test/player-opening-auto.test.mjs:93-130`、`strategy.mjs:635-657`、`player.mjs:2328` |
| D-6 | `ARMOR_ORDER` 导出后无任何消费者；`s.defenseBlocked` 只写不读（注释声称的解锁未实现） | `strategy.mjs:163,425-426` |
| D-7 | Verses 注释声称做了归一化（75→0.75），代码未做，只特判了 `=== 0` | `strategy.mjs:156-158,191` |
| D-8 | 「是不是武器」三个阈值并存：`>1` / `>0` / `>0` | `strategy.mjs:170` vs `special.mjs:166` vs `strategy.mjs:262` |
| D-9 | `baseThreats` 的新 `harvesters` 参数只在 3 个调用点传入，另 3 个沿用旧语义 → 同一判断两个答案 | `player.mjs:92,944` 有传 vs `:1358,1644,1823` 未传 |
| D-10 | 部署判断新旧两套 AND 在一起，新规则只能收紧 | `special.mjs:165` + `strategy.mjs:51-95` |
| D-11 | 强制目标三套数字：8/12/16/20（readiness）vs 12–24+4×escalation（forceGoal）vs 8（选项文案） | `player.mjs:268,293`、`strategy.mjs:677`、`player.mjs:533` |
| D-12 | 过期答案整包丢弃（同批中本可用的生产指令一起丢）；Jev/Laya 校验是整包 all-or-nothing | `player.mjs:2350-2360`、`shared.mjs:200` |
| D-13 | 压缩链三套（页面 / Laya 服务 / OpenAI），日志不记状态编码与 payload | `openai.mjs:18`、`laya-serve-local.py:357-374`、`logbook.mjs:12-32` |
| D-14 | 文档漂移：`auto:` 24 处 vs 文档 11 处；`maxDecisions` 600 vs 2000；`states-armA/B` 不可当 A/B；引用的 `docs/jev-player-goal-audit.md` 不存在 | `docs/jev-player-flow.md` §9、`AGENTS.md`、`strategy.mjs:703-717` |

---

## 附录 A：离线探针的做法（可复现）

探针不在仓库内（写在系统临时目录，避免和其他 AI 的改动冲突），做法是：

1. 劫持 `globalThis.setTimeout/clearTimeout` 与 `performance.now`，改用**虚拟时钟**，
   由测试自己推进 tick 与墙钟；
2. 构造一个最小 `api`（`me/units/production/map/players/onTick` + `produce` 写入队列），
   以及一个 **永远回答 `wait`** 的 `requestDecision`；
3. 用 `api.onTick` 回调驱动 15 tick/s × 240 s，观察 `onEvent` 里的
   `action/stale/stop` 事件；
4. 输出：每组提问次数、每个选项被提问的次数、每次 `auto` 动作的 tick 与 choice。

这套骨架稍加扩展就是第 5.7 节的 `tools/replay-decisions.mjs`——**建议直接把它做成仓库工具**，
它是这次重写唯一能挡住回归的东西。
