# 模型权重来源与许可

## 内容

`models\laya-multilingual\` 是 Laya 的**多语言检查点**（`laya-multilingual`），不是本仓库的训练产物，
随包分发的是上游发布的原始权重文件，未做任何修改。

| 文件 | 大小 | 说明 |
| --- | --- | --- |
| `model.safetensors` | 643,835,514 B | 权重本体（mmBERT 底座 + 决策头，约 3.22 亿参数） |
| `encoder\config.json` | 1,938 B | 编码器配置 |
| `tokenizer\tokenizer.json` | 34,363,188 B | 分词器（256k 词表） |
| `tokenizer\tokenizer_config.json` | 502 B | 分词器配置 |
| `rl_agent_config.json` | 472 B | 决策头配置（`max_len: 1024`、`head_max_len: 256` 等） |
| `configuration.json` | 77 B | 占位配置 |

## 出处

- **上游发布**：Hugging Face `convaiinnovations/laya-multilingual`
- **本包实际来源**：ModelScope 镜像 `https://www.modelscope.cn/models/convaiinnovations/laya-multilingual`
  （抓取时 Hugging Face 在部署网络内不可达，两个来源是同一份权重）
- **抓取方式**：`tools\laya-model-fetch.py`（仅使用 Python 标准库，只取上面这 6 个文件，
  不下载仓库里的评测图片与 notebook）

## 许可

- 模型权重：**Apache-2.0**（随上游 `convaiinnovations/laya` 系列发布）
- 运行库 `laya`（含本包使用的 `laya-serve` HTTP 层）：**Apache-2.0**，全文见 `LICENSES\laya-LICENSE`
- 其余 Python 依赖：见 `wheels\` 内各 `*-dist-info\licenses\` 目录

## 分发注意

把本包转给别人时，请连同 `LICENSES\` 与本文件一起给出；若你修改了权重或在其上做了微调，
按 Apache-2.0 需要注明改动并保留原始版权声明。

## 校验

权重文件的 SHA-256 记在包根目录的 `MANIFEST.sha256` 里。校验方法见 `离线部署说明.md` 第 7 节。
