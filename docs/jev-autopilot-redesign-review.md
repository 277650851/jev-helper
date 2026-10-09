# AI 托管逻辑：问题分析与重写方案（评审稿）

> **基准**：`C:\laya\jev-helper`，分支 `main`，HEAD `7f6d63a`（清洁工作树除了 `VALIDATION.md` 被删除、
> 三个 docs 文件未跟踪）。本文件所有行号、常数、缺陷都按**这一份代码**取证。
> **对照**：同 fork 的 `C:\jev-merge` 分支 `wip/reserved-counter-auto`（HEAD `641bb4f`，比 laya 多 18 个提交）
> 与线上 `ra2web/jev-helper`（`main` = tag `v0.7.5` = `a0412dc2`）。
> 用途：重写 AI 托管逻辑前的现状审计与方案。**本文不改代码**（另有 AI 在改）。
> 生成方式：4 个只读取证 + 基线测试实测；未执行任何写操作。

---

## 0. 一句话结论

**这套托管不是「模型在打」，而是「引擎写好的剧本在打，模型负责给剧本盖章」。**

引擎在提问之前已经把决定性判断算完了（队列空不空、买不买得起、还差几个、有没有矿车），
模型拿到的往往是一道只有一个合理答案的二选一题（本仓 `player.mjs:2134` 只会把「选项数 ≤ 2」
的组送进请求）。本地 Laya 对这类题型几乎恒定回答 `wait`，于是整套系统靠散布在三个模块里的
`auto:` 兜底和一堆绝对阈值维持运转。每次「模型不听话」就再加一条兜底——结果就是本修订里
可以逐条证明的 12 类结构性问题：两组重复构造、标记了却永远打不出的 `auto`、写完从不读的字段、
互相矛盾的兵力目标、够不到也退不出的升级机制。

重写的目标不是把规则写得更准，而是**换掉分工**：
把「引擎算得出答案的事」从提问里移出，把省下来的预算给真正需要判断的事，
并让「引擎接管」变成显式、单调、可审计的设计。

---

## 0.1 已落地（分支 `fix/autopilot-p0-buildstamp-and-stability`）

评审之后按优先级实际改掉的部分，每条都有回归测试或实测数据：

| 提交 | 内容 |
|---|---|
| `0484850` | **构建指纹**：esbuild `define` 注入 git 短 hash（脏则 `-dirty`），经 `meta.build` 进战报；另修掉一条**空断言造成的假红**（见 §2.1） |
| `3ddc7ab` | **S1**：`defenses` 组不再被整体覆盖，special 层的围墙/据点候选首次真正到达模型 |
| `59fa7db` | **自适应反制**：新增 `werhd-jev-counter.mjs`，敌方构成 + 护甲字 + 规则驱动的克制打分进题面与日志 |
| `86b2827` | 反制威胁值按目标护甲与弹头 `Verses` 计算；记下规则来源的版本陷阱 |
| `6a89f59` | **S3**：引擎接管过的选项不再被当成模型的连败而删掉 |
| `b7434ee` | **S2**：空军支援选项不再被施工过滤器删掉（一个失效的 `auto` 掩盖了一个死选项） |
| `57ab372` | **战报审计工具**：量化「引擎在自问自答」的程度（见 §0.4） |
| `eb9f112` | **离线问题基准**：8 个合成场景 + 从 state 重建 api，把「改动是否减少了自问自答」变成可测的数（见 §0.5） |
| `1b455dd` | 场景保真度：建造菜单按阵营过滤，否则基准在给不可能出现的题目打分 |
| `ef49e87` | **引擎自决（第一批）**：钱闲着的建造不再问模型，引擎直接决定并记 `engine_decided`；`RICH_SPEND` 由绝对 5000 改为相对阈值 |
| `6745534` | 为引擎自决补边界测试（只在该选项是组内唯一真实选择时才抬走） |
| `3870780` | 记录开局计划为何暂不能引擎自决（见下） |
| `4da47cb` | **引擎自决（第二批）**：防御底线由引擎直接落，不再问模型 |
| `b94d263` | **引擎自决（第三批）**：开局建造不再问模型；为此重建了 `player-lifecycle` fixture |
| `d9004b0` | **引擎自决（第四批）**：前沿侦察不再问模型（无敌军时引擎选前沿直接派侦察） |
| `201bd5b` | 测量：目标路径的时机契约不能照搬引擎自决（已撤回并写明理由）；基准补 `objective_ready` 场景与 `memory.objective` 接线 |
| `979715e` | **接管契约统一（提议 C）**：`engineOwned` 与 `auto: N` 合并为 `collectTakeovers` 一处判定、按选项计数 |
| `670e841` | **反制评分修正**：先判能否交战再求和；`Verses` 按整行判断编码形式 |
| `dd89c17` | **反制接入选择**：`counterValue` 替换选项排序里的 `effectiveness`（求和、不能交战记 0） |
| `a1b752b` | 反制覆盖步兵与防御组；修正威胁评估里 `effectiveness` 规则/目标颠倒 |
| `342ef97` | 反制简报与引擎选择共用同一评分（`counterScore` 委托 `counterValue`） |
| `10a3604` | 为 `effectiveness` 的语义加测试（参数顺序、平均与求和、拒绝与稀释） |
| `d1b174b` | **修复 `Verses` 读取错误（F2）**：两种形状都读；溅射上移到 `counterValue`（F4） |

**核实后判定不可达、因此不改**：S5（矿车目标两套默认值）、S14（矿车选项被同轮清理删掉）——
两条的详细推翻过程写在各节里，留着是为了避免下一个人按「高严重度缺陷」去改。

---

## 0.4 实测：引擎在自问自答（`tools/audit-report.mjs`）

本轮写了个离线审计工具，把战报里每个「组-问题」按**留给模型的判断空间**分类：

| 类别 | 含义 |
|---|---|
| `forced` | 除 `wait` 外**只有一个真实选项**——答案在提问之前已由引擎的前置条件确定，模型只能同意或拒绝 |
| `narrow` | 2–3 个真实选项 |
| `open` | 4 个以上 |
| `empty` | 只有 `wait`（这种组本不该发出） |

三份真实战报（Laya / choices 模式，全部战败）实测：

| 战报 | 组-问题 | `forced` 占比 | **拒绝唯一选项** |
|---|---|---|---|
| `005106` | 129 | 95（**74%**） | 49（**52%**） |
| `012710` | 232 | 155（**67%**） | 95（**61%**） |
| `020745` | 199 | 116（**58%**） | 54（**47%**） |

**分组差异比总数更有信息量**（三局一致）：

| 组 | 拒绝唯一选项 / 唯一选项题 |
|---|---|
| `vehicles` | 24/26、33/34、32/33 = **92–97%** |
| `defenses` | 11/11、16/16 = **100%** |
| `construction` | 4/7、14/16、8/14 = 53–88% |
| `salvage` | 3/3 = **100%** |
| `tactics` | 0/23、3/30、2/31 = **0–10%** |
| `deployment` | 3/17、17/35、5/26 = 17–48% |

**同一个模型、同一种题型，`vehicles` 拒绝 92–97% 而 `tactics` 只拒绝 0–10%。**
差别来自题目本身而不是模型——这正是「把确定性问题移出提问层」这一主张的直接证据，
也说明**按组做改造**（而非笼统调参）才是对的落点。

顺带说明：这个工具自己也先被它抓出一个 bug（per-group 的拒绝数忘记累加），
所以 §5.7「先做测量工具」这条建议，在本轮被自己的实践又验证了一次。

---

## 0.5 离线问题基准（`tools/bench-questions.mjs`）

审计工具能说历史上问了多少废问题，说不了换策略之后会问什么。**战报无法提供局面**：
它存的 `state` 是 `logbook.mjs` 的 `stateSummary`，只有数字——`army` 是数量不是单位列表，
`visibleEnemies` 没有构成。照它重放会造出一个没有部队、没有敌人的基地，然后给出自信的错误结论，
正是这个仓库反复踩的坑（真实局面只能靠本地服务 `--dump-states` 现采，本 checkout 没有）。

所以局面改为**生成**：`src/synthetic-state.mjs` 给 8 个确定性场景（开局、经济、中期装甲、
射程压制、空中威胁、步兵潮、钱闲着、后期攻坚），`src/replay-state.mjs` 把 state 重建为
引擎可查询的 api。两者都写明了忠实与近似的边界——**只衡量题目形状，不衡量打法**。

跑一次 `node tools/bench-questions.mjs`（加 `--verbose` 看逐场景选项，`--json` 机器可读）：

