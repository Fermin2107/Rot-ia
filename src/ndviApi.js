import { supabase } from "./supabaseClient";

/** @param {number} mean */
export function ndviTier(mean) {
  if (mean < 0.3) return "low";
  if (mean <= 0.5) return "mid";
  return "high";
}

/**
 * @param {number[][]} positions Leaflet ring [lat, lng][]
 * @returns {Promise<{ ok: boolean, meanNdvi?: number, intervalTo?: string, error?: string }>}
 */
export async function fetchPotreroNdvi(positions) {
  const { data, error } = await supabase.functions.invoke("ndvi", {
    body: { positions },
  });
  if (error) {
    let detail;
    try {
      const ctx = error.context;
      if (ctx && typeof ctx.json === "function") {
        const body = await ctx.json();
        if (body?.detail) detail = body.detail;
        else if (body?.error && typeof body.error === "string") detail = body.error;
      }
    } catch {
      /* ignore */
    }
    return {
      ok: false,
      error: error.message ?? "invoke_failed",
      ...(detail ? { detail } : {}),
    };
  }
  return data ?? { ok: false, error: "empty_response" };
}
