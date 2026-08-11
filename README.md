# wj-mcp-server

把现有 WJ 生图能力开放为 ChatGPT Work 可连接的远程 MCP 插件。第一版没有团队、成员或后台管理概念，使用一个共享 OAuth 口令控制访问。

## 已实现

- 标准 MCP Streamable HTTP 端点：`POST /mcp`
- `generate_image` 工具，默认模型 `gpt-image-2`、默认分辨率 `2K`
- 同一提示词可通过 `count` 一次并发生成 1 至 8 个变体
- 不同提示词可通过 `generate_images.requests` 一次提交 2 至 8 个任务，由服务端并发执行
- 每次成功结果保存到 Redis 30 天，并可通过 `get_image_result(resultId)` 无额度恢复
- 工具文本同时返回原图链接，Widget 不可用时仍能打开结果
- 支持 `nano-banana-2`、常用宽高比、`1K/2K/4K` 和参考图 URL
- MCP Apps 图片组件，在支持的 ChatGPT 客户端中直接显示图片
- 不支持组件的客户端仍会收到 Markdown 图片和原图链接
- OAuth 2.1 授权码流程、PKCE、动态客户端注册和刷新令牌
- Redis 持久化 OAuth 数据、分钟/每日限额和登录防爆破
- 服务端 WJ Key，不向 ChatGPT 或浏览器泄露
- Docker Compose、健康检查和宝塔/Nginx 反代示例

## 调用链路

```text
ChatGPT Work
  -> HTTPS /mcp + OAuth
  -> wj-mcp-server
  -> POST https://wj.zaowuwujie.ltd/api/v1/proxy/ai/generate/image
  -> wj-server / wj-ai-server / LiteLLM
  -> public image URL
  -> MCP Apps inline image component
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
3. 名称填 `WJ 生图`。
4. 服务器 URL 填 `https://mcp.wj.zaowuwujie.ltd/mcp`。
5. 身份验证选择 `OAuth`。
6. 勾选自定义 MCP 风险确认后创建。
7. 浏览器会打开 WJ 授权页，输入 `.env` 中的 `MCP_SHARED_PASSWORD`，再确认授权。

每个互不关联的 ChatGPT 账号都重复一次连接即可。成员不需要也不应拿到 `WJ_API_KEY`。只知道 MCP URL 的人会收到 `401`，没有共享口令无法取得访问令牌或调用生图。

推荐使用规则见 `docs/chatgpt-instructions.md`。显式说“使用 WJ 生图”可以稳定触发；ChatGPT 内置生图限流后的回退取决于平台是否把失败暴露给模型，MCP 服务本身无法读取账号内部额度。

同一提示词生成多张时，让 ChatGPT 调用一次 `generate_image` 并设置 `count`。不同提示词生成多张时，让 ChatGPT 调用一次 `generate_images` 并把每个任务放入 `requests`。后者由 MCP 服务端保证并发，不依赖 ChatGPT 是否会并行调度多次工具调用。实际同时请求 WJ 的数量由 `IMAGE_MAX_CONCURRENCY` 控制，每张图片仍分别计入分钟和每日额度。

每次成功调用都会返回 `resultId`、`expiresAt` 和原图链接。结果默认在 Redis 中保存 30 天；如果 ChatGPT 的图片组件没有显示，应调用 `get_image_result` 恢复或直接使用原图链接，不要重新生成。恢复操作不会请求 WJ，也不会消耗图片额度。

## 运维与安全

- 泄露共享口令时，修改 `MCP_SHARED_PASSWORD`，并清理 Redis 中的 OAuth 状态后让成员重新连接。只修改口令不会撤销已经签发的刷新令牌。
- 泄露 WJ Key 时，在 WJ 开放平台撤销并重发。不要把真实 Key 提交到 Git。
- `IMAGE_DAILY_LIMIT` 是第一版的全局成本上限。因为还没有团队身份，所有连接共享同一额度池。
- 图片 CDN 改变时，把新 HTTPS Origin 加入 `IMAGE_RESOURCE_DOMAINS`，否则 ChatGPT Widget 的 CSP 会阻止图片加载。
- 建议备份 Docker volume `redis-data`，否则恢复后需要成员重新授权。

## 验证

```bash
pnpm check
```

该命令依次运行 TypeScript 检查、自动化测试、MCP Apps 单文件构建和服务端构建。
