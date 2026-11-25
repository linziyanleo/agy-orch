# agy-orch

[English](README.md) | [简体中文](README.zh-CN.md)

[![CI](https://github.com/linziyanleo/agy-orch/actions/workflows/ci.yml/badge.svg)](https://github.com/linziyanleo/agy-orch/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node 24+](https://img.shields.io/badge/node-%3E%3D24.0.0-brightgreen.svg)](package.json)

在 Antigravity 里直接调本机 Codex 审方案、查 Bug、改局部代码。

Gemini 擅长界面、需求梳理和与你对齐方向，Codex 擅长抓并发竞态、鉴权漏洞和复杂逻辑缺陷。`agy-orch` 把两者接进同一个对话流程里：小改动直接走，复杂改动叫 Codex 上场，审完把过度设计拦掉，改完代码自动提醒复审。

```text
Antigravity（Gemini）
   |
   +--> 改样式 / 改文案 -------------> Gemini 直接改完，不等 Codex
   |
   +--> 涉及状态 / 并发 / 鉴权 -------> 本机 Codex（review-plan / delegate / review-changes）
                                           |
                                           v
                                      dispose 裁决
                                （真 Bug 最小修复，过度设计直接驳回）
                                           |
                                           v
                             改完代码 -> 旧结论自动失效 -> --resume 原会话复审
```

## 为什么比直接写脚本调 Codex 好用

- 小改动不拖节奏。`triage` 先看改动风险，调个按钮间距或文案直接留在 Gemini 里秒改，不会每次都等几分钟外部审阅。
- 拦住审阅器的过度设计。干净上下文的模型很喜欢顺手建议加一套重试队列、插件抽象或大重构。`agy-orch` 要求每条意见必须给出具体 `file:line`、触发条件、影响和最小修复，再由 Gemini 走 `dispose` 逐条筛掉过度设计；同时对有实锤的缺陷卡死 2 轮上限，没修完绝不放行。
- 多任务并行不串会话。直接用 `codex exec resume --last` 一旦开两个任务就会续到别的线程里。`agy-orch` 按 `task_id` 绑定独立的 `backend_session_id`，跨仓库复用同一 ID 会直接报错拦住。
- 改完代码不会拿旧 LGTM 充数。`review-changes` 通过后只要工作区文件变了，`check-freshness` 立刻把旧审阅标成 `stale`，逼着拿最新代码复审。
- 多路 Codex 可以并行写代码不打架。同一目录并发委派会撞写锁，加上 `--worktree` 就会各开独立 Git worktree 同时推进；中途取消或超时直接按进程组（`-pgid`）杀干净，不留孤儿进程。
- 零第三方 npm 运行依赖。Node 24 直接跑，也不碰你的 `~/.codex/config.toml`。

## 一次真实协作长什么样

比如你修完结账页的重复提交 Bug，让 Antigravity 叫 Codex 查一遍：

1. Codex 在只读沙箱里看完 diff，返回两条结构化意见：
   - `F1`（`real_defect`）：`src/checkout/submit.ts:24` 在参数校验之前就把 `inFlight` 置为 `true`，校验抛错后按钮会永久锁死。
   - `F2`（`engineering_tradeoff`）：建议抽一个通用的请求重试中间件。
2. Gemini 执行 `dispose`：对 `F1` 采纳最小修复，对 `F2` 填理由驳回（`reject_overdesign`，单表单不需要引入重试层）。
3. 改完这 3 行代码后，`check-freshness` 自动把第 1 轮审阅标为失效（`stale_by_code_change`）。
4. Gemini 带 `--resume` 续接刚才同一个 Codex 会话跑第 2 轮复审，确认问题已清干净后交付给你。

## 安装

环境要求：macOS 或 Linux、Node.js 24+、Git，以及已登录的本机 [Codex CLI](https://github.com/openai/codex)（`codex` 在 `PATH` 中可用）。

### 方式 1：Antigravity 插件安装

```bash
agy plugin install https://github.com/linziyanleo/agy-orch
```

### 方式 2：Agent Skills CLI

```bash
npx skills add linziyanleo/agy-orch --skill agy-orch
```

<details>
<summary>本地开发：克隆仓库并软链（或单仓库复制安装）</summary>

```bash
git clone https://github.com/linziyanleo/agy-orch.git
cd agy-orch
mkdir -p ~/.gemini/config/skills
ln -s "$(pwd)/skills/agy-orch" ~/.gemini/config/skills/agy-orch
```

`skills/agy-orch/` 自带运行层、本地 ESM 声明、Schema 和后端配置，也可以直接复制到单个项目的 `.agents/skills/agy-orch` 里使用。

</details>

初始化用户配置（可选；默认留空 `model` 和 `effort`，直接沿用你本机 Codex 的默认模型）：

```bash
SKILL_DIR="$HOME/.gemini/config/skills/agy-orch"
node "$SKILL_DIR/scripts/agy-orch.mjs" config init
node "$SKILL_DIR/scripts/agy-orch.mjs" backends
```

## 在 Antigravity 里直接怎么说

装完直接说人话就行：

- “把 `src/styles/button.css` 里提交按钮的内边距调成 12px。”
  分流跳过 Codex，Gemini 直接改完。
- “我改了 `src/checkout/submit.ts` 防重复下单，叫 Codex 查一下有没有异步竞态或状态锁死。”
  跑只读 `review-changes`，按 `file:line` 证据列出真实缺陷并过滤多余建议。
- “先写退款状态机的改动方案，让 Codex 过一遍，需求外的抽象直接驳回。”
  跑 `review-plan`，通过 `dispose` 保留真实缺口、驳回过度设计。
- “把 `src/rate-limit/` 的限流修复派给 Codex 在独立 worktree 里改，别动我当前工作区。”
  后台起 `start delegate --worktree`，跑完对照 `src/rate-limit/` 检查改动范围。

## 命令行直接调用

所有命令都输出结构化 JSON，也可以在终端或脚本里直接用。

跑轻量分流：

```bash
node "$SKILL_DIR/scripts/agy-orch.mjs" triage \
  --summary "把首页按钮内边距改成 12px 并调整文案" \
  --files "src/styles/button.css" \
  --kind style
```

在当前仓库跑一次最小只读方案审阅：

```bash
cat <<'EOF' | node "$SKILL_DIR/scripts/agy-orch.mjs" review-plan --cwd "$(pwd)" --task-id demo-plan-1 --packet -
{
  "original_request": "给 POST /api/orders 增加幂等键校验，避免重复下单。",
  "goal": "检查方案是否存在并发竞态或不必要的复杂度。",
  "acceptance_criteria": [
    "相同幂等键重复请求时返回原订单，不创建重复记录。"
  ],
  "constraints": ["复用现有 SQLite 事务封装。"],
  "non_goals": ["引入 Redis 或独立异步队列。"],
  "relevant_files": ["README.zh-CN.md"],
  "plan": "1. 为 orders.idempotency_key 添加唯一索引。2. 在事务内捕获唯一键冲突并返回已有订单。"
}
EOF
```

裁决审阅结果、校验失效、续接复审或开隔离 worktree 并行委派：

```bash
node "$SKILL_DIR/scripts/agy-orch.mjs" dispose --run-id "$RUN_ID" --decisions '[{"finding_id":"F1","action":"minimal_fix","reason":"在事务内处理唯一键冲突并返回原记录"}]'
node "$SKILL_DIR/scripts/agy-orch.mjs" check-freshness --run-id "$REVIEW_RUN_ID"
node "$SKILL_DIR/scripts/agy-orch.mjs" review-changes --cwd "$(pwd)" --task-id demo-review-1 --resume --packet /path/to/packet.json
node "$SKILL_DIR/scripts/agy-orch.mjs" start delegate --cwd "$(pwd)" --task-id demo-worker-1 --worktree --packet /path/to/delegate.json
node "$SKILL_DIR/scripts/agy-orch.mjs" status --task-id demo-worker-1
node "$SKILL_DIR/scripts/agy-orch.mjs" cancel --run-id "$RUN_ID"
```

隔离 worktree 放在 `${AGY_ORCH_STATE_DIR:-~/.local/state/agy-orch}/worktrees/<run_id>`，跑完可以用 `git -C "$WORKTREE_PATH" diff` 检查并合入，最后用 `git worktree remove "$WORKTREE_PATH"` 清理。

## 配置与扩展后端

配置按从高到低生效：命令行参数（`--backend`、`--model`、`--effort`、`--timeout-sec`、`--role`）> 环境变量（`AGY_ORCH_*`）> 项目 `.agy-orch/config.json`（只读 `roles` 和 `defaults`，忽略二进制与命令覆写）> `~/.config/agy-orch/config.json` > 内置后端配置。切换后端时会自动丢弃原后端的 `model` 和 `effort`；要覆盖后端默认超时，直接配角色级 `timeout_sec` 或传 `--timeout-sec`。

目前围绕 `codex` 做了完整实测。仓库里也附带了 `agy`、`qodercli`、`pi`、`claude-code` 的实验性 JSON Profile（`skills/agy-orch/backends/`），或者直接在 `~/.config/agy-orch/backends/<name>.json` 接入你自己的 CLI。

更多参考：
- 交接包与输出 Schema：[handoff-and-schemas.md](skills/agy-orch/references/handoff-and-schemas.md)
- 分流与 2 轮裁决细则：[triage-and-disposition.md](skills/agy-orch/references/triage-and-disposition.md)
- 后端与配置参考：[backends-and-config.md](skills/agy-orch/references/backends-and-config.md)
- 完整端到端示例：[agy-orch接入配置与使用说明](docs/2026-11-25-14-37%20agy-orch接入配置与使用说明.md)

## 贡献与协议

提 PR 前请先跑通 `npm test`，详见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。基于 [MIT License](LICENSE) 开源。
