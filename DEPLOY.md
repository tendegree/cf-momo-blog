# momo-blog → Cloudflare 移植部署指南

本目录是 `momo-blog-main` 的 Cloudflare 免费版：同一 Worker 托管前端 + API，用 **D1** 取代 SQLite，用 **R2** 取代服务器本地文件系统。

## 架构总览

```
momo-blog（Railway）                myblog（Cloudflare 免费）
─────────────────                  ─────────────────────────
Node + Express + Kysely/SQLite  →  单一 Cloudflare Worker（Hono）
node:sqlite DatabaseSync        →  D1（createDb 封装 + better-auth kysely-over-D1）
本地 uploads 文件目录            →  R2 对象存储（media.filename = R2 key）
sharp 重编码图片到 WebP          →  浏览器 Canvas 预压缩后上传 WebP + 缩略图
ffmpeg 校验音频 + 提封面         →  music-metadata（纯 JS）取时长/声道/内嵌封面，封面原格式存 R2
Express 路由 + multer + 限流     →  Hono 路由 + 手写内存限流
better-auth(node handler)       →  better-auth 通用 auth.handler(Request)
静态前端由 Express 托管          →  wrangler [assets] 托管 dist/client
```

## 目录结构

```
myblog/
├── wrangler.toml          # Worker + D1(R2) 绑定 + Assets 托管
├── vite.config.ts         # 前端构建到 dist/client
├── tsconfig(.worker).json # worker / client 分开类型检查
├── server/
│   ├── worker.ts          # Hono 入口：全 API + 静态回退
│   ├── env.ts             # Env（DB/STORAGE/ASSETS 绑定 + 密钥）
│   ├── db.ts              # BusinessDb 封装 + 建表 + readHome
│   ├── auth.ts            # better-auth(kysely→D1) + setup 逻辑
│   ├── media.ts           # R2 上传/服务 + music-metadata
│   ├── messages.ts        # 留言板 + 限流
│   └── weather.ts
├── client/src/imagePrep.ts# 浏览器端 WebP 预压缩（新增）
├── scripts/seed.mjs       # 一次性演示数据 → R2 + D1
├── assets/demo, profile
└── shared/model.ts        # 与原仓库一致，未改动
```

## 本地开发

```bash
npm install
npm run dev   # 同时启动 wrangler dev(端口8787) + vite(4317)，/api 代理到 8787
```
`wrangler dev` 会读取 `.dev.vars`（复制 `.dev.vars.example`），本地自动建一套 D1(Miniflare) 与 R2 模拟器。

## 部署到 Cloudflare（git + wrangler）

