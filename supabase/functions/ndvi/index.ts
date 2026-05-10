/**
 * Proxy NDVI (Sentinel-2 L2A) → Copernicus CDSE Statistical API.
 *
 * Secrets (dashboard: Project Settings → Edge Functions → Secrets, o CLI):
 *   supabase secrets set CDSE_OAUTH_CLIENT_ID="..." CDSE_OAUTH_CLIENT_SECRET="..."
 *
 * Deploy: supabase functions deploy ndvi
 * Local:  supabase functions serve ndvi --env-file supabase/.env
 *          (supabase/.env con las mismas claves; no commitear)
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.8";

const corsHeaders: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

const CDSE_TOKEN_URL =
  "https://identity.dataspace.copernicus.eu/auth/realms/CDSE/protocol/openid-connect/token";
const STATS_URL = "https://sh.dataspace.copernicus.eu/statistics/v1";

const NDVI_EVALSCRIPT = `//VERSION=3
function setup() {
  return {
    input: [{
      bands: ["B04", "B08", "SCL", "dataMask"]
    }],
    output: [
      { id: "data", bands: 1 },
      { id: "dataMask", bands: 1 }
    ]
  };
}
function evaluatePixel(samples) {
  let ndvi = (samples.B08 - samples.B04) / (samples.B08 + samples.B04);
  let validNDVIMask = 1;
  if (samples.B08 + samples.B04 == 0) validNDVIMask = 0;
  let noWaterMask = 1;
  if (samples.SCL == 6) noWaterMask = 0;
  return {
    data: [ndvi],
    dataMask: [samples.dataMask * validNDVIMask * noWaterMask]
  };
}`;

type Ring = [number, number][];

/** Área aproximada del bbox en m² (estimación rápida) */
function bboxAreaM2(positions: Ring): number {
  const lats = positions.map((p) => p[0]);
  const lngs = positions.map((p) => p[1]);
  const dLat = (Math.max(...lats) - Math.min(...lats)) * 111320;
  const dLng = (Math.max(...lngs) - Math.min(...lngs)) * 111320 *
    Math.cos((((Math.max(...lats) + Math.min(...lats)) / 2) * Math.PI) / 180);
  return dLat * dLng;
}

function jsonResponse(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function ringToGeoJsonPolygon(ring: Ring): {
  type: "Polygon";
  coordinates: [number, number][][];
} {
  if (!Array.isArray(ring) || ring.length < 3) {
    throw new Error("INVALID_RING");
  }
  const coords: [number, number][] = ring.map(([lat, lng]) => [lng, lat]);
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    coords.push([first[0], first[1]]);
  }
  return {
    type: "Polygon",
    coordinates: [coords],
  };
}

async function getCdseAccessToken(
  clientId: string,
  clientSecret: string,
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "client_credentials",
    client_id: clientId,
    client_secret: clientSecret,
  });
  const res = await fetch(CDSE_TOKEN_URL, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body,
  });
  if (!res.ok) {
    const t = await res.text();
    console.error("CDSE token error", res.status, t.slice(0, 500));
    throw new Error("CDSE_TOKEN_FAILED");
  }
  const json = (await res.json()) as { access_token?: string };
  if (!json.access_token) throw new Error("CDSE_TOKEN_MISSING");
  return json.access_token;
}

type StatsInterval = {
  interval?: { from?: string; to?: string };
  outputs?: {
    data?: {
      bands?: {
        B0?: {
          stats?: {
            mean?: number;
            sampleCount?: number;
          };
        };
      };
    };
  };
};

function pickLatestNdviInterval(
  data: StatsInterval[],
  minSamples: number,
): {
  mean: number;
  intervalFrom: string;
  intervalTo: string;
} | null {
  for (let i = data.length - 1; i >= 0; i--) {
    const row = data[i];
    const mean = row.outputs?.data?.bands?.B0?.stats?.mean;
    const n = row.outputs?.data?.bands?.B0?.stats?.sampleCount ?? 0;
    if (
      typeof mean === "number" &&
      Number.isFinite(mean) &&
      n >= minSamples
    ) {
      const from = row.interval?.from ?? "";
      const to = row.interval?.to ?? "";
      return { mean, intervalFrom: from, intervalTo: to };
    }
  }
  return null;
}

