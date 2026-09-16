import { parseBuffer, type IAudioMetadata } from "music-metadata";
import type { Env } from "./env.js";
import type { BusinessDb } from "./db.js";

export class HttpError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

const IMAGE_MIMES = ["image/webp", "image/jpeg", "image/png"];
const AUDIO_TYPES: Record<string, { ext: string; mime: string }> = {
  "audio/mpeg": { ext: "mp3", mime: "audio/mpeg" },
  "audio/mp4": { ext: "m4a", mime: "audio/mp4" },
  "audio/x-m4a": { ext: "m4a", mime: "audio/mp4" },
  "audio/wav": { ext: "wav", mime: "audio/wav" },
  "audio/x-wav": { ext: "wav", mime: "audio/wav" },
  "video/mp4": { ext: "m4a", mime: "audio/mp4" },
};
/**
 * 上传图片。
 * 图片已在浏览器端预压缩为 WebP（并附带可选缩略图），这里只负责落到 R2 并登记。
 */
export async function uploadImage(
  env: Env,
  db: BusinessDb,
  file: File,
  thumb: File | null,
): Promise<{ id: string; kind: string; url: string }> {
  if (!IMAGE_MIMES.includes(file.type))
    throw new HttpError(
      400,
      "照片仅支持 WebP、JPEG 或 PNG，请选择有效图片。",
    );
  if (file.size > 20 * 1024 * 1024)
    throw new HttpError(400, "图片不能超过 20 MB。");
  const id = crypto.randomUUID();
  const bytes = await file.arrayBuffer();
  const fullKey = `${id}.webp`;
  await env.STORAGE.put(fullKey, bytes, {
    httpMetadata: { contentType: file.type },
  });
  let thumbKey: string | null = null;
  if (thumb && thumb.size > 0 && thumb.size <= 20 * 1024 * 1024) {
    const tBytes = await thumb.arrayBuffer();
    thumbKey = `${id}-thumb.webp`;
    await env.STORAGE.put(thumbKey, tBytes, {
      httpMetadata: { contentType: thumb.type || "image/webp" },
    });
  }
  await db.run(
    "INSERT INTO media(id,kind,filename,thumb,mime) VALUES(?,?,?,?,?)",
    id,
    "image",
    fullKey,
    thumbKey,
    file.type,
  );
  return { id, kind: "image", url: `/api/media/${id}` };
}

/**
 * 上传音频：用纯 JS(music-metadata) 读取时长/声道/内嵌封面，去掉 ffmpeg 全量解码校验。
 */
export async function uploadAudio(
  env: Env,
  db: BusinessDb,
  file: File,
): Promise<{ id: string; kind: string; url: string; duration?: number }> {
  const audio = AUDIO_TYPES[file.type];
  if (!audio) throw new HttpError(400, "音乐仅支持有效的 MP3、M4A 或 WAV 文件。");
  if (file.size > 50 * 1024 * 1024)
    throw new HttpError(400, "音频不能超过 50 MB。");
  const bytes = await file.arrayBuffer();
  let meta: IAudioMetadata;
  try {
    meta = await parseBuffer(new Uint8Array(bytes), file.type, {
      duration: true,
    });
  } catch {
    throw new HttpError(400, "音频无法解析或超过 30 分钟，请更换文件。");
  }
  const duration = meta.format.duration || 0;
  if (
    !Number.isFinite(duration) ||
    duration <= 0 ||
    duration > 1800 ||
    !meta.format.numberOfChannels ||
    meta.format.hasVideo
  )
    throw new HttpError(400, "音频无法解析或超过 30 分钟，请更换文件。");

  const id = crypto.randomUUID();
  const key = `${id}.${audio.ext}`;
  await env.STORAGE.put(key, bytes, {
    httpMetadata: { contentType: audio.mime },
  });

  // 提取内嵌封面原样存 R2（不做 webp 转码，已是最小改动）
  const picture = pickCover(meta);
  let thumbKey: string | null = null;
  let coverMime: string | null = null;
  if (picture) {
    thumbKey = `${id}-cover`;
    coverMime = isImageMime(picture.format) ? picture.format : "image/jpeg";
    await env.STORAGE.put(thumbKey, picture.data, {
      httpMetadata: { contentType: coverMime },
    });
  }
  await db.run(
    "INSERT INTO media(id,kind,filename,thumb,cover_mime,mime,duration) VALUES(?,?,?,?,?,?,?)",
    id,
    "audio",
    key,
    thumbKey,
    coverMime,
    audio.mime,
    duration,
  );
  return { id, kind: "audio", url: `/api/media/${id}`, duration };
}

// 优先取内嵌的前封面
function pickCover(meta: IAudioMetadata) {
  const pics = meta.common.picture || [];
  const ordered = [...pics].sort(
    (a, b) =>
      Number(b.type === "Cover (front)") - Number(a.type === "Cover (front)"),
  );
  for (const p of ordered) {
    if (!p.data.length || p.data.length > 10 * 1024 * 1024) continue;
    return p;
  }
  return null;
}

function isImageMime(m: string): boolean {
  return /^image\/(jpeg|png|webp)$/i.test(m);
}

/** 读取媒体文件并组装响应。thumb 请求音频时返回内嵌封面。 */
export async function serveMedia(
  env: Env,
  db: BusinessDb,
  id: string,
  wantThumb: boolean,
): Promise<{
  body: ReadableStream | null;
  contentType: string;
  cacheControl: string;
}> {
  const row = await db.get<{
    kind: string;
    filename: string;
    thumb: string | null;
    cover_mime: string | null;
    mime: string;
  }>("SELECT kind,filename,thumb,cover_mime,mime FROM media WHERE id=?", id);
  if (!row) throw new HttpError(404, "素材不存在。");
  if (wantThumb && row.kind === "audio") {
    // 音频无内嵌封面
    if (!row.thumb) throw new HttpError(404, "这首音乐没有内嵌封面。");
    const obj = await env.STORAGE.get(row.thumb);
    return {
      body: obj?.body ?? null,
      contentType: row.cover_mime || "image/jpeg",
      cacheControl: "public, max-age=31536000, immutable",
    };
  }
  const isThumb = wantThumb && !!row.thumb && row.thumb !== row.filename;
  const key = isThumb ? row.thumb! : row.filename;
  const obj = await env.STORAGE.get(key);
  return {
    body: obj?.body ?? null,
    contentType: row.mime,
    cacheControl: "public, max-age=31536000, immutable",
  };
}