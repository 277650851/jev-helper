# 从 SupalosaBot（bot2/bot3.js）移植决策逻辑到 jev-helper

状态：2026-09-28 整理。来源文件：`C:\RAR2WEB\Localclient\js\bot2.js`（SupalosaBot generation 2）、`bot3.js`（generation 3, rulesDriven）。
目标：把传统脚本 AI 中被实战验证的智能决策机制，逐项对照 jev-helper 三层架构（知识层 / 指挥层 / 执行与本能层），给出可落地的优化清单。

## 1. 来源定位

| 来源 | 形态 | 核心思路 |
| --- | --- | --- |
| bot2.js（93KB, g2） | 手工硬编码单位策略表 + 6 类生产队列 | "写死的经验表"：电厂断电 100 优先、精炼×2 矿车、威胁 1.1 倍触发防御 |
| bot3.js（863KB, g3） | 规则驱动能力画像 + Mission 动作协议 + 仲裁 + 遥测 | "会读规则的推理引擎"：从 rules 推武器/克制/角色，任务抽象成动作协议，全局仲裁 |
| jev-helper（0.7.6） | LLM 托管，三层分工 | 扩展负责"看清+执行"，模型负责"指挥"；选择题模式（默认）+ 指挥模式（OpenAI 兼容来源） |

jev-helper 现状关键实现（对照锚点）：
- 知识层：`werhd-jev-commander.mjs` buildBrief（单位卡/小队/敌军集群/压力/合法目标）、`werhd-jev-strategy.mjs`（weaponEffectiveness / canFireAt / baseThreats / vehicleOptions / scoutScore）
- 指挥层：选择题模式 `candidateGroups / investmentGroups / operationalGoals / recoveryGroups / specialGroups` + `acceptMission / missionGate`；指挥模式 LLM 意图表
- 执行层：`orderSquad / garrisonSquad / respondToThreats / maintainBattle / chooseRallySite / chooseBuildingSite / refreshInfrastructure / specialOrders / updateLedger / rememberEnemyBuildings / objectiveState`

## 2. 决策机制清单（按主题分组）

### A. 能力推导与战术推理

| 机制 | 来源 | 说明 | jev-helper 现状 | 建议 |
| --- | --- | --- | --- | --- |
| 规则驱动能力画像（武器伤害×装甲克制×射速、特殊效应、角色标签） | bot3 `Lu/xu/Bu` + `_u` 缓存 | 自动打 20+ 角色标签：anti-air / anti-submarine / transport / saboteur / siege-artillery / terrain-clearer 等 | `unitCard` 已有 dps/range/tags（子集：engineer/miner/deployable/garrisonable 等） | **P1**：补齐角色标签到 unitCard tags（from roles），让模型一眼知道"这是防空、这是运兵车" |
| 部署变换净收益评估 | bot3 `Iu` | 移动 vs 部署形态：伤害率、生存率、展开时间、目标移动是否会逃出射程 → 决定推荐展开 | `specialGroups` 有 deploy_morph/undeploy_morph 触发，但判断简单（deployer 就部署） | **P0**：加 `deployRecommendation(rule, target)`：对可部署单位算净收益，简报里标注"推荐展开/不展开"，执行层据此或交给模型 |
| 命中率预测 | bot3 `Js` | 武器射程+追击速度 vs 目标速度 → 命中系数 0.35~1 | 无 | **P1**：追击/命中系数用于 forceReadiness 与攻击目标评分（减少追不死还白跑） |
| 四域射程（陆/水面/水下/空域） | bot3 `Lu.maxRangeByDomain` | 海军/潜艇/防空分开算射程 | `unitCard` 只分 range（对地）/ airRange（对空） | **P2**：若游戏含海军，简报 range 分四域；当前地图无海军可暂缓 |

### B. 威胁评估与攻守转换

| 机制 | 来源 | 说明 | jev-helper 现状 | 建议 |
| --- | --- | --- | --- | --- |
| 全局威胁量化对比 | bot2 `threatCache` | 敌方进攻威胁 vs 我方反地面/反空火力，1.1 倍触发防御优先级 | `pressure` 是每小队粒度（谁压制谁）；`assessStrategy` 有总体评估 | **P0**：简报加 1~2 个全局数字（敌方总火力 / 我方总火力 + 防空缺口），帮模型判断"该攻还是该守"；执行层保留 1.1 倍规则做防御兜底 |
| 防空缺口感知 | bot2/bot3 `totalOffensiveAirThreat vs totalAvailableAntiAirFirepower` | 空军威胁超我方防空 1.1 倍 → 补防空 | `canFireAt` / `baseThreats` 有单点判定，无全局防空缺口 | **P1**：简报加"防空缺口：是/否"，防空不足时模型优先产防空（配合角色标签） |
| 防御选址（前出拦截） | bot2 `Ss` | 防御塔在敌我出生点连线间随机偏移，威胁触发 | `chooseBuildingSite` 已有，含 base 就近逻辑 | **P2**：给防御类建筑加"前出拦截点"候选（前沿点 frontierPoints 已有基础） |

