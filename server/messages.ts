import { Hono } from "hono";
import { z } from "zod";
import { messageSchema } from "../shared/model.js";
import type { Env } from "./env.js";
import type { BusinessDb } from "./db.js";
import { AuthError } from "./auth.js";
import { HttpError } from "./media.js";

type MsgCtx = import("hono").Context<{ Bindings: Env; Variables: any }>;

export function mountMessages(
  router: Hono<{ Bindings: Env; Variables: any }>,
  dbFactory: (c: MsgCtx) => BusinessDb,
) {
  const limiter = createLimiter(15 * 60_000, 10);

  const isAdmin = async (c: MsgCtx) => {
    try {
      await c.var.auth.requireAdmin(c);
      return true;
    } catch (e) {
      if (e instanceof AuthError) return false;
      throw e;
    }
  };

  router.post("/api/messages", async (c) => {
    if (!limiter(c)) return c.json({ error: "留言有点频繁，请稍后再试。" }, 429);
    const input = messageSchema.safeParse(await c.req.json());
    if (!input.success)
      throw new HttpError(400, input.error.issues[0]?.message || "请检查留言内容。");
    const { submissionId, name, email, body } = input.data;
    const db = dbFactory(c);
    const visitorId = await c.var.visitor(c);
    const previous = await db.get<{
      visitor_id: string;
      name: string;
      email: string;
      body: string;
    }>(
      "SELECT visitor_id,name,email,body FROM contact_messages WHERE id=?",
      submissionId,
    );
    if (previous) {
      if (
        previous.visitor_id !== visitorId ||
        previous.name !== name ||
        previous.email !== email ||
        previous.body !== body
      )
        throw new HttpError(409, "这条留言已提交，请修改内容后重新发送。");
      return c.json({ received: true });
    }
    await db.run(
      "INSERT INTO contact_messages(id,visitor_id,name,email,body,created_at) VALUES(?,?,?,?,?,?)",
      submissionId,
      visitorId,
      name,
      email,
      body,
      new Date().toISOString(),
    );
    return c.json({ received: true }, 201);
  });

  router.get("/api/messages", async (c) => {
    if (!(await isAdmin(c))) return c.json({ error: "登录已过期，请重新登录。" }, 401);
    const db = dbFactory(c);
    const pageRes = z.coerce
      .number()
      .int()
      .min(1)
      .max(100000)
      .safeParse(c.req.query("page") || 1);
    if (!pageRes.success) throw new HttpError(400, "页码无效。");
    const page = pageRes.data;
    const pageSize = 20;
    const rows = await db.all<{
      id: string;
      name: string;
      email: string;
      body: string;
      created_at: string;
      is_read: number;
    }>(
      "SELECT id,name,email,body,created_at,is_read FROM contact_messages ORDER BY created_at DESC,id DESC LIMIT ? OFFSET ?",
      pageSize,
      (page - 1) * pageSize,
    );
    const total = Number(
      (await db.get<{ n: number }>("SELECT COUNT(*) n FROM contact_messages"))?.n ?? 0,
    );
    const unread = Number(
      (await db.get<{ n: number }>("SELECT COUNT(*) n FROM contact_messages WHERE is_read=0"))?.n ?? 0,
    );
    return c.json({
      messages: rows.map((row) => ({
        id: row.id,
        name: row.name,
        email: row.email,
        body: row.body,
        createdAt: row.created_at,
        read: Boolean(row.is_read),
      })),
      total,
      unread,
      page,
      pageSize,
    });
  });

  router.patch("/api/messages/:id", async (c) => {
    if (!(await isAdmin(c))) return c.json({ error: "登录已过期，请重新登录。" }, 401);
    const input = z.object({ read: z.boolean() }).safeParse(await c.req.json());
    if (!input.success) throw new HttpError(400, "留言状态无效。");
    const r = await dbFactory(c).run(
      "UPDATE contact_messages SET is_read=? WHERE id=?",
      Number(input.data.read),
      c.req.param("id"),
    );
    if (!r.changes) throw new HttpError(404, "这条留言已不存在。");
    return c.json({ updated: true });
  });

  router.delete("/api/messages/:id", async (c) => {
    if (!(await isAdmin(c))) return c.json({ error: "登录已过期，请重新登录。" }, 401);
    await dbFactory(c).run("DELETE FROM contact_messages WHERE id=?", c.req.param("id"));
    return c.json({ deleted: true });
  });
}

interface Box {
  count: number;
  reset: number;
}
export function createLimiter(windowMs: number, limit: number) {
  const buckets = new Map<string, Box>();
  const key = (c: { req: { header(name: string): string | undefined } }) =>
    c.req.header("CF-Connecting-IP") || "anon";
  return (c: { req: { header(name: string): string | undefined } }): boolean => {
    const k = key(c);
    const now = Date.now();
    const box = buckets.get(k);
    if (!box || box.reset <= now) {
      buckets.set(k, { count: 1, reset: now + windowMs });
      return true;
    }
    box.count += 1;
    return box.count <= limit;
  };
}