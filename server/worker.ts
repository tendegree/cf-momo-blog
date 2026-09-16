import { Hono, type Context } from "hono";
import { createHmac } from "node:crypto";
import { z } from "zod";
import {
  contentSchema,
  referencedMedia,
  sydneyDay,
  type Stats,
  type Media,
} from "../shared/model.js";
import {
  createDb,
  applySchema,
  ensureStartedAt,
  readHome,
  type BusinessDb,
} from "./db.js";
import type { Env } from "./env.js";
import { createAuth, AuthError, type AuthHandle } from "./auth.js";
import { HttpError, uploadImage, uploadAudio, serveMedia } from "./media.js";
import { createWeatherService } from "./weather.js";
import { mountMessages, createLimiter } from "./messages.js";

const API = "/api";

// ---- 全局单例（每个隔离实例只跑一次）----
let ready: Promise<void> | null = null;
function ensureReady(env: Env): Promise<void> {
  ready ??= (async () => {
    await applySchema(env.DB);
    const db = createDb(env.DB);
    await ensureStartedAt(db);
  })();
  return ready;
}

let authHandle: Promise<AuthHandle> | null = null;
function getAuth(env: Env): Promise<AuthHandle> {
  authHandle ??= createAuth(env, createDb(env.DB));
  return authHandle;
}

type Vars = {
  db: BusinessDb;
  auth: AuthHandle;
  visitor: (c: any) => Promise<string>;
  initialized: () => Promise<boolean>;
};

type AppEnv = { Bindings: Env; Variables: Vars };
// 路由处理器内的 c 由 Hono 自动推断；辅助函数按“任意上下文”处理避免泛型摩擦
type AnyCtx = any;

const router = new Hono<{ Bindings: Env; Variables: Vars }>();

// 请求上下文：建表、DB、认证、visitor
router.use("*", async (c, next) => {
  const env = c.env;
  await ensureReady(env);
  c.set("db", createDb(env.DB));
  c.set("auth", await getAuth(env));
  c.set("initialized", () => c.var.auth.initialized());
  c.set("visitor", async () => getVisitor(c));
  await next();
});

// 安全响应头
router.use("*", async (c, next) => {
  await next();
  c.res.headers.set("X-Content-Type-Options", "nosniff");
  c.res.headers.set("Referrer-Policy", "strict-origin-when-cross-origin");
});

// /api：写请求来源校验 + 缓存头（首页/媒体自行覆盖）
router.use(`${API}/*`, async (c, next) => {
  const method = c.req.method;
  if (!["GET", "HEAD", "OPTIONS"].includes(method)) {
    const origins = trustedOrigins(c);
    if (
      c.req.header("sec-fetch-site") === "cross-site" ||
      (c.req.header("origin") && !origins.includes(c.req.header("origin")!))
    )
      return c.json({ error: "请求来源无效。" }, 403);
  }
  const p = c.req.path;
  if (!p.startsWith(`${API}/home`) && !p.startsWith(`${API}/media`))
    c.header("Cache-Control", "no-store");
  await next();
});

// 统一错误处理（Hono 的 onError 回调是 (err, c)）
router.onError((err, c) => {
  const status =
    err instanceof HttpError
      ? err.status
      : err instanceof AuthError
        ? err.status
        : 500;
  const message =
    err instanceof HttpError || err instanceof AuthError
      ? err.message
      : "暂时无法完成，请稍后重试。";
  if (status === 500) console.error(err);
  return c.json({ error: message }, status as never);
});

// ---- 工具 ----
function trustedOrigins(c: AnyCtx): string[] {
  const host = c.req.header("host") || "localhost";
  const scheme = c.req.header("x-forwarded-proto") === "https" ? "https" : "http";
  const base = `${scheme}://${host}`;
  return [
    base,
    c.env.APP_URL || "",
    "http://127.0.0.1:4317",
    "http://localhost:4317",
    "http://127.0.0.1:8787",
  ].filter(Boolean);
}

const hmac = (id: string, secret: string) =>
  createHmac("sha256", secret).update(id).digest("hex");

async function getVisitor(c: AnyCtx): Promise<string> {
  const cookie: string = String(c.req.header("cookie") || "");
  const raw = cookie
    .split(";")
    .map((x: string) => x.trim())
    .find((x: string) => x.startsWith("hejia-home-visitor="))
    ?.slice(19);
  let visitor = "";
  if (raw && /^[\da-f-]{36}\.[\da-f]{64}$/.test(raw)) {
    const id = raw.slice(0, 36);
    if (
      `${id}.${hmac(id, c.env.SECRET)}` === raw &&
      (await c.var.db.get("SELECT id FROM visitors WHERE id=?", id))
    )
      visitor = id;
  }
  if (!visitor) {
    visitor = crypto.randomUUID();
    await c.var.db.run("INSERT INTO visitors(id) VALUES(?)", visitor);
    const secure = (c.env.APP_URL || "").startsWith("https:");
    c.header(
      "set-cookie",
      `hejia-home-visitor=${visitor}.${hmac(visitor, c.env.SECRET)}; HttpOnly; SameSite=Lax; Path=/api; Max-Age=${365 * 86400}${secure ? "; Secure" : ""}`,
      { append: true },
    );
  }
  return visitor;
}

