# Contributing · 贡献指南

Thanks for your interest in **b2b-call-agent**! This is an open-source MIT-licensed project — issues, PRs, ideas, and forks are all welcome.

感谢关注 **b2b-call-agent**！这是一个 MIT 许可的开源项目 —— 欢迎提 issue / PR / 想法 / fork。

---

## 中文

### 几种参与方式

- **报 Bug**：在 [Issues](https://github.com/jinweihan-ai/b2b_call_agent/issues) 里描述复现路径、看到的现象、预期的现象。日志/截图很有帮助。
- **提需求**：开 issue 时打上 `enhancement` 标签，简单说一下场景和动机。如果是新功能而不是修补，最好先讨论再写代码。
- **直接发 PR**：见下方"开发流程"。小改动直接 PR；大改动建议先开 issue 对齐。
- **分享你的部署案例**：如果你拿这套东西改造给自己工厂或客户用了，欢迎在 Discussions 里贴个简介，给社区做参考。

### 开发流程

1. **Fork + Clone**

   ```bash
   git clone git@github.com:<your-username>/b2b_call_agent.git
   cd b2b_call_agent
   npm install
   ```

2. **配置环境**

   ```bash
   cp .dev.vars.example .dev.vars
   # 编辑 .dev.vars 填进你自己的 key
   ```

3. **本地跑**

   ```bash
   npx wrangler dev
   # 改文件会自动 reload
   ```

4. **类型检查**

   ```bash
   npx tsc --noEmit
   # 必须零错误才能合
   ```

5. **建分支 + 提交**

   ```bash
   git checkout -b feat/your-feature
   # ... 改代码 ...
   git commit -m "feat: <one-line summary>"
   ```

6. **发 PR**

   - 描述里写清楚改了什么、为什么改、怎么测
   - 如果对应已有 issue，链上去
   - 截图欢迎（特别是 UI 改动）

### 代码风格

- **TypeScript strict 模式** —— 别 `any`，宁愿写显式类型
- **单文件 < 1500 行** —— 超了就拆
- **不预设抽象** —— 三行相似代码 > 一个早熟的抽象
- **错误处理只在边界** —— 外部 API、用户输入要检查；内部模块之间相信对方
- **注释只在需要解释 WHY 时写** —— 代码本身已经能说 WHAT 的就别注释
- **不要为了"以防万一"加 fallback** —— 用 TypeScript + 测试保障，不靠运行时兜底

### 哪些改动比较受欢迎

- ✅ 新的语言支持（西班牙语 / 阿拉伯语 / 葡萄牙语等）
- ✅ 新的 CRM 后端（HubSpot / Salesforce / 飞书 / 钉钉 OA 同步）
- ✅ 新的下游集成（更多 MCP tools、webhook 订阅、OpenAPI 自动生成）
- ✅ 性能改善（语音路径延迟、Gemini token 优化）
- ✅ 多租户隔离（生产 SaaS 化方向）
- ✅ 测试覆盖（任何）
- ✅ 文档改进（README / 注释 / 错误信息）

### 哪些改动不太受欢迎

- ❌ 全文件级别的代码风格"清理" —— 风格分歧请先开 issue 讨论
- ❌ 加大依赖（拉新的 npm 包做小事）—— 先看看 stdlib 或现有 lib 能不能用
- ❌ 把演示用的 FerroLaser 数据替换成别的具体厂家 —— 项目要保持**通用**

### 报安全问题

发现密钥泄漏 / 注入漏洞 / 权限绕过等安全问题，**请不要在公开 issue 里报**。请通过 GitHub 私信功能联系仓库所有者。

### 提交即视为同意 MIT

发 PR 即视为你同意：你的贡献按 [MIT License](LICENSE) 授权给本项目和它的下游用户。

---

## English

### Ways to contribute

- **File bugs**: open an [issue](https://github.com/jinweihan-ai/b2b_call_agent/issues) with repro steps, observed vs expected behavior. Logs / screenshots help.
- **Request features**: open an issue tagged `enhancement` with the scenario and motivation. For larger features, discuss first before coding.
- **Send PRs**: see "Dev workflow" below. Small changes → PR directly; large changes → issue first to align.
- **Share deployments**: if you've adapted this for your own factory or customers, post a brief writeup in Discussions for the community to learn from.

### Dev workflow

1. **Fork + clone**

   ```bash
   git clone git@github.com:<your-username>/b2b_call_agent.git
   cd b2b_call_agent
   npm install
   ```

2. **Configure env**

   ```bash
   cp .dev.vars.example .dev.vars
   # Edit .dev.vars with your own keys
   ```

3. **Run locally**

   ```bash
   npx wrangler dev
   # File saves auto-reload
   ```

4. **Type-check**

   ```bash
   npx tsc --noEmit
   # Must be zero errors to merge
   ```

5. **Branch + commit**

   ```bash
   git checkout -b feat/your-feature
   # ... make changes ...
   git commit -m "feat: <one-line summary>"
   ```

6. **Open a PR**

   - In the description: what changed, why, how you tested
   - Link to any related issue
   - Screenshots welcome (especially for UI changes)

### Code style

- **TypeScript strict** — no `any`; prefer explicit types
- **Single file < 1500 lines** — split if it grows past
- **No premature abstraction** — three similar lines beat one early abstraction
- **Error handling only at boundaries** — validate external APIs and user input; trust internal calls
- **Comments only when explaining WHY** — if the code already says WHAT, skip the comment
- **No "just in case" fallbacks** — rely on TypeScript + tests, not runtime guards

### Welcome changes

- ✅ New language support (Spanish / Arabic / Portuguese / etc.)
- ✅ New CRM backends (HubSpot / Salesforce / Feishu / Dingtalk OA sync)
- ✅ New downstream integrations (more MCP tools, webhook subscriptions, OpenAPI autogen)
- ✅ Performance improvements (voice-path latency, Gemini token efficiency)
- ✅ Multi-tenant isolation (toward production SaaS)
- ✅ Test coverage (any kind)
- ✅ Doc improvements (README / inline / error messages)

### Less welcome

- ❌ Whole-file "style cleanups" — discuss style disagreements in an issue first
- ❌ Adding heavyweight deps for small tasks — check stdlib / existing libs first
- ❌ Replacing the demo FerroLaser catalog with another specific vendor — the project must stay **generic**

### Security issues

If you find a secret leak / injection / auth bypass, **do not file a public issue**. Use GitHub's private security advisory or DM the repo owner.

### By submitting, you agree to MIT

Opening a PR means you agree your contribution is licensed under [MIT License](LICENSE) for this project and all downstream users.

---

## Communication

- **Issues**: [github.com/jinweihan-ai/b2b_call_agent/issues](https://github.com/jinweihan-ai/b2b_call_agent/issues)
- **Discussions** (if enabled): [github.com/jinweihan-ai/b2b_call_agent/discussions](https://github.com/jinweihan-ai/b2b_call_agent/discussions)

Thanks for helping make this useful for the next factory.
