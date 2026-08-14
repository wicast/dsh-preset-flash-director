# dsh-preset-flash-director

**Flash 主控 · Pro 专家** —— DeepSeek Harness 的省 token 模式预设。

> flash 级模型当主控（分诊 / 取证 / 机械执行 / 验收），深度思考类任务通过**策略工具**委派给 deepseek-v4-pro 专家子代理；简报强制校验 + 硬性预算，从机制上防止"弱智能指挥强智能"和"pro 烧钱失控"。

[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE) [![topic](https://img.shields.io/badge/topic-dsh--plugin-1f883d)](https://github.com/topics/dsh-plugin)

---

## 目录

- [这是什么](#这是什么)
- [为什么省 token](#为什么省-token)
- [架构](#架构)
- [协议摘要](#协议摘要)
- [安装](#安装)
- [使用](#使用)
- [配置](#配置)
- [卸载](#卸载)
- [排障](#排障)
- [安全与信任](#安全与信任)
- [许可证](#许可证)

---

## 这是什么

一个 DeepSeek Harness **agent preset**（代理预设），由三部分构成：

| 文件 | 作用 |
|---|---|
| `flash-director/agent.cordis.yml` | 组合文件：controller persona 协议 + 行裁剪（移除裸 `subagent`/`subagent_fork`/`workflow`/`ralph`） |
| `flash-director/expert-delegation.mjs` | 预设本地策略插件（零依赖）：`expert_consult` / `expert_review` 工具 + 简报校验 + 预算账本 |
| `flash-director/preset.yml` | 名册元数据（名称/描述） |

核心设计：**委派是默认，主控自己做深度思考是例外**。所有"深思考"工作（规划设计、架构权衡、根因分析、高风险决策、对抗性审查）只能走 `expert_consult` / `expert_review`，且专家固定跑 `deepseek-v4-pro`；主控负责读文件、跑命令、机械修改、按预写清单验证。

## 为什么省 token

- **pro 的输入 token 最贵**：每次委派 = 简报（主控写、专家读）+ pro 生成 + 回传（主控读）。协议强制主控先取证、精炼简报（工具硬上限），专家从不空手探索工作区，也从不接触主控的对话历史。
- **flash 的上下文便宜**：一切"读"的活（大文件、日志、搜索）都由主控完成，机械修改也在主控侧落地。
- **有界追问**：专家子代理是 continuable 的，验收不通过时可用 `send_message` 做一次增量追问（复用同一上下文，不必重付简报）；二次不达标即停止并向用户报告，杜绝 ping-pong。
- **硬预算**：每用户任务默认 3 次专家启动（新人类消息自动重置），`stakes: high` 审查计 2 次，用完即拒。

## 架构

```
用户 ──► 主控（deepseek-v4-flash，本预设 persona）
            │  分诊 / 取证 / 机械执行 / 验收
            │
            ├── expert_consult(kind, task, background, evidence, acceptance)
            │        │  简报校验（必填+有界）→ 预算记账 → startContinuable
            │        ▼
            │   pro 专家子代理（deepseek-v4-pro，continuable）
            │        · per-child persona：只"想"不"读"、结构化报告、必须 report
            │        · toolFilter 摘除：委派/写入/问人/后台任务/目标 等工具
            │        · 异步回报 "Background subagent <id> reported:"
            │
            ├── expert_review(subject, content, stakes)   ← 对抗性审查（可审自己）
            │
            └── send_message（追问，最多一次）/ interrupt_agent（止损）
```

关键机制（全部在策略插件内硬性执行，不靠模型自觉）：

1. **简报校验**：`task`/`background`/`evidence`/`acceptance` 必填且有界（单字段 ≤6000 字符，简报 ≤12000），超大即拒绝。
2. **预算账本**：按 agent 记账，`agent/pre-step` 检测到新人类消息（`source.kind === 'user'`）时清零。
3. **禁止专家链**：专家子代理被摘除一切委派/写入工具，只能通过 `bash`/`read` 等低成本手段验证假设，不能修改工作区。
4. **验收循环**：主控在委派**之前**写好 `acceptance` 清单，专家回报后逐项机械验证（跑测试/命令/查格式），这是"弱指挥强"的支点。

## 协议摘要

**必须委派给专家**（禁止主控硬做）：多步方案/架构/重构设计；需求模糊时的任务分解；难 bug 根因分析；高风险变更（schema/迁移/安全）决策；复杂 diff 或主控自己产出的方案审查。

**主控自己做**：读/搜/跑命令、机械编辑、摘要整理、常规修复、落地执行专家方案、按清单验证。

**委派四步**：① 取证（evidence 为空会被拒绝）→ ② 简报完整（task = 一个认知问题；acceptance = 委派前写好的可验证清单）→ ③ 等待异步回报 → ④ 对照 acceptance 验证；缺口 → 一次 `send_message` 追问；仍不达标 → 停止并向用户报告。

## 安装

### 方式一：git 克隆后拷贝（最直接）

```bash
git clone https://github.com/zhaoyilun/dsh-preset-flash-director.git
mkdir -p ~/.dsh/.agent-presets
cp -R dsh-preset-flash-director/flash-director ~/.dsh/.agent-presets/
```

### 方式二：仓库内的安装脚本

```bash
git clone https://github.com/zhaoyilun/dsh-preset-flash-director.git
cd dsh-preset-flash-director
./install.sh        # 已存在则自动备份
```

### 方式三：npm 包装包

```bash
npm install -g dsh-preset-flash-director   # 或 npx dsh-preset-flash-director install
dsh-preset-flash-director install
dsh-preset-flash-director info             # 查看安装状态
```

> 安装即拷贝目录，**无需重启**：DSH 名册每次调用都会重扫预设根目录。卸载用 `dsh-preset-flash-director uninstall`（保留备份）。

## 使用

1. 打开 DeepSeek Harness Web UI，**新开会话**，预设选择 **Flash 主控 · Pro 专家**。
2. 把会话模型切换为 **deepseek-v4-flash**（模型路由是会话级用户选择；本预设不也不应自设模型）。
3. 验证：工具列表应出现 `expert_consult` / `expert_review`，且**不应**出现裸 `subagent` / `subagent_fork` / `workflow` / `ralph`。
4. 直接发任务。观察主控先取证、再委派、再验收的节奏；专家报告以 `Background subagent <id> reported:` 帧到达。

### 模型适配

默认专家模型为 `deepseek-official` / `deepseek-v4-pro`。若你的部署模型 id 不同，改 `flash-director/agent.cordis.yml` 中 `expert-delegation` 行的 config（插件有同值兜底）：

```yaml
- id: expert-delegation
  name: ./expert-delegation.mjs
  config:
    expertProvider: deepseek-official
    expertModel: deepseek-v4-pro
    expertMaxTokens: 8192
    maxExpertsPerUserTask: 3
    briefMaxChars: 12000
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `expertProvider` | `deepseek-official` | 专家子代理的 provider 路由 |
| `expertModel` | `deepseek-v4-pro` | 专家子代理模型（主控则用会话级模型选择） |
| `expertMaxTokens` | `8192` | 专家子代理每次请求的输出上限 |
| `maxExpertsPerUserTask` | `3` | 每个用户任务的专家启动硬上限（`stakes: high` 审查计 2） |
| `briefMaxChars` | `12000` | 简报硬上限（单字段另限 6000） |

## 卸载

```bash
rm -rf ~/.dsh/.agent-presets/flash-director    # 或 dsh-preset-flash-director uninstall
```

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| 委派返回 `rejected` | 简报缺字段或超限：补全/精炼 `evidence`、`background`、`acceptance` 后重试 |
| 委派返回 `budget-exhausted` | 本用户任务预算耗尽：主控自行收尾并告知用户；新消息后自动重置；或调大 `maxExpertsPerUserTask` |
| 专家迟迟不回报 | `list_agents` 查看状态；跑飞可用 `interrupt_agent` 止损；确认模型 id 正确（无效模型会让子代理报错） |
| 工具列表没有 `expert_consult` | 预设未安装（重跑安装脚本）或会话未重建（新开会话） |
| 不想用 flash 主控 | 该预设也兼容 pro 主控（只是省 token 效果打折）；或换回标准模式 |

## 安全与信任

- 预设是**信任边界**：`expert-delegation.mjs` 是随预设执行的宿主侧代码，安装前请审阅源码（本包完全开源、零依赖、无网络请求）。
- 专家子代理可运行 `bash`（persona 要求只读/无副作用使用），但**无法**写文件、委派、与用户对话；其所有行为仍受宿主沙箱与审批策略约束。
- 本预设与 DeepSeek 官方无隶属关系，社区分享，按 MIT 许可使用。

## 许可证

MIT © 赵义仑 (zhaoyilun)
