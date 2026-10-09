# Jev 托管 AI —— 完整决策流程（v0.7.5+）

> 依据
> `src/player/werhd-jev-player.mjs`
> 、
> `src/player/werhd-jev-strategy.mjs`
> 当前代码（分支
> `wip/reserved-counter-auto`
> ，HEAD
> `07bc7ae`
> \+ 工作树未提交的 weaponEffectiveness 修复）整理。行号指向写文档时的版本。
> 一句话总览：
> **开局建造由引擎直管，经济 / 侦察 / 防御 / 生产 / 交战由「选择题」驱动本地 Laya 模型决策，引擎在关键处兜底并在执行前复查。**



***

## 1. 总体架构与数据流



```
Chrome 扩展（content → background → page.mjs 注入 MAIN world）
        │  attachJevPlayer(api, {requestDecision, catalog, ...})
        ▼
┌───────────────────────── werhd-jev-player.mjs 主循环 ─────────────────────────┐
│ micro 循环（每 150ms）：                                                       │
│   maintainBattle / respondToThreats / spreadInfantry / placeReadyBuilding      │
│   updateCamera / 状态观察（每 60 tick 一次 observation）                       │
│ decide 循环（异步，每 tick 至多 1 次决策请求）：                                │
│   collectState() → candidateGroups() → 组排序取前 8 → requestDecision()        │
│   → 校验时效（自适应 staleTicks）→ executeCandidate() → 接受/拒绝 → auto 兜底   │
└────────────────────────────────────────────────────────────────────────────────┘
        │
        ▼
本地 Laya 决策服务（laya-multilingual，torch CPU，slim 模式 512 选项预算）
```



* **两种决策模式**：`choices`（多选一，默认）与 `commander`（简报模式，仅 OpenAI 兼容源）。

* **决策组**：construction / vehicles / infantry / scouting / defenses / tactics / aircraft / engineering / garrison / transport / salvage / deployment。

* **上下文约束**：模型～1024 token，**从右往左截断**。slim 模式把 `queues`/`forceReadiness` 保在前列（全量模式下这两个字段 100% 被截掉，模型根本看不到建造队列是否为空 —— 这是 256→512 预算提升（`5c0c082`）与 slim-state 决策的根因背景）。

* **staleTicks 自适应**：答案年龄超过预算→翻倍放宽并丢弃该答案；连续快速返回→回落。防止 "模型回答了但答案已过期被全部丢弃"（历史上出现过 102 决策 103 丢弃，模型全程无发言权）。

* **决策预算**：`maxDecisions` 默认 600，耗尽即停止托管。



***

## 2. 阶段 0：进入对局

`attachJevPlayer`（player.mjs:2063）：



1. 校验 api /requestDecision/catalog，`refreshCatalog` 载入单位规则目录。

2. 初始化 `memory`（frontiers、enemyBuildings、orders、mission、specialOrders…）与 `status` 簿记。

3. 挂载 tick 与计时器；胜负检测就位（`defeated`/`observer` → 输出 outcome 并停止；所有敌方 `defeated` → victory）。



***

## 3. 阶段 1：开局建造 —— 引擎直管（`d1e4031`）

`construction` 组（candidateGroups，player.mjs:501-558）——**这是全游戏唯一 "模型拒绝 1 次即执行" 的组（auto:1）**：



| 顺序 | 条件                       | 动作                               |
| -- | ------------------------ | -------------------------------- |
| 0  | 基地车在场                    | `deploy_base`（URGENT：先展开，基地才能开工） |
| 1  | `powerMargin < 50` 或全无建筑 | 发电厂                              |
| 2  | 无兵营且菜单有兵营                | 兵营                               |
| 3  | 无精炼厂                     | 矿石精炼厂                            |
| 4  | 无战车工厂                    | 战车工厂                             |

关键设计：



* **顺序 =***&#x20;游戏自带 AI 的开局 \*\*。注*释记载教训：曾把精炼厂放第二，开局全花在收入上，第一波袭击来临时无兵可守；先兵营才能把第一笔钱变成步兵和防御塔。