| 指标 | 基线 | 引擎自决落地后 |
|---|---|---|
| 需要决策的组-问题 | 31 | 31 |
| **引擎自己决定（不再提问）** | 0 | **5（16%）** |
| 交给模型的 | 31 | 26 |
| 其中只有一个真实选项 | 11（**35%**） | 6（**23%**） |

集中度与真实战报一致：`vehicles`、`construction` 是唯一选项的重灾区，而
`infantry`/`defenses`/`scouting` 基本不是。

**基准本身也抓出过我的错**：第一版场景把盟苏单位混在一个菜单里（联军玩家能看到 V3、天启），
测出来的「唯一选项」是伪影；加了 `side` 过滤（等价于规则的 `Owner=`）后数字才可信。

---

## 0.6 引擎自决：把「不是问题的问题」从模型手里拿走

机制：生产者给选项打 `engineOwned`，`requestGroupsFrom` 把标记带进请求形状，
`splitEngineOwned` 在发请求前把它抬出来、由引擎执行并记 `reason: engine_decided`。
**刻意按选项 opt-in**，而不是按「这组只有一个选项」推断——买得起不等于已决定要买，
只有生产者知道哪个候选是它自己前置条件的答案。

已改的一处是**钱闲着**，理由最硬：余额相对充裕（≥ 组内最便宜作战单位成本 ×2 且不低于 1500）、
兵力低于上限、队列空闲、单位买得起——决策的每个前提都已在同一段代码里成立。它原来是 `auto: 2`，
即「问一次、被拒、再问、再被拒、然后照样建造」。同时把 `RICH_SPEND` 从绝对 5000 改为相对阈值：
`005106` 那局 26 个 vehicles 问题有 18 个的余额低于 5000，绝对线只在开局那 10000 还没花完时被跨过，
靠赚来的钱永远回不去（那局结束剩 5741、兵力峰值 8、十七次拒绝一辆 750 的坦克）。

**边界与代价（不对称，所以有测试）**：抬错了会静默夺走模型的真实选择，抬少了只是浪费一轮。
`test/player-engine-owned.test.mjs` 六组用例钉住这条边界，把实现改成「有替代也抬走」可复现红。

**已改的四处**（按落地顺序）：

| 位置 | 前提在哪成立 | 原来的做法 |
|---|---|---|
| 钱闲着的建造 | 余额 ≥ 组内最便宜作战单位成本 ×2 且 ≥1500、兵力低于上限、队列空闲 | `auto: 2`：问两次、被拒两次、照样建 |
| 防御底线 | 兵营在、防御数低于 `MIN_BASE_DEFENSES`、队列空闲、塔买得起 | `auto: 2`，真实战报 11/11 与 16/16 全被拒 |
| 开局建造 | 该步前置成立、施工队列空闲、首付够 | `auto: 1`（此前已直管） |
| 前沿侦察 | 无敌军可见、无敌基地已知 | 提供两个等价前沿 + `auto: 3`，真实战报 13/15 答 wait |

**这四处把基准从「唯一选项 35%」压到 21%，引擎自决 27%**（`opening` 场景完全不再提问）。
侦察那一处还顺带修掉一个更隐蔽的问题：原来给模型的两个前沿**只差坐标**，
多选题模型无法据以排序——这类「伪选择」比「唯一选项」更浪费，因为它看起来像在提问。

**重建 `player-lifecycle` fixture 的经过**（记下来，因为它教训具体）：那个 fixture 的驱动世界
（无建筑、无部队、建造菜单只有一项）里，开局步骤是决策层**唯一能问出的问题**；让它引擎自决，
模型就没有任何可答的题，而三段测试恰好是驱动「迟到回答 / 过期快照 / 战斗结束后到达」的——
它们永远等不到请求，测试挂死（进程 CPU 近 0、零输出，那是顶层 `await` 永不 resolve）。
修法是给那三段各配一个**兵营 + 步兵菜单项**，于是它们有了与开局无关的真实问题，
测的也终于是它们本想测的东西。

过程中我自己犯了两个错，都值得记：**其一**，把 `available` 的返回值又包了一层
（该 fixture 已返回 `{name,type}` 对象），建造菜单被静默清空——现象是"引擎什么都不做"，
而不是报错；**其二**，block 3 原来的收敛条件 `accepted > 0` 被引擎自决动作**立刻**满足，
块在模型被问之前就结束——**这正是「断言恒真」的旧病复发**，我在同一个文件里修过一次同类问题，
这次是另一个变体。现在每段都分别证明「模型确实被问到」与「引擎那一步仍执行」。

**下一批**（按价值排序）：

1. **实跑验证**（需要人）：基准只能衡量题目形状，衡量不了打法质量。要看的是
   `meta.build` 是否为新指纹、有没有 `reason: engine_decided` 的 action 条目、
   以及 `vehicles`/`defenses`/`scouting` 的拒绝率是否下降（对照 §0.4 的 92–97% / 100% / 87%）。

---

## 0.8 接管契约统一（提议 C）

引擎有两种方式把选项从模型手里拿走，本质是**一个机制的两个触发**：

- `engineOwned`：生产者已确立全部前提，没有可问的；
- `auto: N`：本身可问，但被模型连续拒绝 N 次后回落给引擎。

此前是**两次独立扫描**：归属在发请求前由 `splitEngineOwned` 决定，`auto` 兜底在收到回答后
另扫一遍所有组、取「带标记里 N 最小的那个」。于是**声明的阈值与实际使用的阈值落在两条代码路径上**
（§3.2 记的歧义），而且两个同为 `auto: 2` 的选项谁先谁后取决于键的枚举顺序。

现在 `collectTakeovers` 一处判定两条触发，**按选项记账**、按 `(阈值, 键名)` 稳定排序；
`askableGroups` 只负责「还剩什么可以问」，与抬走规则共用一处实现；执行与记账合并成一个
`runTakeovers`，归属动作与兜底动作走同一段日志与预算逻辑。**基准不变**（38 个组-问题、
引擎自决 24%），符合纯重构的预期。

过程中修掉一个自己引入的真实缺陷：标记最初取自 `splitEngineOwned` 的结果，
而它只包含**幸存的**组——被整组丢弃的组其标记信息丢失，直接导致侦察接管失效。
改为从完整批次 `engineOwnedMarks(groups)` 求标记。另一个必须显式处理的边界：
**引擎归属但组内还有真实替代的选项不会进 `asked`**（不在模型的副本里），
若不单独为它准备计数就永远不会回落；现在为每个归属选项也准备计数、
无可声明阈值时按「首次拒绝即回落」，与它原来 `auto: 1` 的语义一致。

`test/player-takeover.test.mjs` 九例钉住这些边界，其中最容易被写错的两条是
「同组两个标记各计其数」与「已在运行的同一任务不重发且清计数」（后者是 §S8 的失败模式）。

---

## 0.9 自适应反制：核心主张此前并不成立

反制模块（`werhd-jev-counter.mjs`）的**核心主张**是「推荐单位随敌方构成改变」。它有测试，
但测试只验了一条固定构成里的相对大小，**没有任何一条验证「构成变了推荐就变」**——
而那正是这个模块存在的理由。

量化探针（三种敌方构成 × 同一组可生产选项）给出的是反例：

| 敌方构成 | 修正前推荐 | 修正后推荐 |
|---|---|---|
| 4 辆 Rhino（重型装甲） | MTNK 16 / E1 9 | **MTNK 65** / E1 11 |
| 2 架 Kirov（空中） | **E1 9（错）**，唯一正确的 NASAM 缺席 | **只有 NASAM 18** |
| 6 名 Conscript（步兵） | **MTNK 16 高于 E1 9（反了）** | **E1 68** / MTNK 24 |

两个独立的成因：

1. **`effectiveness` 的结构**：它对每个目标取「所有武器里的最大值」再按目标数平均。
   反装甲单位靠对装甲的高分拉高均值，于是「对付步兵」也被它赢下；更糟的是它**对空目标也用地面
   武器打分**，Grizzly 因此被推荐去对付 Kirov。修正为 `counterScore`：对每个可见目标先问
   **能否交战**（对空必须有 `aa`；`Verses` 里的 0/1/2 是 flag 而不是小比例），能交战才累加伤害。
2. **`Verses` 的编码形式被逐条猜**：原代码按「单个数值是否大于 1」判断，把**满伤害的百分比
   `100` 当成 1%**（真实的满伤害是 `1.0`）。而 API 类型只声明 `versus` 是
   `Record<number, number>`、**没有标度**，规则文件一律写百分比、测试夹具历来写比例，两种都合法。
   逐条判断无解——比例的满伤害 `1` 与百分比的 `1%` 是同一个数——所以改为**按整行判断**：
   行内出现 `>2` 的值即为百分比行。残留歧义（整行都是 1）在测试里显式记录并说明取舍。

