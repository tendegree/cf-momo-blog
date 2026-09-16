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
 */
export function createAuth(env: Env, db: BusinessDb): Promise<AuthHandle> {
  const baseURL = env.APP_URL || "http://127.0.0.1:8787"; // wrangler dev 默认端口
  const secure = new URL(baseURL).protocol === "https:";
  const baseOrigin = new URL(baseURL).origin;
  const trustedOrigins = [
    baseOrigin,
    "http://127.0.0.1:4317",
    "http://localhost:4317",
    "http://127.0.0.1:8787",
    "http://localhost:8787",
  ];

  const config = {
    database: env.DB, // 直接传 D1Database，让 better-auth 自行识别类型并迁移
    baseURL,
    secret: env.SECRET,
    trustedOrigins,
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

  return (async () => {
    // 运行 better-auth 的表迁移（幂等）
    const migrations = await getMigrations(config);
    await migrations.runMigrations();
    // 仅允许一个站点管理员账号
    await db.batch([
      `CREATE UNIQUE INDEX IF NOT EXISTS single_site_admin ON "user" ((1))`,
    ]);

    const auth = betterAuth({ ...config });
    const bootstrap = betterAuth({
      ...config,
      emailAndPassword: { ...config.emailAndPassword, disableSignUp: false },
    });

    const initialized = async () =>
      !!(await db.get<{ id: string }>('SELECT id FROM "user" LIMIT 1'));

    const session = (c: Context) =>
      auth.api.getSession({ headers: c.req.raw.headers });

    const requireAdmin = async (c: Context) => {
      const data = (await session(c)) as { user: AdminUser } | null;
      const admin = await db.get<{ id: string }>(
        'SELECT id FROM "user" LIMIT 1',
      );
      if (!data || !admin || data.user.id !== admin.id) {
        throw new AuthError(401, "登录已过期，请重新登录。");
      }
      return { user: data.user };
    };

    return {
      handler: (request: Request) => auth.handler(request),
      initialized,
      session,
      requireAdmin,
      async signup({ email, password }) {
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