import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import type { Context } from "hono";
import type { Env } from "./env.js";
import type { BusinessDb } from "./db.js";

export class AuthError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export interface AdminUser {
  id: string;
  email: string;
}

export interface AuthHandle {
  handler(request: Request): Promise<Response>;
  initialized(): Promise<boolean>;
  session(c: Context): Promise<unknown>;
  requireAdmin(c: Context): Promise<{ user: AdminUser }>;
  signup(input: {
    email: string;
    password: string;
  }): Promise<unknown>;
}

/**
 * 创建认证。better-auth 直接接收 D1Database（env.DB）——它会自动挂上
 * Kysely adapter、正确识别数据库类型，并完成自己的表迁移（user/session/account/verification）。
 * 不能手动包一层 Kysely(D1Dialect) 再传入，否则 better-auth 无法推断数据库类型，
 * 迁移时会回退 sqlite 并 process.exit(1) 崩溃。
 *
 * 认证的受信来源（trustedOrigins）按“请求的真实 Origin”动态确定，而不是写死白名单。
 * 这样无论通过自定义域名（如 https://blg.auster.ccwu.cc）还是 workers.dev 访问，登录都不会报
 * “Invalid origin”。每个不同 Origin 惰性生成并缓存一个 betterAuth 实例（迁移全局只跑一次）。
 */
export function createAuth(env: Env, db: BusinessDb): Promise<AuthHandle> {
  if (!env.SECRET)
    throw new AuthError(500, "服务端未配置 SECRET，请在 Dashboard → Variables and Secrets 以 Secret 类型添加后重试。");
  const defaultBaseURL = env.APP_URL || "http://127.0.0.1:8787";
  const defaultSecure = new URL(defaultBaseURL).protocol === "https:";
  const trustedOrigins = [
    "http://127.0.0.1:4317",
    "http://localhost:4317",
    "http://127.0.0.1:8787",
    "http://localhost:8787",
  ];

  // 从请求推导 Origin（含 x-forwarded-proto，兼容 HTTPS）
  const originOf = (req: Request): string => {
    const proto =
      req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
      new URL(req.url).protocol.replace(":", "");
    const host = req.headers.get("host") || new URL(req.url).host;
    return `${proto}://${host}`;
  };

  // 每个 Origin 一个 { auth, bootstrap }；迁移单独跑一次，避免并发冲突
  const instances = new Map<string, { auth: any; bootstrap: any }>();
  const migrationsDone = (async () => {
    // 用默认 baseURL 跑迁移（幂等，表结构不依赖具体域名）
    const seedConfig = {
      database: env.DB,
      baseURL: defaultBaseURL,
      secret: env.SECRET,
      trustedOrigins,
      telemetry: { enabled: false },
      session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
      advanced: {
        useSecureCookies: defaultSecure,
        cookiePrefix: "hejia-homepage",
        defaultCookieAttributes: { httpOnly: true, sameSite: "lax" as const },
      },
      emailAndPassword: { enabled: true, disableSignUp: true },
    } as const;
    const migrations = await getMigrations(seedConfig);
    await migrations.runMigrations();
    // 仅允许一个站点管理员账号
    await db.batch([
      `CREATE UNIQUE INDEX IF NOT EXISTS single_site_admin ON "user" ((1))`,
    ]);
  })();

  const getInstances = async (origin: string) => {
    let inst = instances.get(origin);
    if (inst) return inst;
    const secure = origin.startsWith("https:");
    const config = {
      database: env.DB,
      baseURL: origin,
      secret: env.SECRET,
      trustedOrigins: [origin, "http://127.0.0.1:4317", "http://localhost:4317"] as string[],
      telemetry: { enabled: false },
      session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
      advanced: {
        useSecureCookies: secure,
        cookiePrefix: "hejia-homepage",
        defaultCookieAttributes: { httpOnly: true, sameSite: "lax" as const },
      },
      emailAndPassword: {
        enabled: true,
        disableSignUp: true,
        minPasswordLength: 12,
        maxPasswordLength: 128,
        autoSignIn: false,
      },
    } as const;
    inst = {
      auth: betterAuth({ ...config }),
      bootstrap: betterAuth({
        ...config,
        emailAndPassword: { ...config.emailAndPassword, disableSignUp: false },
      }),
    };
    instances.set(origin, inst);
    return inst;
  };

  const initialized = async () =>
    !!(await db.get<{ id: string }>('SELECT id FROM "user" LIMIT 1'));

  const sessionFor = async (c: Context) => {
    const origin = originOf(c.req.raw);
    const { auth } = await getInstances(origin);
    return auth.api.getSession({ headers: c.req.raw.headers });
  };

  return (async () => {
    await migrationsDone;
    return {
      handler: async (request: Request) => {
        const origin = originOf(request);
        const { auth } = await getInstances(origin);
        return auth.handler(request);
      },
      initialized,
      session: (c: Context) => sessionFor(c),
      requireAdmin: async (c: Context) => {
        const data = (await sessionFor(c)) as { user: AdminUser } | null;
        const admin = await db.get<{ id: string }>(
          'SELECT id FROM "user" LIMIT 1',
        );
        if (!data || !admin || data.user.id !== admin.id) {
          throw new AuthError(401, "登录已过期，请重新登录。");
        }
        return { user: data.user };
      },
      async signup({ email, password }) {
        const base = env.APP_URL || defaultBaseURL;
        const secure = base.startsWith("https:");
        const cfg = {
          database: env.DB,
          baseURL: base,
          secret: env.SECRET,
          trustedOrigins,
          telemetry: { enabled: false },
          session: { expiresIn: 60 * 60 * 24 * 7, cookieCache: { enabled: false } },
          advanced: {
            useSecureCookies: secure,
            cookiePrefix: "hejia-homepage",
            defaultCookieAttributes: { httpOnly: true, sameSite: "lax" as const },
          },
          emailAndPassword: { enabled: true, disableSignUp: false },
        } as const;
        const bootstrap = betterAuth(cfg);
        return bootstrap.api.signUpEmail({
          body: { email, password, name: "Site Admin" },
        });
      },
    };
  })();
}

/** 恒定时间校验初始化令牌 */
export function verifyToken(actual: string, expected: string): boolean {
  const a = new TextEncoder().encode(actual);
  const e = new TextEncoder().encode(expected);
  if (!e.length || a.length !== e.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ e[i];
  return diff === 0;
}