**教训**：一个模块有测试，不等于它的**核心主张**被测试。这里的测试验证的是「分数在一条固定构成里
排序正确」，而模块的卖点是「排序随构成改变」——两者不是一回事。探针先行、把主张直接量化，
才让这个反例显形。

---

## 0.10 反制结论接入兵种选择

§0.9 修好的是**给模型看的建议文本**，但引擎**提供哪些选项**由 `strategy.mjs` 的 `effectiveness`
决定。它对目标集**取平均**：问的是「平均而言多好」，不是「眼前这股敌人我能打掉多少」。
两个后果——对抗混编部队时每个地面单位都被它打不到的空中目标拉低分数；更要紧的是
**坦克波与动员兵波排出来的顺序一样**，而这正是「选反制」要避免的。

新增 `counterValue`（对可见敌军**求和**、不能交战的目标记 0、`Verses` 为百分比形式时 0/1/2 视为拒绝），
接入 `counterPlan` 与 `forcePlan` 两处选择。`canEngageTarget` 与 counter 模块的 `canEngage`
语义一致，用一致性测试锁住防止发散。

**被一条既有测试拦下，并暴露真实缺口**：没有可见敌军时 `counterValue` 恒为 0，
于是所有选项被淘汰、`mobilize` 计划冻结——正是测试里记录的
「六辆载具长期卡在进攻门槛之下」（`player-strategy.test.mjs:320`，Battle 30）。
改为无敌军时退化为通用评分（等价于原平均值），并加断言固定这个回退。

**诚实记录当前覆盖范围**：反制分数现在确实进入选择路径，但工具探针显示，
在无压力局面下 `counterPlan`/`forcePlan` 的门（`underPressure`、空闲载具队列）并未打开，
所以**那类局面下提供的菜单仍不受影响**。要观察真实效果需要压力局面，或依赖实战战报。

---

## 0.11 反制覆盖其余两组，以及威胁评估里的参数颠倒

**防御组**：塔的选项评分改用 `counterValue`（对在程攻击者求和、不能交战的记 0），
于是「对空袭」与「对坦克推进」的答案不再由同一个平均分决定。

**步兵组**：这一组按**角色**筛选而非排序，所以改为在选项文本里给出
「对当前可见敌军的实效」——那是它此前唯一缺失的信息。这里修的是一个具体的错误信息：
角色的反步兵/反装甲分是**抽象**的（对样本装甲测得）且**从不为零**，于是步枪兵带着不错的
反步兵分被送进空袭——它根本打不到。现在敌军全是空中时，每个不能对空的选项都显示
`0` 并注明「cannot engage them」，火箭兵显示真实数值。
**同一选项文本在两种局面下不同**，这正是「随构成自适应」最直接的观测点。

**顺带发现同类真实 bug**：`assessStrategy` 计算双方战力的两行把 `effectiveness` 的
**规则与目标写反了**——`effectiveness(catalog[threat.name], threats, …)`，即
「威胁的规则」对「威胁列表」评分。于是 `ownPower` 与 `enemyPower` **都是用敌方武器算出来的**，
而它们的比较正是 `suppressed` 的判据。修正为各自用己方规则对对方单位评分。

这与 §0.10 的 `effectiveness` 结构问题同源：**这个函数的参数是 (规则, 目标集)，而它被到处
以「像是一个通用的强弱比较」的方式调用**。两次修正都指向同一结论——该函数的语义需要在使用处
被明确检验，而不是假定它回答了调用者想问的问题。

---

## 0.12 主动审计 `effectiveness` 的全部调用点

同类 bug 已出现两次，其中一次（§0.11 的战力比较）**让 `suppressed` 的判据变成两个都由敌方武器
算出的数**。既然它两次显形，就不该等第三次，于是把 `src/player/` 里全部 `effectiveness` /
`weaponEffectiveness` 调用点逐个核对「参数 1 是否为行动方的规则、参数 2 是否为目标单位列表、
以及该处想问的到底是哪一个问题」。

**结论：除已修的两处外，其余调用点的参数顺序都正确。** 需要单独说明的两类：

- `strategy.mjs` 的两处（防御塔排序、`counterPlan`/`forcePlan` 的兵种选择）此前用的是
  「对目标集取平均」的语义，而它们问的是「眼前这股敌人我能打掉多少」——已改为 `counterValue`。
- `player.mjs` 的多处「本方单位能否伤害某目标」的判断，用 `effectiveness(...) > 0` 作谓词。
  这对**混合**目标列表是偏保守的（平均值 > 0 需要至少一个目标可交战的权重足够大），
  但方向正确、不会误判为「能打」，因此保留；若日后要精确化，应同样改用 `counterValue`。

同时把反制模块的 `counterScore` 改为**委托** `counterValue`：两者本是同一判断的两份实现，
而且**已经发散**（反制侧的 `dps` 不含距离系数，引擎侧含）。一份与引擎选择相矛盾的简报
比没有简报更糟。委托后一处测试变红，因为它锁的是旧公式的数值；数值变化的原因是**射速**
（MTNK 每 4 帧一发对 E1 每 20 帧一发），不是回归——该断言已改为锁「简报与引擎一致」这一
真正要保证的性质。

**新增 `test/player-effectiveness-semantics.test.mjs`**，把调用者依赖的性质直接钉住：
参数顺序（用有护甲针对性的武器验证，避免夹具的装甲解析把断言变成对它自身的验证）、
平均与求和（`effectiveness` 与兵力规模无关、`counterValue` 随规模放大）、
以及「不能交战的目标」对前者只是稀释、对后者是拒绝——后者正是地面武器对空时
「平均值仍给出健康数字」的原因。

---

## 0.13 独立审计：一次严重的读取错误（F2），以及审计本身的价值

§0.12 的审计是我自己做的。本轮另派了一个独立子代理，对同一批调用点做穷尽核对——
它带回了**我自己没发现的严重缺陷**，证明这一步值得做。

### F2（严重）：`Verses` 的读取对真实规则完全失效

`canEngageTarget` 与 `versesArePercent` 写成 `const row = w.versus ?? w.verses` 并**要求
`Array.isArray(row)`**。但：

- API 类型声明 `versus: Record<number, number>`——**对象**（`werhd-player-api.d.ts:260`）；
- 目录里 `verses` 才是数组（`catalog.mjs:13` 的 `Object.assign([], w.versus)`），而 `versus`
  经展开仍然留在对象上。

于是真实规则下读到的永远是那个**对象**，`Array.isArray` 为假，被当作「没有表格」——
**`canEngageTarget` 对所有通过 aa/ag 闸门的目标都返回 `true`，`versesArePercent` 恒为假。**
前几轮辛苦建立的「不能交战的记 0」在实战里几乎完全失效。

`weaponEffectiveness` 一直是对的（它优先 `verses`），所以这是我**自己新代码引入的读取错误**——
而**夹具无法发现它**：测试只传数组或只传 `verses`，于是永远走那条能工作的分支。

修法：抽出 `versesRow`/`verseAt` 一处共享读取，两种形状都支持、都按索引取值；
`canEngageTarget` 同时接受 `armor` **是索引**的情形（真实状态摘要带数字索引，
经词表解析会 miss 并再次被读成「无表格」而放行）。新增测试用**生产的真实形状**验证。

### F4：溅射项在它唯一的目标路径上是空操作

我把溅射乘在 `weaponEffectiveness` 里，而 `counterValue`/`effectiveness` 都是**逐个目标**
调用它（单元素列表），于是 `splashReach` 恒为 1——功能静默失效。
改为把溅射上移到 `counterValue`（那里握着完整目标列表），`weaponEffectiveness` 恢复为纯粹的单目标分。

### 审计给出的其余发现（未修，按价值排序）

- **F1（高，影响瞄准决策）**：`player.mjs` 有六处用 `effectiveness(rule, [target]) > 0` 作
  「能否打它」的谓词。参数顺序正确，但 `effectiveness` 会**同时扫两个武器**、忽略姿态，
  而 `activeWeapons` 对可部署单位只给一个槽位。实证：`[GGI]` 移动时 `Primary=GuardianPara`（无对空）、
  部署后 `Secondary=GuardianMissile`（有对空），于是移动中的 Guardian GI 会被判定为能打飞机。
  仓里 `mobileAntiAirCount` 与 `hurts`/`canFireAt` 已经用 `activeWeapons` 做对了这件事。
- **F3**：`special.mjs:184` 是最后一处仍用 `effectiveness` 排名的选项排序（IFV 载谁）。
- **F5**：`strategy.mjs:568` 打印的「estimated effectiveness」用全图敌人，而该处选择用
  `counterValue`——正是我自己写下的「与选择矛盾的简报比没有简报更糟」。