* **auto:1 的原因**（注释原文）：`jev-report-20261009-055438` 中模型连续 36 个建造轮次拒绝 `produce_CAREFN`—— 队列空、4749 余额、2000 成本的精炼厂，35 次拒绝、置信度 0.53-0.84。且实测改写文案无效（39 题真实提问，动作率 46%→41%）。**结论：引擎决定，模型事后被告知。**

* **单精炼厂策略**：`targetRefineries = 1`。第二精炼厂是后期决策，不是自动行为（曾出现把建造序列花在重复精炼厂上，`jev-report-20261008-054847` 连选三次 `produce_GAWEAP`）。

* 每步先检查队列空闲（`!queueOf(constructionType).size`）与余额 ≥ `min(500, cost)`，**不满足就跳过该轮**，开局不会卡死。

> **注意：这四步只是「基础开局」，不是全部建造。**
>
>  战车工厂立起来之后，
>
> `construction`
>
>  组继续承担：① 科技建筑链（见第 7 节后文：雷达→实验室→维修厂 / 机场，
>
> `coreReady`
>
>  才解锁，按前置条件排序）；② 被毁设施重建（矿场 / 工厂 / 基地车，最高优先，见 
>
> `recoveryGroups`
>
> ）；③ 电力补足（
>
> `POWER FOR TECH`
>
> ）。防御塔由 
>
> `defenses`
>
>  组负责，单位由 vehicles /infantry/aircraft /engineering 组持续生产。第二座战车工厂是明确不推荐项（仅富余收入时）。



***

## 4. 阶段 2：经济计划（economyPlan）

`economyPlan`（player.mjs:181-208）+ `investmentGroups` 的 ECONOMY FIRST 分支（strategy.mjs:416-442）：

**目标矿车数动态决策**（按优先级）：



| 情形                     | targetMiners                      | 原因      |
| ---------------------- | --------------------------------- | ------- |
| 无精炼厂                   | 0                                 | 精炼厂先于矿车 |
| 有矿车空闲且无矿可采             | 保持现状                              | 再买也是浪费  |
| 资金 ≥4000 且上升（surplus）  | 保持                                | 钱不是瓶颈   |
| 资金 <1500 且下降（starving） | 扩到最多 3（=refineries×2）             | 采矿不足    |
| 正常                     | min (3, max (1, 现有，refineries×2)) | 收支平衡    |

**矿车缺失 = 最高优先级**（strategy.mjs:419-441）：



* `economyDeficit = targetMiners - 现有矿车 - 在造矿车`；`minerUrgent = 现有 0 辆`。

* 有矿车缺口且（无矿车或基地未受攻击）且工厂在 / 在重建 → 加入 `ECONOMY FIRST` offer。

* 门槛：**credits ≥ 矿车成本即可**（旧版 500 门槛被模型读成 "先攒 500"，导致更贵的矿车永远不造）。

* 注释教训：`jev-report 20261008-021015` 矿车 0 辆时队列填满 HOWI/BGGY/CHAR，最终 21065 余额花不出去 ——**矿车是唯一收入，优先于一切**。



***

## 5. 阶段 3：侦察（infantry SCOUT FIRST + scouting）



* **侦察兵选择**（strategy.mjs:601-618）：用 `scoutPreference`（速度 + 成本 + 损失代价），**军犬优先**—— 它能在疯狂伊万引爆前发现目标，且是玩家最不愿损失的便宜单位。按原始速度排序曾选出廉价步枪兵，是错误选择。

* **SCOUT FIRST**（player.mjs:640-678）：敌基地未知且没有该侦察兵在造 → 无条件 offer 快速侦察兵，**auto:2**（模型拒绝 2 次即训练 ——"这是找到敌基地的唯一方式"）。注释教训：`jev-report-20261008-063613` 只派 E1/GGI，因为一旦见到敌建筑 `needsScout` 变 false，军犬再也不被 offer。

* **步兵战斗部队**：按角色（反步兵 / 反装甲 / 防空）配比，上限默认 6（无战车工厂的纯步兵局放宽到 20，钱多时 `RICH_INFANTRY_CAP`）。按 armor-adjusted 得分选，不堆同一种。

* scouting 组：探索指令（独立语义，先不动）。



***

## 6. 阶段 4：防御（assessStrategy + defenses）

