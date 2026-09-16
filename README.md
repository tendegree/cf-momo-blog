# MyBlog · Personal Bento Space

源项目地址：<https://github.com/snowhejia/momo-blog>

`myblog` 是一个个人 Bento 风格博客空间，由 `momo-blog`（React + TypeScript + SQLite，原部署于 Railway）迁移改造而来，目标平台为 **Cloudflare 免费层**。

迁移后**保留了全部前端样式与业务功能**，仅更换了底层存储：用 Cloudflare 的 **D1** 取代 SQLite、用 **R2** 取代服务器本地文件系统。前端 React + TypeScript 代码与源仓库基本一致，界面、交互、移动端自适应均保持不变。

> 底层存储变更（SQLite → D1、本地文件 → R2）属后端迁移，不影响前端展示与用户操作效果。

## 功能特性

- **Bento 主页**：在线的项目墙 / 文章 / 相册 / 收藏 / 音乐，支持可视化管理、拖拽式在线编辑

- **访客统计**：访问量、当日打卡、站点点赞，Cookie 签名 + HMAC 防伪造

- **登录与管理员初始化**：better-auth 邮箱密码登录，首次通过 `SETUP_TOKEN` 创建唯一管理员

- **媒体上传**：图片浏览器端预压缩为 WebP（全尺寸 + 缩略图），音频用 `music-metadata` 提取时长/封面，存 R2

- **留言板**：访客留言 + 管理员已读/删除管理，带内存限流

- **天气**：open-meteo 实时天气

- **移动端自适应**：响应式布局，与源站一致

## 技术栈与架构

| 层    | 技术                                                             |
| ---- | -------------------------------------------------------------- |
| 前端   | React 19 + TypeScript + Vite + React Router + lucide-react     |
| 后端   | 单一 Cloudflare Worker（Hono 路由）                                  |
| 数据库  | Cloudflare D1（Kysely + D1Dialect 自动迁移，更底层的 `createDb` 封装处理业务表） |
| 对象存储 | Cloudflare R2                                                  |
| 认证   | better-auth（通用 `auth.handler(Request)`）                        |
| 校验   | zod + music-metadata                                           |

**部署形态**：同一个 Worker 既提供 `/api/*` REST 接口，也通过 `[assets]` 托管 Vite 构建产物（前端）。无需单独部署静态站点。

```
浏览器 ──▶ Cloudflare Worker (Hono)
                 ├─ /api/*        → 业务接口 + 认证 + 留言板 + 媒体
                 ├─ /api/auth/*   → better-auth handler
                 └─ 前端静态资源  → wrangler [assets] 托管 dist/client
         ├─ D1（业务表 + better-auth 用户表）
         └─ R2（图片 / 音频对象）
```

## 目录结构

```
myblog/
├── wrangler.toml          # Worker 配置 + D1/R2 绑定 + Assets 托管
├── vite.config.ts         # 前端构建到 dist/client
├── tsconfig(.worker).json # worker / client 分开类型检查
├── package.json
├── DEPLOY.md              # 详细部署指南与坑点（迁移背景）
├── server/                # Cloudflare Worker 后端
│   ├── worker.ts          # Hono 入口：全部 API + 静态回退
│   ├── env.ts             # Env（DB / STORAGE / ASSETS 绑定 + 密钥）
│   ├── db.ts              # BusinessDb 封装 + 幂等建表 + readHome
│   ├── auth.ts            # better-auth(kysely → D1) + 初始化逻辑
│   ├── media.ts           # R2 上传/服务 + music-metadata
│   ├── messages.ts        # 留言板 + 内存限流
│   └── weather.ts         # open-meteo 天气服务
├── client/                # 前端（React + TS）
│   └── src/
│       ├── App.tsx        # 路由与页面骨架
│       ├── store.tsx      # 全局状态 + API 调用
│       ├── styles.css     # 全站样式（字体、配色、布局、移动端）
│       ├── imagePrep.ts   # 浏览器 Canvas → WebP 预压缩（新增）
│       └── components/    # HomeCards、Editor、Auth、Contact、Music 等
├── shared/model.ts        # 前后端共享类型（与源仓库一致）
├── scripts/seed.mjs       # 一次性演示数据 → R2 + D1
└── assets/                # seed 脚本用的示例素材
```

## 环境要求