- **F6**：`counter.mjs` 遗留未使用的 `effectiveness` 导入；两处 `versesArePercent` 副本。

**结论**：独立审计抓到了作者（我）看不见的错误，因为它不受「我刚写的代码应该是对的」这一预设影响。
这类「静默返回合理数字」的缺陷，正是最需要外部核对的。

---

## 0.7 目标的时机契约不能照搬引擎自决（一次被测试拦下的改动）

四批引擎自决之后，接着去量剩下的 `auto: N`：真实战报里实际触发的只有五种
（`auto_explore` / `auto_construction` / `auto_vehicles` / `auto_defenses` / `auto_infantry`），
其中前四种已经改成引擎自决。于是尝试把目标路径（`objective_*` 与「掩护占领」）也改掉——
它的前提同样在打标处成立（`ready || ids.length >= CAPTURE_PUSH_UNITS`），看起来与钱闲着同级。

**全量测试立刻红了四条**，全部锁的是目标的**时机契约**：

- 「两次 wait 后才执行」
- 「只有就绪的部队才自动」
- 「掩护推进在六个单位时就出发，不等满编」

这些不是旧机制的产物，而是刻意的设计。而且它与前四批有**本质区别**：
那四处是**一次性采购**（建一座塔、造一辆坦克），目标则是**给整支部队重发任务**——
每轮都触发就有可能在任务运行期间反复重派、把部队从交火中拉走，
这个仓库已经吃过一次亏（§S8：每轮重发任务让 92 个单位在三分钟内被磨掉）。

**结论：撤回。** 理由写在两处源码注释里，避免下一个人照着「前提已成立」的模板再改一次。
教训记下来：**「前提已在代码里成立」是引擎自决的必要条件，不是充分条件**——
还要问「这个动作是不是一次性、重发有没有代价」。前四批都满足第二条，目标不满足。

同时把测量能力补上：新增 `objective_ready` 场景与 `PENTAGON` 目标建筑，
并让基准把场景的 `objective` 传进 `memory.objective`——目标的决策路径读的是那里，
基准之前根本没接线，这些路径等于**从未被测过**（这本身就是个应当先修的工具缺陷）。

---

## 0.2 自适应反制的设计（`src/player/werhd-jev-counter.mjs`）

**要解决的问题**：决策层只能看到敌人的**数量**（`visibleEnemyCount` / `nearbyEnemyCount` /
`airThreatCount`）。`collectState` 其实早已采集 `visibleEnemies`（id、名称、坐标、血量），
但没有任何决策读它的构成——**8 个动员兵和 4 辆犀牛在题面上长得一样**，
所以「造有效克制」只能停在抽象层面。日志同样只记 `visibleEnemies: number`，
事后无法解释某次决策为什么这么选。

**做法**（不硬编码任何克制表，全部来自运行时 `api.rules()`）：

1. **兵种归类**：`building / defense / infantry / vehicle / air / harvester / engineer / naval`
2. **威胁值**：按目标护甲取该武器弹头的 `Verses` 系数后折算 DPS——同一门炮打步兵和打重甲能差十倍，
   不乘系数会排错威胁序
3. **护甲字**（`heavy` / `light` / `none`…）：这是每张 `Verses` 表的**索引**，没有它武器表无法映射到目标
4. **意图句**：由数字得出，例如「1 架敌机可见：地面武器答不了它」
   「敌方射程 5.75、我方 5：我们被压制」
5. **最佳应对**：借 `effectiveness`（内部就是 `Verses` 表）给**当期可造**的选项打分排序
6. 简报追加到 `vehicles / infantry / defenses` 三组题面（答案就在这三组产生）；
   无敌军时不编造

**顺带补上的可见性**：`unitSummary` 增加 `type / armor / owner / garrisoned`。
这几个字段此前**都已可得却从未进入 state**；其中 `armor` 是护甲字，`type` 让列表能按兵种拆开，
而不是只被计数。`state.enemyProfile` 随每次提问发出，并进日志（含各组数量、护甲、威胁值、克制清单）。

**必须知道的规则来源陷阱**：

- `docs/rules-规则文件.ini` 是**早期红色警戒 2** 规则，**不是尤里复仇**——没有尤里阵营、没有 YR 单位；
  `ra2-unit-catalog.md` 里的 `GATTTANK` / `MASTERMIND` / `ROBOTANK` 是**显示名，不是内部 ID**。
- **任何 RA2 规则文件里都没有 `[ArmorTypes]` 段**；11 项护甲顺序（`None,Flak,Plate,Light,Medium,Heavy,Wood,Steel,Concrete,Special_1,Special_2`）
  只在武器系统词典里有权威记载。
- 两个护甲值在 YR 里变过：**基洛夫 `light` → `medium`、防空步兵 `flak` → `none`**。

所以护甲与克制**只能读运行时 `api.rules()`**；照 `docs/` 抄表至少会错这两个。

### 0.3 `docs/rules-规则文件.ini` 与游戏实际规则的关系（已实测）

游戏真正使用的是覆盖层 `C:\ra2web.github.io\res\overlay\rules.ini`（392 KB / 21958 行，
目录里另有 `ra2.csf` 字符串表与 `art.ini`）。把入库的 `docs/rules-规则文件.ini`
（568 KB / 25124 行）与它逐节比对：

| 项 | 结果 |
|---|---|
| 节数 | live 1258 / doc 1245，**共有 1244** |
| 共有节中完全一致 | **1169** |
| 关键单位数值 | `MTNK heavy/105mm`、`FV light/HoverMissile`、`HTNK heavy/120mm`、`DESO plate/RadBeamWeapon`、`ZEP light/BlimpBomb`、`FLAKT flak/FlakGuyGun` —— **两边完全相同** |
| 只在 live 的节 | 14 个：`GGI`、`J5(J5MISSILE)`、`GUARDIANPARA`、`J10`、`SEAWOLFMP5`、`MIRAGEWH` … |
| 只在 doc 的节 | 1 个：`AIRTOGROUNDMISSILE1` |

**结论**：入库的那份是覆盖层的**带中文注释版本，不是另一套规则**——两者是同一规则集，
live 更新一点（多 14 个尤里复仇后期单位）。所以：

- 该文件适合当**注释版参考**（注释解释了每项含义），这是它比覆盖层更适合入库的原因。
- 但它**不是权威**：真正的权威是覆盖层，且两者会各自演进。**一切数值仍读运行时 `api.rules()`。**
- 游戏跑的是**基础红警 2** 规则（`Name=Red Alert 2 -- Official Rules of Engagement`，
  `[Countries]` 无 `YuriCountry`），`rules.ini` 里 `TANY`/`BEAG`/`GAAIRC` 才是真 ID，
  **没有 `TANYA`/`BEAGLE`/`GAHPAD`**。
- `ra2-unit-catalog.md` 那 51 个对不上的 ID，多数（含整套尤里单位与建筑）
  **在这个客户端里根本不存在**——不是文档写错，是客户端不提供。它描述的是完整的红警 2 单位表。

---

## 1. 先澄清三条线的关系（这决定哪些结论能用）

```
ra2web/jev-helper   a0412dc2  ← 「在线项目地址」
   └─ +13 commits →  7f6d63a  ← C:\laya\jev-helper   main          ← 本文基准
        └─ +18 commits →  641bb4f  ← C:\jev-merge    wip/reserved-counter-auto
```

全部经 git 验证：

| | `C:\laya\jev-helper` | `C:\jev-merge` |
|---|---|---|
| HEAD | `7f6d63a`（main） | `641bb4f`（wip） |
| 关系 | 是对方的**祖先**（对方独有 18 提交，本方独有 0） | 包含 laya 全部提交 |
| player.mjs | 2336 行 / 148,631 B | 更大（工作树仍在变） |
| strategy.mjs | 45,096 B | 65,960 B |
| 测试文件 | 25 个（其中 6 个不是 `node:test`） | 31 个 |
| `node_modules` / `dist` | **都没有**（需要 `npm ci` + `npm run build` 才能跑全量测试） | 有 |
| slim 状态压缩 / `--slim-state` | **不存在**（`git grep -i slim` 零命中） | 存在 |
| `tools/laya-*` 工具族 | 不存在（只有 `laya-server.py`/`.sh`） | 存在（8 个工具） |
| 离线部署件 | 不存在（无 `dist/`、无部署脚本） | 存在 |
| 相对兜底 `moneyIdle` / `RICH_SPEND` 相对化 | **不存在**（仍是绝对 5000） | 已于 `f3dc4bf` 落地 |
| `vsAir * 2.2` 防空加权 | **不存在**（只有 `(air ? 2 : 1)`） | 存在 |
| `wantsConstruction` 白名单 | **不存在** | 存在 |
| `localModel` 默认值 | `'laya'`（英文 checkpoint，中文战场会崩） | `'laya-multilingual'` |

