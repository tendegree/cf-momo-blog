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

> 下面提供 **三种部署方式，任选其一**。三者共用同一套交付物（前端构建产物 + Worker 编译脚本 + D1/R2 绑定 + Secrets），只是“如何把产物推上 Cloudflare”不同。

| 方式                                                    | 适用场景                       | 说明                                     |
| ----------------------------------------------------- | -------------------------- | -------------------------------------- |
| [方式一 · git + wrangler](#方式一--git--wrangler推荐适合有-cli)  | 本机已装 Wrangler，想一条命令部署      | `wrangler deploy`，绑定写在 `wrangler.toml` |
| [方式二 · Dashboard 手动上传](#方式二--dashboard-手动上传适合只用网页控制台) | 只用 Cloudflare 网页控制台，不装 CLI | 编译产物手动拖到控制台                            |
| [方式三 · GitHub 部署](#方式三--github-部署适合已有-github-仓库)      | 已有 GitHub 仓库，希望提交即自动部署     | Dashboard 连接仓库，或 GitHub Actions        |

三方式的「前置准备」共享如下：

**前置：构建交付物**

```bash
npm install
npm run build               # 类型检查 + vite 构建前端 → dist/client
npx wrangler deploy --dry-run --outdir=dist
                            # ① 若走 CLI：直接跳到方式一
# ② 若走手动/GitHub：生成 Worker 编译脚本（见方式二）
```

***

### 方式一 · git + wrangler（推荐，适合有 CLI）

#### 1. 登录并创建存储资源

```bash
wrangler login

# 创建 D1 数据库
npx wrangler d1 create momo-blog-db
#  ↑ 返回的 database_id 填到 wrangler.toml 的 database_id

# 创建 R2 桶
npx wrangler r2 bucket create momo-blog-storage
```

#### 2. 设置密钥（不写入代码）

> 依据项目安全约定：**API 密钥与请求地址必须存放在 Cloudflare Secrets/KV，不硬编码。**

```bash
npx wrangler secret put SECRET        # 会话/签名密钥，≥32 字符
npx wrangler secret put SETUP_TOKEN   # 首次创建管理员的初始化令牌，≥20 字符
npx wrangler secret put APP_URL       # 生产域名，例如 https://blog.example.com
```

#### 3. 构建并部署

```bash
npm run build
npx wrangler deploy
```

首次请求会自动执行 D1 建表（业务表 + better-auth 用户/会话表）。

#### 4. 写入演示数据（可选，但有首页）

```bash
npm run seed
```

把 `assets/demo` 素材上传到 R2，并写入示例首页。**首次部署建议先 seed 再访问，否则** **`/api/home`** **提示"首页尚未初始化"。**

#### 5. 首次初始化管理员

打开站点 → 点「登录」→「创建你的管理员账号」，粘贴上一步在 `SETUP_TOKEN` 中设置的值 + 邮箱 + 密码（≥12 位）。之后即可「编辑页面」。

#### 6.（可选）绑定自定义域名

Dashboard → Workers 详情 → 设置 → 域/触发器 → 添加自定义域，并把 `APP_URL` 设为该 https 域名，使 Cookie 携带 `Secure`。

***

### 方式二 · Dashboard 手动上传（适合只用网页控制台）

> 说明：代码必须被 **打包/编译** 后才能作为 Worker 上传，这一步在浏览器里做不到，因此首次仍需用本机 `npx wrangler` 生成一次产物（`npx` 免全局安装）；之后的**部署与修改**都可在 Cloudflare 网页控制台完成。

#### 1. 生成交付物

```bash
npm install
npm run build                    # → dist/client（前端）
npx wrangler deploy --dry-run --outdir=dist
# 编译产物：dist/worker.js（主脚本，内含全部后端与依赖）
```

#### 2. 在 Dashboard 创建 D1/R2

- Workers & Pages → D1 → Create database → 命名 `momo-blog-db`，记下返回的 `database_id`，填进 `wrangler.toml` 后重新运行上一步 `dry-run`。

- Workers & Pages → R2 → Create bucket → 命名 `momo-blog-storage`。

#### 3. 创建 Worker

Workers & Pages → Create → Worker → 命名 `momo-blog` → Deploy。

#### 4. 上传主脚本

打开该 Worker → **编辑代码** → 清空默认内容，把 `dist/worker.js` 的**全部内容粘贴**进去 → 右上角 **Deploy**。

> 注意：控制台编辑保存即重新部署，且会覆盖脚本源码。之后若再改用方式一/GitHub，会以云端这份为准。

#### 5. 上传静态前端（Assets）

- Worker 详情 → 打开 **Assets**（静态资源）面板 → 上传 `dist/client/` 里的所有文件（含 `index.html` 与 `assets/` 子目录）。

- 开启 **Serve Single-Page-Application**（404 回退到 `index.html`）。**必须开启**，否则刷新子路由会 404。

- 绑定名保持 `ASSETS`（与代码一致）。

#### 6. 绑定 D1 与 R2

Worker → **Settings** → **Variables and Secrets** → **Add binding**：

| 绑定类型        | 名称        | 指向                  |
| ----------- | --------- | ------------------- |
| D1 Database | `DB`      | `momo-blog-db`      |
| R2 Bucket   | `STORAGE` | `momo-blog-storage` |

#### 7. 设置密钥 / 变量

同样在 Variables and Secrets 中，`SECRET`、`SETUP_TOKEN` 以 **Secret** 类型添加，`APP_URL` 以普通变量添加（值是你的 https 域名）。密钥不写入代码仓库。

#### 8. 初始化管理员

打开站点 → 登录 → 使用 `SETUP_TOKEN` 创建管理员账号（见方式一第 5 步）。至此即可使用。

> **seed 演示数据的限制**：`npm run seed` 需要本机 wrangler 连远程写 D1/R2，纯网页控制台无法执行。Dashboard 手动部署若想有示例首页，需在本机 `wrangler login` 后运行 `npm run seed` 一次；否则直接进入管理员后台自行编辑即可（无需 seed）。

***

### 方式三 · GitHub 部署（适合已有 GitHub 仓库）

把仓库推到 GitHub，让 Cloudflare 在每次 push 后自动构建并部署。两种实现二选一：

#### 选项 A · Dashboard 连接 GitHub（贴合"仅网页控制台"）

> **重要说明**：Cloudflare 新 Workers UI 创建页面**没有**"Build command / Root directory / Build output dir"这些字段。这是 Workers 与旧 Pages UI 的入口差异——Worker 的构建配置需要在 **创建完成后**，从 Worker 详情页 **Settings → Build** 进入。本项目因为用 `wrangler.toml` 的 `[assets] directory` 声明了静态前端路径，所以 Cloudflare Builds 只需要跑一个构建命令即可，不需要填 output dir 或 root directory。

1. 把项目推到 GitHub 仓库。
2. Workers & Pages → **Create** → Worker → **Connect to Git** → 连接 GitHub，选中仓库，分支选 `main`。
3. 首次部署完成后，从该 Worker 详情页进入 **Settings → Build**，修改构建配置：

   - **Build command**：`npm ci && npm run build`（让 Cloudflare 在 deploy 前先生成 `dist/client`）
   - **Deploy command**：保持默认 `npx wrangler deploy`（wrangler.toml 里的 `[assets] directory = "./dist/client"` 会被自动识别）
   - Root directory **留空**（项目就是仓库根目录）

   保存后 Cloudflare 会在下次 push 时按新配置构建。

4. D1/R2 绑定、`SECRET`/`SETUP_TOKEN`/`APP_URL` 密钥，在 **Settings → Bindings / Variables and Secrets** 中按方式二第 6–7 步配置一次。

#### 选项 B · GitHub Actions + wrangler-action

需要两个仓库 Secret（Settings → Secrets and variables → Actions）：

- `CLOUDFLARE_API_TOKEN`：Cloudflare → 我的个人资料 → **API Tokens** → Create token，勾选权限：`Workers Scripts — Edit`、`Account Settings — Read`、`Workers R2 Bucket — Edit`、D1 相关 Edit（若 token 类型可选）。

- `CLOUDFLARE_ACCOUNT_ID`：Dashboard 右下角账户 ID。

创建 `.github/workflows/deploy.yml`：

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
> - Secrets（`SECRET`/`SETUP_TOKEN`/`APP_URL`）不随代码提交，在 Dashboard 的 Worker 设置里添加一次即可，Actions 每次 deploy 不会覆盖它们。
>
> - D1/R2 绑定在云端已存在，`wrangler deploy` 会按 `wrangler.toml` 的 `name`/绑定匹配既有 Worker 与资源。

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
