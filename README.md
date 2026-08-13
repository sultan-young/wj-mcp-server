# wj-mcp-server

把现有 WJ 图片与利润试算能力开放为 ChatGPT Work 可连接的远程 MCP 插件。第一版没有团队、成员或后台管理概念，使用一个共享 OAuth 口令控制访问。

## 已实现

- 标准 MCP Streamable HTTP 端点：`POST /mcp`
- 图片：`generate_image`（提交即返回 `jobId`，组件轮询至完成）、`get_image_result`（按 resultId 恢复已完成结果，只读）
- `generate_image` 通过 `gpt_reference_images`（`openai/fileParams`，最多 10 张）接收 ChatGPT 附件，并与本次 `prompts` 每一项共享；编辑时按附件顺序传入并由对应提示词说明改法
- OAuth scope：`wj:tools`（同时仍接受已有 `wj:image` 令牌）
- 利润：`calculate_profit`（试算）、`save_profit_calculation`（确认后录入）
- 商品草稿：`list_product_categories`、`create_product_draft`（需确认，立即占号）、`update/get/list/validate_product_draft`
- Skill：`skills/wj-product-draft/SKILL.md`（品类以接口为准、创建前确认、SKU 规则）
- 部署前在 WJ-SREVER 执行 `node scripts/seed_open_platform.js`，确保 MCP 用的 Key 具备 `openApi.productDraft`（对已有利润试算授权的 Key 会自动补授）
- 试算不要求 SKU；录入必须提供商品池中真实存在的 SKU，并由 WJ 服务端重新计算后保存
- 录入名称在前端为可选字段；通过 MCP 录入时由 GPT 使用用户名称或自动生成简短名称
- `generate_image` 立刻返回 `jobId`；后台按 `IMAGE_MAX_CONCURRENCY` 并发生成；任务窗口默认 20 分钟（`IMAGE_JOB_TTL_SECONDS`）
- 完成后结果保存到 Redis 30 天，可通过 `get_image_result` 无额度恢复
- 组件轮询 `get_image_job`；不可用时以纯文本原图 HTTPS 链接兜底（不返回 Markdown 图片块）
- 支持 `nano-banana-2`、常用宽高比、`1K/2K/4K` 和 ChatGPT 附件参考图
- MCP Apps 图片组件：左侧主图、右侧缩略图切换，主图下方展示分辨率/耗时等元信息并提供打开/下载
- OAuth 2.1 授权码流程、PKCE、动态客户端注册和刷新令牌
- Redis 持久化 OAuth 数据、分钟/每日限额和登录防爆破
- 服务端 WJ Key，不向 ChatGPT 或浏览器泄露
- Docker Compose、健康检查和宝塔/Nginx 反代示例

## 调用链路

```text
ChatGPT Work
  -> HTTPS /mcp + OAuth
  -> wj-mcp-server
  -> WJ Open Platform API
     -> image: wj-server / wj-ai-server / LiteLLM -> image component
     -> profit: wj-server calculation / confirmed record upsert
     -> product draft: /api/v1/products/category/list + /api/v1/products/drafts/*
```

`wj-mcp-server` 不直接请求 LiteLLM。它使用 WJ 开放平台接口，因此保留 WJ 已有的 Key、额度、日志和模型路由。

## 本地开发

要求 Node.js 22.13+、pnpm 11.16+ 和 Redis。

```bash
pnpm install
cp .env.example .env
pnpm secrets
```

把 `pnpm secrets` 输出的两行填入 `.env`，再设置：

```dotenv
NODE_ENV=development
PUBLIC_BASE_URL=http://127.0.0.1:6070
TRUST_PROXY=false
ALLOWED_HOSTS=127.0.0.1,localhost
REDIS_URL=redis://127.0.0.1:6379
WJ_API_KEY=你的WJ开放平台Key
MCP_SHARED_PASSWORD=至少12位的共享访问口令
```

启动：

```bash
pnpm dev
```

检查地址：`http://127.0.0.1:6070/healthz`。MCP Inspector 可用 `pnpm inspect` 启动，然后连接 `http://127.0.0.1:6070/mcp`。

## Ubuntu 发布

推荐使用独立子域名，例如 `mcp.wj.zaowuwujie.ltd`，避免 OAuth 的 `/auth`、`/token`、`/reg` 等路径与现有网站冲突。