async function stats(c: AnyCtx): Promise<Stats> {
  const db: BusinessDb = c.var.db;
  const visitor = await c.var.visitor(c);
  const day = sydneyDay(new Date());
  const started =
    (await db.get<{ value: string }>("SELECT value FROM settings WHERE key='startedAt'"))?.value ??
    new Date().toISOString();
  return {
    todayVisitors: Number((await db.get<{ n: number }>("SELECT COUNT(DISTINCT visitor_id) n FROM visits WHERE day=?", day))?.n ?? 0),
    totalViews: Number((await db.get<{ n: number }>("SELECT COUNT(*) n FROM visits"))?.n ?? 0),
    daysOnline: Math.max(1, Math.floor((Date.parse(day) - Date.parse(sydneyDay(new Date(started)))) / 86400000) + 1),
    checkedIn: !!(await db.get("SELECT 1 FROM checkins WHERE visitor_id=? AND day=?", visitor, day)),
    checkins: Number((await db.get<{ n: number }>("SELECT COUNT(*) n FROM checkins WHERE visitor_id=?", visitor))?.n ?? 0),
    likeCount: Number((await db.get<{ n: number }>("SELECT COUNT(*) n FROM likes"))?.n ?? 0),
    liked: !!(await db.get("SELECT 1 FROM likes WHERE visitor_id=?", visitor)),
  };
}

// ---- 首页 ----
router.get(`${API}/home`, async (c) => {
  const home = await readHome(c.var.db);
  c.header("Cache-Control", "public, max-age=0, must-revalidate");
  c.header("ETag", `"home-${home.revision}"`);
  return c.json(home);
});

router.put(`${API}/home`, async (c) => {
  const db = c.var.db;
  const input = z
    .object({ revision: z.number().int().positive(), content: contentSchema })
    .safeParse(await c.req.json());
  if (!input.success)
    throw new HttpError(400, input.error.issues[0]?.message || "请检查内容格式。");
  let refs: Map<string, "image" | "audio">;
  try {
    refs = referencedMedia(input.data.content);
  } catch {
    throw new HttpError(400, "素材类型不匹配。");
  }
  for (const [id, kind] of refs) {
    const m = await db.get<{ kind: string }>("SELECT kind FROM media WHERE id=?", id);
    if (!m || m.kind !== kind)
      throw new HttpError(400, "部分素材已不存在或类型不正确，请重新选择。");
  }
  const result = await db.run(
    "UPDATE site_content SET data=?,revision=revision+1 WHERE id=1 AND revision=?",
    JSON.stringify(input.data.content),
    input.data.revision,
  );
  if (!result.changes)
    throw new HttpError(409, "另一个窗口已更新首页。你的草稿仍在，请先取消编辑并重新载入，再重新应用修改。");
  return c.json(await readHome(db));
});

// ---- 状态 / 统计 ----
router.get(`${API}/state`, async (c) => {
  const session = (await c.var.auth.session(c)) as {
    user: { id: string; email: string };
  } | null;
  return c.json({
    auth: {
      initialized: await c.var.initialized(),
      authenticated: !!session,
      ...(session ? { email: session.user.email } : {}),
    },
    stats: await stats(c),
  });
});

router.get(`${API}/stats`, async (c) => c.json(await stats(c)));

const apiLimiter = createLimiter(60_000, 90);

router.post(`${API}/visits`, async (c) => {
  if (!apiLimiter(c)) return c.json({ error: "操作有点频繁，请稍后重试。" }, 429);
  const db = c.var.db;
  const visitor = await c.var.visitor(c);
  const p = z.object({ pageViewId: z.uuid() }).safeParse(await c.req.json());
  if (!p.success) throw new HttpError(400, "访问标识无效。");
  const session = (await c.var.auth.session(c)) as { user: { id: string } } | null;
  if (!session)
    await db.run(
      "INSERT OR IGNORE INTO visits(id,visitor_id,day) VALUES(?,?,?)",
      p.data.pageViewId,
      visitor,
      sydneyDay(new Date()),
    );
  return c.json(await stats(c));
});

router.post(`${API}/checkin`, async (c) => {
  if (!apiLimiter(c)) return c.json({ error: "操作有点频繁，请稍后重试。" }, 429);
  const db = c.var.db;
  const visitor = await c.var.visitor(c);
  await db.run("INSERT OR IGNORE INTO checkins(visitor_id,day) VALUES(?,?)", visitor, sydneyDay(new Date()));
  return c.json(await stats(c));
});

