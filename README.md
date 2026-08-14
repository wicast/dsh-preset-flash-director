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
- [使用指南](#使用指南)
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

1. **简报校验**：`task`/`background`/`evidence`/`acceptance` 必填且有界（简报整体 ≤40000，task ≤4000、background ≤16000、evidence ≤20000），超大即拒绝。
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

## 使用指南

### 快速上手（5 步）

1. 按上文安装预设；
2. 打开 DeepSeek Harness Web UI，**新开会话**，预设选择 **Flash 主控 · Pro 专家**；
3. 把会话模型切换为 **deepseek-v4-flash**（模型路由是会话级用户选择；本预设不也不应自设模型）；
4. 验证工具列表：应出现 `expert_consult` / `expert_review`，**不应**出现裸 `subagent` / `subagent_fork` / `workflow` / `ralph`；
5. 发一个真实任务。观察主控的节奏：**先取证 → 再委派 → 收到报告后验证 → 落地**；专家报告以 `Background subagent <id> reported:` 帧到达。

### 委派决策速查

| 必须委派给专家（禁止自己硬做） | 主控自己做（便宜，直接干） |
|---|---|
| 多步方案 / 架构 / 重构设计（"这个服务该怎么拆"） | 读文件、搜索、跑命令、看日志 |
| 需求模糊时的澄清与任务分解 | 重命名、格式化、样板代码等机械修改 |
| 难 bug 的根因分析（**先取证再委派**） | 按专家方案落地实现、改配置、调接口 |
| 高风险变更决策（schema 变更、迁移、安全） | 跑测试、验证行为、检查 diff |
| 复杂 diff / 你自己产出的方案的审查（`expert_review`） | 汇总、摘要、写说明 |

**一句话判断**：需要更多上下文 → 自己做（你的上下文便宜）；需要更深思考 → 委派（但要把上下文精炼成简报）。

### 怎么写一份合格的简报（`expert_consult` 参数）

| 参数 | 要求 | 上限 |
|---|---|---|
| `kind` | `plan` / `design` / `debug` / `analysis` 四选一，决定专家侧重点 | — |
| `task` | **一个认知问题**，不是操作。❌"重构 payment.ts" → ✅"支付模块当前分层是否合理？给出拆分方案与迁移路径" | 4000 |
| `background` | 现状、已尝试过什么、已知约束 | 16000 |
| `evidence` | 主控已收集的事实：文件关键片段、命令输出、日志摘录。**放摘录不放整文件** | 20000 |
| `constraints` | 硬约束列表（可不填） | — |
| `acceptance` | **委派之前**写好的、可机械验证的清单，≥1 条 | — |

简报整体上限 40000 字符。被拒绝时工具会告诉你缺什么/超了多少——按提示精炼后重试。

### 完整调用示例（主控实际传给工具的参数形状）

设计类任务：

```json
{
  "kind": "design",
  "task": "订单与支付之间应如何拆分？给出推荐方案与权衡。",
  "background": "当前是单体，订单模块直接调支付网关 SDK；QPS 峰值 800，目标是双活部署。单体内加缓存已试过，效果有限。",
  "evidence": "payment.ts 主流程 320 行（关键片段已摘录）；订单表索引现状；网关 SDK 限流参数 1000/s；压测峰值 812 QPS @ p99 420ms。",
  "constraints": ["不引入新中间件（部署团队限制）", "迁移期间旧接口必须保持兼容"],
  "acceptance": [
    "列出 ≥2 个候选方案并给出取舍依据",
    "明确数据一致性边界（哪张表归哪个服务）",
    "给出 ≤3 步、每步可独立回滚的迁移路径",
    "不引入新中间件"
  ]
}
```

调试类任务（先取证再委派）：

```json
{
  "kind": "debug",
  "task": "这个 flaky 测试的根因是什么？给出最小修复与回归测试方案。",
  "background": "test_checkout 偶发失败，本地复现率约 20%，CI 上约 5%。重试能过。",
  "evidence": "失败堆栈（已摘录）；checkout 服务日志 200 行；疑似竞态的代码段；已排除：无外部依赖、非时间相关（时区固定）、DB 隔离级别已确认。",
  "acceptance": [
    "指出根因并给出证据链（不能只给猜测）",
    "给出最小修复，且修复后本地连续跑 20 次不失败",
    "给出一个能稳定复现的回归测试思路"
  ]
}
```

### 收到报告后：验收循环

1. 报告以 `Background subagent <id> reported:` 到达，内容按「结论 / 依据 / 风险与未决」组织；
2. **逐条对照你的 acceptance 打勾**，用可执行手段确认：跑测试、跑命令、看 diff、查格式；
3. 有缺口 → **最多一次** `send_message` 追问（指明哪条没过、要补什么）：

   ```
   send_message(subagent_id=<id>,
     message="验收第 3 条没过：迁移路径第 2 步会破坏旧接口兼容（/v1/orders 不再可用）。请只补这一部分的替代方案。")
   ```

4. 追问后仍不达标 → **停止**，向用户如实报告分歧点，不要第三次委派。

### 用 `expert_review` 审查（元认知循环）

- 适用：高风险变更上线前（DB schema 变更、迁移、安全改动）；你对专家方案有疑虑时（用它审专家的方案 = 双专家把关）；你自己的设计/计划/diff 交付前。
- `subject` 一句话说明审什么；`content` 放完整材料（≤40000）；`criteria` 放你的具体疑虑；`stakes: high` 表示不可逆变更（计 2 次预算）。
- 收到审查报告后：**逐条处理 blocking 意见**，落实 must-fix 清单，裁定为"通过"才继续（或用户明确豁免）。

### 预算行为实例

- 默认每用户任务 **3 次**专家启动；`expert_review(stakes: high)` 计 **2 次**；新用户消息到达自动重置。
- 例：一个服务拆分任务，`design(1) + review(high, 2) = 3`，正好用满；同一任务内再想委派会被 `budget-exhausted` 拒绝，主控自行收尾并告知你。
- 想放宽：把 `agent.cordis.yml` 里 `expert-delegation` 行的 `maxExpertsPerUserTask` 调大（见下）。

### 一个完整流程示例（叙事）

"给支付模块做服务化拆分"：

1. 主控读 `payment.ts`、跑现有测试、拉接口清单、确认网关限流参数 → 收集成 `evidence`；
2. `expert_consult(kind=design, ...)` → 专家给拆分方案与迁移路径；
3. 主控对照 acceptance 逐条验证（方案覆盖两个候选、一致性边界明确、迁移三步可回滚）→ 通过；
4. 主控按方案落地机械改动：建服务骨架、改路由、迁移表结构（小步提交）；
5. `expert_review(stakes=high)` 审查迁移路径 → 修复 blocking 意见；
6. 跑全量测试 → 交付并汇报验证结果。

### 模型适配

默认专家模型为 `deepseek-official` / `deepseek-v4-pro`。若你的部署模型 id 不同，改 `flash-director/agent.cordis.yml` 中 `expert-delegation` 行的 config（插件有同值兜底）：

```yaml
- id: expert-delegation
  name: ./expert-delegation.mjs
  config:
    expertProvider: deepseek-official
    expertModel: deepseek-v4-pro
    expertMaxTokens: 32768
    maxExpertsPerUserTask: 3
    briefMaxChars: 40000
```

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `expertProvider` | `deepseek-official` | 专家子代理的 provider 路由 |
| `expertModel` | `deepseek-v4-pro` | 专家子代理模型（主控则用会话级模型选择） |
| `expertMaxTokens` | `32768` | 专家子代理每次请求的输出上限（**含思考 token**——pro 在 max 推理档下思考会占大头，太小会导致正文报告写不完被截断） |
| `maxExpertsPerUserTask` | `3` | 每个用户任务的专家启动硬上限（`stakes: high` 审查计 2） |
| `briefMaxChars` | `40000` | 简报整体硬上限；单字段：task ≤4000、background ≤16000、evidence ≤20000、审查内容 ≤40000 |

## 卸载

```bash
rm -rf ~/.dsh/.agent-presets/flash-director    # 或 dsh-preset-flash-director uninstall
```

## 排障

| 现象 | 原因 / 处理 |
|---|---|
| 委派返回 `rejected` | 简报缺字段或超限：按返回信息补全/精炼 `evidence`、`background`、`acceptance` 后重试（上限见配置表） |
| 委派返回 `budget-exhausted` | 本用户任务预算耗尽：主控自行收尾并告知用户；新消息后自动重置；或调大 `maxExpertsPerUserTask` |
| 专家迟迟不回报 | `list_agents` 查看状态；跑飞可用 `interrupt_agent` 止损；确认模型 id 正确（无效模型会让子代理报错） |
| 工具列表没有 `expert_consult` | 预设未安装（重跑安装脚本）或会话未重建（新开会话） |
| 主控好像没在委派、自己在硬做设计 | 那是协议违规：提醒它"深度思考任务必须走 expert_consult/expert_review"；仍不改就换回标准模式 |
| 不想用 flash 主控 | 该预设也兼容 pro 主控（只是省 token 效果打折）；或换回标准模式 |

## 安全与信任

- 预设是**信任边界**：`expert-delegation.mjs` 是随预设执行的宿主侧代码，安装前请审阅源码（本包完全开源、零依赖、无网络请求）。
- 专家子代理可运行 `bash`（persona 要求只读/无副作用使用），但**无法**写文件、委派、与用户对话；其所有行为仍受宿主沙箱与审批策略约束。
- 本预设与 DeepSeek 官方无隶属关系，社区分享，按 MIT 许可使用。

## 许可证

MIT © 赵义仑 (zhaoyilun)
