# agy-orch

[English](README.md) | [简体中文](README.zh-CN.md)

面向 Antigravity（Gemini）与外部专业代理（默认 Codex，可扩展 qodercli、pi、claude-code 等）的轻量编排运行时与 Skill。

## 定位与职责分工

- 主导代理（Gemini / agy）负责需求澄清、范围控制、界面与交互编写、任务拆分、对审阅意见做对抗式裁决（dispose）、最终集成以及面向用户的沟通。
- 外部专业代理（默认 Codex，也可替换为其他 CLI）负责方案只读审阅（review-plan）、有范围边界的逻辑实现与缺陷修复（delegate），以及包含前端状态竞态、重复提交与鉴权检查在内的只读代码审阅（review-changes）。
- 轻量分流门控（triage）先判断改动风险：纯文案、CSS 样式或单组件展示调整直接由主导代理完成，跳过外部审阅开销；涉及状态、并发、鉴权、接口或多文件改动时再按风险选择调用阶段。

## 目录结构

- `skills/agy-orch/SKILL.md`：Skill 主指令与工作流约束。
- `skills/agy-orch/scripts/agy-orch.mjs` 与 `skills/agy-orch/scripts/runtime/`：自包含的 CLI 入口与编排运行层（零第三方运行时依赖，基于 Node 24 原生 TypeScript 执行）。
- `skills/agy-orch/backends/`：内置后端描述文件（`agy.json`、`codex.json`、`qodercli.json`、`pi.json`、`claude-code.json`）。
- `skills/agy-orch/schemas/`：结构化输出校验 Schema（`review-output.schema.json`、`delegate-output.schema.json`）。
- `skills/agy-orch/references/`：按需加载的参考文档（`handoff-and-schemas.md`、`triage-and-disposition.md`、`backends-and-config.md`）。
- `skills/agy-orch/evals/`：`skill-creator` 评估用例与触发测试集。
- `bin/agy-orch.mjs`：仓库根目录命令行入口。
- `tests/`：单元测试与 CLI 端到端集成测试。
- `docs/`：环境核查、接入配置说明与验证报告。

## 快速安装与初始化

运行环境要求 Node.js 24 及以上版本，并在 `PATH` 中安装至少一个可用后端（如 `codex`）。

1. 克隆仓库并将 `skills/agy-orch` 软链到 Antigravity 全局技能目录（请勿覆盖已有技能）；由于运行层已内聚在 `skills/agy-orch/` 内，也可以单独复制 `skills/agy-orch` 目录进行安装：

```bash
git clone https://github.com/linziyanleo/agy-orch.git
cd agy-orch
ln -s "$(pwd)/skills/agy-orch" ~/.gemini/config/skills/agy-orch
```

2. 初始化用户默认配置（仅在文件不存在时创建 `~/.config/agy-orch/config.json`，不会修改 `~/.codex/config.toml`）：

```bash
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs config init
```

3. 检查本机可用后端与当前解析配置：

```bash
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs backends
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs config resolve --cwd . --role reviewer
```

4. 在仓库根目录运行内置单元测试与 CLI 集成测试：

```bash
npm test
```

## 常用配置与常用命令

- 修改模型或推理强度：编辑 `~/.config/agy-orch/config.json`（全局）或目标仓库 `.agy-orch/config.json`（仅允许 `roles` 与 `defaults`），或在命令中显式传入 `--model`、`--effort`、`--timeout-sec`。若当前 Codex 账号不支持指定模型或推理强度，运行时会明确返回 `invalid_parameter`，不会静默切换模型。
- 接入其他外部代理：在 `~/.config/agy-orch/backends/<name>.json` 放置后端 Profile，并通过 `--backend <name>` 或角色配置启用。
- 运行前先分流：

```bash
node ~/.gemini/config/skills/agy-orch/scripts/agy-orch.mjs triage --summary "修复结账按钮重复提交与响应竞态" --files "src/checkout/submit.ts" --kind logic
```

- 启动与管理后台任务：支持 `start <review-plan|delegate|review-changes>`、`status`、`result`、`list`、`cancel`、`check-freshness` 与 `dispose`。详细接入步骤与三个端到端示例见 [agy-orch接入配置与使用说明](docs/2026-11-25-14-37%20agy-orch接入配置与使用说明.md)。

## 贡献与协议

欢迎提交 Issue 或 Pull Request，协作规范见 [CONTRIBUTING.md](CONTRIBUTING.md) 与 [SECURITY.md](SECURITY.md)。本项目基于 [MIT License](LICENSE) 开源。