function buildNdviHistory(
  data: StatsInterval[],
  maxDays: number,
  minSamples: number,
): Array<{ date: string; mean: number }> {
  const cutoff = new Date();
  cutoff.setUTCDate(cutoff.getUTCDate() - maxDays);
  const points: Array<{ date: string; mean: number }> = [];
  for (const row of data) {
    const to = row.interval?.to;
    if (!to) continue;
    if (new Date(to) < cutoff) continue;
    const mean = row.outputs?.data?.bands?.B0?.stats?.mean;
    const n = row.outputs?.data?.bands?.B0?.stats?.sampleCount ?? 0;
    if (typeof mean !== "number" || !Number.isFinite(mean) || n < minSamples) continue;
    points.push({ date: to.slice(0, 10), mean: Math.min(1, Math.max(0, mean)) });
  }
  return points.sort((a, b) => a.date.localeCompare(b.date));
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  if (req.method !== "POST") {
    return jsonResponse({ ok: false, error: "METHOD_NOT_ALLOWED" }, 405);
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return jsonResponse({ ok: false, error: "UNAUTHORIZED" }, 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL");
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY");
    if (!supabaseUrl || !supabaseAnonKey) {
      console.error("Missing SUPABASE_URL or SUPABASE_ANON_KEY");
      return jsonResponse({ ok: false, error: "SERVER_MISCONFIGURED" }, 500);
    }

    const supabase = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: userErr } = await supabase.auth.getUser();
    if (userErr || !user) {
      return jsonResponse({ ok: false, error: "UNAUTHORIZED" }, 401);
    }

    const clientId = Deno.env.get("CDSE_OAUTH_CLIENT_ID");
    const clientSecret = Deno.env.get("CDSE_OAUTH_CLIENT_SECRET");
    if (!clientId || !clientSecret) {
      console.error("Missing CDSE_OAUTH_CLIENT_ID or CDSE_OAUTH_CLIENT_SECRET");
      return jsonResponse({ ok: false, error: "NDVI_PROXY_MISCONFIGURED" }, 500);
    }

    const body = (await req.json()) as { positions?: Ring };
    const ring = body.positions;
    if (!ring) {
      return jsonResponse({ ok: false, error: "MISSING_POSITIONS" }, 400);
    }

    const geometry = ringToGeoJsonPolygon(ring);

    const areaM2 = bboxAreaM2(ring);
    // Para polígonos chicos (< 1 ha) aceptar 1 píxel.
    // Para polígonos grandes (> 8 ha) exigir hasta 8 píxeles.
    // Escala lineal entre 1 y 8 según área.
    const MIN_SAMPLE_COUNT = areaM2 < 10_000
      ? 1
      : areaM2 < 80_000
        ? Math.max(1, Math.floor(areaM2 / 10_000))
        : 8;

    const windowDays = areaM2 < 50000 ? 180 : 120;
    const dateTo = new Date();
    const dateFrom = new Date(dateTo.getTime() - windowDays * 24 * 60 * 60 * 1000);

    const statsPayload = {
      input: {
        bounds: {
          geometry,
          properties: {
            crs: "http://www.opengis.net/def/crs/EPSG/0/4326",
          },
        },
        data: [
          {
            type: "sentinel-2-l2a",
            dataFilter: {
              mosaickingOrder: "leastCC",
            },
          },
        ],
      },
      aggregation: {
        timeRange: {
          from: dateFrom.toISOString(),
          to: dateTo.toISOString(),
        },
        aggregationInterval: { of: "P10D" },
        evalscript: NDVI_EVALSCRIPT,
        resx: 0.001,
        resy: 0.001,
      },
    };

    const accessToken = await getCdseAccessToken(clientId, clientSecret);

    const shRes = await fetch(STATS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
      body: JSON.stringify(statsPayload),
    });

    if (!shRes.ok) {
      const t = await shRes.text();
      console.error("Sentinel statistics error", shRes.status, t.slice(0, 800));
      return jsonResponse({
        ok: false,
        error: "UPSTREAM_ERROR",
        status: shRes.status,
        detail: t.slice(0, 600),
      }, 502);
    }

    const shJson = (await shRes.json()) as {
      status?: string;
      data?: StatsInterval[];
    };

    if (shJson.status !== "OK" || !Array.isArray(shJson.data)) {
      const snippet = JSON.stringify(shJson).slice(0, 600);
      console.error("Unexpected statistics body", snippet);
      return jsonResponse({
        ok: false,
        error: "INVALID_UPSTREAM_RESPONSE",
        detail: snippet,
      }, 502);
    }

    const picked = pickLatestNdviInterval(shJson.data, MIN_SAMPLE_COUNT);
    if (!picked) {
      return jsonResponse({
        ok: false,
        error: "NO_CLEAR_DATA",
      }, 200);
    }

    return jsonResponse({
      ok: true,
      meanNdvi: picked.mean,
      intervalFrom: picked.intervalFrom,
      intervalTo: picked.intervalTo,
      history: buildNdviHistory(shJson.data, 90, MIN_SAMPLE_COUNT),
    });
  } catch (e) {
    const msg = e instanceof Error ? e.message : "UNKNOWN";
    if (msg === "INVALID_RING") {
      return jsonResponse({ ok: false, error: "INVALID_RING" }, 400);
    }
    console.error("ndvi function error", e);
    return jsonResponse({ ok: false, error: "INTERNAL" }, 500);
  }
});