### 前置
- 已安装 [Node](https://nodejs.org) ≥ 20 与 [Wrangler](https://developers.cloudflare.com/workers/wrangler/)（`npm i -g wrangler` 或直接用 `npx wrangler`）
- 已 `wrangler login`

### 1. 创建 D1 与 R2
```bash
npx wrangler d1 create momo-blog-db
npx wrangler r2 bucket create momo-blog-storage
```
`d1 create` 会返回 `database_id`，把它填进 `wrangler.toml` 的 `database_id`。

### 2. 设置密钥（生产，不放代码里）
```bash
npx wrangler secret put SECRET        # 会话/签名密钥，≥32 字符
npx wrangler secret put SETUP_TOKEN   # 首次创建管理员时输入的初始化令牌，≥20 字符
npx wrangler secret put APP_URL       # 生产域名，例如 https://blog.example.com
```
> 密钥必须部署后设置；`wrangler secret put` 立即推送到生产 Worker。

### 3. 构建并部署
```bash
npm run build        # 类型检查 + vite 构建前端
npx wrangler deploy
```
首次请求会自动执行 D1 建表（业务表 + better-auth 表）。

### 4. 写入演示数据（可选但有首页）
```bash
npm run seed
```
把 `assets/demo` 素材上传到 R2，并写入示例首页（site_content/media/settings）。**首次部署建议先 seed 再访问，否则 /api/home 提示“首页尚未初始化”。**

### 5. 首次初始化管理员
打开站点 → 点「登录」→「创建你的管理员账号」，粘贴你在 `SETUP_TOKEN` 里设置的值 + 邮箱 + 密码（≥12 位）。之后即可「编辑页面」。

### 6.（可选）绑定自定义域名
Dashboard → Workers 详情 → 设置 → 域/触发器 → 添加自定义域。设置 `APP_URL` 密钥为该 https 域名，以便 Cookie 使用 Secure。

## 代码改动点（相对原仓库）

| 模块 | 改动 |
|---|---|
| `server/index.ts` | 删除；入口改为 `server/worker.ts`（`{ fetch }` 默认导出） |
| `server/app.ts` | Express 重写为 Hono，路由/契约不变；所有 DB 调用改为 `await` |
| `server/db.ts` | `node:sqlite DatabaseSync` → `createDb(D1)` 封装（`run/get/all/batch`）；`openDatabase`→`applySchema`（幂等建表）；表新增 `media.cover_mime` |
| `server/auth.ts` | `betterAuth(config)` 传 **kysely(over D1)**；`toNodeHandler`→通用 `auth.handler(Request)`；屏蔽 Express 相关 |
| `server/media.ts` | 删除 sharp/ffmpeg/file-type/multer；`importImage/importAudio`→R2 上传；音频用 `parseBuffer` 提时长/封面；封面原格式存 R2 |
| `server/messages.ts` | Express 中间件/`express-rate-limit` → Hono 路由 + 手写内存限流 |
| `server/seed.ts` | 删除；演示数据改由 `scripts/seed.mjs`（免 sharp）写 R2+D1 |
| `client/src/components/Editor.tsx` | 上传图片前先 `prepareImage()` 转 WebP，FormData 追加 `file` + `thumb` |
| `client/src/imagePrep.ts` | **新增**：浏览器 Canvas 重编码（全尺寸 2400 + 缩略图 600） |

## 部署坑点（重要）

1. **sharp 无法在 Workers 运行** → 图片必须在浏览器端压缩。因此服务端不再猜测/校验任意格式，上传即 WebP。用浏览器 Canvas 保证正常。

2. **ffmpeg 无法在 Workers 运行** → 音频去掉了“完整解码校验”，仅靠 `music-metadata` 解析成功 + 合法性判断（时长/声道/hasVideo）。极罕见损坏文件可能混入，但不影响正常使用。

3. **文件大小限制不同**：Workers 请求体上限约 100MB、R2 每个对象上限 5GB，但 Worker 每次上传的**单个请求体**受限（100MB）。原限值 20MB 已按保守保留；如需更大请改用「客户端直传 R2」签名方案。

4. **内存限流是每个隔离实例的**，非全局。个人博客可忽略（Cloudflare 网络层也有自适应限速）。若需严格全局限流，应启用 Dashboard 的 **Rate Limiting**。

5. **绑定绑定在 `wrangler.toml`，纯 Dashboard 无法改**（这是选 git+wrangler 的原因）。Dashboard 只能删/重建 Worker 时保持同名绑定。

6. **Cold start 建表是幂等的**：不要并发首次请求，避免重复迁移；`applySchema`/better-auth 迁移均为 `IF NOT EXISTS`，安全。

7. **Cookie 域名**：忘了设 `APP_URL` 时默认按 `http://127.0.0.1:8787` 推导 → `useSecureCookies=false`，生产版 Cookie 无 `Secure` 标记。不影响功能，但建议设置 APP_URL 获取更安全的 Cookie。

8. **better-auth 版本**：必须显式传递 `database: Kysely(D1Dialect)`，让 `getMigrations().runMigrations()` 自动建用户/会话/账号表；`database_id` 未填前部署会失败。

9. **演示图无缩略图**：`npm run seed` 上传的是原格式（非 WebP），`thumb` 为空，相册/封面走“原图当缩略图”降级。登录后重新上传一次图片即可生成 WebP+缩略图。

10. **Query 参数复用在 /api/media/:id**：原实现里“草稿(未发布)媒体仅管理员可见”逻辑保留；发布后媒体 URL 带 immutable 缓存，替换素材时记得让前端 URL 变化触发刷新。

11. **`nodejs_compat` 已开启**：`node:crypto`(createHmac) 在 Worker 可用；`Buffer` 改用 `TextEncoder` 恒定时间比较，避免 Buffer 兼容差异。

## 功能保留对照
- 首页在线编辑 / 项目 / 文章 / 相册 / 收藏 / 音乐 / 访客统计(访问量/打卡/点赞) / 登录与管理员初始化 / 留言板 / 天气 / 移动端适配：**全部保留**
- 唯一行为差异：
  - 图片上传改为“浏览器预压缩 WebP”，等价但不再服务端转码；
  - 音频去掉 ffmpeg 解码校验（其余时长/封面/格式校验保留）；
  - 演示种子素材以原格式存储（无缩略图）。