router.post(`${API}/likes`, async (c) => {
  if (!apiLimiter(c)) return c.json({ error: "操作有点频繁，请稍后重试。" }, 429);
  const db = c.var.db;
  const visitor = await c.var.visitor(c);
  const body = z.object({ liked: z.boolean() }).safeParse(await c.req.json());
  if (!body.success) throw new HttpError(400, "点赞状态无效。");
  if (body.data.liked) await db.run("INSERT OR IGNORE INTO likes(visitor_id) VALUES(?)", visitor);
  else await db.run("DELETE FROM likes WHERE visitor_id=?", visitor);
  return c.json(await stats(c));
});

router.get(`${API}/weather`, async (c) => c.json(await createWeatherService()()));

// ---- 媒体 ----
router.post(`${API}/media`, async (c) => {
  const admin = await c.var.auth.requireAdmin(c).catch((e: AuthError) => e);
  if (admin instanceof AuthError)
    return c.json({ error: admin.message }, admin.status as never);
  const kind = c.req.query("kind") ?? "";
  if (!["image", "audio"].includes(kind)) throw new HttpError(400, "请选择图片或音乐素材。");
  const form = await c.req.formData();
  const file = form.get("file");
  if (!(file instanceof File) || file.size === 0) throw new HttpError(400, "请选择文件。");
  let media: Media;
  if (kind === "image") {
    const thumb = form.get("thumb");
    const res = await uploadImage(
      c.env,
      c.var.db,
      file,
      thumb instanceof File && thumb.size > 0 ? thumb : null,
    );
    media = { id: res.id, kind: "image", url: res.url };
  } else {
    const res = await uploadAudio(c.env, c.var.db, file);
    media = { id: res.id, kind: "audio", url: res.url, ...(res.duration ? { duration: res.duration } : {}) };
  }
  return c.json(media, 201);
});

router.get(`${API}/media/:id`, async (c) => {
  const id = c.req.param("id");
  const isPublic = referencedMedia((await readHome(c.var.db)).content).has(id);
  if (!isPublic) {
    const session = (await c.var.auth.session(c)) as { user: { id: string } } | null;
    if (!session) throw new HttpError(404, "素材不存在。");
  }
  const out = await serveMedia(
    c.env,
    c.var.db,
    id,
    c.req.query("size") === "thumb",
  );
  if (!out.body) throw new HttpError(404, "素材不存在。");
  return new Response(out.body, {
    headers: {
      "Content-Type": out.contentType,
      "Cache-Control": out.cacheControl,
    },
  });
});

// ---- 认证 ----
router.all(`${API}/auth/*`, async (c) => {
  const endpoint = c.req.path.slice(`${API}/auth/`.length);
  if (!["sign-in/email", "get-session", "sign-out"].includes(endpoint))
    return c.json({ error: "此认证入口未开放。" }, 404);
  // better-auth 自带通用 Request 处理器，直接在 Cloudflare 上运行
  return c.var.auth.handler(c.req.raw);
});

router.get(`${API}/admin/status`, async (c) => {
  const session = (await c.var.auth.session(c)) as {
    user: { id: string; email: string };
  } | null;
  return c.json({
    initialized: await c.var.initialized(),
    authenticated: !!session,
    ...(session ? { email: session.user.email } : {}),
  });
});

router.post(`${API}/setup`, async (c) => {
  const auth = c.var.auth;
  if (await auth.initialized())
    return c.json({ error: "管理员已创建，初始化入口已关闭。" }, 409);
  const input = z
    .object({ token: z.string().min(20).max(256), email: z.email(), password: z.string().min(12).max(128) })
    .safeParse(await c.req.json());
  if (!input.success)
    return c.json({ error: "请填写有效邮箱、初始化令牌和至少 12 位密码。" }, 400);
  const expected = c.env.SETUP_TOKEN || "";
  const a = new TextEncoder().encode(input.data.token);
  const e = new TextEncoder().encode(expected);
  let ok = a.length > 0 && a.length === e.length;
  if (ok) {
    let diff = 0;
    for (let i = 0; i < a.length; i++) diff |= a[i] ^ e[i];
    ok = diff === 0;
  }
  if (!ok) return c.json({ error: "初始化令牌不正确。" }, 403);
  try {
    await auth.signup({ email: input.data.email, password: input.data.password });
  } catch {
    return c.json({ error: "创建失败，请检查资料后重试。" }, 400);
  }
  return c.json({ ok: true }, 201);
});

// ---- 留言板 ----
mountMessages(router, (c) => c.var.db);

// ---- /api 兜底（JSON 404）+ 静态前端 ----
router.all(`${API}/*`, (c) => c.json({ error: "接口不存在。" }, 404));
router.notFound(async (c) => c.env.ASSETS.fetch(c.req.raw));

export default { fetch: router.fetch };
export type { Env };