**必须作废的结论**（上一版评审基于 wip 分支，对 laya 不成立）：

- ❌「46% 的提问在问引擎已知答案」这个**量化**来自 wip 分支的战报，laya 没有对应证据。
- ❌「同组取最小 `auto` → `auto:1` 每轮开火」**不成立于 laya**：那个坑来自 wip 新增的
  `construction` 开局 `auto:1`。laya 的开局建造仍然是交给模型选的（`player.mjs:498-546`），
  laya 只有矿车是 `auto:1`。**但 `autos[0]`（取最小 N）这个机制本身在 laya 同样存在**
  （`player.mjs:2232`），只是「平局按插入顺序」——见 §3.2。
- ❌ 三套 token 预算（797/1024/6495）、`.preview/states-*` A/B、`laya-state-report.py`
  全部是 wip 的产物；laya 里连 `slim` 这个词都不存在。
- ❌ `docs/jev-player-flow.md`（未跟踪）描述的是 **wip 部署件**，不能当 laya 的证据。

**已经一致、可以直接沿用的结论**：

- ✅ 主循环结构（微循环 + 决策循环 + `api.onTick` 唤醒 + `status.busy`）
- ✅ 8 组裁剪与 `questionTicks` 优先级排序
- ✅ `auto:N` 兜底语义（按组计数、任何非 `wait` 回答清零）
- ✅ `missionGate` / `MISSION_LOCK_TICKS`、缺省常数、commander 路径
- ✅ 传输层：`LOCAL_TIMEOUT = 18000`、`STALE_TICKS = {openai:900, local:1200}`、
  `BODY_MAX_BYTES = 256000`（按 UTF-8 字节）——**这些本地改进 laya 也有**，
  只有 slim 链和 `moneyIdle` 是 wip 新增。

---

## 2. laya/main 基线（实测）

### 2.1 构建与测试

`package.json` 的 `test` 是 `npm run package && node --test --test-concurrency=1 "test/*.test.mjs"`，
即**测试会先重建 `dist/` 和 `artifacts/`**——所以「跑测试」不是只读操作。
本 checkout 既没有 `node_modules` 也没有 `dist/`，我借用另一份的 esbuild 0.27.7 完成构建后实测：

| 项 | 结果 |
|---|---|
| 测试文件 | 25 个（`commander-world.mjs` 是共享 fixture，非测试） |
| 断言项 | **187** |
| 通过 | **187（修复后连续 10 次全量全绿，修复前 10 次里红 1 次）** |
| 跳过 | 1 |
| 失败 | 无 |

**那条不稳定用例已定位并修复——它是测试缺陷，不是引擎缺陷**（初判为「引擎重复执行」，实测推翻）：

- 现象：全量跑约 10% 概率红，形态固定为 `player-lifecycle.test.mjs:378` 期望 `[["produce","TANK"]]`
  实得两条或零条。
- 真因：该文件是**顶层断言脚本**（不 import `node:test`），`calls` 这个共享数组全程只在
  `:350` 被清空过一次。四个块都对 `calls` 做**全量**断言，而每个块之前的块可能在其后
  才把自己的指令写进去（收敛条件是 15 ms 轮询 + 在途请求）。于是：
  - 有一条残留时，四条断言**全部**被这一条满足 → **断言是空的**；
  - 残留来得晚或来得早，就变成 0 条或 2 条 → 红。
- 实测证据：埋点显示 `ended` 块**恒产出 0 条**（`decisions=1`、`accepted=0`），
  `ages` 块产出 1–2 条；用复刻脚本连跑 5 次，`ended` 块的调用序列固定为
  `… → DECIDE → tick(ended=true)`——答案在结算同拍就已作废，**引擎行为是对的**。
- 修法：改成**增量断言**（每块只看自己新增的条目），并把三条与自身语义相反的期望值改正
  （「late responses must not issue commands」原本期望 1 条）。

**教训**：这条红不是「窗口很窄的真实缺陷」，而是**共享可变状态 + 异步轮询**让断言退化成恒真。
仓库自己写在 `player-opening-auto.test.mjs:110-111` 的那句话适用：
「一条因为未知原因变红的测试会训练读者忽略红色」——但它同样适用于**一条因为未知原因变绿的测试**。

### 2.2 这一版**没有**的东西（避免和 wip 混淆）

无 `slim` 状态压缩、无 `moneyIdle`、无相对 `RICH_SPEND`、无 `tools/laya-*` 工具族、
无离线部署件、**无构建指纹**（见 §4.9）。唯一的体积管理是
`openai.mjs:18-28` 的 `compactState`（48000 **字符**上限，仅对 OpenAI choices 生效）和
`shared.mjs:169` 的 256000 **字节**上限。

---

## 3. 现状：决策是怎么产生的

### 3.1 三层循环

```
微循环 micro()  每 150 ms（player.mjs:2045-2118）
  卡死检测 → 胜负判定 → maintainCommand（仅 commander）
  → maintainBattle → spreadInfantry → placeReadyBuilding → updateCamera
  每 60 tick 一次 observation
决策循环 decide()  每 600 ms；连续 5 轮全 wait 且无动作后放宽到 3 s（2317）
  collectState → candidateGroups（13 个组）→ 过滤只剩 wait 的组
  → 排序：construction/defenses/tactics/salvage 强制优先，其余按最久没问
  → 取前 8 组 → requestDecision({state, groups})
  → 过期则整包丢弃 → 逐组执行 → auto: 兜底扫描
commander 循环 command()  每 180 tick 或 urgent，仅 OpenAI 兼容来源
```

三个关键细节（都可证）：

1. **`status.busy` 只守一件事**：`runDue` 的唤醒路径（`player.mjs:2324`）。
   它不阻止 `decide`/`command` 被 `setTimeout` 链再次拉起，也不守 `micro`。
   并发保护实际来自「每个 loop 在 `finally` 里重排定时器」+ `clearTimeout`。
2. **`questionTicks` 在发请求之前就写入**（`player.mjs:2146-2147`），
   所以一次失败的请求也会把这些组标记成「刚问过」，影响下一轮的排序。
3. **无法区分的三种「没动作」**：`mission_continues`（2180-2204，不计 rejected、不调
   `rememberChoice`）、过期整包丢弃（2156-2166）、未知选项 key 落到 `{reason:"wait"}`
   （`executeCandidate` 1077-1078）。日志里这三者和「模型真的选了 wait」长得一样。

### 3.2 `auto:` 兜底的真实语义（逐字取自 `player.mjs:2226-2245`）

```js
memory.autoDeclines ??= {};
for (const [id, g] of Object.entries(groups)) {
  const answer = result.answers[id];
  const autos = Object.entries(g.actions)
    .filter(([k, a]) => k !== "wait" && a && Number.isFinite(a.auto))
    .sort((a, b) => a[1].auto - b[1].auto);
  if (!answer || !autos.length) { if (!autos.length) delete memory.autoDeclines[id]; continue; }
  const [choice, action] = autos[0];
  memory.autoDeclines[id] = answer.choice === "wait" ? (memory.autoDeclines[id] ?? 0) + 1 : 0;
  if (memory.autoDeclines[id] < action.auto) continue;
  ...
  memory.autoDeclines[id] = 0;   // ← 在执行之前就清零
```

- **每个组只有一个选项能开火**：`autos[0]` 是 `auto` 最小者；平局按 `Object.entries` 的
  插入顺序。具体后果：`engineering` 组里 `repair_*`（`auto:2`）插在 `capture_*`（`auto:1/2/3`）
  之前，所以「中立无守卫建筑占领」（本应 `auto:2`）在平局时会输给「修桥小屋」。
- **计数器在执行结果未知时就清零**（2241），任何非 wait 回答也清零（2235）——
  所以一个一直被 `executeCandidate` 拒绝的兜底动作，每次都从 0 重新计数。
- **兜底能把自己从菜单里删掉**：`rememberChoice(..., true)`（2243）把机械开火记进
  `memory.recent`，于是同一选项累积 `streak`；`historyHints`（160-171）在
  `streak >= STALE_REMOVE (6)` 或 `level >= 2` 时 `delete g.actions[choice]`，
  而保护名单只有 `defend_base` 和 `objective_*`。**一个反复被引擎自动执行的动作，
  会因此从候选中消失**（这是本修订里最反直觉的一条）。

### 3.3 送给模型的 state

`collectState`（`player.mjs:27-112`）产出的字段顺序固定，`visibleEnemies`/`army` 各截 24 条；
随后 `candidateGroups` 往同一个对象上追加 `economy / airThreatCount / antiAirCount /
mobileAntiAirCount / mission / activeMission / infantryRoles / deployment / knownEnemyBuildings /
combatAssessment / forceReadiness / combat / objectiveTarget`，
`strategy.mjs` 追加 `strategy / objective / forceGoal / decisionReadiness`，
`special.mjs` 追加 `infrastructure`，`historyHints` 追加 `recentChoices`。