**压力分级**（assessStrategy，strategy.mjs:230-265）：



| 档位            | 条件                        | 意图（instructions） |
| ------------- | ------------------------- | ---------------- |
| critical      | 核心建筑 HP<35% 且威胁 < 8 格     | 保住核心建筑，紧急反制      |
| suppressed    | 持续受压 / ≥3 威胁且敌火力 > 己方 80% | 防御稳住阵地，预留科技突破    |
| sustained     | 受压 >450 tick              | 同上               |
| underPressure | 有威胁                       | 维持经济，推进科技与合成部队   |
| 正常            | 无威胁                       | 维持经济，推进科技与合成部队   |

**防御计划**（investmentGroups defenses，strategy.mjs:338-410）：



* **防御底线 MIN\_BASE\_DEFENSES**：有兵营就建底线（无论是否受攻击）。教训：`jev-report-20261008-054847` 防御 83 题 wait 82 题、只建一座机枪碉堡，第一波袭击遇到裸基地。底线只在有兵营时生效 ——**电力与开局仍优先**。

* **防空价值 ×2.2**：敌方空军存在时，能打飞机的防御塔按 `ground + vsAir × 2.2` 评分 —— 运输机 / 轰炸机是唯一能直接打到精炼厂和战车工厂的威胁，塔不会被飞机甩开。

* **扇形布防**（DEFENSE\_SECTORS）：防御塔绕基地均匀分布（3-4 个扇区），优先填威胁接近方向；半径 = `max(4, min(10, weapon.range × 0.7))`。围墙只沿威胁方向。

* **反制射程校验**：只出 "能打到威胁" 的塔（比较敌我射程，短射程塔不算 standoff 威胁的 counter）；无法覆盖的威胁留给机动部队或科技。

* **无威胁且达底线 → 删除 defenses 组**（不占模型 token）。

* 底线第一座塔 **auto:2**，但不抢钱：非受压基地的塔不得占用工程师 / 矿车保留资金。



***

## 7. 阶段 5：生产（vehicles 组优先级链）

`vehicles` 组指令（player.mjs:562-599）+ `investmentGroups`（strategy.mjs:443-479）+ `operationalGoals`（strategy.mjs:615-682）。

**优先级链**（同轮至多命中一个）：



1. **ECONOMY FIRST** —— 矿车缺口且可支付（见阶段 2）。

2. **ANTI-AIR** —— `airThreatCount>0` 且 `mobileAntiAirCount<3`：先造移动防空（坦克打不到飞机；部署的步兵不算移动护航）。4 辆坦克后保持 2 辆移动防空护航。

3. **RANGE COUNTER / MOBILE DEFENSE** —— 有 standoff（射程威胁）或基地受压且兵力不足：机动反制。评分 = `effectiveness / √cost`，射程 ≥ 敌方射程 ×1.75（能还手 / 追上的优先）。静态炮塔追不上侧翼部队。

4. **FORM THE ATTACK FORCE（普通分支）** —— 兵力缺口且经济达标：8 辆进攻部队目标（`ATTACK_FORCE_SIZE=8`）。带 `mobileCount/8` 数值。

5. **保留计数器分支（MOBILE COUNTER FIRST）** —— 战略投资目标存在（counter\_range/counter\_pressure/mobilize）：这是**保留投资**，别的都不建，先完成它。

**保留计数器分支的当前形态**（strategy.mjs:635-661，commit `9107014` 后）：



* 指令已补三项数值（实测 wait **100% → 20%**，44-55 题翻转选生产）：


  * 兵力缺口：`We have ${current} of the ${desired} ... so ${deficit} more will close the deficit`

  * 队列状态：`The vehicle queue is idle / busy with N`

  * 可支付性：`${uncommitted} credits uncommitted against a cost of ${cost}`

* 并把「空闲队列 + 买得起 + 还差 N 辆」显式定义为 *stall, not a decision*。

* **当前无 auto 兜底**（注释明确 `No auto fallback here on purpose`）：补数值后 44/55 模型自己选生产，剩余 wait 全部是 `baseUnderAttack=true`（敌人已打进基地，再造一辆不改变局面 —— 合法等待，audit 347 行禁止替模型强制）。**21:59 讨论中倾向保留 auto:2，尚未改回工作树，待实跑数据定夺。**

