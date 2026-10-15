# Jev 托管 AI —— 会话交接（2026-10-15）

> 给**新会话/新接手者**：这份是"从零开始也能继续"的交接。仓库里另有一份**活的待办清单**
> `docs/jev-autopilot-handoff.md`（编号条目就是待办），本文档引用它的条目号。

## 0. 一句话现状

`HEAD = 59c734b`，`npm test` **359/359**，工作区干净、`ahead 0`。本次会话修了 15 个提交的
**真 bug**（军犬打装甲、装甲下标、经济容量、展开陷阱、侦察开局不出门、引擎刷兵…），并三次**主动撤回**
无法证明的改动；**唯一还开着的功能缺口是"超武不会自动建造"**（根因已缩到一处，见 §4.1）。

## 1. 环境与路径（先读，能省一小时）

| 项 | 值 |
|---|---|
| 真实仓库（源码在这里） | `C:\laya0.7.5` —— **所有改动与构建都在这里** |
| 远端 / 分支 | `https://github.com/277650851/jev-helper.git` / `develop` |
| 离线整合包 | `C:\laya\jev-helper-offline`（`venv\` + `model\` + `extension\` + `tools\`） |
| 管理器菜单 | 整合包里的 `manage-laya.ps1`（已纳入仓库模板 `tools/offline-bundle/` ✓） |
| 启动器 | 整合包里的 `launch.ps1` / `启动.cmd` |
| 路径关系 | `C:\laya\jev-helper` 是**指向 `C:\laya0.7.5` 的 junction**（可删；菜单已自适应探测 ✓） |
| 服务 | 本地 Laya，`http://127.0.0.1:8742/v1`，模型名 `laya-multilingual`，令牌留空 |
| 浏览器加载点 | Edge 扩展 `C:\laya0.7.5\dist`（**改完必须点「重新加载」，只刷游戏页无效** ✗） |

构建/测试：`npm test`（= `npm run package` + `node --test`）。`dist/BUILD.json` 里的 `build` 就是
"这一份构建来自哪个提交" ✓。构建后**同步整合包**（枚举式复制，**不要**用 `Copy-Item <目录>` ✗）：

```powershell
Copy-Item (Get-ChildItem C:\laya0.7.5\dist -Recurse -File).FullName -Destination C:\laya\jev-helper-offline\extension -Force
Copy-Item (Get-ChildItem C:\laya0.7.5\dist -Recurse -File).FullName -Destination C:\laya\jev-helper-offline\dist -Force
```

## 2. 本次会话完成（按提交，全部有测试）

| 提交 | 内容 |
|---|---|
| `d8afeb7` | §0.48：`deploy_no_space` 改成"开到合法地格再展开"（含基地已没时的环形搜索）|
| `49da35e` | 经济：ECONOMY FIRST 矿车补 `auto: PLAN_STEP_AUTO`（**不夺走选择**）|
| `76d3734` / `e43585d` / `d172716` | 规则文件注释版入库（每次逐键比对：1258 节 / 19443 键值、0 取值差异）|
| `a8746c9` | 攻击编队按 `canUnitHurt` 过滤（`assault_*` / `engage_visible`）|
| `7050dfe` | **本能层**攻击循环同样过滤（军犬不再被派去啃坦克）|
| `b831b82` | 超武进建造候选 + 防御类型多样性 + deploy 落点进日志 |
| `ceb7bed` / `c099ea0` | 伞兵自动空投 + 补第三个载体（`CARADR` 雷达塔）|
| `fe858d8` | 超武自动开火（打敌方目标最密处 / 主基地）+ 载体表补全为规则里的九条 |
| `823d01c` | 车辆自动维修（`UnitRepair` 建筑 + 工程师进 IFV 变维修车，均走 `OrderType.Repair=15`）|
| `c2dfca0` | 矿场容量：6 矿车配 1 矿场的死法（含电力守卫，既有测试逼出两条修正）|
| `7a9da71` | 审计：目标编队过滤、装甲**单词当数字下标**、百分比/比例尺度归一、维修车 `gunner`、矿场耗电 |
| `11b40a0` | 审计：**展开陷阱**（被飞机钉死）、`airportBound` 拼写、`attackDog` 字段不存在 |
| `f58d9b6` | 审计：箱子指派移错车、运输剩余容量、我自己的矛盾注释 |
| `7bb5744` | 开局：引擎自动练兵要求"钱在**堆积**"而非"账户钱多" |
| `908dd05` | 伞兵落点先判危险度，投不下去就投到能站住的位置 |
| `947a00a` / `59c734b` | handoff：超武探针 + **更正我自己写错的结论** |

**报告级已验证**（`jev-report-20261015-143001`，build `7bb5744`）：超武自动开火 **35 条**记录
（`LightningStorm` 打敌方主基地、伞兵按 ~3560 拍节奏投最密处/安全位置 ✓）；侦察开局 t1008 出门
（此前是 t9584 ✓）。

## 3. 未完成 —— 按优先级，每条都带证据与验收判据

### 4.1（← 你的编号：最高优先）**超武不会自动建造**
- **证据**：`jev-report-20261015-143001` 里 `construction` 组被问 **175 次**，
  `produce_GACSPH`/`produce_GAWEAT`/`produce_NAMISL` **一次都没出现在选项里**；同局 `place` 里这三样
  各有一座 → **是玩家手动建的**。而 `produce_GATECH` **出现了**（`docs/jev-autopilot-handoff.md` 第 14 条）。
