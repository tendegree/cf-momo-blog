// 浏览器端把图片预压缩为 WebP（全尺寸 + 缩略图），再交给服务端存入 R2。
// Cloudflare Worker 无法运行 sharp，因此重编码挪到浏览器完成。

const FULL_MAX = 2400;
const THUMB_MAX = 600;
const FULL_QUALITY = 0.88;
const THUMB_QUALITY = 0.8;

function canvasToWebP(
  canvas: HTMLCanvasElement,
  quality: number,
): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(
      (b) => (b ? resolve(b) : reject(new Error("图片编码失败，请更换文件。"))),
      "image/webp",
      quality,
    );
  });
}

function drawScaled(
  bitmap: ImageBitmap,
  max: number,
): { canvas: HTMLCanvasElement; width: number; height: number } {
  const scale = Math.min(1, max / Math.max(bitmap.width, bitmap.height));
  const width = Math.max(1, Math.round(bitmap.width * scale));
  const height = Math.max(1, Math.round(bitmap.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("浏览器不支持图片处理，请更换浏览器。");
  ctx.drawImage(bitmap, 0, 0, width, height);
  return { canvas, width, height };
}

/**
 * 把一个图片文件转成 { full, thumb } 两个 WebP。
 * 无法解码（如损坏文件）或超限时抛出含中文提示的错误。
 */
export async function prepareImage(file: File): Promise<{
  full: File;
  thumb: File;
  width: number;
  height: number;
}> {
  if (
    !["image/jpeg", "image/png", "image/webp"].includes(file.type) &&
    !/\.(jpe?g|png|webp)$/i.test(file.name)
  )
    throw new Error("照片仅支持 JPEG、PNG 或 WebP，请选择有效图片。");
  if (file.size > 20 * 1024 * 1024)
    throw new Error("图片不能超过 20 MB。");

  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    throw new Error("图片无法解码或尺寸过大，请更换文件。");
  }
  try {
    const { canvas, width, height } = drawScaled(bitmap, FULL_MAX);
    const full = await canvasToWebP(canvas, FULL_QUALITY);
    const { canvas: thumbCanvas } = drawScaled(bitmap, THUMB_MAX);
    const thumb = await canvasToWebP(thumbCanvas, THUMB_QUALITY);
    const base = /\.webp/i.test(file.name) ? file.name : file.name.replace(/\.[^.]+$/, "");
    return {
      full: new File([full], `${base || "image"}.webp`, { type: "image/webp" }),
      thumb: new File([thumb], `${base || "image"}-thumb.webp`, { type: "image/webp" }),
      width,
      height,
    };
  } finally {
    bitmap.close();
  }
}