**这份 state 随每一次请求整体重发**，且其中若干字段是**无上界**的：
`deployment`（每个可部署单位一条，内嵌原始 `r.weapon`/`r.secondary` 规则对象）、
`knownEnemyBuildings`（整局累积）、`inventory`、`queues`。
laya 里没有任何「按问题裁剪」的逻辑，唯一的裁剪在 OpenAI 路径。

> 注意：`slim`、`--dump-states`、`laya-state-report.py` 都只在 wip 分支存在，
> 所以 laya 的 state 究竟占多少 token，**本仓没有测量工具**（这是 §5.7 要补的第一件工具）。

---

## 4. 可以在 laya 代码里逐条证明的问题

编号 S1–S13，全部给出文件与行号。严重度按「对局结果影响 × 修复成本」排序。

### S1（最严重）`defenses` 组被整体覆盖，special 层的候选永远进不了模型

- `special.mjs:314` 用 `group('defenses', …)` 建组，`:317-321` 往里加围墙/据点的 `produce` 选项；
- `strategy.mjs:266` 随后做的是**整体赋值**：`const dg = groups.defenses = { … }`（不是 `??=`）；
- 调用顺序 `player.mjs:1008`（specialGroups）→ `1009`（investmentGroups），所以
  special 写进去的 instructions、`wait` 文案、全部选项在发请求前被抹掉；
- 两层对预算的判断还不一致：`special.mjs:319` 要求 `afford(r, 1000)`，
  `strategy.mjs:297` 只要求 `Math.min(200, r.cost)`。

**为什么单测没抓到**：测 `specialGroups` 的用例直接调用该模块，测 `investmentGroups` 的用例
直接调用另一个，**没有一个用例走完整管线**。

### S2 `auto: 2` 的空军支援选项永远不可能开火

`special.mjs:333` 给 air support 打了 `auto: 2`，但 `strategy.mjs:312-313` 会删除所有
`factory ∉ ['InfantryType','UnitType','BuildingType']` 且非海军/精炼厂/电厂的 `produce` 动作。
`isAirSupport(r) = r.factory === 'AircraftType'`（`strategy.mjs:4`），
所以这个标记在发请求前一定被删掉；同一建筑在 `strategy.mjs:394` 又被**不带 `auto`** 地重新提供。
`special.mjs:327` 的注释还在说「the option is tagged auto so it is queued even if the model waits」——
注释描述的是代码做不到的事。

### S3 兜底计数器在结果已知前清零，且会被 `historyHints` 删掉自己

见 §3.2。两句话概括：`autoDeclines` 无法表达「连续 N 次尝试都失败」，
而反复被自动执行的动作会因为 `STALE_REMOVE` 从菜单消失。

### S4 写完从不读的字段，纯消耗请求预算

`state.combat`（`player.mjs:759-765`，重复了 `combatAssessment`/`forceReadiness` 的字段）、
`strategy.techChoices`（`strategy.mjs:408`）、`strategy.escortDeficit`（`:410`）、
`state.forceGoal`（`:454`）、`state.decisionReadiness`（`:457-487`）——
在 `src/` 里没有任何读者。同时 `state.antiAirCount` 被算了两遍且口径不同：
`collectState:90` 一次、`candidateGroups:487` 用**另一个 arm y 过滤条件**再算一次并覆盖前者。

### S5 矿车目标有 0 与 2/3 两套默认值（**核实后：真实对局不可达，降级为清理项**）

`state.economy.targetMiners` 在**没有精炼厂**时是 `0`（`player.mjs:197`），
而 `strategy.mjs` 里有 `?? 3`（21、317、333、477、480）和 `?? 2`（32、278、341、383、439、484）两套兜底。
表面推论是：`economyDeficit = max(0, 0 - harvesters - incoming) = 0`（`strategy.mjs:317`）、
`miner` 为 `undefined`（`:326`），基地会「既不买矿车也不出战斗单位」。

**实测核对后这条不成立**：`?? ` 只在 `targetMiners` 为 `undefined`/`null` 时生效，
而 `economyPlan`（`player.mjs:197-201`）的四个分支**都**给 `targetMiners` 赋了数值，
`state.economy` 是 `{refineries, miners, ...plan, ...}`（`:477-484`），`plan` 展开在后、必然覆盖。
所以真实对局里取到的一直是数值，两个默认值都走不到。
真正的行为是：无精炼厂 → 目标 0 → 不提供矿车（这正是设计意图），
而 `harvesters < Math.min(2, 0)` = `harvesters < 0` 恒假 → 门槛放行，不会互相锁死。

**结论**：这是**可读性/一致性问题，不是行为缺陷**；改动它属于纯重构且无法用测试证明收益，
因此本次不动，只在文档里留档，避免下一个人按「高严重度缺陷」去改。
如果将来 `economyPlan` 不再保证赋值，这才升级为真缺陷——届时应把两个默认值收敛为一个具名常量。

### S6 出击门槛自相矛盾，且「卡死就走」的口子会绕过防空检查

同一轮里，`strategy.mjs:471` 对模型说「完成 8 辆车的编队」（`ATTACK_FORCE_SIZE = 8`），
而 `operationalGoals:452` 把同一组的目标覆盖成
`min(24, max(12, ceil(nearbyEnemyCount × 1.5)) + 4 × escalation)`，`player.mjs:490` 把这个数字印出来。
**同一个组同一轮被告知两个目标（8 和 ≥12）。**
另外 `player.mjs:550` 要求「4 辆坦克之后保持 2 辆机动防空，即使还没看到敌机」，
但检测条件 `aaNeeded = airThreatCount > 0 && mobileAntiAirCount < 2`（`:287`）只在有敌机时成立——
「还没看到」这个从句无法执行。而 `stalled` 分支（`:303`）在放行进攻时
**同时跳过了出击门槛和防空条件**，与 `player.mjs:815`「包括 2 辆防空护航」的说法冲突。

### S7 出击就绪的迟滞根本没有生效（读到的永远是上一拍）

`player.mjs:297` 读 `memory.readinessLatch`，`:316` 立刻用当前值覆盖它，
所以 `holding`（`:298`）只看得到上一拍。注释（`:295-296`）描述的
「一旦就绪，跌到门槛 75% 以下才回到集结」是代码产不出的行为。
真正生效的 75% 判断是另一个变量 `committedAttack`（`:294`）。

### S8  mínimo 门槛死锁：`tooFew` 否掉 `ready`，而 `stalled` 也进不去

无可生产单位时门槛降到 1（`:265`），`ready = combatUnits > 0`（`:313`），
但 `tooFew = readiness.canBuildAnything && active.length < MIN_ATTACK_UNITS`（`:739`）
仍然把 `ready` 改回 false（`:741`）；而 `stalled` 逃生分支（`:303`）自己也要求
`combatUnits >= MIN_ATTACK_UNITS`。结果：**有生产能力、但只有 1–3 个残兵的基地，
既永远不 ready，也永远不算 stalled。**
（另一条同类死锁有实测记录：`README.md:194` —— 一局 Jev 从第 13 分钟到第 78 分钟一动不动，
只有 4 个动员兵，每轮都说「能调动的兵不足 4 个，先集结」，烧掉 1400 多万 token。）

### S9 升级机制既够不到也退不出

升级需要 `staleAttack`（`:227`），它要求 `targetAlive`（`:223`）＝目标此刻可见
**或**仍在 `memory.enemyBuildings` 里；而被记住的建筑一旦在可见空地上被观察到就会立刻删除
（`player.mjs:429-431`）。对一个躲在迷雾里的目标久攻不下，`staleAttack` 会真/假交替，
可能永远凑不齐 1800 tick 的间隔。降级需要 `tradingWell` 或再等 5400 tick（`:232`）。
于是劣势方一路升到 3 级、面对门槛 20，而唯一的逃生口（S6 的 `stalled` 分支）又会同时绕开防空要求。

### S10 没有构建指纹：两份 `0.7.5` 的战报无法区分

`background-core.mjs:108` 只写 `version: runtime.getManifest().version`，即 `0.7.5`——
没有 commit SHA、没有 dirty 标记、没有构建时间。
本仓自己也吃过这个亏：`player-opening-auto.test.mjs` 的注释记录了
`jev-report-20261009-214501`「先被判为旧代码、后纠正为新代码，误读两次」。
（wip 分支已在 `d083381` 用 esbuild `define` 注入 `BUILD_STAMP` 修掉，**laya 没有**。）