### C. 生产与经济

| 机制 | 来源 | 说明 | jev-helper 现状 | 建议 |
| --- | --- | --- | --- | --- |
| 生产意图权重仲裁（intent 权重表 + 缺口比例 + 等待衰减） | bot3 `qu` + `$u` | 11 种意图（strategic-strike 2 / emergency-defence 2 / economic-recovery 2 / legacy 1…）× 缺口比例 × 等待时间，优先级每 tick ×0.75 衰减 | 选择题模式有 investmentGroups；指挥模式生产由模型直接下 train/build | **P0**：执行层加"模型静默兜底"——模型响应中/断线超过 N tick 时，按 intent 权重表自动续产（复用现有队列 API），避免托管中断时停产 |
| 电力硬性兜底 | bot2 `tt` | 电力不足 → 电厂优先级 100（无条件） | `economyPlan` 窗口统计 + 建议 | **P1**：断电（power.total < drain）时执行层强制补电厂，不进模型决策 |
| 矿车/精炼比例 | bot2 `Ct` | 矿车 < 精炼×2 → 紧急补；超出 → 停 | economyPlan 有收入/资金窗口 | **P1**：加"采矿比"指标进简报（矿车数/精炼数），模型看到经济健康度 |
| 浮动资金门槛 | bot2 `_` | 科技建筑只在资金 > 门槛时建（按资金比例缩放优先级） | 部分在 investmentGroups | **P2**：科技/高成本建筑保留"资金门槛"缩放在执行层 |

### D. 部队调度与执行

| 机制 | 来源 | 说明 | jev-helper 现状 | 建议 |
| --- | --- | --- | --- | --- |
| 单位唯一归属 + 失踪/摧毁追踪 | bot3 `unitIdToMission` + 24 tick | 单位失踪（装运/瞬移）24 tick 保留归属，超时移除；被摧毁立即移除并统计 | `memory.intents` 有 members；`STALE_COMMAND` 900 tick 处理命令过期 | **P0**：给意图成员加"失踪追踪"——单位从视野消失 24 tick 内意图不散、超时自动解散（防意图因成员瞬移悬空）；摧毁立即释放单位 |
| 命令批处理（按订单类型/目标/坐标聚合 orderUnits，非法坐标拒绝） | bot3 `ku` | 减少 API 调用，非法格直接拒绝计数 | `orderSquad` 逐单位下命令 | **P1**：同一意图下的大编队（>8）按目标聚合 orderUnits；非法坐标在执行层前置校验（`mapApi.getTile` 判空） |
| 意图锁定与去重 | bot3 `Te.isSameAs` + 命令去重 | 相同意图不重复下命令 | `sameIntent` + `INTENT_REFRESH_TICKS` 45 已有 | 已覆盖，无需改 |
| 自动修理（30 tick 扳手） | bot2 `vs` | 受损可修理单位自动开扳手 | 未发现单位自动修理逻辑 | **P1**：本能层加"受损单位自动送修/开扳手"（间隔 30 tick） |
| 止损判定 | bot2 `en` | 无军队+无生产 → quitGame | 无自动投降 | **P2**：不加自动投降（托管场景由用户决定）；改为简报提示"经济/兵力崩溃风险"，模型可下 retreat/停产意图 |

### E. 附加能力

| 机制 | 来源 | 说明 | jev-helper 现状 | 建议 |
| --- | --- | --- | --- | --- |
| 超级武器控制器快照 | bot3 `superWeaponController.getSnapshot` | 超时空/铁幕就绪状态 | 无 | **P2**：检测超武就绪并进简报（模型决定是否/何时用），仅当游戏有超武时 |
| 遥测快照（mission 状态/阶段耗时/事件） | bot3 `telemetry` | 决策可复盘 | jev-helper 已有 `logbook.mjs` + `command` 日志 | 已覆盖，方向一致；可补"每条意图的执行耗时" |
| 地形拓扑 | bot3 `topology` | 桥/高地/水域 | `refreshInfrastructure`（桥/小屋）+ `findVisibleOre` + `frontierPoints` | 已覆盖（桥/矿点），无需改 |

## 3. 落地优先级

### P0（本轮建议做，改动小收益大）
1. **部署变换推荐**：`werhd-jev-special.mjs` specialGroups 里加 `deployRecommendation`，简报标注推荐展开；执行层按推荐部署（模型可覆盖）。
2. **全局威胁数字**：`buildBrief` 概况区加"敌方总火力 / 我方总火力 / 防空缺口"（复用 weaponEffectiveness 汇总，1~2 个数字，不占 token）。
3. **模型静默兜底生产**：执行层在模型响应超时（如 2×12 秒）时，按 intent 权重表（strategic-strike/emergency-defence/economic-recovery 等）自动续产队列。
4. **意图成员失踪追踪**：`refreshSquads`/`acceptMission` 处加 24 tick 失踪判定（对应 bot3 的 transientMissing），摧毁即释放。