* 防回归测试：`decisionReadiness` 必须带 current/target、指令必须含兵力缺口表述 —— 防止将来有人把 "看起来啰嗦" 的数值当冗余删掉。

**运营目标（operationalGoals）**：



* `forceGoal`：地面战斗车辆目标 `target = min(24, max(12, nearbyEnemyCount×1.5)) + 4×escalation`；飞机目标 4 架。

* **escalation 升级**（0-3）：`combatAssessment` 监测损失 / 击杀交换（`recentLost≥4 且 killed×2≤lost` → tradingBadly）。进攻失败或亏交换 → 升级 → 目标扩大 + 指令追加 `REINFORCE (escalation N): attacks are failing...`。

* 每个生产组的等待条件收紧：**只有队列忙 / 买不起（扣除 reserve 后）/ 兵力已达标才允许 wait**。

* 空军组：准备 4 架侦察 + 集中打击，敌未现身也照造（"find and destroy the enemy base"）。



***

## 8. 阶段 6：交战与实时指挥（micro 循环，150ms）

每 150ms 一轮（player.mjs:2165-2237），优先级固定：



1. **胜负检测** → outcome 事件 + 停止。

2. `maintainBattle`（player.mjs:1512）—— 交战管理：攻击 / 撤退 / 目标选择 / 火力协调。

3. `respondToThreats`（player.mjs:1433）—— 敌军进入基地范围的响应（含射程外威胁预警）。

4. `spreadInfantry`（player.mjs:1384）—— 步兵展开 / 部署姿势。

5. `placeReadyBuilding`（player.mjs:1312）—— 把已建造完成的建筑放下（自动选点）。

6. `updateCamera` —— 镜头跟随。

7. 每 60 tick 输出 observation（余额 / 电力 / 可见敌 / 队列 / 账本）。

**编队系统**：`refreshSquads`（1721）/ `orderSquad`（1738）/ `garrisonSquad`（1838）—— 进攻编队、驻守编队（守家不倾巢，`e26b8ab` 常驻守家部队）。

**特殊单位**：`specialOrders`—— 工程师抓建筑 / 维修（objectiveState 跟踪目标建筑 HP 与占领状态）、工兵 / 超时空等特殊行动。

**武器评分（工作树未提交修复）**：`weaponEffectiveness` 现在正确处理：



* **versus 顺序**：11 项 `None,Flak,Plate,Light,Medium,Heavy,Wood,Steel,Concrete,Special_1,Special_2`（按词典 6. 武器系统代码词典 247 行），直接索引 ArmorType。

* **值形式**：`"75%"` 字符串 → 0.75；>1 的值除以 100（75 = 0.75，不归一化会把所有评分放大 100 倍）。

* **0/1/2 是标志不是倍率**：0%= 不能攻击 / 不能反击；1%= 不能反击；2%= 不锁定目标（Westwood bug）—— 这些武器按 "无法使用" 计 0，不再当满强度武器。

* **工具槽过滤**（activeWeapons）：Damage≤1 的 "工具"（工程师 DefuseKit/VirtualScanner、军犬 VirtualScanner，InvisibleAll 占位弹丸被 rules.ini 标 AA=yes/AG=yes）**不算武器**—— 之前工程师会被计为防空炮台并按坦克评分，一处修复覆盖全部六个调用点。



***

## 9. 兜底与安全机制



| 机制         | 语义                                                                                | 位置                                       |
| ---------- | --------------------------------------------------------------------------------- | ---------------------------------------- |
| **auto:N** | 模型**连续拒绝 N 次**后引擎执行；执行前复查队列 / 余额，失败返回 `queue_changed`/`production_changed` 拒绝而非强推 | player.mjs:2346-2364（计数）、1231-1238（执行复查） |
| 当前 auto 分布 | 共 11 处（见下表）                                                                       | —                                        |

**auto:N 完整分布（2026-10-09 核实）**：



