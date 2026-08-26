# dsh-flash-director-ui

**Flash 主控 · Pro 专家** 预设的配置界面 —— 复用 DSH 设置页编辑预设的两类配置。

- 设置侧栏新增 **「Flash 主控」** 分区页（`settings.section` slot），复用 `--dsw-*` 设计令牌；
- 官方**「插件配置」**页出现 **Flash 主控 · Pro 专家** 卡片（`settings.plugin.item`，key=`flash-director`，对齐服务端 settings 命名空间 `flash-director` + schemastery schema）。

## 能操作什么

| 配置 | 文件 | 键 | 生效时机 |
|---|---|---|---|
| 覆盖文件 | `expert-delegation.config.json`（`$FLASH_DIRECTOR_CONFIG` 优先，否则活动 preset 目录） | 9 键（含 `followupRetryBudget`/`expertReasoningEffort`） | 保存后**下次委派**即生效（mtime 热加载） |
| 基线 | `agent.cordis.yml`（expert-delegation 行 config 块） | 7 键 | 改动需**新开会话**生效 |

- 覆盖文件是**部分覆盖**语义：留空的键回退基线/默认；表单里清空某键 = 从覆盖文件移除。
- `expertReasoningEffort` 无默认（缺省 = 不注入思考强度），只能走覆盖文件；`followupRetryBudget` 同理。
- 官方表单（schemastery 渲染）提交时经 `scope.watch` **单向镜像**到覆盖文件——不反向，无循环。

## 文件

```
ui/
├── package.json          # DSH 插件包（peerDeps 由 Desktop 运行时解析，零新增安装）
├── cordis.patch.yml      # dsh plugin --profile web add 路径的 insert patch
├── lib/
│   ├── index.js          # 服务端半：settings 注册 + watch 镜像 + HTTP 端点
│   ├── client.js         # 客户端半：__ModuleLoader__.load bundle（设置分区页 + 卡片）
│   ├── paths.mjs         # 纯函数：路径解析（每次实时重算，不缓存）
│   ├── schema.mjs        # 纯函数：9 键 schema / 校验 / 归一化 / 生效值合并
│   └── cordis-patch.mjs  # 纯函数：基线行级定位/读取/打补丁（逐字保留其余内容）
└── test/                 # node:test 单测（纯函数 + 服务端集成，mock webServer/settings）
```

## 安装（接入运行中的 DSH web profile）

```bash
# 1. 在 ~/.dsh/profiles/web/package.json 加入：
#    dependencies:  "dsh-flash-director-ui": "link:/path/to/dsh-preset-flash-director/ui"
#    dsh.profile.bundles: "dsh-flash-director-ui"
# 2. 在 profile 目录执行：
cd ~/.dsh/profiles/web && pnpm install
# 3. 重启 DSH Desktop（web profile 在启动时加载 bundles），刷新页面
```

依赖解析：`@deepseek-ai/{dsh-settings,schemastery,cordis}` 与 `js-yaml` 由 Desktop
运行时从 `app.asar.unpacked/node_modules` 提供（peerDeps 声明，profile 的
`autoInstallPeers: false` 不会尝试安装）。

## HTTP 端点

| 端点 | 方法 | 说明 |
|---|---|---|
| `/api/flash-director/state` | GET | 路径 / override / baseline / 生效值（逐键标注来源） |
| `/api/flash-director/override` | POST | `{values}` 写覆盖文件（已知键整体替换）；空对象 = 移除覆盖文件 |
| `/api/flash-director/baseline` | POST | `{patch}` 行级 patch 基线（写前备份 + 写后宽容 YAML 校验，失败回滚 409） |

全部端点带同源校验（`127.0.0.1`/`localhost`），跨源 403。

## 活动 preset 目录解析

1. `$FLASH_DIRECTOR_PRESET_DIR`（显式覆盖）
2. `$DSH_HOME/.agent-presets/flash-director`（安装态，DSH 实际使用）
3. 仓库内 `flash-director/`（开发态回退）

## 开发

```bash
node --test "ui/test/*.test.mjs"   # 纯函数 + 服务端集成单测
```

`ui/node_modules/` 是开发期符号链接（指向 DSH Desktop 的 node_modules），已被
`.gitignore` 覆盖，不入库；`ui/lib/index.js` 顶层 import 需要它才能被 node 直接加载。