- [Node.js](https://nodejs.org) ≥ 20

- [Wrangler](https://developers.cloudflare.com/workers/wrangler/)（`npm i -g wrangler`，或用 `npx wrangler`）

- 一个 Cloudflare 账号（免费即可）

## 安装与本地开发

```bash
# 1. 安装依赖
npm install

# 2. 本地开发（同时启动 wrangler dev 8787 + vite 4317，/api 代理到 8787）
npm run dev
```

本地开发前先复制环境变量示例：

```bash
cp .dev.vars.example .dev.vars   # Windows PowerShell: Copy-Item
```

`wrangler dev` 会用 Miniflare 自动创建一套本地 D1/R2 模拟器，首次请求自动建表。

## 构建与检查

```bash
npm run typecheck     # 前后端 TypeScript 类型检查
npm run build         # typecheck + vite 构建前端
npm run check:deploy  # wrangler deploy --dry-run，部署前校验
npm run format        # prettier 格式化
```

## 部署到 Cloudflare（免费）

采用 **GitHub 部署**：把仓库推到 GitHub，让 Cloudflare 在每次 push 后自动构建并部署。

### 0. 准备：构建交付物

```bash
npm install
npm run build
```

### 1. 创建存储资源并填 database_id

1. Dashboard → **Workers & Pages → D1 → Create database**：命名 `momo-blog-db`，记下首页返回的 **Database ID**。

2. 把真实 ID **手动替换**到 `wrangler.toml` 的占位符（当前为 `REPLACE_WITH_YOUR_D1_ID`）：

   ```toml
   [[d1_databases]]
   binding = "DB"
   database_name = "momo-blog-db"
   database_id = "你的真实 D1 ID"   # ← 手动替换
   ```

   > `database_id` 是**必填**的编译期绑定字段，官方规定无法放入 Secret，必须写在 `wrangler.toml` 中。占位符未替换会导致部署失败（code 10021）。

3. Dashboard → **Workers & Pages → R2 → Create bucket**：命名 `momo-blog-storage`（R2 无需 id）。

### 2. 设置变量（务必添加完整）

在 Cloudflare Worker 的 **Settings → Variables and Secrets** 中，按下表添加（`SECRET` / `SETUP_TOKEN` 类型选 **Secret（加密）**，值只读不显示）：

> 依据项目安全约定：**API 密钥与请求地址必须存放在 Cloudflare Secrets/KV，不硬编码。**

| 变量名 | 类型 | 是否必填 | 说明 |
|---|---|---|---|
| `SECRET` | Secret（加密） | 必填 | 会话/签名密钥，**≥32 字符**随机串（如 `openssl rand -hex 32` 生成） |
| `SETUP_TOKEN` | Secret（加密） | 必填 | 首次创建管理员的初始化令牌，**≥20 字符**随机串 |
| `APP_URL` | 普通变量 | 建议 | 你的 https 域名（例如 `https://cf-momo-blog.<你的子域>.workers.dev` 或自定义域名）；设了登录 Cookie 才带 `Secure` |
| `D1_DATABASE_ID`（可选） | 不适用 | — | 见下注 |

> **关于 `D1_DATABASE_ID`**：D1 绑定必须使用 wrangler.toml 里的 `database_id`，它不能迁移到运行时 Secret。此表仅列出实际需要的变量，无需添加这个名称。

### 4. 选择一种 GitHub 部署实现

> 两种方式**二选一**，都依赖第 1 步已把真实 `database_id` 写进 `wrangler.toml`、第 2 步已在 Cloudflare 配好变量。

---

#### 方式 A · GitHub（fork）部署（推荐新手）

在 **GitHub 网页**上 fork 本项目并修改 `database_id`，再让 Cloudflare 连接你 fork 的仓库，push 后自动构建部署。

1. 在 GitHub 打开本仓库 → 点右上角 **Fork**（会得到一份属于你的副本）。

2. 在你 **fork 后的仓库**里，把 `wrangler.toml` 的占位符改成你的真实 D1 ID（GitHub 网页可直接编辑）：
   - 进入 `wrangler.toml` → 点铅笔图标编辑 → 把 `database_id = "REPLACE_WITH_YOUR_D1_ID"` 改成 `database_id = "你的真实 D1 ID"` → **Commit changes**（提交到 `main` 分支）。

   > 直接在 GitHub 网页改即可，不需要本地 git。占位符未替换会导致部署失败（code 10021）。

3. 将 fork 的仓库连接到 Cloudflare：
   - Workers & Pages → **Create** → Worker → **Connect to Git** → 选中你的 fork 仓库、分支 `main` → **Create**。

4. 进 Worker 详情 → **Settings → Build**，改成：

   | 字段 | 值 |
   |---|---|
   | **Build command** | `npm ci && npm run build` |
   | **Deploy command** | `npx wrangler deploy`（默认） |
   | **Root directory** | 留空 |

   Save 后 Cloudflare 自动构建部署（或点 **Retry deployment**）。

5. 访问站点 API 验证可正常读写。

> **特点**：全程在 GitHub + Cloudflare 网页完成，无需本地命令、无需配 GitHub Actions 凭据，适合不想碰 CLI 的用户。对应 Cloudflare 的「Git integration」能力。

---

#### 方式 B · GitHub Actions 自动部署（推荐进阶）

在**你自己的仓库**里启用 GitHub Actions，push 到 `main` 即自动构建并部署（适合本地改代码、希望有完整 CI 的开发者）。

1. 把项目推到你的 GitHub 仓库（`main` 分支）。

2. 在 **GitHub → 仓库 → Settings → Secrets and variables → Actions** 添加两个 Secret：

   | Secret | 说明 |
   |---|---|
   | `CLOUDFLARE_API_TOKEN` | Cloudflare → 个人资料 → **API Tokens** → Create token，权限：Workers Scripts — Edit、Account Settings — Read、Workers R2 Bucket — Edit、D1 — Edit |
   | `CLOUDFLARE_ACCOUNT_ID` | Dashboard 右下角账户 ID |

3. 仓库已有 [`.github/workflows/deploy.yml`](./.github/workflows/deploy.yml)。确认其中 `wrangler.toml` 的 `database_id` 已是真实值（在你本地/仓库中替换占位符）。

4. push 到 `main`，Actions 自动执行 `npm ci && npm run build` 后 `wrangler deploy`。

5. 访问站点 API 验证可正常读写。

`deploy.yml` 核心：

```yaml
name: Deploy to Cloudflare Workers
on:
  push:
    branches: [ main ]
  workflow_dispatch:
jobs:
  deploy:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 20
      - run: npm ci
      - run: npm run build
      - name: Publish to Cloudflare
        uses: cloudflare/wrangler-action@v3
        with:
          apiToken: ${{ secrets.CLOUDFLARE_API_TOKEN }}
          accountId: ${{ secrets.CLOUDFLARE_ACCOUNT_ID }}
          command: deploy
```

> - 该方式要求 `wrangler.toml` 中 `database_id` 已填真实值。
>
> - D1/R2 绑定在云端已创建并写了 `wrangler.toml`，`wrangler deploy` 会按 `name`/绑定匹配既有 Worker 与资源。
>
> - Secrets（`SECRET`/`SETUP_TOKEN`/`APP_URL`）在 Dashboard 的 Worker 设置里添加一次即可；`wrangler.toml` 已开启 `keep_vars = true`，Actions 每次 deploy 不会覆盖它们。

### 5. 首次初始化管理员

打开站点 → 滚动到底部点「管理」→「创建你的管理员账号」，输入**初始化令牌 + 邮箱 + 密码（≥12 位）**，之后即可「编辑页面」。

> 令牌规则：若已在 Cloudflare 设置 `SETUP_TOKEN`（加密 Secret），必须与其一致；**未设置时可直接在网页里自行设定**（≥20 字符，首次输入即生效，令牌仅 HMAC 签名存储，管理员创建完成后入口自动关闭）。

***

## 使用说明

- 访问部署后的域名即为主页；首页默认展示演示数据（执行过 `seed`）。

- 点右上角「登录」进入管理员界面：

  - 首次登录用「创建你的管理员账号」完成初始化；

  - 登录后可「编辑页面」：在线修改项目、文章、相册、收藏、音乐等内容。

- 访客可：浏览主页、查看相册/收藏、播放音乐、签到打卡、点赞、发表留言。

- 后台留言管理：登录后在留言板区域可查看/标记已读/删除留言。

## 数据库与绑定说明

- **D1**（`DB` 绑定）：存储站点内容、设置、媒体元数据、访客统计、留言与 better-auth 用户表。

- **R2**（`STORAGE` 绑定）：存媒体对象本身，`media.filename` 即 R2 key；图片为 WebP（全尺寸 + 缩略图），音频保留原始格式。

- 建表均为幂等（`IF NOT EXISTS`），可安全重复部署。

- D1/R2 的绑定配置在 `wrangler.toml`，纯 Dashboard 无法修改，需用 git + wrangler。

## 常见问题

- **部署后首页报"首页尚未初始化"**：先执行 `npm run seed`。

- **数据库 id**：`wrangler.toml` 中 `database_id` 仍为占位符会导致部署失败，请用 `d1 create` 返回的 id 替换。

- **图片/音频上传**：图片在浏览器端压缩为 WebP，音频仅做元数据校验（Worker 环境不支持 ffmpeg），属预期行为。

- **冷启动建表**：建表是幂等的，首访勿并发，避免重复迁移。

- 更多迁移细节与坑点见 [DEPLOY.md](./DEPLOY.md)。

## License

[MIT](./package.json)