| N                       | 位置                                                 | 语义                                            |
| ----------------------- | -------------------------------------------------- | --------------------------------------------- |
| auto:1                  | player.mjs:555 construction 开局建筑                   | 发电厂 / 兵营 / 精炼厂 / 战车工厂：模型拒 1 次即执行（历史 36 次拒精炼厂） |
| **RICH\_SPEND（钱闲兜底）** | player.mjs:1200-1213，门槛 **credits≥5000** 且兵力<40      | **生产兜底的实际主力**（223656 实证 9/14 辆 MTNK 来自此）——两条路径：①给已有 combat 选项打 auto:2（choice 名**不变**，仍 produce\_XXX）；②无选项时新建 `auto_produce_XXX`（MONEY IS IDLE）。归因勿用 `auto_produce_` 前缀筛，会漏掉路径① |
| auto:2                  | player.mjs:667 infantry 侦察兵                        | SCOUT FIRST：找到敌基地的唯一方式                        |
| auto:2                  | player.mjs:889 tactics OBJECTIVE PUSH              | 占领掩护推进（无威胁且兵力就绪时）                             |
| auto:2                  | player.mjs:903 tactics OBJECTIVE                   | 本局目标攻击（无威胁且兵力就绪时）                             |
| auto:2                  | strategy.mjs:385-405 defenses 底线塔                   | **注意：floorTagged 每轮重置** → 底线内每轮都对"第一个塔"打 auto:2，行为上等价"底线塔自动建造"（223656 实证 3 座 GAPILL 全 auto 造出，慢 2 轮） |
| auto:2                  | strategy.mjs:764 recoveryGroups 重建                 | 矿场 / 工厂 / 基地车被毁重建（最高优先）                       |
| auto:2                  | strategy.mjs:782 sell                              | 卖建筑回收资金                                       |
| auto:2                  | special.mjs:313 repair                             | 维修                                            |
| auto:2                  | special.mjs:395/398 机场 / 船坞                        | 解锁空军 / 海军                                     |
| auto:3                  | special.mjs:141 special 行动                         | 侦察 / 无基地 / 兵少时                                |
| auto:3                  | special.mjs:426 explore 探索                         | 敌基地未知且无敌时                                     |
| （已撤）                    | strategy.mjs:635-661 保留计数器                         | 9107014 已撤除（补数值后 wait 100%→20%，剩余 wait 是 baseUnderAttack 合法等待）。**223656 实证：9 辆 auto MTNK 实为 RICH\_SPEND 兜底，非保留计数器** |
| **staleTicks 自适应**      | 答案过期→放宽预算 + 丢弃；快速返回→回落                             | player.mjs:2079-2089                          |
| **executeCandidate 复查** | 执行前复查队列状态与余额，陈旧决策被拒而非强推                            | player.mjs:1196-1310                          |
| **decision budget**     | maxDecisions 默认 600，耗尽停止                           | player.mjs:2246                               |
| **观察防卡死**               | tick 30 秒不推进 → stop ("simulation\_not\_advancing") | player.mjs:2169-2174                          |



***

## 10. 关键设计决策清单（注释沉淀的教训）



| 决策                                 | 动机（来源）                                          |
| ---------------------------------- | ----------------------------------------------- |
| 开局顺序 = 发电厂→兵营→精炼厂→战车工厂             | 游戏 AI 同款；先精炼厂→开局无防守力量                           |
| 开局 auto:1                          | 36 次连续拒绝精炼厂；文案改写无效（46%→41%）                     |
| 单精炼厂 + 动态矿车目标                      | 双精炼厂曾浪费建造序列（3 次 produce\_GAWEAP）                |
| 矿车缺失 = 最高优先                        | 21065 余额花不出去的那局；矿车是唯一收入                         |
| 防御底线（有兵营即建）                        | 83 防御题 wait 82 的教训                              |
| 防空价值 ×2.2                          | 轰炸机直接威胁精炼厂 / 战车工厂，塔不被甩开                         |
| 扇形布防                               | 防御塔均匀覆盖，优先威胁方向                                  |
| 数值进 instructions 是杠杆               | 100%→20%（`9107014`）；选项文本里不够（19/32 题缺口可见仍 5% 生产） |
| 不替模型强制选项                           | audit 347 行：剩余 wait 是 baseUnderAttack 的合法等待     |
| 工具槽过滤（damage>1）                    | 工程师 DefuseKit 之前被当防空炮台 / 坦克评分                   |
| versus 解析（"75%"/0/1/2 标志 / 11 项顺序） | 值未归一化会把评分放大 100 倍；0/1/2 不是倍率                    |