### S11 Jev/Laya 路径的校验是整包 all-or-nothing

`shared.mjs:197` 的 `validateAnswer` 对**每个**送出去的组都要求答案合法，
任何一组缺失或 choice 不在 criteria 里就 `throw`，整包作废、一个动作都不执行。
而 OpenAI 路径（`openai.mjs:99-103`）是按组降级成带 `fallback:true` 的 `wait`。
同一个战场状态、两种失败语义，日志里无法区分「模型弃权」和「某一组格式坏了」。

### S12 六个测试文件是「脚本」而不是 `node:test` 用例

`player-camera`、`player-lifecycle`、`player-range-defense`、`player-roles-traffic`、
`player-special`、`player-strategy` 不 import `node:test`，是顶层断言脚本，结尾 `console.log`。
它们**只能靠抛异常失败**，没有逐用例报告，也无法单独跳过/定位。
再叠加 §2.1 那条 10% 概率的红用例，测试套件的可信度被显著削弱。

### S13 死代码与文档漂移

`BASE_GARRISON_SPARE`（`special.mjs:3`）声明后从未使用；
`memory.lastReady`（`player.mjs:736`）写了不读；
`air_scout`（`special.mjs:353-354`）没有 `auto`，而它的兄弟 `naval_scout`（`:360-364`）
有 `auto: 3` 且注释写着「和地面探索同样的自动兜底」——不对称。
注释与代码不符：`player.mjs:598-599` 说门槛是「12 或 16」，实际是 `8×(1+0.5·level)` 封顶 20；
`player.mjs:2044-2045` 关于溅射武器的注释贴在 `micro` 上方，而溅射处理在 `:1253-1269` 的
`spreadInfantry` 里。此外**本仓的 `AGENTS.md` 描述的是另一个（部署件）修订**，
`docs/local-laya.md:284` 写请求超时 8 s，而代码是 `LOCAL_TIMEOUT = 18000`。

### S14 「ECONOMY FIRST」的矿车选项会被同一轮的清理循环删掉（**核实后：结构性不可达**）

表面上：`strategy.mjs:362` 把矿车选项加进 `vehicles` 组（队列 Vehicles），
随后 `:452` 在 `plan.purpose ∈ ['mobilize','counter_range','counter_pressure']` 时
**删除所有 `queue === plan.queue` 的 produce 动作**；而 `plan` 的优先级链里
`counterPlan` 排在 `economyPlan` 之前，于是「加了又删」。

**实测核对后这条不成立**：带这三个 purpose 的计划只有 `forcePlan`（`:405`）与
`counterPlan`（`:410`，或未受压时的 `:412`），它们都用 Vehicles 队列——但
`forcePlan` 所在的整块以 `strategy.underPressure` 为前提，而矿车选项本身的成立条件包含
`minerUrgent || !strategy.underPressure`（`player.mjs:356` 附近，`minerUrgent` = 零矿车）。
**受压时经济分支根本不提供矿车**，所以两条路径不会在同一轮相遇。
fixture 实测：敌人放在 40 格 → `underPressure=true`、`purpose=counter_range`、vehicles 只有 `produce_SIEGE`；
放到 56 格 → `underPressure=false`、无 plan、vehicles 有 `produce_MINER`。

**结论**：不可达。只保留一条注明「不可达、仅作守卫」的保护（矿车与精炼厂属基础设施，
不与作战投资争队列），不做出无法用测试证伪的行为改动。

### S15 部分「未使用字段」其实是**被覆盖的死文本**

除了 S4 列的写完不读，还有几条 instructions 被静默丢弃：
`strategy.mjs:310` 的 `group('construction', …)` 用 `??=`，但玩家侧 `:498` 已经建过这个组；
`special.mjs:98` 的 `deployment` 同理（`player.mjs:645` 已建）；
`special.mjs:291/333/336` 直接传空字符串；
`strategy.mjs:537` 的 `groups.salvage ??=` 永远不生效（`special.mjs:307` 总是先建），
且 `:538` 又会覆盖 instructions。
**结论：13 个组里有 4 个的 instructions 存在两个来源，其中一个必然浪费。**

### S16 基地自动防御有两套实现，且只在 commander 模式生效

`maintainCommand` 只在 `if (commander)` 下调用（`player.mjs:2083`），它的自动 `defend_base`
（`:1847-1855`，受 `AUTO_DEFENSE_TICKS`/`AUTO_LOCK_TICKS` 约束）因此只服务指挥官模式；
choices 模式的等效路径是微循环里的 `maintainBattle`（`:2087`）加上 tactics 组的 `auto:` 选项。
同一条规则两套实现、两套常数，其中一个模式永远走不到。

---

## 5. 重写方案

### 5.1 设计原则（四条，其余都是推论）

1. **可计算的事不问模型。** 若某选项的前提在提问前已被引擎证明，它就不该出现在选项表里：
   要么引擎直接执行，要么该组本轮不提问。判据是「提问前引擎能否证明答案唯一」，
   而不是「这个问题重不重要」。
2. **每次提问自带最小上下文切片。** 事实用短键、紧凑形式表达，问题自包含；
   不再把整份 state 随每个问题重发。
3. **接管必须显式、单调、可审计。** 引擎接管要写进决策记录（谁接管、为什么、依据哪个前提）；
   接管计数只在**成功执行**时清零；被接管多次的动作不允许被自动从菜单撤下。
4. **一切改动必须能被离线重放验证。** 没有 replay 指标，任何重写都是换一种方式猜。

### 5.2 提议 A（最高优先）：按「确定性」给选项分三档

给每个 action 增加 `decided` / `gated` / 判断题三种来源标记：

- `decided`：引擎已证明前提成立（队列空闲、余额足够、前置齐备）→ **不出现在 criteria 里**，
  由引擎执行并记 `reason: engine_decided`。laya 的开局建造四步、矿车补足、缺陷 S2 的空军支援
  都属于这一档。
- `gated`：引擎知道该做，但有一个需要判断的开关（先补兵还是先补塔）→ 作为**一个选项**出现，
  等待条件由引擎在题面里给出。
- 其余保持不变。

**收益**：能直接消灭 §3.2 里「同组多个 auto、只有最小 N 能开火」的歧义，
并让 `autoDeclines` 这种按组计数、会被自身触发的兜底彻底退场。

### 5.3 提议 B：按问题切片上下文（Question Slice）

把 `requestDecision({state, groups})` 改成 `requestDecision({common, questions})`：

- `common`：所有问题都要的少量标量（tick、credits、power、baseUnderAttack、forceReadiness 摘要）；
- 每个 question 自带 `facts`：该问题真正需要的数字与短列表
  （vehicles 组就是 `{miners, target, queue, cheapest:{MTNK:750}, credits, deficit}`）；
- 单位用短键（`MTNK 45,70 74%` 这类）。

**同时修 S4**：删掉写完从不读的字段（`state.combat`、`forceGoal`、`decisionReadiness`、
`techChoices`、`escortDeficit`），给 `deployment` / `knownEnemyBuildings` 加上界，
统一 `antiAirCount` 的口径（只保留一处计算）。
并把压缩逻辑收回 `src/`，给 state 一个 schema 版本号写进日志——S10 的可归因性顺带解决。

### 5.4 提议 C：统一接管契约（替掉 24 处 `auto:`）

- 删除 `auto:` 数值，改为每组声明 `takeover` 契约：`{afterDeclines, accept, why}`，
  **每个选项独立计数**（修 §3.2 的 `autos[0]` 歧义）；
- 计数器只在「该选项被**成功执行**」时清零（修 S3 前半）；
- `historyHints` 的撤下逻辑必须与接管互斥：**被引擎接管的选项不得被 `STALE_REMOVE` 删除**
  （修 S3 后半）；
- **消除重复构造**：`defenses` 组只允许一个 owner。建议 `investmentGroups` 改成
  往 special 建好的组里追加（`??=` / `add()`），而不是整体赋值（修 S1）；
- 阈值一律相对化：把 `RICH_SPEND = 5000` 改成「余额 ≥ 该组最便宜可造单位成本 × N」，
  并给矿车补足一个与支付力一致的判断（修 S5 的边界情况）。

### 5.5 提议 D：给决策加时间维度，并消掉自相矛盾的目标

- 引入 `memory.plan = {intent, target, committedAt, expiresAt, preconditions, abortIf}`，
  模型的选择变成「接受/修改/放弃当前计划」，而不是每轮从零选一个 mode。
  commander 的 `lastPlan`/`lastPlanReport` 已经是这个形状，把它下沉到 choices 即可。
- **统一兵力目标**（修 S6）：一个数字只有一个来源。建议以 `operationalGoals` 为准，
  `ATTACK_FORCE_SIZE` 只作为下限常量，指令文案从同一个值渲染。
