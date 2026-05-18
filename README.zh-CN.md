# b2b-call-agent

> 给中国 B2B 外贸制造业的 AI 询盘副驾驶 —— 你团队睡觉的时候它替你接电话，提取需求、生成回复草稿、把成包的待发动作交给销售。

> 🌐 [English](README.md) · **中文**

[![License: MIT](https://img.shields.io/github/license/jinweihan-ai/b2b_call_agent?color=blue)](LICENSE)
[![TypeScript strict](https://img.shields.io/badge/TypeScript-strict-3178C6?logo=typescript&logoColor=white)](tsconfig.json)
[![Cloudflare Workers](https://img.shields.io/badge/runtime-Cloudflare%20Workers-F38020?logo=cloudflare&logoColor=white)](https://workers.cloudflare.com)
[![MCP](https://img.shields.io/badge/MCP-Streamable%20HTTP-8A2BE2)](https://modelcontextprotocol.io)
[![PRs welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](CONTRIBUTING.md)
[![GitHub stars](https://img.shields.io/github/stars/jinweihan-ai/b2b_call_agent?style=social)](https://github.com/jinweihan-ai/b2b_call_agent/stargazers)

---

## 截图

**销售仪表盘** —— 一个客户一张卡（按电话去重），AI 准备状态 + 背调富化信息直接展示。

![销售仪表盘 · CRM kanban 流水线](docs/screenshots/dashboard.png)

**客户工作台 · Brief 部分** —— 一个客户一个 URL（`/person/+phone`）。内嵌改名、资质评分、来电方背调摘要、推荐型号，一张卡说清楚。

![客户工作台 · Brief 卡含资质评分与背调](docs/screenshots/person_brief.png)

**客户工作台 · 时间轴 + 草稿** —— 历史所有通话的 transcript + 录音（如有）+ 已做动作，右侧并排 AI 起好的英文 SMS / 中文供应链 RFQ / 内部 briefing 等销售审核。

![客户工作台 · 时间轴 + AI 草稿动作面板](docs/screenshots/person_timeline.png)

---

## 这是什么

一个**给中国 B2B 外贸制造业**用的开源询盘自动响应系统。

中国出口制造业每天产生海量的海外询盘 —— 一通跨洋电话、一封 RFQ 邮件、一条 LinkedIn 消息都可能是几万到几百万美元的订单。但是真正落到一线销售手里、能在 24 小时内被妥善响应的询盘，比例并不高。

本项目用 **LLM + 电话/SMS + CRM** 把这件事自动化。AI 接电话、问清需求、生成回复草稿、把信息归档进 CRM、跟踪客户的状态变化 —— 销售人员变成 AI 的**副驾驶**：审核 AI 选的产品型号和文案，必要时改一下，按按钮就把消息发给客户、把询价发给工厂的中国团队。

## 这个项目想解决什么痛点

中国出口企业接询盘有三个长期痛点：

1. **时区错位** —— 客户在美国/欧洲/中东打电话来，国内是凌晨。错过的每一通电话都可能是一个被竞争对手抢走的 lead。
2. **英语人才贵** —— 中小工厂请不起足够多、口语足够好的外贸业务员。一个能流利讲英语的销售就是公司的瓶颈。
3. **多语言覆盖更贵** —— 全球询盘可能来自西班牙语、阿拉伯语、葡萄牙语、俄语、德语、日语客户。靠人覆盖所有语种成本高到几乎不可能。

LLM 在这三个点上**结构性占优**：永远在线（解决 #1），英语母语水平（解决 #2），多语言原生（解决 #3）。

## 它怎么工作

```
客户来电 (任意国家、任意时区)
       │
       ▼
  Agent Phone (运营商网关)
       │ webhook
       ▼
  Cloudflare Worker  ─── Gemini 2.5 Flash (~1.5s P50 实时回话)
       │              ─── Supermemory (产品目录语义检索)
       │              ─── Browser Use (来电方公司背景调查)
       ▼
  挂机后流水线
   ├─ 实体抽取 (材料/厚度/预算/Timeline/sentiment/buyer persona/Concerns)
   ├─ 推荐型号 + 推荐理由
   ├─ 3 份草稿:  💬 客户 SMS         (英文回复)
   │             🇨🇳 供应链 RFQ      (中文询价单)
   │             📋 内部 briefing    (给销售看的速读包)
   ├─ Workers KV (call_id → CallRecord, lead:<phone> → LeadIndex)
   ├─ Airtable (永久留档)
   └─ Slack (#hackathon-calls 主通知 + #sourcing-china 供应链通道)
       │
       ▼
  销售打开 /person/<phone> (一个客户一个页面)
   ├─ Brief 卡: 客户/公司/资质评分/推荐型号/背调摘要/风险点
   ├─ 历史时间轴: 这通+历史所有通话录音+transcript + 发出的 SMS/RFQ/动作
   ├─ Actions 列: 改名 / 启动背调 / 3 份草稿 (审核+发送) / 阶段推进
   │
   ▼
  外部系统集成
   ├─ REST API     /api/v1/*   (X-API-Key 鉴权, JSON in/out)
   └─ MCP Server   /mcp        (Streamable HTTP, JSON-RPC 2.0)
                                给 AI agent (Claude Desktop/Cursor) 直接接管
```

## 销售工作流程

CRM 阶段是按制造业 B2B 习惯做的：

```
[ new_lead ]         AI 已合格化, 销售还没发任何外联
   ↓ 3 个外联动作 (SMS / RFQ / Brief) 都完成
[ outreach_sent ]    SMS + RFQ + briefing 都发了, 等客户和工厂反馈
   ↓ 工厂确认报价
[ quoted ]           正式报价发给客户
   ↓ 客户回应
[ negotiating ]      客户已经在和你谈, 进入收尾博弈
   ↓
[ closed_won ]   [ closed_lost ]   [ nurture (暂缓再跟进) ]
```

每个阶段销售只需要审核 AI 做出的判断（型号选对了吗？回复文案行不行？要不要调整？），不需要从零起草。

## 技术栈

| 层 | 技术 | 说明 |
|---|---|---|
| 边缘运行时 | Cloudflare Workers + Hono | 全球边缘部署, 冷启动近 0 |
| 存储 | Workers KV | call_id 24h TTL, lead:phone 7d TTL |
| LLM | Google Gemini 2.5 Flash | JSON 模式, `thinkingBudget: 0`, 256 tokens, P95 < 2.8s |
| 语义检索 | Supermemory v3 | 产品目录 ~300ms 语义匹配, 每次通话给 Gemini 做检索增强 |
| 浏览器 agent | Browser Use Cloud v3 | 自动上网查来电方公司背景, ~$0.10/次 |
| 电话/SMS | Agent Phone | 接电话、回 SMS、录音 |
| CRM | Airtable | 永久存档+人类可读 |
| 通知 | Slack | 询盘到达 + 工厂询价 |
| API/MCP | 自写 | REST `/api/v1/*` + MCP `/mcp` (JSON-RPC 2.0) |
| 类型 | TypeScript strict | `noEmit` 编译检查, 全文零类型错误 |

## 商业模式参照

这套东西可以做成**标准 SaaS**：

- 每家企业自带产品知识库 (用 Supermemory container_tag 隔离)
- 每家企业自己的电话号码 (Agent Phone 多号支持)
- 每家企业自己的 CRM (Airtable workspace 隔离 / 也可以接 HubSpot)

询盘的价值有清晰的市场定价 —— **CPL (Cost Per Lead)** 是营销领域的标准指标。一个询盘电话在大多数 B2B 行业的 CPL 是几百到上千人民币不等。本项目把"每个询盘的处理成本"压到接近零，**回收 CPL 的边际增量 = 直接的商业价值**。

中国出口制造业有数万家有真实询盘的 B2B 公司 —— 标准化的 SaaS 是有市场支撑的。

## 快速开始 (本地开发)

```bash
# 1. clone + 装依赖
git clone https://github.com/jinweihan-ai/b2b_call_agent.git
cd b2b_call_agent
npm install

# 2. 配置环境变量
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 填入你的 key (见下表)

# 3. 起本地 worker
npx wrangler dev

# 4. (可选) 用 ngrok 暴露给 Agent Phone webhook 用
ngrok http 8787
# 把 ngrok 给的 https URL 填到 Agent Phone 控制台的 webhook 配置里
```

## 需要的环境变量

| 变量 | 用途 | 必需? |
|---|---|---|
| `AIRTABLE_TOKEN` | Airtable PAT | 是 |
| `AIRTABLE_BASE_ID` | Airtable base id | 是 |
| `AIRTABLE_TABLE_NAME` | 表名 (默认 `Calls`) | 是 |
| `SLACK_WEBHOOK_URL` | 主 Slack 通知通道 | 是 |
| `SOURCING_WEBHOOK_URL` | 供应链询价专用通道 | 否, 缺则回落到主通道带前缀 |
| `AGENT_PHONE_API_KEY` | Agent Phone API key, 用于发 SMS + 拉录音 | 是 |
| `AGENT_PHONE_API_BASE` | 默认 `https://api.agentphone.ai/v1` | 否 |
| `AGENT_PHONE_SIGNING_SECRET` | webhook HMAC 验证用 | 否 (建议生产开) |
| `GEMINI_API_KEY` | Google AI Studio key | 是 |
| `SUPERMEMORY_API_KEY` | Supermemory v3 key | 是 |
| `BROWSER_USE_API_KEY` | Browser Use Cloud key (`bu_...`) | 否, 缺则关闭背调 |
| `API_KEY` | REST API + MCP 共享鉴权密钥 | 是 (对外暴露时) |

## 给下游系统的接口

### REST API (给 OA / 营销 / KOL / 社媒平台 / CRM 联动用)

所有请求带 `X-API-Key: <API_KEY>` header. JSON in/out.

```bash
# 查所有客户
curl -H "X-API-Key: $KEY" https://<your-domain>/api/v1/persons

# 查单个客户详情
curl -H "X-API-Key: $KEY" https://<your-domain>/api/v1/persons/+16692120332

# 改名 (sales 给客户起一个易记的名字)
curl -X POST -H "X-API-Key: $KEY" -H "Content-Type: application/json" \
  -d '{"display_name":"Ron @ Hudson Sign Co"}' \
  https://<your-domain>/api/v1/persons/+16692120332/rename

# 启动背调
curl -X POST -H "X-API-Key: $KEY" \
  https://<your-domain>/api/v1/persons/+16692120332/research

# 自动发现：列出所有端点
curl https://<your-domain>/api/v1
```

完整端点列表见 `GET /api/v1` 的自动发现响应。

### MCP Server (给 AI agent 用, 如 Claude Desktop / Cursor / 自研 agent)

Streamable HTTP transport, JSON-RPC 2.0, 单一 `POST /mcp` 端点.

客户端配置示例 (Claude Desktop / Cursor 风格)：

```json
{
  "mcpServers": {
    "b2b-call-agent": {
      "url": "https://<your-domain>/mcp",
      "headers": { "X-API-Key": "<your-api-key>" }
    }
  }
}
```

暴露的 15 个 tools：

| Tool | 用途 |
|---|---|
| `list_persons` / `get_person` | 客户列表 / 详情 |
| `rename_person` | 改名 |
| `start_research` | 启动 Browser Use 背调 |
| `list_calls` / `get_call` | 通话列表 / 详情 |
| `send_sms` / `send_rfq` | 发客户 SMS / 发供应链询价 |
| `ack_briefing` | 标记 briefing 已读 |
| `move_to_quoted` / `move_to_negotiating` / `close_deal` | 阶段推进 |
| `list_products` / `search_products` | 产品目录 / 语义搜索 |
| `reindex_leads` | 重建索引 |

3 个静态资源 + 2 个模板资源：

- `catalog://products`, `persons://all`, `calls://all`
- `person://{phone}`, `call://{call_id}`

## 项目结构

```
src/
├── index.ts                    # Hono 路由总入口
├── types.ts                    # Bindings (env vars + KV namespace)
├── handlers/
│   ├── voice-reply.ts          # 实时对话: Gemini JSON 模式, stall guard, FSM 回落
│   ├── call-end.ts             # 挂机流水线: KV + Airtable + Slack + 抽取 + 草稿生成
│   ├── replay.ts               # 单通话页 (legacy alias, 自动 302 → /person/<phone>)
│   ├── person.ts               # /person/:phone 客户工作台
│   ├── dashboard.ts            # / 主仪表盘 (一个客户一张卡)
│   ├── actions.ts              # 表单 POST 处理 (UI 用)
│   ├── admin.ts                # 索引回填等管理端
│   ├── api.ts                  # REST API /api/v1/*
│   └── mcp.ts                  # MCP server /mcp
├── lib/
│   ├── render.ts               # HTML 渲染 (brief + timeline + actions)
│   ├── leads.ts                # 客户索引层 (phone → calls[] + research + display_name)
│   ├── call-io.ts              # 共享的 call 读写 + state 转换 + Agent Phone SMS
│   ├── services.ts             # 业务逻辑 service 层 (REST + MCP 共用)
│   ├── airtable.ts             # Airtable 写入
│   ├── slack.ts                # Slack webhook
│   ├── extract-gemini.ts       # Gemini 实体抽取 (含 caller_name/company)
│   ├── extract.ts              # 老的 regex 抽取 (回落)
│   ├── drafts-gemini.ts        # 3 份草稿生成
│   ├── supermemory.ts          # 产品语义检索
│   ├── browser-use.ts          # Browser Use Cloud v3 wrapper
│   └── gemini.ts               # JSON 模式 generateContent 包装
└── data/
    └── products.json           # 演示用产品目录 (FerroLaser 15 SKU)
```

## 路线图

短期：
- [ ] 多语言: 当前只覆盖英文来电方, 接下来加西班牙语/阿拉伯语/葡萄牙语
- [ ] Webhook 订阅: 让下游系统订阅 `call.received` / `lead.research_done` / `call.outcome` 事件
- [ ] Pagination + cursor (REST 当前 list 是一把抓 200)
- [ ] OpenAPI 3 spec 自动生成 (让下游 SDK 自动生成)
- [ ] 自动 re-extract 端点 (给老的 call 补 caller_name / company)

中期：
- [ ] 多租户隔离 (按 workspace_id 分离每家企业的数据)
- [ ] 自定义产品知识库 UI (上传 / 训练 / 测试)
- [ ] HubSpot / Salesforce / 飞书 OA 双向同步
- [ ] 主动外呼 / 定时回拨

长期：
- [ ] 询盘归因 + ROI 报表 (CPL 指标对齐)
- [ ] Agentic follow-up (AI 自主在邮件/SMS/社媒之间切换通道跟进)

## 贡献

欢迎 PR 和 issue。完整指南见 [CONTRIBUTING.md](CONTRIBUTING.md)。TL;DR：TypeScript strict, 单文件 < 1500 行, 不预设抽象, 错误处理只在边界。

## 致谢

本项目最初是为 **YC Hackathon 2026 "call my agent"** 赛道写的原型。感谢：
- **Google DeepMind** 提供 Gemini API credit
- **Supermemory** 提供存储 + 语义检索
- **Browser Use** 提供 cloud agent credit ($100)
- **Agent Phone** 提供电话网关 + 录音

Demo 用的产品目录 (FerroLaser 激光切割机) 是真实公开数据，从 [ferrolaser.com](https://ferrolaser.com) 通过 Browser Use 抓的。本项目本身和 FerroLaser 没有商业关系，仅作为演示样本。

## 许可

[MIT License](LICENSE) —— 你可以自由商用、改造、私有部署。鼓励改成自己工厂或服务商的 SaaS 上线。