- **已排除**：`coreReady` 的计划门 ✗（未修改的代码里 `produce_GATECH` 就会出现）；
  `strategy.critical` / `free(Structures)` / `available` ✓。
- **已缩到一处**：夹具 `pwr=180`，而超时空传送自身 **`Power=-200`** ✗ →
  **最可能是我自己给超武加的电力守卫** `powerMargin >= Math.max(0, -r.power)`。
- **下一步（只需一次实验）**：把夹具电力余量抬到 **> 200**（加电厂），看 `produce_GACSPH` 是否出现。
  - 出现 → 结论"电力守卫过严"。**改法**：把**电厂与超武作为一次投资**提供；
    **不要**放宽到 `>= 0` ✗（0~49 余量会拉闸）。
  - 不出现 → 查 `superWeaponChoices` 的 `ready` / `queued` / `owned` 三个入参。
- **验收判据**：`construction` 组的选项里出现 `produce_GACSPH`。

### 4.2 超时空传送（`ChronoSphere`）仍不自动释放
- 卡点：`superweapon(type, x, y, x2?, y2?)` 的**双点语义**在本客户端 API 里声明，
  但**没有任何报告验证过**（起点=我方载具？终点=敌方落点？）✗。
- 两条硬约束必须建在这个语义之上：`[GACSPH]` **只能传送载具**（不能传送步兵）、**传进水里载具直接沉没**。
- 我曾实现并**撤回**（测试无法证实双点语义）→ 结论：**先验证语义，再实现**。

### 4.3 铁幕（`IronCurtain`）未测
- 它是罩**自己单位**的（且**不能对步兵使用**）→ "打敌人"是错的规则 ✗；等你实测后定规则。

### 4.4 审计剩余的低优先级（不影响胜负）
- `strategy.mjs` 局部力量对比用**规则级**武器（含展开后才有的那门）→ `suppressed` 偏乐观；
- `capturePush` / `strategy.techChoices` / `strategy.hasAirSupport` **写了没人读**（删掉会改变模型可见
  的 state 负载 → 属取舍，不是 bug）。

## 4. 读战报的固定方法（新会话直接用）

```powershell
node --test --test-concurrency=1 "test/*.test.mjs"      # 先确认绿
# 战报目录：C:\Users\Administrator\Downloads\jev-reports\
```

判据表（全部可从 JSON 直接读）：

| 想看什么 | 读哪里 |
|---|---|
| **这一局跑的是哪份代码** | `match.meta.build` —— 与 `dist/BUILD.json` 对比（**这一条先看**）|
| 造了什么 | `match.produced` |
| 引擎 vs 模型各自下了什么 | `entries[kind=action]` 的 `auto`（true=引擎）与 `choice`；或 `kind=gates` 的 `armed/byModel/declined/fired` |
| 引擎跳过原因 | `match.skippedReasons` |
| 我的自动动作有没有跑 | `entries[kind=micro].text`（超武/伞兵/维修/散开都在这里）|
| deploy 落点 | `action` 的 `movedTo` / `refusedAt` |
| 侦察是否早出门 | 第一条 `choice` 以 `explore_` 开头的 `action` 的 `tick` |
| 败因 | `node tools/postmortem.mjs <战报>` |

**注意**：打包器把中文转义成 `\uXXXX` ✗ —— 在 `dist/*.js` 里搜中文永远搜不到，要搜符号名。

## 5. 这个仓库的纪律（照做，能少走弯路）

1. **先证据后改动**：单局比较不能归因（评审 §0.43）；**至少三局同码取分布**。
2. **不许留无法证明的改动**：测试没变绿就 `git checkout` 撤回（我这次撤回三次）。
3. **测试必须能真的红**：夹具若用了和代码一样的错拼写（`airportbound`、`attackDog`），
   测试通过只证明"错误自洽" ✗ —— 修代码时**一并把夹具改成 API/规则的真实拼写**。
4. **改注释要读回去**：我两次把多行注释改成断句 ✗，必须重读。
5. **同类判断要横向比对**：这次的军犬 bug 与维修车 `gunner`，都是"同一文件四处同类判断，三处对、一处漏"。
6. **别用 `Copy-Item <目录>`** 覆盖已存在的目录（会拷进去而不是替换）✗。

## 6. 夹具与探针的坑（我耗时最多的地方）

- **`NAWEAP` 不在共用测试 catalog 里** ✗ → 用 `u()` 构造会抛
  `TypeError: Cannot read properties of undefined (reading 'weapon')`。
  **我三次"测试没变绿"都是这个异常，不是断言失败** —— 用**字面构造** `{ id, name, type, tile, ... }` 绕过。
- `economy.factories` **只数战车工厂**（`NAWEAP`），兵营不算。
- 科技建筑的 `buildCategory` 必须是 **`'Tech'`**（建造候选过滤要求它）。
- 要有真经济计划：**2 座矿场 + 2 辆矿车** → `targetMiners 3` → 缺口 1。
- 探针模板（字面构造 + 矩阵）：见本次会话最后两次 `node --input-type=module -e` 的写法。
