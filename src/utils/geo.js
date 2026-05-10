import area from "@turf/area";
import { polygon } from "@turf/helpers";
import { NOMINATIM_APP_ID, ARGENTINA_CENTER } from "../constants";

export function startOfLocalDayMs(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** Días de calendario locales desde `from` hasta `to` (inclusive del día final − inicio). */
export function calendarDaysBetween(from, to = new Date()) {
  const ms = startOfLocalDayMs(to) - startOfLocalDayMs(from);
  return Math.max(0, Math.round(ms / 86400000));
}

/**
 * Interpreta "lat, lng" o "lat lng" (orden latitud, longitud).
 * @returns {[number, number] | null}
 */
export function parseCoordinatePair(s) {
  const num = /-?\d+(?:\.\d+)?/g;
  const m = String(s).trim().match(num);
  if (!m || m.length < 2) return null;
  const a = parseFloat(m[0]);
  const b = parseFloat(m[1]);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  if (Math.abs(a) > 90 || Math.abs(b) > 180) return null;
  return [a, b];
}

/**
 * @returns {Promise<{ lat: number, lng: number, label: string | null } | null>}
 */
export async function geocodeFreeText(query) {
  const trimmed = query.trim();
  if (!trimmed) return null;
  const pair = parseCoordinatePair(trimmed);
  if (pair) {
    return { lat: pair[0], lng: pair[1], label: null };
  }
  const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(trimmed)}&format=json&limit=1`;
  const res = await fetch(url, {
    headers: {
      Accept: "application/json",
      "Accept-Language": "es",
      "User-Agent": NOMINATIM_APP_ID,
    },
  });
  if (!res.ok) return null;
  const json = await res.json();
  if (!Array.isArray(json) || json.length === 0) return null;
  const x = json[0];
  const lat = parseFloat(x.lat);
  const lng = parseFloat(x.lon);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  return {
    lat,
    lng,
    label: typeof x.display_name === "string" ? x.display_name : null,
  };
}

/** Centro aproximado del anillo [lat, lng] para ubicar el badge. */
export function ringCentroid(ring) {
  if (!ring?.length) return ARGENTINA_CENTER;
  let lat = 0;
  let lng = 0;
  const n = ring.length;
  for (let i = 0; i < n; i++) {
    lat += ring[i][0];
    lng += ring[i][1];
  }
  return [lat / n, lng / n];
}

/** Superficie geodésica en hectáreas (anillo Leaflet [lat, lng]). */
export function leafletRingAreaHectares(leafletRing) {
  if (!leafletRing || leafletRing.length < 3) return null;
  const coords = leafletRing.map(([lat, lng]) => [lng, lat]);
  const first = coords[0];
  const last = coords[coords.length - 1];
  if (first[0] !== last[0] || first[1] !== last[1]) {
    coords.push([first[0], first[1]]);
  }
  try {
    const m2 = area(polygon([coords]));
    if (!Number.isFinite(m2) || m2 <= 0) return null;
    return m2 / 10000;
  } catch {
    return null;
  }
}
