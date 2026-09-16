// 一次性把演示素材（assets/demo, assets/profile）写入 R2，并把首页示例内容写入 D1。
// 依赖 wrangler 命令行（使用 .dev.vars / 已登录账号的远程资源）。
// 用法：npm run seed
import { execFileSync } from "node:child_process";
import { readFileSync, existsSync, writeFileSync, unlinkSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join, basename } from "node:path";
import { fileURLToPath } from "node:url";
import { parseFile } from "music-metadata";

const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, "..");
const assetDir = join(root, "assets", "demo");

// 读取 wrangler.toml 拿资源名
const cfg = readFileSync(join(root, "wrangler.toml"), "utf8");
const grab = (re) => {
  const m = cfg.match(re);
  return m ? m[1] : null;
};
const dbName = grab(/database_name\s*=\s*"([^"]+)"/);
const bucket = grab(/bucket_name\s*=\s*"([^"]+)"/);
if (!dbName || !bucket) {
  console.error("无法从 wrangler.toml 读取 database_name / bucket_name。");
  process.exit(1);
}

const run = (args) =>
  execFileSync("npx", ["wrangler", ...args], { stdio: "inherit", cwd: root });

const put = (key, file) =>
  run(["r2", "object", "put", `${bucket}/${key}`, "--file", file]);

const mimeOf = (file) => {
  const ext = file.split(".").pop().toLowerCase();
  return ext === "jpg" || ext === "jpeg"
    ? "image/jpeg"
    : ext === "png"
      ? "image/png"
      : ext === "webp"
        ? "image/webp"
        : ext === "wav"
          ? "audio/wav"
          : "application/octet-stream";
};

const ids = {
  coffee: randomUUID(),
  forest: randomUUID(),
  coast: randomUUID(),
  sunlight: randomUUID(),
  sydney: randomUUID(),
  poster: randomUUID(),
  architecture: randomUUID(),
  audio: randomUUID(),
};

// 上传媒体对象到 R2
const uploads = [
  ["coffee.jpg", ids.coffee],
  ["forest.jpg", ids.forest],
  ["coast.jpg", ids.coast],
  ["sunlight.jpg", ids.sunlight],
  ["sydney.png", ids.sydney],
  ["poster.png", ids.poster],
  ["architecture.png", ids.architecture],
  ["slow-morning.wav", ids.audio],
];
for (const [file, id] of uploads) {
  put(id, join(assetDir, file));
}

// 读取音频时长（用于 media 表 duration）
const audioMeta = await parseFile(join(assetDir, "slow-morning.wav"));
const audioDuration = Math.round(audioMeta.format.duration || 0);

// 组 SQL
const media = uploads
  .map(([file, id]) => {
    const isAudio = file.endsWith(".wav");
    const mime = mimeOf(file);
    return isAudio
      ? {
          id,
          kind: "audio",
          filename: id,
          mime,
          thumb: "null",
          cover_mime: "null",
          duration: audioDuration || "NULL",
        }
      : {
          id,
          kind: "image",
          filename: id,
          mime,
          thumb: "null",
          cover_mime: "null",
          duration: "NULL",
        };
  })
  .map(
    (m) =>
      `INSERT OR IGNORE INTO media(id,kind,filename,thumb,cover_mime,mime,duration) ` +
      `VALUES('${m.id}','${m.kind}','${m.filename}',${m.thumb},${m.cover_mime},'${m.mime}',${m.duration});`,
  )
  .join("\n");

