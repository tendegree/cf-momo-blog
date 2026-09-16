import { betterAuth } from "better-auth";
import { getMigrations } from "better-auth/db/migration";
import { Kysely } from "kysely";
import { D1Dialect } from "kysely-d1";
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
 * 创建认证。better-auth 通过 kysely(over D1) 同时完成建表迁移与查询。
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

  const kysely = new Kysely({
    dialect: new D1Dialect({ database: env.DB }),
  });

  const config = {
    database: kysely, // better-auth 经 kysely 访问 D1（迁移 + 查询共用）
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