***

## 11. 当前代码状态（2026-10-09 22:00，深夜更新）



* **分支**：`wip/reserved-counter-auto`，HEAD=`d083381`。提交链：`9107014` 补数值+撤 auto:2 → `07bc7ae` 只读规则探针 → `5b9baad` Verses 语义校正+工具槽过滤（weaponEffectiveness 修复，已提交）→ `9eeea37` 五项托管缺陷（开局建造补雷达/机场/维修厂/实验室、军犬咬坦克/不探图、工程师舍近求远、防御前置断裂不可见）→ `d083381` 战报写入构建指纹（git 短 hash + -dirty，BUILD_STAMP 由 esbuild define 注入）。main 仍为 `5c0c082`。

* **工作树**：`test/player-opening-auto.test.mjs`（OpenCode 自报红测试，construction.actions 为空，未定位未提交）+ `docs/jev-player-flow.md`（本文档，未提交）。

* **未决事项（2026-10-09 深夜更新）**：

1. **RICH_SPEND 门槛（A1/D1 新主线）**：223656 实证 9/14 辆 MTNK 由 RICH\_SPEND（credits≥5000）兜底、模型自主 5/14（36%）。「vehicles 直管 vs 降低门槛」的取舍待定——模型在 223656 并非 0 贡献，直管会拿走自主权；门槛相对化证据更强。

2. 探针快照（活体 rules () 的 versus 键 / 值形式）—— 上次探针 `{"error":"no werhd"}`，需重载扩展后进对局再点；5b9baad 已按词典校正语义，探针作为交叉验证仍待做。

3. 三臂重放：原样 / 缺口进 instructions / 缺口进 instructions + 删 wait 里 affordability 句 —— OpenCode 进行中。

4. **defenses 归因已核验（223656）**：6/6 题全在底线内拒绝（GAPILL<3、非受压），3 座 GAPILL 全 auto 兜底；`floorTagged` 每轮重置 → 底线塔行为上已自动建造（慢 2 轮）。

5. **实跑验证**：223656（9107014 之后、d083381 之前）已见补数值部分生效迹象（模型自主 MTNK 36%）；下一局带 build 字段可直接归因。

* **协作**：改动在 `wip/reserved-counter-auto` 分支未并入 main；`docs/ra2-unit-catalog.md` 已由 OpenCode 提交。红测试是否需 DSH 介入待 OpenCode 确认。

---

## 12. 优化建议与待验证项（2026-10-09 评审）

> 来源：DSH-agent 基于本文档 + 战报 `jev-report-20261009-214501`（已删，结论经 223656 复核）+ `jev-report-20261009-223656`（完整核验）+ `docs/ra2-unit-catalog.md` 的评审。2026-10-09 23:28 发房间与 OpenCode 对齐；深夜以 223656 数据复核并更新状态（RICH\_SPEND 归因、B1/C2 核验、A1 降级、D1 升为首选）。

### A. 生产决策层（速败根因）

| 编号 | 建议 | 依据 | 状态 |
|---|---|---|---|
| **A1** | vehicles 组「引擎直管或 auto:1」**需重新评估**：223656 实证模型自主选了 5/14 辆 MTNK（36%，非 0 贡献），直管会拿走这份自主权。更精确的杠杆是 **D1**（RICH\_SPEND 门槛相对化）——兜底本身有效，只是介入太晚（第一辆 MTNK tick 8826≈3.7 分钟，触发余额 5265~10329 全部 ≥5000） | 223656 战报：9 辆 auto MTNK 全部 RICH\_SPEND 兜底、模型 5 辆自主；wait 非 100%（223656 vehicles wait 41/51=80%） | **待定**：A1 降级，优先 D1；若 D1 后模型仍拒产再议直管 |
| **A2** | 进攻目标分阶段：4 辆即可骚扰/防守反击（配步兵+防御），8 辆才总攻。当前 `incompleteForce` 以 8 辆为触发线、operationalGoals 目标 12→24，速败局 8 辆凑不齐 = 永远无进攻能力 | 战报 6.4 分钟速败（223656）；forceReadiness/readiness 语义需评估 | 建议先出方案再动（会改 readiness 语义） |

