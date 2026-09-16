export interface Env {
  DB: D1Database;
  STORAGE: R2Bucket;
  ASSETS: Fetcher;
  // 敏感配置走后端密钥（wrangler secret put），不硬编码
  SECRET: string;
  SETUP_TOKEN: string;
  APP_URL?: string;
}

export interface Db {
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