- **修 S7/S8/S9**：`readinessLatch` 要真的持久（在 `ready` 判定之后写、在下一次读之前不覆盖）；
  无可生产单位时的门槛塌缩要与 `tooFew` 自洽；升级的判定不要依赖「目标当前可见」，
  改用「同一目标连续 N 拍无血量变化」。

### 5.6 提议 E：请求节奏与失败语义

- 只在「某组输入的哈希变化」或「距上次提问超过 T」时提问（紧急事件沿用现有 `urgent` 机制）；
- 把 S11 的 all-or-nothing 校验改成**按组降级**（与 OpenAI 路径一致），
  并在日志里区分「模型弃权」与「某组格式非法」；
- S4 里那三种「没动作」的原因要分开记录，否则所有等待率统计都掺了噪声。

### 5.7 提议 F：先做两个工具（这是重写的前置闸门）

1. **构建指纹**：把 wip 的 `BUILD_STAMP` 做法（esbuild `define` 注入 git 短 hash + `-dirty`）
   搬过来。没有它，重写前后各跑一局战报也分不清谁是谁（S10 已经让本仓误读过两次）。
2. **离线重放闸门** `tools/replay-decisions.mjs`：
   输入一组 state 快照 + 一个策略版本 + 一个假模型（always-wait / always-first / 录制回放），
   输出每组提问次数、wait 率、引擎接管次数与理由、被拒原因分布、每题 payload 大小，
   以及**与旧策略逐轮 diff（同一 state 下选项集合与最终动作的差异）**。

**验收指标建议**（以「同一批 state 跑旧/新策略」的 diff 为准，而不是看单局胜负）：

| 指标 | 目标 |
|---|---|
| 确定性问题占比（引擎可判定却被提问） | < 5% |
| 每题 payload 大小 | 相对当前基线下降 ≥60% |
| 同一决策的双实现（§4 的 S1/S4/S6） | 归零 |
| 写完从不读的字段 | 归零 |
| 全量测试 | 通过，且 §2.1 的不稳定用例被定位并修掉 |
| 首次战斗单位出厂时间 | 相对基线前移（作为效果指标，不是硬门槛） |

---

## 6. 分阶段落地顺序

| 阶段 | 内容 | 依赖 | 验收 |
|---|---|---|---|
| **0** | 构建指纹 + `tools/replay-decisions.mjs` + 稳定那条不稳定用例 | 无（需要 `npm ci`） | 能用固定语料跑出基线报告；全量测试 3 次连跑无红 |
| **1** | 提议 A（确定性三档）+ 修 S2/S3（接管计数与菜单保护） | 0 | 不再有「标记了却永远打不出」的 auto；确定性问题占比 <5% |
| **2** | 提议 B（Question Slice）+ 清理 S4 的死字段 + state schema 版本 | 1 | 每题 payload 下降 ≥60%；日志能回答「模型看到了什么」 |
| **3** | 提议 C（接管契约）+ 修 S1（单一 owner）+ 修 S5/S11 | 1 | 每个组只有一个构造者；校验按组降级 |
| **4** | 提议 D（计划对象）+ 修 S6/S7/S8/S9 | 3 | 同一决策只有一个数字来源；迟滞真的生效 |
| **5** | 提议 E（事件驱动提问）+ 修 S12/S13（测试与文档） | 2,4 | 请求次数下降 ≥40%；脚本式测试改为 `node:test` |

**每一步都必须先过阶段 0 的闸门**——这套代码的教训（`test/player-opening-auto.test.mjs:110-111`、
`background-core.mjs` 关于 214501 的注释）反复说明：没有可归因的证据，改动只会制造新的误读。

---

## 7. 缺陷清单（重写时的 checkpoint）

| 编号 | 缺陷 | 位置证据 | 严重度 |
|---|---|---|---|
| S1 | `defenses` 组被整体覆盖，special 层候选永远不可达 | `special.mjs:314,317-321` vs `strategy.mjs:266` | 高 |
| S2 | air support 的 `auto: 2` 永远被删除，注释与代码矛盾 | `special.mjs:333,327` vs `strategy.mjs:312-313` | 高 |
| S3 | 兜底计数在执行前/非 wait 时清零；`STALE_REMOVE` 能删掉被接管的选项 | `player.mjs:2235,2241,2243` + `160-171` | 高 |
| S4 | `state.combat`/`forceGoal`/`decisionReadiness`/`techChoices`/`escortDeficit` 写完不读；`antiAirCount` 双口径 | `player.mjs:759-765,487,90`；`strategy.mjs:408,410,454,457-487` | 中高 |
| S5 | 矿车目标两套默认值（`?? 2` / `?? 3`）——**核实为不可达，纯清理项** | `player.mjs:197`；`strategy.mjs:21,32,317,326` | 低（原判高） |
| S6 | 同一组同轮被告知 8 与 ≥12；防空「未看到敌机也保持」不可执行；`stalled` 绕过防空 | `strategy.mjs:471` vs `:452`；`player.mjs:550,287,303,815` | 高 |
| S7 | 就绪迟滞不生效（读到的是上一拍） | `player.mjs:297,298,316` | 中 |
| S8 | 1–3 残兵 + 有生产能力 = 永不 ready、也永不 stalled | `player.mjs:265,313,739,741,303` | 高 |
| S9 | 升级够不到也退不出（`targetAlive` 依赖当前可见） | `player.mjs:222,223,227,232` | 中 |
| S10 | 无构建指纹，两份 0.7.5 不可区分 | `background-core.mjs:108` | 中高 |
| S11 | Jev/Laya 校验 all-or-nothing（与 OpenAI 不对称） | `shared.mjs:197` vs `openai.mjs:99-103` | 中 |
| S12 | 6 个测试文件是脚本；另有 1 条约 10% 概率的红用例（**已定位并修复：测试缺陷，非引擎缺陷**） | `test/player-lifecycle.test.mjs:378` | 中 |
| S13 | 死代码（`BASE_GARRISON_SPARE`、`memory.lastReady`）、`air_scout` 无 auto、注释漂移 | `special.mjs:3,353`；`player.mjs:736,598,2044` | 低 |
| S14 | 「ECONOMY FIRST」矿车选项被同一轮清理循环删除 | `strategy.mjs:332-334` vs `:404,417-424` | 中高 |
| S15 | 4 个组的 instructions 有两个来源，其中一个被静默丢弃 | `strategy.mjs:310,537`；`special.mjs:98,291,333,336` | 低 |
| S16 | 基地自动防御两套实现，`maintainCommand` 只在 commander 生效 | `player.mjs:2083,1847-1855,2087` | 中 |

---

## 附录 A：与 wip 分支的差异对照（哪些已经修了）

| 问题 | laya/main | wip（`641bb4f`） | 建议 |
|---|---|---|---|
| 防空加权 | 只有 `(air ? 2 : 1)` | 有 `vsAir × 2.2` | 需要实测再决定，别照搬常数 |
| 钱闲兜底门槛 | 绝对 `RICH_SPEND = 5000` | 相对 `moneyIdle()`，下限 1500 | **把 wip 的做法移植回来** |
| 开局建造 | 交给模型选 | 前四步 `auto:1` 引擎直管 | 方向对，但 `auto:1` 引入了「每轮开火」的新坑，应按提议 A 重做 |
| 状态压缩 | 无 | `--slim-state` 服务端链 + 三套预算未对齐 | 移植思路，但按提议 B 收回 `src/` 并统一版本 |
| 构建指纹 | 无 | `BUILD_STAMP`（`d083381`） | **直接移植** |
| 死字段/双构造 | S1/S2/S4 都在 | 部分仍在（`defenses` 覆盖、`floorTagged` 每轮重置） | 不要指望合并 wip 能修掉，见提议 C |
| 离线工具 | 无 | `laya-ctl`/`laya-state-report`/`run-slim` 等 8 个 | 按需移植（重放工具必须自建，两边都没有） |

---

## 附录 B：取证方法与可复现性

- 四份只读取证分别覆盖：决策产生链路（`attachJevPlayer`/`decide`/`candidateGroups`/`auto`）、
  经济-兵力-防御-目标逻辑、传输与测试契约、常数与死代码。全部给出文件行号与引文。
- 基线测试：本 checkout 无 `node_modules`/`dist`，借用 esbuild 0.27.7 完成构建后
  `node --test --test-concurrency=1 "test/*.test.mjs"`，共跑 10 次定位那条不稳定用例。
- **未能验证**：state 的实测字节/token 体积（本修订没有测量工具，需按 §5.7 自建）；
  若干常数的影响是「读调用顺序」推出的，不是执行出来的。
  本文不采用 wip 分支的战报数据作为 laya 的证据。
