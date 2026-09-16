import type { HomeContent, HomeResponse } from "../shared/model.js";

/** 业务表访问封装：node:sqlite 风格调用，映射到 D1 异步 API。 */
export interface BusinessDb {
  run(sql: string, ...args: unknown[]): Promise<{ changes: number }>;
  get<T = Record<string, unknown>>(
    sql: string,
    ...args: unknown[]
  ): Promise<T | null>;
  all<T = Record<string, unknown>>(
    sql: string,
    ...args: unknown[]
  ): Promise<T[]>;
  batch(sqls: string[]): Promise<unknown>;
}

export function createDb(d1: D1Database): BusinessDb {
  const stmt = (sql: string, args: unknown[]) => {
    const p = d1.prepare(sql);
    return args.length ? p.bind(...(args as unknown[])) : p;
  };
  return {
    async run(sql: string, ...args: unknown[]) {
      const r = await stmt(sql, args).run();
      return { changes: Number(r.meta.changes ?? 0) };
    },
    async get<T>(sql: string, ...args: unknown[]) {
      return (await stmt(sql, args).first<T>()) ?? null;
    },
    async all<T>(sql: string, ...args: unknown[]) {
      const r = await stmt(sql, args).all<T>();
      return r.results;
    },
    async batch(sqls: string[]) {
      return d1.batch(sqls.map((s) => d1.prepare(s)));
    },
  };
}

/**
 * 初始化 D1：幂等地创建业务表。
 * better-auth 自己的表（user/session/account/verification）由它的 kysely 迁移自动创建。
 */
export async function applySchema(db: D1Database): Promise<void> {
  const statements = [
    `CREATE TABLE IF NOT EXISTS site_content (
      id INTEGER PRIMARY KEY CHECK(id=1),
      revision INTEGER NOT NULL DEFAULT 1,
      data TEXT NOT NULL
    )`,
    `CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL)`,
    `CREATE TABLE IF NOT EXISTS media (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      filename TEXT NOT NULL,
      thumb TEXT,
      cover_mime TEXT,
      mime TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      duration REAL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS visitors (
      id TEXT PRIMARY KEY,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE TABLE IF NOT EXISTS visits (
      id TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      day TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
    )`,
    `CREATE INDEX IF NOT EXISTS visit_day_visitor ON visits(day, visitor_id)`,
    `CREATE TABLE IF NOT EXISTS checkins (
      visitor_id TEXT NOT NULL,
      day TEXT NOT NULL,
      PRIMARY KEY(visitor_id, day)
    )`,
    `CREATE TABLE IF NOT EXISTS likes (
      visitor_id TEXT PRIMARY KEY
    )`,
    `CREATE TABLE IF NOT EXISTS contact_messages (
      id TEXT PRIMARY KEY,
      visitor_id TEXT NOT NULL,
      name TEXT NOT NULL,
      email TEXT NOT NULL,
      body TEXT NOT NULL,
      created_at TEXT NOT NULL,
      is_read INTEGER NOT NULL DEFAULT 0
    )`,
    `CREATE INDEX IF NOT EXISTS contact_messages_created ON contact_messages(created_at DESC, id DESC)`,
  ];
  await db.batch(statements.map((s) => db.prepare(s)));
}

export async function ensureStartedAt(db: BusinessDb): Promise<void> {
  await db.run(
    "INSERT OR IGNORE INTO settings(key,value) VALUES('startedAt',?)",
    new Date().toISOString(),
  );
}

/**
 * 确保 site_content 至少有一条默认记录，避免 readHome 因空表而抛「首页尚未初始化」。
 * 这是 Cloudflare（Git 部署）下替代 seed 脚本的最小初始化：写入一个空首页，
 * 前端可正常渲染，管理员登录后在线编辑即可。已存在数据时不覆盖。
 */
export async function ensureHomeContent(db: BusinessDb): Promise<void> {
  const empty: HomeContent = {
    profile: {
      name: "",
      avatarId: null,
      headline: "",
      introduction: "",
      description: "",
      eyebrow: "",
      motto: "",
      photoId: "",
      photoCaption: "",
      demo: true,
    },
    social: { github: "", xiaohongshu: "", email: "" },
    projects: [],
    articles: [],
    photos: [],
    collections: [],
    tracks: [],
  };
  await db.run(
    "INSERT OR IGNORE INTO site_content(id,revision,data) VALUES(1,1,?)",
    JSON.stringify(empty),
  );
}

export async function readHome(db: BusinessDb): Promise<HomeResponse> {
  const row = await db.get<{ revision: number; data: string }>(
    "SELECT revision,data FROM site_content WHERE id=1",
  );
  if (!row) throw new Error("首页尚未初始化");
  const content = JSON.parse(String(row.data)) as HomeContent;
  content.profile.avatarId ??= null;
  content.social.xiaohongshu ??= "";
  return { revision: Number(row.revision), content };
}