import type { Weather } from "../shared/model.js";

export function createWeatherService(fetcher: typeof fetch = fetch) {
  let cached: Weather | null = null,
    nextFetch = 0;
  let pending: Promise<Weather> | null = null;
  return async function weather(): Promise<Weather> {
    if (Date.now() < nextFetch && cached) return cached;
    if (pending) return pending;
    pending = (async () => {
      try {
        const res = await fetcher(
          // 佛山（China, Foshan）坐标，时区 Asia/Shanghai
          "https://api.open-meteo.com/v1/forecast?latitude=23.0218&longitude=113.1215&current=temperature_2m,weather_code&timezone=Asia%2FShanghai",
          { signal: AbortSignal.timeout(5000) },
        );
        if (!res.ok) throw new Error("weather unavailable");
        const data = (await res.json()) as {
          current?: { temperature_2m?: number; weather_code?: number };
        };
        if (
          !Number.isFinite(data.current?.temperature_2m) ||
          !Number.isFinite(data.current?.weather_code)
        )
          throw new Error("invalid weather");
        cached = {
          available: true,
          temperature: data.current!.temperature_2m,
          code: data.current!.weather_code,
          updatedAt: new Date().toISOString(),
          stale: false,
        };
        nextFetch = Date.now() + 15 * 60_000;
      } catch {
        cached = cached?.available
          ? { ...cached, stale: true }
          : { available: false };
        nextFetch = Date.now() + 60_000;
      }
      return cached!;
    })().finally(() => {
      pending = null;
    });
    return pending;
  };
}