### P1（下一批）
5. unitCard 补角色标签（防空/运兵/炮击/工兵等，从武器推导）。
6. 命中率/追击系数进 forceReadiness 与目标评分。
7. 断电硬性补电厂 + 采矿比指标。
8. 命令批处理聚合 + 坐标前置校验。
9. 自动修理。

### P2（按需）
10. 四域射程、防御前出拦截点、浮动资金门槛、止损提示、超武快照。

## 4. 约束与注意

- **token 预算**：指挥模式简报目标 3,000–6,000 token；新增字段要克制（全局威胁 2 个数字、角色标签复用现有 tags 行，不增行数）。
- **模型能力分层**：本地 Laya（约 256 token/组，不会推理）只适合选择题模式；以上 P0/P1 的"简报增强"只对指挥模式（OpenAI 兼容）生效；执行层兜底（静默续产、断电补电厂、自动修理）对两种模式都生效。
- **不破坏现有选择题模式**：P0 的兜底生产只在模型静默时触发，选择题模式已有候选机制时互不干扰；所有新规则放执行层/知识层，指挥模式不保留"写死的战术判断"。
- **实现位置**（P0）：
  - `src/player/werhd-jev-commander.mjs`：buildBrief 加全局威胁数字、unitCard 加角色标签、squad 失踪追踪接入。
  - `src/player/werhd-jev-special.mjs`：deployRecommendation。
  - `src/player/werhd-jev-player.mjs`：模型静默兜底生产（新函数 `fallbackProduction`，在决策主循环超时分支调用）。
  - `src/player/werhd-jev-strategy.mjs`：命中系数 `hitChance`、全局火力汇总 `globalPowerBalance`。
- **测试**：现有 `node --test test/*.test.mjs`（179/179）基础上，为 P0 每项加断言（部署推荐、全局威胁数字、静默兜底、失踪追踪）。

## 5. 实施反馈（DSH，2026-09-28 → 0.8.0，测试 182/182）

### 已完成

**P0-4 意图成员失踪追踪** —— `werhd-jev-player.mjs`，新增 `MISSING_INTENT_TICKS = 24`
- `refreshSquads` 原来在意图所属小队消失的那一拍就删掉意图。现在保留 24 拍宽限，**并且同时保留该小队的成员名册**——这一步不能省：`formSquads` 只在成员重叠时才复用 squad id，若名册一起丢掉，归队的单位会拿到新 id，意图就变成没人能继承的孤儿，宽限窗口等于白设。
- **一条 API 限制（已核对上游 `main`：本地 `docs/player-console-api.md` 与远端逐字一致）**：`werhd.unit(id)` 对「已消失 / 已摧毁 / 不可见」一律返回 `undefined`，且公开 API 只有 `onTick`，**没有单位被摧毁事件**。所以本项里「摧毁立即释放」**无法实现**，只能用时间宽限。
  好在同一文档第 102 行说明 `order` 会自动过滤已消失的己方单位，因此宽限期内对已死单位下命令不会产生非法指令——这是该方案可行的前提。
- 依据：真实 12 分钟对局中 `unit_gone` 是第二大跳过原因（12 次 / 共 58 次跳过）。

**P0-3 模型静默兜底生产** —— `werhd-jev-player.mjs`，新增 `silentProduction()`
- 决策请求失败时不再整轮空转：重算一次候选（纯查询、零 API 调用），按既有 `auto` 标记排序，执行编号最低的一个，每轮最多一个，避免模型停摆时灌满队列。
- **对触发条件的修正**：文档写的是「模型响应超时 / 断线超过 N tick」。但三局真实战报都是 **`failures: 0`、`stale: 0`**（400+ 次决策无一失败）——本地 Laya 从不静默，它是**高置信地回答「等待」**：`defenses` 22/22 次拒绝、概率 0.84–0.96；`vehicles` 的 `produce_CMIN`（文案写着 ECONOMY FIRST）被以 0.92–0.95 拒绝。
  所以**纯静默触发在本地模型上永远不会开火**。真正造成损失的是「主动选等待」，那部分由 `auto` 标记 + 拒绝计数覆盖（0.7.9 已给 `defenses`/`scouting` 补上），静默兜底是它的补充而非替代。建议把这一条的目标改写成「生产不依赖模型同意」，静默只是其中一种情形。

### 未做

- **P0-1 部署变换净收益推荐**、**P0-2 全局威胁数字**：本轮未实施。
  - P0-2 按要求只进指挥模式简报，对本地 Laya（当前主用来源）**零效果**；要做建议同时给出「选择题模式下怎么用这两个数字」的落点。
  - P0-1 的执行层部分有价值，但 `specialGroups` 现有 deploy 触发的实际表现需要先有一局实测数据（部署/未部署的伤害与存活差异）才好定阈值，否则是凭感觉写规则。
- **建议优先级调整**：把 **P1-7「断电硬补电厂」提到 P0**。它与已确认的失败模式同源（资金堆到 17,451–19,460 而生产停摆），且属执行层，对本地 Laya 直接生效；而它现在只是 P1。