// 与 server 端相同的示例首页内容
const content = {
  profile: {
    name: "Momo",
    avatarId: null,
    headline: "把好奇心，\n变成作品。",
    introduction: "我是 Momo，喜欢设计、代码和日常里的小发现。",
    description: "这里是我的作品、文字与日常收藏。",
    eyebrow: "DESIGN · CODE · EVERYDAY",
    motto: "Made with curiosity.",
    photoId: "sydney",
    photoCaption: "走走，停停。",
    demo: true,
  },
  social: { github: "", email: "", xiaohongshu: "" },
  projects: [
    {
      id: "sample-project",
      title: "Idea Garden",
      summary: "给每一个想法，一个生长的地方。",
      description:
        "这是一个用于展示的虚构笔记应用：把随手记下的想法、喜欢的图片和生活碎片，整理成自己的数字花园。\n\n登录后可以替换项目名称、封面、介绍和链接。",
      coverId: null,
      url: "",
    },
  ],
  articles: [
    {
      id: "start",
      title: "从一个小想法开始",
      summary: "关于创造，也关于生活。",
      date: "2026-09-12",
      coverId: ids.coffee,
      url: "",
      body: "我喜欢那些还很小的想法。它们可能是散步时冒出来的一句话，也可能是觉得「这里还可以更好一点」的瞬间。\n\n先记录下来，再做一个能用的小版本。把下一步缩小到今天就能开始的程度，想法才会慢慢长成生活的一部分。\n\n这是一段用于展示阅读效果的示例文字，可登录后直接替换。",
    },
    {
      id: "garden",
      title: "我的数字花园，慢慢长大",
      summary: "给想法一个可以停留的地方。",
      date: "2026-09-08",
      coverId: ids.forest,
      url: "",
      body: "把喜欢的图片、读到的句子，以及还没想明白的事放在一起，是整理日常的一种方式。\n\n花园不必每一天都盛开。记下一点，整理一点，留下以后再回来的入口。\n\n此为可替换的示例文字。",
    },
    {
      id: "sydney",
      title: "在悉尼，收集日常的光",
      summary: "生活碎片，慢慢收藏。",
      date: "2026-09-02",
      coverId: ids.coast,
      url: "",
      body: "有时候，一天最值得记住的部分，只是树叶间的一点光，或走过海边时刚好吹来的风。\n\n想把这些微小又明亮的片刻收藏起来。等忙碌的时候，回来看看。\n\n此为可替换的示例文字。",
    },
  ],
  photos: [
    {
      id: "sydney",
      mediaId: ids.sydney,
      title: "走走，停停。",
      caption: "在光影之间，留住片刻。",
      location: "Sydney",
      source: "AI 生成的悉尼示意图，非站主实拍",
      demo: true,
    },
    { id: "photo-0", mediaId: ids.coffee, title: "午后一杯", caption: "喜欢的小片刻。", location: "", source: "演示素材，非站主作品", demo: true },
    { id: "photo-1", mediaId: ids.forest, title: "走进绿色里", caption: "喜欢的小片刻。", location: "", source: "演示素材，非站主作品", demo: true },
    { id: "photo-2", mediaId: ids.coast, title: "海风来信", caption: "喜欢的小片刻。", location: "", source: "演示素材，非站主作品", demo: true },
    { id: "photo-3", mediaId: ids.sunlight, title: "日光漫游", caption: "喜欢的小片刻。", location: "", source: "演示素材，非站主作品", demo: true },
  ],
  collections: [
    { id: "design", title: "让想法长成设计", description: "一些值得留下的灵感。", kind: "灵感", imageId: ids.poster, url: "", source: "本站原创排版示例", demo: true },
    { id: "architecture", title: "在留白里，发现更多", description: "观察空间、比例与留白。", kind: "图片", imageId: ids.architecture, url: "", source: "演示素材，非站主作品", demo: true },
    { id: "mdn", title: "MDN Web Docs", description: "把好奇心，变成可以实现的东西。", kind: "网站", imageId: null, url: "https://developer.mozilla.org/zh-CN/", source: "MDN", demo: true },
  ],
  tracks: [
    {
      id: "slow-morning",
      title: "Slow Morning",
      artist: "本站原创 · 演示旋律",
      audioId: ids.audio,
      coverId: ids.coast,
      demo: true,
      source: "assets/demo/generate-audio.py，原创合成器旋律",
    },
  ],
};

const sql = `INSERT OR IGNORE INTO settings(key,value) VALUES('startedAt','${new Date().toISOString()}');\n` +
  media +
  `\nINSERT OR IGNORE INTO site_content(id,revision,data) VALUES(1,1,'${JSON.stringify(content).replace(/'/g, "''")}');\n`;

const tmp = join(root, ".seed-tmp.sql");
writeFileSync(tmp, sql);
try {
  run(["d1", "execute", dbName, "--remote", "--file", tmp]);
  console.log("\n✅ 演示数据已写入 D1，素材已上传 R2。");
  console.log("提示：若需重新初始化，可先清空 site_content / media 表再跑本脚本。");
} finally {
  unlinkSync(tmp);
}