# 败因记录

每一行是一局，由 `node tools/postmortem.mjs --append <战报>` 写入，判定只依据
`match.history` 里已经有的数字（我方单位 / 建筑、敌军单位、资金、新建 / 损失 / 击毁），
不靠读题面或猜。阈值是 `tools/postmortem.mjs` 顶部的具名常量，
所以对一条判定有异议，是对一个数字有异议。

**单局不能验证任何改动**（评审 §0.43）。这张表的作用是让三局同码的对比成立，
以及让"同一个死法又发生了"变成一件看得见的事。

| 战报 | 构建 | 结果 | 判定 | 时长 | 我方部队 峰→末 | 新建/损失/击毁 | 击杀比 |
| --- | --- | --- | --- | --- | --- | --- | --- |
| jev-report-20261014-214423 | a0d12a3-dirty | defeat | **economic_stall** | 1608s | 16→2 | 60/57/31 | 0.54 |
| jev-report-20261014-215900 | a0d12a3-dirty | defeat | **economic_stall** | 2927s | 21→0 | 129/129/151 | 1.17 |
| jev-report-20261014-231556 | 4a7d885-dirty | defeat | **economic_stall** | 3265s | 21→1 | 134/133/187 | 1.41 |
| jev-report-20261014-233357 | 4a7d885-dirty | defeat | **economic_stall** | 2085s | 20→3 | 73/70/115 | 1.64 |
| jev-report-20261014-234919 | 12baa9e-dirty | defeat | **economic_stall** | 1009s | 9→2 | 28/26/41 | 1.58 |
| jev-report-20261014-234353 | 4a7d885-dirty |  | **overrun** | 865s | 10→0 | 47/44/240 | 5.45 |
| jev-report-20261015-000251 | a86cea3-dirty | defeat | **economic_stall** | 3666s | 17→0 | 87/87/239 | 2.75 |
| jev-report-20261015-024314 | 4d7798d | defeat | **economic_stall** | 2163s | 16→2 | 112/110/71 | 0.65 |
| jev-report-20261015-030433 | 4d7798d | ended | **economic_stall** | 3862s | 17→12 | 81/48/179 | 3.73 |
| jev-report-20261015-032110 | 4d7798d |  | **economic_stall** | 4604s | 21→1 | 93/64/153 | 2.39 |
| jev-report-20261015-043756 | 30250c1-dirty | ended | **attrition** | 6533s | 23→23 | 121/67/109 | 1.63 |
| jev-report-20261015-051331 | 3f0a9c8-dirty | defeat | **economic_stall** | 2476s | 32→0 | 114/114/78 | 0.68 |
| jev-report-20261015-054554 | 9a3bc17-dirty | ended | **attrition** | 2794s | 27→23 | 85/42/60 | 1.43 |