### B. 防御层（91% wait，基地裸奔）

| 编号 | 建议 | 依据 | 状态 |
|---|---|---|---|
| **B1** | 防御底线改为引擎直管（auto:1，底线内全部塔）。底线防御是"安全地板"，不该是选择题 | **223656 核验：defenses 6/6 题全在底线内拒绝**（GAPILL<3、非受压），3 座 GAPILL 全 auto 兜底造出；`floorTagged` 每轮重置 → 行为上已等价底线自动建造，auto:1 只把延迟从 2 轮减半 | 待对齐（动模型权威，需与 audit 347 行平衡；机制上 auto 已兜底，价值是提速） |
| **B2** | 防空 = 硬需求：`airThreatCount>0` 且无防空时 NASAM/NAFLAK 引擎直接下单 | 有空军威胁却无防空 = 精炼厂/战车工厂被直接轰炸；vsAir×2.2 加权救不了拒绝 | 待对齐 |

### C. 输入/信息层

| 编号 | 建议 | 依据 | 状态 |
|---|---|---|---|
| **C1** | 决策组动态裁剪：无机场删 aircraft、无敌方海军删 naval、无中立建筑可占删 engineering，把 token 让给有 offer 的组 | 8 组上限塞满无 offer 组会稀释决策质量（现只裁 defenses） | 待对齐 |
| **C2** | 核验阵营专属过滤：TNKD（德国）/GTGCAN（法国巨炮）/BEAGLE（韩国）/DESO（伊拉克）等是否在 vehicleOptions/defenseOptions 按 faction 过滤 | 不过滤会 offer 不可造单位（executeCandidate 会拒但浪费 token/轮次） | **已核验，无需改动**：`production.available()` 已按阵营（含国家）过滤。223656 盟军局 vehicles 51 题选项全盟军（MTNK/FV/CMIN/SHAD），无 TNKD/GTGCAN/HTNK/APOC |

### D. 经济/节奏层

| 编号 | 建议 | 依据 | 状态 |
|---|---|---|---|
| **D1** | MONEY IS IDLE 门槛从绝对 5000 改为相对判断（如余额 ≥ 矿车成本×3 且收入为正），让"有钱不花"兜底更早介入 | **223656 支持**：9 辆 RICH\_SPEND 兜底 MTNK 触发余额全部 ≥5000（5265~10329），第一辆 3.7 分钟才出——绝对门槛把兜底拖得太晚；速败局钱攒不到 5000 就结束 | **待对齐（A1 的新首选杠杆）** |

### E. 工程流程层（防再次归因混乱）

| 编号 | 建议 | 依据 | 状态 |
|---|---|---|---|
| **E1** | 战报/决策日志写入代码 hash（VERSION 或 git hash），归因查字段而非时间线；工作树未提交改动（weaponEffectiveness 修复）叠加实跑前先合并提交 | 214501 教训：新旧代码分不清（先判旧、后纠正为新） | **已落地**：`d083381` 构建指纹（BUILD\_STAMP 由 esbuild define 注入，写 `git-hash` + `-dirty`），归因改读字段 |
| **E2** | 重放请求必须写独立目录，写进 AGENTS.md 陷阱清单 | OpenCode 两次污染真实采集目录（636 份 / 混入 laya-check 固定请求） | OpenCode 已同意，落地状态待确认 |

### 优先级（2026-10-09 深夜更新）

**D1+A2 > B1+B2 > E1 > C1**（C2 已核验关闭；A1 降级为 D1 的备选）

- D1（RICH\_SPEND 门槛相对化）是当前证据最强的杠杆：兜底有效但介入太晚（223656 全部触发余额 ≥5000）。
- A1 原「引擎直管」需重新评估：223656 模型自主贡献 36%，直管会夺走自主权。
- A2 会改 `forceReadiness`/`readiness` 语义，先出方案再动。
- B1 机制上 auto 已兜底，改 auto:1 价值在提速；是否动模型权威需 owner 拍板（audit 347 行边界）。
- E1 已落地。