1. 为子域名添加指向腾讯云服务器的 A 记录。
2. 在宝塔新建该子域名的 Nginx 站点并申请 Let's Encrypt 证书。
3. 把本项目上传到服务器，执行 `cp .env.example .env`。
4. 执行 `pnpm secrets`，把输出写入 `.env`。
5. 设置 `WJ_API_KEY`、强共享口令、真实 `PUBLIC_BASE_URL` 和 `ALLOWED_HOSTS`。
6. 参考 `deploy/nginx.conf.example` 配置反向代理；SSL 仍交给宝塔管理。
7. 启动并检查：

```bash
docker compose up -d --build
docker compose ps
curl https://mcp.wj.zaowuwujie.ltd/healthz
curl https://mcp.wj.zaowuwujie.ltd/.well-known/oauth-protected-resource/mcp
```

不要把容器的 `6070` 端口直接暴露到公网。示例 Compose 只绑定 `127.0.0.1:6070`，公网统一经过 HTTPS Nginx。

## 在 ChatGPT Work 中连接

1. 打开“工作”模式，进入“连接插件”或插件管理页。
2. 选择“新插件”。
3. 名称填 `WJ 工具`。
4. 服务器 URL 填 `https://mcp.wj.zaowuwujie.ltd/mcp`。
5. 身份验证选择 `OAuth`。
6. 勾选自定义 MCP 风险确认后创建。
7. 浏览器会打开 WJ 授权页，输入 `.env` 中的 `MCP_SHARED_PASSWORD`，再确认授权。

每个互不关联的 ChatGPT 账号都重复一次连接即可。成员不需要也不应拿到 `WJ_API_KEY`。只知道 MCP URL 的人会收到 `401`，没有共享口令无法取得访问令牌或调用生图。

推荐使用规则见 `docs/chatgpt-instructions.md`。显式说“使用 WJ 生图”可以稳定触发；ChatGPT 内置生图限流后的回退取决于平台是否把失败暴露给模型，MCP 服务本身无法读取账号内部额度。

利润试算应先调用 `calculate_profit` 并向用户展示结果。只有用户明确确认录入后，才调用 `save_profit_calculation`；缺少 SKU 时必须先询问用户，不能虚构 SKU。部署前还需要在 WJ 开放平台为 `WJ_API_KEY` 对应凭证授予利润试算和利润录入接口能力。

生成图片时始终传入 `prompts` 字符串数组（1–10 项；单张为一项）。服务端按 `IMAGE_MAX_CONCURRENCY` 并发生成，默认每个 OAuth 终端最多同时 10 个 WJ 请求，不同终端队列彼此独立。同提示词变体在 `prompts` 中重复相同文案；不同图写入不同提示词。可选的 `gpt_reference_images` 与本次所有 `prompts` 条目共享。

`generate_image` 立刻返回 `jobId`；WJ 图片组件轮询任务（最长约 20 分钟）并在完成后展示。完成后会写入 `resultId`、`expiresAt` 和原图链接，结果默认在 Redis 中保存 30 天。可用 `get_image_result` 按 `resultId` 恢复；模型仍可使用返回文本中的原图链接，不能因为组件没有显示而重新生成。恢复操作不会请求 WJ，也不会消耗图片额度。

## 运维与安全

- 泄露共享口令时，修改 `MCP_SHARED_PASSWORD`，并清理 Redis 中的 OAuth 状态后让成员重新连接。只修改口令不会撤销已经签发的刷新令牌。
- 泄露 WJ Key 时，在 WJ 开放平台撤销并重发。不要把真实 Key 提交到 Git。
- `IMAGE_MAX_CONCURRENCY` 是每个 OAuth 插件终端的并发上限，不是整个服务的共享上限。图片请求不再额外设置每分钟或每日限制。
- 图片 CDN 改变时，把新 HTTPS Origin 加入 `IMAGE_RESOURCE_DOMAINS`，否则 ChatGPT Widget 的 CSP 会阻止图片加载。
- 建议备份 Docker volume `redis-data`，否则恢复后需要成员重新授权。

## 验证

```bash
pnpm check
```

该命令依次运行 TypeScript 检查、自动化测试、MCP Apps 单文件构建和服务端构建。
