import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import L from "leaflet";
import {
  MapContainer,
  TileLayer,
  useMap,
  useMapEvents,
  CircleMarker,
  Polyline,
  Polygon,
  Marker,
  Popup,
} from "react-leaflet";
import area from "@turf/area";
import { polygon } from "@turf/helpers";
import { supabase } from "./supabaseClient";
import { fetchPotreroNdvi, ndviTier } from "./ndviApi";

/*
  Supabase — esquema esperado por la app:

  - Tabla campos: id, user_id (FK auth.users), name, lat, lng, zoom (default 14), created_at,
    descanso_bases_dias jsonb null — días base del motor de descanso por tipo (ver mergeDescansoBasesDias).
    RLS: todas las filas visibles/mutables sólo si auth.uid() = user_id.

    Migración opcional:
      alter table campos add column if not exists descanso_bases_dias jsonb default null;

  - Tabla potreros: debe incluir user_id, campo_id (FK campos ON DELETE CASCADE), name, positions,
    tipo_pasto text null (festuca | raigras | campo_natural | verdeo | otro), created_at.
    RLS acorde (dueño del potrero / del campo).

    Migración tipo de pasto:
      alter table potreros add column if not exists tipo_pasto text;

  - Tabla eventos: potrero_id FK potreros ON DELETE CASCADE; user_id si la app lo envía.
    La app también borra eventos con DELETE explícito antes del potrero (por si el FK no es CASCADE).

  - Tabla aguadas: id, campo_id (FK campos ON DELETE CASCADE), user_id, lat, lng, label text null, created_at.
    RLS: sólo el dueño (auth.uid() = user_id) y mismo criterio que campos/potreros.

  - potreros.aguada_id uuid null references aguadas(id) on delete set null — aguada asignada al potrero.

    alter table potreros add column if not exists aguada_id uuid references aguadas (id) on delete set null;
    create table if not exists aguadas (
      id uuid primary key default gen_random_uuid(),
      campo_id uuid not null references campos (id) on delete cascade,
      user_id uuid not null references auth.users (id) on delete cascade,
      lat double precision not null,
      lng double precision not null,
      label text,
      created_at timestamptz default now()
    );
    create index if not exists aguadas_campo_id_idx on aguadas (campo_id);

  Migración típica si ya tenés potreros sin campo:
    alter table potreros add column campo_id uuid references campos (id) on delete cascade;
    -- Crear campos de backfill y actualizar potreros existentes;
    -- Luego: alter table potreros alter column campo_id set not null;
*/

function LoginScreen() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState(null);

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true);
    setMessage(null);
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    if (error) setMessage({ text: error.message, isError: true });
    setLoading(false);
  };

  const handleRegister = async () => {
    if (!email || !password) {
      setMessage({ text: "Ingresá email y contraseña.", isError: true });
      return;
    }
    setLoading(true);
    setMessage(null);
    const { error } = await supabase.auth.signUp({ email, password });
    if (error) setMessage({ text: error.message, isError: true });
    else setMessage({ text: "Revisá tu email para confirmar la cuenta.", isError: false });
    setLoading(false);
  };

  return (
    <main style={styles.page}>
      <section style={styles.card}>
        <div style={styles.brand}>
          <div style={styles.logo} aria-hidden="true">
            <span style={styles.logoLeaf}>🌿</span>
          </div>
          <h1 style={styles.title}>Rotia</h1>
        </div>

        <form style={styles.form} onSubmit={handleLogin}>
          <label htmlFor="email" style={styles.label}>Email</label>
          <input
            id="email"
            type="email"
            placeholder="tu@email.com"
            style={styles.input}
            value={email}
            onChange={(e) => setEmail(e.target.value)}
            autoComplete="email"
            required
          />
          <label htmlFor="password" style={styles.label}>Contraseña</label>
          <input
            id="password"
            type="password"
            placeholder="••••••••"
            style={styles.input}
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            autoComplete="current-password"
            required
          />

          {message && (
            <p style={{ ...styles.loginMessage, color: message.isError ? "#b94040" : "#2f6a3a" }}>
              {message.text}
            </p>
          )}

          <button type="submit" style={styles.button} disabled={loading}>
            {loading ? "Ingresando…" : "Ingresar"}
          </button>
          <button
            type="button"
            style={styles.buttonSecondary}
            onClick={handleRegister}
            disabled={loading}
          >
            Registrarse
          </button>
        </form>
      </section>
    </main>
  );
}

const ARGENTINA_CENTER = [-38.4161, -63.6167];
const CLICK_DEBOUNCE_MS = 280;
const CAMPO_STORAGE_KEY = "rotia_campo_id";
/** sessionStorage: no volver a mostrar el aviso de potreros listos en esta sesión. */
const LISTOS_BANNER_SESSION_KEY = "rotia_listos_descanso_banner_dismissed";

/** Clave en `campos.descanso_bases_dias` para potreros sin tipo_pasto / otro. */
const DESCANSO_BASE_KEY_SIN_ESPECIFICAR = "sin_especificar";

const aguadaMarkerIcon = L.divIcon({
  className: "rotia-aguada-m",
  html: '<div style="font-size:22px;line-height:1;text-align:center">💧</div>',
  iconSize: [28, 32],
  iconAnchor: [14, 32],
  popupAnchor: [0, -28],
});
/** Identificación para políticas de uso de Nominatim (el navegador puede sobrescribir User-Agent). */
const NOMINATIM_APP_ID = "RotiaCampoApp/1.0";

/**
 * Interpreta "lat, lng" o "lat lng" (orden latitud, longitud).
 * @returns {[number, number] | null}
 */
function parseCoordinatePair(s) {
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
async function geocodeFreeText(query) {
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

function MapViewSync({ center, zoom }) {
  const map = useMap();
  useEffect(() => {
    if (!center || zoom == null) return;
    map.flyTo(center, zoom, { duration: 0.65 });
  }, [map, center, zoom]);
  return null;
}

/** Margen extra sobre el borde del visual viewport (Safari barra inferior / teclado). */
const VISUAL_VIEWPORT_BOTTOM_BUFFER_PX = 12;

/**
 * Píxeles entre el borde inferior del layout viewport y el del visual viewport
 * (teclado + chrome inferior en Safari móvil). Sumar al `bottom` de UI `position: fixed`.
 */
function useVisualViewportBottomInset() {
  const [insetPx, setInsetPx] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;

    const compute = () => {
      const layoutH = window.innerHeight;
      // Borde inferior del visual viewport respecto al layout (Safari barra / teclado).
      const visibleBottom = vv.offsetTop + vv.height;
      const overlap = Math.max(0, layoutH - visibleBottom);
      setInsetPx(Math.round(overlap + VISUAL_VIEWPORT_BOTTOM_BUFFER_PX));
    };

    compute();
    vv.addEventListener("resize", compute);
    vv.addEventListener("scroll", compute);
    window.addEventListener("resize", compute);

    return () => {
      vv.removeEventListener("resize", compute);
      vv.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
    };
  }, []);

  return insetPx;
}

function useMediaQuery(query) {
  const [matches, setMatches] = useState(
    () => typeof window !== "undefined" && window.matchMedia(query).matches,
  );

  useEffect(() => {
    const mq = window.matchMedia(query);
    const onChange = () => setMatches(mq.matches);
    onChange();
    mq.addEventListener("change", onChange);
    return () => mq.removeEventListener("change", onChange);
  }, [query]);

  return matches;
}

const potreroStyle = {
  color: "#2f6a3a",
  weight: 2,
  fillColor: "#3d7f49",
  fillOpacity: 0.38,
};

function formatNdviWindowDate(iso) {
  if (!iso) return null;
  try {
    return new Date(iso).toLocaleDateString("es-AR", {
      day: "numeric",
      month: "short",
      year: "numeric",
    });
  } catch {
    return null;
  }
}

function polygonStyleForNdvi(ndEntry, interactive) {
  if (!ndEntry || ndEntry.status !== "ok") {
    return { ...potreroStyle, interactive };
  }
  if (ndEntry.tier === "low") {
    return {
      color: "#8b2f2f",
      weight: 2,
      fillColor: "#d47272",
      fillOpacity: 0.4,
      interactive,
    };
  }
  if (ndEntry.tier === "mid") {
    return {
      color: "#8a6a10",
      weight: 2,
      fillColor: "#e6c94a",
      fillOpacity: 0.4,
      interactive,
    };
  }
  return {
    color: "#1f5c2e",
    weight: 2,
    fillColor: "#46a858",
    fillOpacity: 0.42,
    interactive,
  };
}

const draftPolylineStyle = { color: "#2f6a3a", weight: 2, interactive: false };
const draftDashStyle = { ...draftPolylineStyle, dashArray: "6 6" };

function DrawingClicks({ active, onAddVertex, onAttemptClosePolygon, onHover }) {
  const timerRef = useRef(null);
  const activeRef = useRef(active);

  useEffect(() => { activeRef.current = active; }, [active]);

  useMapEvents({
    mousemove(e) {
      if (!active) return;
      onHover([e.latlng.lat, e.latlng.lng]);
    },
    click(e) {
      if (!active) return;
      if (timerRef.current !== null) window.clearTimeout(timerRef.current);
      const { lat, lng } = e.latlng;
      timerRef.current = window.setTimeout(() => {
        timerRef.current = null;
        if (!activeRef.current) return;
        onAddVertex([lat, lng]);
      }, CLICK_DEBOUNCE_MS);
    },
    dblclick(e) {
      if (!active) return;
      const ev = e.originalEvent;
      if (ev) { ev.preventDefault(); L.DomEvent.stopPropagation(ev); }
      if (timerRef.current !== null) { window.clearTimeout(timerRef.current); timerRef.current = null; }
      onAttemptClosePolygon();
    },
  });

  useEffect(() => {
    return () => { if (timerRef.current !== null) window.clearTimeout(timerRef.current); };
  }, []);

  return null;
}

function DrawingMapUi({ crosshair }) {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    if (crosshair) { map.doubleClickZoom.disable(); el.style.cursor = "crosshair"; }
    else { map.doubleClickZoom.enable(); el.style.cursor = ""; }
    return () => { try { map.doubleClickZoom.enable(); } catch { /* */ } };
  }, [crosshair, map]);
  return null;
}

function AguadaPlacementClicks({ active, onPlace }) {
  useMapEvents({
    click(e) {
      if (!active) return;
      onPlace(e.latlng.lat, e.latlng.lng);
    },
  });
  return null;
}

function MapResizeNotifier({ drawingMode, selectedPotrero, aguadaPlacementMode }) {
  const map = useMap();
  useEffect(() => {
    const bump = () => map.invalidateSize({ animate: false });
    bump();
    const rafId = window.requestAnimationFrame(bump);
    const t2 = window.setTimeout(bump, 120);
    const t3 = window.setTimeout(bump, 420);
    const el = map.getContainer();
    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => bump()) : null;
    const target = el?.parentElement ?? el;
    if (ro && target) ro.observe(target);
    window.addEventListener("resize", bump);
    window.addEventListener("orientationchange", bump);
    return () => {
      window.cancelAnimationFrame(rafId);
      window.clearTimeout(t2);
      window.clearTimeout(t3);
      window.removeEventListener("resize", bump);
      window.removeEventListener("orientationchange", bump);
      if (ro) ro.disconnect();
    };
  }, [map]);
  useEffect(() => {
    const id = window.setTimeout(() => map.invalidateSize({ animate: false }), 0);
    return () => window.clearTimeout(id);
  }, [map, drawingMode, selectedPotrero, aguadaPlacementMode]);
  return null;
}

const EVENTO_TIPOS = [
  { id: "lluvia", label: "Lluvia", icon: "🌧️" },
  { id: "fertilizacion", label: "Fertilización", icon: "🌱" },
  { id: "movimiento", label: "Movimiento", icon: "🐄" },
  { id: "foto", label: "Foto", icon: "📷" },
];

function eventoTipoHistorialIcon(tipo) {
  return EVENTO_TIPOS.find((t) => t.id === tipo)?.icon ?? "📌";
}

function formatEventoHistorialFecha(iso) {
  if (!iso) return "—";
  try {
    return new Date(iso).toLocaleString("es-AR", {
      day: "numeric",
      month: "short",
      year: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "—";
  }
}

/** Valores persistidos en potreros.tipo_pasto (text, opcional). */
const TIPO_PASTO_IDS = {
  FESTUCA: "festuca",
  RAIGRAS: "raigras",
  CAMPO_NATURAL: "campo_natural",
  VERDEO: "verdeo",
  OTRO: "otro",
};

const TIPOS_PASTO_OPTIONS = [
  { id: TIPO_PASTO_IDS.FESTUCA, label: "Festuca" },
  { id: TIPO_PASTO_IDS.RAIGRAS, label: "Raigrás" },
  { id: TIPO_PASTO_IDS.CAMPO_NATURAL, label: "Campo natural" },
  { id: TIPO_PASTO_IDS.VERDEO, label: "Verdeo" },
  { id: TIPO_PASTO_IDS.OTRO, label: "Otro" },
];

/** Defaults del motor de descanso (días); editables por campo en ⚙️. */
const DEFAULT_DESCANSO_BASES_DIAS = {
  [TIPO_PASTO_IDS.FESTUCA]: 75,
  [TIPO_PASTO_IDS.RAIGRAS]: 52,
  [TIPO_PASTO_IDS.CAMPO_NATURAL]: 105,
  [TIPO_PASTO_IDS.VERDEO]: 37,
  [DESCANSO_BASE_KEY_SIN_ESPECIFICAR]: 60,
};

/**
 * Fusiona overrides de `campos.descanso_bases_dias` con defaults.
 * @param {unknown} dbJson
 * @returns {Record<string, number>}
 */
function mergeDescansoBasesDias(dbJson) {
  const out = { ...DEFAULT_DESCANSO_BASES_DIAS };
  if (dbJson && typeof dbJson === "object" && !Array.isArray(dbJson)) {
    const o = /** @type {Record<string, unknown>} */ (dbJson);
    for (const k of Object.keys(DEFAULT_DESCANSO_BASES_DIAS)) {
      const v = Number(o[k]);
      if (Number.isFinite(v) && v >= 1 && v <= 500) out[k] = v;
    }
  }
  return out;
}

function baseDiasDescansoForTipo(tipoPasto, bases) {
  if (tipoPasto && bases[tipoPasto] != null) return bases[tipoPasto];
  return bases[DESCANSO_BASE_KEY_SIN_ESPECIFICAR];
}

/** Hemisferio sur: primavera sep–nov, verano seco dic–feb, otoño mar–may, invierno jun–ago. */
function seasonMultiplierDescanso(date) {
  const m = date.getMonth();
  if (m === 8 || m === 9 || m === 10) return 0.7;
  if (m === 11 || m === 0 || m === 1) return 1.3;
  if (m >= 2 && m <= 4) return 0.9;
  return 1.1;
}

/**
 * @typedef {{ kind: "sin_datos" }} MotorDescansoSinDatos
 * @typedef {{ kind: "en_uso" }} MotorDescansoEnUso
 * @typedef {{
 *   kind: "descanso",
 *   listo: boolean,
 *   diasTranscurridos: number,
 *   diasNecesarios: number,
 *   diasRestantes: number,
 *   primaryLine: string,
 * }} MotorDescansoOk
 * @typedef {MotorDescansoSinDatos | MotorDescansoEnUso | MotorDescansoOk} MotorDescanso
 */

/**
 * Bloque E — motor de descanso (días necesarios vs transcurridos).
 * @param {{
 *   tipoPasto: string | null,
 *   ultimoMovimiento: { fecha: string, direccion?: string } | null | undefined,
 *   lluviaMm30d: number,
 *   pastoreoCabezasUltima: number | null | undefined,
 *   basesDias: Record<string, number>,
 *   today?: Date,
 * }} p
 * @returns {MotorDescanso}
 */
function computeDescansoInteligente(p) {
  const st = descansoFromUltimoMovimiento(p.ultimoMovimiento);
  if (st.kind === "sin_datos") {
    return { kind: "sin_datos" };
  }
  if (st.kind === "en_uso") {
    return { kind: "en_uso" };
  }
  const elapsed = st.days;
  const salidaDate = new Date(p.ultimoMovimiento.fecha);
  const base = baseDiasDescansoForTipo(p.tipoPasto, p.basesDias);
  let afterEpoca = base * seasonMultiplierDescanso(salidaDate);
  const rainStep = Math.floor(Math.max(0, p.lluviaMm30d) / 10);
  const maxRainOff = afterEpoca * 0.2;
  const rainOff = Math.min(rainStep, maxRainOff);
  let needed = afterEpoca - rainOff;
  const heads = p.pastoreoCabezasUltima;
  if (heads != null && Number.isFinite(heads) && heads > 100) {
    needed *= 1.15;
  }
  needed = Math.max(1, Math.ceil(needed));
  const remaining = Math.max(0, needed - elapsed);
  const today = p.today ?? new Date();
  if (remaining <= 0) {
    return {
      kind: "descanso",
      listo: true,
      diasTranscurridos: elapsed,
      diasNecesarios: needed,
      diasRestantes: 0,
      primaryLine: "Listo para entrar",
    };
  }
  const fechaListo = new Date(today);
  fechaListo.setHours(12, 0, 0, 0);
  fechaListo.setDate(fechaListo.getDate() + remaining);
  const ddmm = fechaListo.toLocaleDateString("es-AR", {
    day: "2-digit",
    month: "2-digit",
  });
  const primaryLine = `Listo en ${remaining} ${remaining === 1 ? "día" : "días"} · ${ddmm}`;
  return {
    kind: "descanso",
    listo: false,
    diasTranscurridos: elapsed,
    diasNecesarios: needed,
    diasRestantes: remaining,
    primaryLine,
  };
}

/**
 * Última entrada con fecha estrictamente anterior a la última salida (misma salida que cierra el pastoreo).
 * @param {Array<{ fecha: string, datos?: { direccion?: string, cantidad?: unknown } }>} movRowsDesc
 */
function pastoreoCabezasUltimaAntesDeSalida(movRowsDesc) {
  if (!movRowsDesc?.length) return null;
  const first = movRowsDesc[0];
  if (first.datos?.direccion !== "salida") return null;
  const tSalida = new Date(first.fecha).getTime();
  for (let i = 1; i < movRowsDesc.length; i++) {
    const r = movRowsDesc[i];
    if (new Date(r.fecha).getTime() >= tSalida) continue;
    if (r.datos?.direccion === "entrada") {
      const c = Number(r.datos?.cantidad);
      return Number.isFinite(c) ? c : null;
    }
  }
  return null;
}

function labelTipoPasto(tipoPasto) {
  if (!tipoPasto) return null;
  const o = TIPOS_PASTO_OPTIONS.find((x) => x.id === tipoPasto);
  return o ? o.label : tipoPasto;
}

function isKnownTipoPastoId(id) {
  return Boolean(id && TIPOS_PASTO_OPTIONS.some((o) => o.id === id));
}

/** Por encima de este umbral los días estimados del motor de rotación se muestran como "—" (UI). */
const ROTACION_UI_DIAS_ESTIMADOS_MAX = 365;

/** kg materia seca/hectárea ≈ NDVI × este factor (aproximación inicial). */
const KG_MS_PER_HA_NDVI_FACTOR = 3000;
const CONSUMO_MS_CABEZA_DIA_MIN = 10;
const CONSUMO_MS_CABEZA_DIA_MAX = 12;
const CONSUMO_MS_CABEZA_DIA_DEFAULT = 11;

function startOfLocalDayMs(d) {
  const x = new Date(d);
  x.setHours(0, 0, 0, 0);
  return x.getTime();
}

/** Días de calendario locales desde `from` hasta `to` (inclusive del día final − inicio). */
function calendarDaysBetween(from, to = new Date()) {
  const ms = startOfLocalDayMs(to) - startOfLocalDayMs(from);
  return Math.max(0, Math.round(ms / 86400000));
}

/** @param {{ fecha: string, direccion?: string } | null | undefined} ultimo */
function descansoFromUltimoMovimiento(ultimo) {
  if (!ultimo?.fecha) return { kind: "sin_datos" };
  const dir = ultimo.direccion;
  if (dir !== "entrada" && dir !== "salida") return { kind: "sin_datos" };
  if (dir === "entrada") return { kind: "en_uso" };
  const days = calendarDaysBetween(new Date(ultimo.fecha), new Date());
  return { kind: "descanso", days };
}

/** Centro aproximado del anillo [lat, lng] para ubicar el badge. */
function ringCentroid(ring) {
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
function leafletRingAreaHectares(leafletRing) {
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

function rotationRankTier(row) {
  if (row.enUso) return 4;
  if (row.ndviCargando) return 2;
  if (row.ndvi == null) return 3;
  return 1;
}

/**
 * @param {number} heads
 * @param {number} kgMsPorCabezaDia
 */
function buildRotationRanking(potreros, ndviById, heads, kgMsPorCabezaDia) {
  const rows = [];
  for (const pot of potreros) {
    const desc = descansoFromUltimoMovimiento(pot.ultimoMovimiento);
    const ndviE = ndviById[pot.id];
    const ndvi = ndviE?.status === "ok" ? ndviE.meanNdvi : null;
    const ndviCargando = ndviE?.status === "loading";
    const areaHa = leafletRingAreaHectares(pot.positions);
    const msPorHa = ndvi != null ? ndvi * KG_MS_PER_HA_NDVI_FACTOR : null;
    const enUso = desc.kind === "en_uso";
    let diasEstimados = null;
    if (
      !enUso &&
      areaHa != null &&
      ndvi != null &&
      heads >= 1 &&
      kgMsPorCabezaDia > 0
    ) {
      const msPotrero = areaHa * ndvi * KG_MS_PER_HA_NDVI_FACTOR;
      const necesidadDiaria = heads * kgMsPorCabezaDia;
      diasEstimados = msPotrero / necesidadDiaria;
    }
    rows.push({
      potreroId: pot.id,
      nombre: pot.name,
      areaHa,
      ndvi,
      msPorHa,
      diasEstimados,
      descansoDias: desc.kind === "descanso" ? desc.days : null,
      enUso,
      ndviCargando,
      sinAguada: !pot.aguadaId,
    });
  }
  rows.sort((a, b) => {
    const ta = rotationRankTier(a);
    const tb = rotationRankTier(b);
    if (ta !== tb) return ta - tb;
    const da = a.descansoDias ?? -1;
    const db = b.descansoDias ?? -1;
    if (da !== db) return db - da;
    const na = a.ndvi ?? -1;
    const nb = b.ndvi ?? -1;
    return nb - na;
  });
  return rows;
}

function formatDiasEstimados(d) {
  if (d == null || !Number.isFinite(d) || d < 0) return "—";
  if (d > ROTACION_UI_DIAS_ESTIMADOS_MAX) return "—";
  if (d >= 100) return `${Math.round(d)} días`;
  if (d >= 10) return `${d.toFixed(1)} días`;
  return `${d.toFixed(2)} días`;
}

function PlanificarRotacionModal({ open, onClose, potreros, ndviById }) {
  const [cabezasStr, setCabezasStr] = useState("");
  const [kgDia, setKgDia] = useState(CONSUMO_MS_CABEZA_DIA_DEFAULT);

  useEffect(() => {
    if (open) {
      setCabezasStr("");
      setKgDia(CONSUMO_MS_CABEZA_DIA_DEFAULT);
    }
  }, [open]);

  const heads = Number.parseInt(cabezasStr, 10);
  const headsValid = Number.isFinite(heads) && heads >= 1;

  const ranking = useMemo(() => {
    if (!headsValid) return [];
    return buildRotationRanking(potreros, ndviById, heads, kgDia);
  }, [potreros, ndviById, heads, kgDia, headsValid]);

  if (!open) return null;

  return (
    <div
      role="presentation"
      style={styles.rotacionBackdrop}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="rotacion-title"
        style={styles.rotacionDialog}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={styles.rotacionHeader}>
          <h2 id="rotacion-title" style={styles.rotacionTitle}>Planificar rotación</h2>
          <button type="button" style={styles.rotacionClose} onClick={onClose} aria-label="Cerrar">×</button>
        </div>
        <p style={styles.rotacionLead}>
          Ingresá la cantidad de cabezas adultas. Ordenamos los potreros con más días de descanso y mejor NDVI primero
          y estimamos cuántos días podría alimentar el lote según la biomasa aproximada.
        </p>
        <label style={styles.rotacionLabel} htmlFor="rotacion-cabezas">Cabezas adultas</label>
        <input
          id="rotacion-cabezas"
          type="number"
          min="1"
          step="1"
          inputMode="numeric"
          placeholder="Ej. 80"
          style={styles.rotacionInput}
          value={cabezasStr}
          onChange={(e) => setCabezasStr(e.target.value)}
        />
        <label style={{ ...styles.rotacionLabel, marginTop: "12px" }} htmlFor="rotacion-consumo">
          Consumo estimado (kg MS/cabeza/día)
        </label>
        <select
          id="rotacion-consumo"
          style={styles.rotacionSelect}
          value={kgDia}
          onChange={(e) => setKgDia(Number(e.target.value))}
        >
          <option value={10}>{CONSUMO_MS_CABEZA_DIA_MIN} (bajo)</option>
          <option value={11}>{CONSUMO_MS_CABEZA_DIA_DEFAULT} (medio)</option>
          <option value={12}>{CONSUMO_MS_CABEZA_DIA_MAX} (alto)</option>
        </select>

        {!headsValid ? (
          <p style={styles.rotacionHint}>Ingresá al menos 1 cabeza para ver el ranking.</p>
        ) : potreros.length === 0 ? (
          <p style={styles.rotacionHint}>Todavía no hay potreros dibujados.</p>
        ) : (
          <>
            <h3 style={styles.rotacionSubTitle}>Ranking sugerido</h3>
            <div style={styles.rotacionList}>
              {ranking.map((row, idx) => (
                <div
                  key={row.potreroId}
                  style={{
                    ...styles.rotacionRow,
                    ...(row.enUso ? styles.rotacionRowMuted : {}),
                  }}
                >
                  <div style={styles.rotacionRowTop}>
                    <span style={styles.rotacionRank}>#{idx + 1}</span>
                    <span style={styles.rotacionNombre}>{row.nombre}</span>
                    <span style={styles.rotacionDuracion}>{formatDiasEstimados(row.diasEstimados)}</span>
                  </div>
                  <div style={styles.rotacionRowMeta}>
                    <span>
                      {row.areaHa != null ? `${row.areaHa.toFixed(1)} ha` : "— ha"}
                    </span>
                    <span>
                      NDVI {row.ndvi != null ? row.ndvi.toFixed(2) : row.ndviCargando ? "…" : "—"}
                    </span>
                    <span>
                      ~{row.msPorHa != null ? Math.round(row.msPorHa) : "—"} kg MS/ha
                    </span>
                    <span>
                      Descanso:{" "}
                      {row.enUso
                        ? "con hacienda"
                        : row.descansoDias != null
                          ? `${row.descansoDias} d`
                          : "sin datos"}
                    </span>
                    {row.sinAguada && !row.enUso && (
                      <span style={styles.rotacionWarnAguada}>Sin aguada asignada</span>
                    )}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}

        <p style={styles.rotacionDisclaimer}>
          Estimación inicial: MS disponible ≈ NDVI × {KG_MS_PER_HA_NDVI_FACTOR} kg/ha;
          consumo {CONSUMO_MS_CABEZA_DIA_MIN}–{CONSUMO_MS_CABEZA_DIA_MAX} kg MS/cabeza/día.
          No incluye pérdidas por pisoteo, estratos ni objetivos de reserva. Ajustá en campo según tu sistema.
          {" "}
          Días estimados mayores a {ROTACION_UI_DIAS_ESTIMADOS_MAX} no se muestran.
        </p>
      </div>
    </div>
  );
}

/**
 * Badge mapa / copy: prioriza motor de descanso (Bloque E); NDVI como refuerzo visual.
 * @returns {{ tier: "listo"|"casi"|"recup", label: string, mapShort: string, hint?: string }}
 */
function recomendacionRotacion(ndviEntry, motor) {
  const ndvi = ndviEntry?.status === "ok" ? ndviEntry.meanNdvi : null;

  if (!motor || motor.kind === "sin_datos") {
    return {
      tier: "casi",
      label: "Sin datos",
      mapShort: "—",
      hint: "Registrá movimientos de hacienda para calcular el descanso.",
    };
  }
  if (motor.kind === "en_uso") {
    return {
      tier: "recup",
      label: "Con hacienda",
      mapShort: "Hac.",
      hint: "Hay hacienda en el potrero.",
    };
  }
  if (motor.listo) {
    return { tier: "listo", label: "Listo para entrar", mapShort: "Listo" };
  }

  const n = motor.diasNecesarios ?? 1;
  const r = motor.diasRestantes ?? 1;
  const umbralCasi = Math.max(1, Math.ceil(n * 0.12));

  if (r <= umbralCasi) {
    return {
      tier: "casi",
      label: "Casi listo",
      mapShort: "Casi",
      hint: motor.primaryLine,
    };
  }
  if (ndvi !== null && ndvi < 0.28) {
    return {
      tier: "recup",
      label: "En recuperación",
      mapShort: "Recup.",
      hint: motor.primaryLine,
    };
  }
  return {
    tier: "recup",
    label: "En recuperación",
    mapShort: "Recup.",
    hint: motor.primaryLine,
  };
}

function formatUltimaLluviaLine(ultimoLluvia) {
  if (!ultimoLluvia?.fecha) return "Sin registro de lluvia en este potrero.";
  const mm =
    ultimoLluvia.mm != null && Number.isFinite(Number(ultimoLluvia.mm))
      ? `${ultimoLluvia.mm} mm · `
      : "";
  const fechaStr = formatNdviWindowDate(ultimoLluvia.fecha);
  return `${mm}${fechaStr ?? ""}`.trim() || "Lluvia registrada.";
}

function RotacionRecoMarker({ pot, reco, interactive, onSelect }) {
  const icon = useMemo(
    () =>
      L.divIcon({
        className: "rotia-reco-badge-wrap",
        html:
          `<div class="rotia-reco-badge rotia-reco-badge--${reco.tier}">` +
          `<span class="rotia-reco-badge-text">${reco.mapShort}</span></div>`,
        iconSize: [76, 28],
        iconAnchor: [38, 28],
      }),
    [reco.tier, reco.mapShort],
  );

  return (
    <Marker
      position={ringCentroid(pot.positions)}
      icon={icon}
      zIndexOffset={650}
      interactive={interactive}
      eventHandlers={{
        click: (e) => {
          if (!interactive) return;
          const ev = e.originalEvent;
          if (ev) L.DomEvent.stopPropagation(ev);
          onSelect(pot);
        },
      }}
    />
  );
}

function formatEvento(tipo, fields) {
  const hoy = new Date().toLocaleDateString("es-AR", { day: "numeric", month: "short" });
  if (tipo === "lluvia") return `Lluvia ${fields.mm} mm · ${hoy}`;
  if (tipo === "fertilizacion") return `Fertilización: ${fields.producto}, ${fields.dosis} kg/ha · ${hoy}`;
  if (tipo === "movimiento") {
    const dir = fields.direccion === "entrada" ? "Entrada" : "Salida";
    return `${dir} ${fields.cantidad} cab. · ${hoy}`;
  }
  if (tipo === "foto") return fields.nota ? `Foto: ${fields.nota} · ${hoy}` : `Foto registrada · ${hoy}`;
  return "";
}

function EventoForm({ onSave, onClose, saving }) {
  const [tipo, setTipo] = useState(null);
  const [mm, setMm] = useState("");
  const [producto, setProducto] = useState("");
  const [dosis, setDosis] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [direccion, setDireccion] = useState("entrada");
  const [nota, setNota] = useState("");
  const [fotoName, setFotoName] = useState("");

  const canSave = tipo && (
    (tipo === "lluvia" && mm !== "") ||
    (tipo === "fertilizacion" && producto.trim() !== "" && dosis !== "") ||
    (tipo === "movimiento" && cantidad !== "") ||
    (tipo === "foto")
  );

  const handleSave = () => {
    if (!canSave || saving) return;
    onSave(tipo, { mm, producto, dosis, cantidad, direccion, nota, fotoName });
  };

  return (
    <div
      style={styles.eventoBackdrop}
      onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}
    >
      <div style={styles.eventoDialog}>
        <div style={styles.eventoHeader}>
          <h2 style={styles.eventoTitle}>Registrar evento</h2>
          <button type="button" style={styles.eventoClose} onClick={onClose} aria-label="Cerrar">×</button>
        </div>

        <div style={styles.tipoGrid}>
          {EVENTO_TIPOS.map((t) => (
            <button
              key={t.id}
              type="button"
              style={{ ...styles.tipoChip, ...(tipo === t.id ? styles.tipoChipActive : {}) }}
              onClick={() => setTipo(t.id)}
            >
              <span style={styles.tipoIcon}>{t.icon}</span>
              <span style={styles.tipoLabel}>{t.label}</span>
            </button>
          ))}
        </div>

        {tipo === "lluvia" && (
          <div style={styles.fieldsSection}>
            <label style={styles.fieldLabel}>Milímetros caídos (mm)</label>
            <input autoFocus type="number" min="0" step="0.1" placeholder="Ej. 25"
              value={mm} onChange={(e) => setMm(e.target.value)} style={styles.fieldInput} />
          </div>
        )}

        {tipo === "fertilizacion" && (
          <div style={styles.fieldsSection}>
            <label style={styles.fieldLabel}>Producto</label>
            <input autoFocus type="text" placeholder="Ej. Urea"
              value={producto} onChange={(e) => setProducto(e.target.value)} style={styles.fieldInput} />
            <label style={{ ...styles.fieldLabel, marginTop: "10px" }}>Dosis (kg/ha)</label>
            <input type="number" min="0" step="0.1" placeholder="Ej. 150"
              value={dosis} onChange={(e) => setDosis(e.target.value)} style={styles.fieldInput} />
          </div>
        )}

        {tipo === "movimiento" && (
          <div style={styles.fieldsSection}>
            <label style={styles.fieldLabel}>Cantidad de cabezas</label>
            <input autoFocus type="number" min="0" step="1" placeholder="Ej. 40"
              value={cantidad} onChange={(e) => setCantidad(e.target.value)} style={styles.fieldInput} />
            <label style={{ ...styles.fieldLabel, marginTop: "10px" }}>Tipo de movimiento</label>
            <div style={styles.toggleRow}>
              <button type="button"
                style={{ ...styles.toggleBtn, ...(direccion === "entrada" ? styles.toggleBtnActive : {}) }}
                onClick={() => setDireccion("entrada")}>Entrada</button>
              <button type="button"
                style={{ ...styles.toggleBtn, ...(direccion === "salida" ? styles.toggleBtnActive : {}) }}
                onClick={() => setDireccion("salida")}>Salida</button>
            </div>
          </div>
        )}

        {tipo === "foto" && (
          <div style={styles.fieldsSection}>
            <label style={styles.fieldLabel}>Imagen</label>
            <label style={styles.fileLabel}>
              <input type="file" accept="image/*" style={{ display: "none" }}
                onChange={(e) => setFotoName(e.target.files?.[0]?.name ?? "")} />
              <span style={styles.fileLabelText}>
                {fotoName ? `📎 ${fotoName}` : "Seleccionar imagen"}
              </span>
            </label>
            <label style={{ ...styles.fieldLabel, marginTop: "10px" }}>Nota (opcional)</label>
            <input type="text" placeholder="Ej. Estado del pastizal"
              value={nota} onChange={(e) => setNota(e.target.value)} style={styles.fieldInput} />
          </div>
        )}

        <div style={styles.eventoActions}>
          <button type="button" style={styles.eventoSecondary} onClick={onClose} disabled={saving}>
            Cancelar
          </button>
          <button
            type="button"
            style={{
              ...styles.eventoPrimary,
              opacity: canSave && !saving ? 1 : 0.42,
              cursor: canSave && !saving ? "pointer" : "not-allowed",
            }}
            onClick={handleSave}
            disabled={!canSave || saving}
          >
            {saving ? "Guardando…" : "Guardar"}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * @param {"primer"|"adicional"|"edit"} variant
 * @param {object | null} editingCampo — fila `campos` cuando variant === "edit"
 */
function PrimerCampoModal({
  open,
  variant,
  editingCampo,
  onClose,
  onCreated,
  onUpdated,
  onPreviewLocation,
  fallbackMapCenter = ARGENTINA_CENTER,
  fallbackMapZoom = 14,
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);
  const [descansoBasesForm, setDescansoBasesForm] = useState(() => ({
    ...DEFAULT_DESCANSO_BASES_DIAS,
  }));

  useEffect(() => {
    if (!open) {
      setName("");
      setQuery("");
      setPreview(null);
      setError(null);
      setBusy(false);
      setSaving(false);
      setDescansoBasesForm({ ...DEFAULT_DESCANSO_BASES_DIAS });
      return;
    }
    if (variant === "edit" && editingCampo) {
      setName(String(editingCampo.name ?? ""));
      setQuery("");
      setPreview({
        lat: Number(editingCampo.lat),
        lng: Number(editingCampo.lng),
        label: null,
      });
      setDescansoBasesForm(mergeDescansoBasesDias(editingCampo.descanso_bases_dias));
      setError(null);
      return;
    }
    setName("");
    setQuery("");
    setPreview(null);
    setError(null);
  }, [open, variant, editingCampo]);

  const handleBuscar = async () => {
    const q = query.trim();
    setError(null);
    if (!q) {
      setError("Escribí el nombre de un lugar o coordenadas (latitud, longitud).");
      return;
    }
    setBusy(true);
    try {
      const r = await geocodeFreeText(q);
      if (!r) {
        setPreview(null);
        setError("No se encontró. Probá otro texto o el formato -34.5, -58.3");
        return;
      }
      setPreview({ lat: r.lat, lng: r.lng, label: r.label, searched: true });
      onPreviewLocation(r.lat, r.lng, 14);
    } finally {
      setBusy(false);
    }
  };

  const handleGuardar = async () => {
    const n = name.trim();
    setError(null);
    if (!n) {
      setError("Ingresá el nombre del establecimiento.");
      return;
    }
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setError("Sesión no válida.");
        return;
      }

      if (variant === "edit" && editingCampo) {
        const lat = preview?.lat ?? Number(editingCampo.lat);
        const lng = preview?.lng ?? Number(editingCampo.lng);
        const zoom = preview?.searched ? 14 : (Number(editingCampo.zoom) || 14);
        const { data, error: updErr } = await supabase
          .from("campos")
          .update({
            name: n,
            lat,
            lng,
            zoom,
            descanso_bases_dias: descansoBasesForm,
          })
          .eq("id", editingCampo.id)
          .select()
          .single();
        if (updErr || !data) {
          console.error(updErr);
          setError(updErr?.message ?? "No se pudo guardar el establecimiento.");
          return;
        }
        onUpdated?.(data);
        onClose?.();
        return;
      }

      const lat =
        preview?.lat ??
        (variant === "primer" ? ARGENTINA_CENTER[0] : fallbackMapCenter[0]);
      const lng =
        preview?.lng ??
        (variant === "primer" ? ARGENTINA_CENTER[1] : fallbackMapCenter[1]);
      const zoom = preview?.searched
        ? 14
        : variant === "primer"
          ? 6
          : (Number.isFinite(Number(fallbackMapZoom)) ? Number(fallbackMapZoom) : 14);
      const { data, error: insErr } = await supabase
        .from("campos")
        .insert({
          name: n,
          lat,
          lng,
          zoom,
          user_id: user.id,
        })
        .select()
        .single();
      if (insErr || !data) {
        console.error(insErr);
        setError(insErr?.message ?? "No se pudo crear el establecimiento.");
        return;
      }
      onCreated(data);
      if (variant !== "primer") onClose?.();
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;
  if (variant === "edit" && !editingCampo) return null;

  const title =
    variant === "primer"
      ? "Tu primer establecimiento"
      : variant === "edit"
        ? "Editar establecimiento"
        : "Nuevo campo";
  const lead =
    variant === "primer"
      ? "Creá un campo para dibujar potreros. Podés buscar la ubicación en el mapa o usar el centro de Argentina por defecto."
      : variant === "edit"
        ? "Cambiá el nombre y, si querés, buscá otra ubicación para recentrar el mapa del campo."
        : "Creá otro establecimiento en tu cuenta. Podés buscar la ubicación o dejar el mapa como está y ajustar después.";
  const canDismiss = variant !== "primer" && typeof onClose === "function";
  const primaryLabel =
    variant === "edit"
      ? (saving ? "Guardando…" : "Guardar cambios")
      : saving
        ? "Creando…"
        : "Crear establecimiento";

  return (
    <div
      role="presentation"
      style={styles.primerCampoBackdrop}
      onClick={canDismiss ? () => { if (!saving) onClose(); } : undefined}
    >
      <div
        style={styles.primerCampoDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="campo-modal-title"
        onClick={(e) => e.stopPropagation()}
      >
        <h2 id="campo-modal-title" style={styles.primerCampoTitle}>
          {title}
        </h2>
        <p style={styles.primerCampoLead}>
          {lead}
        </p>
        <label style={styles.primerCampoLabel} htmlFor="campo-modal-nombre">Nombre</label>
        <input
          id="campo-modal-nombre"
          style={styles.primerCampoInput}
          placeholder="Ej. Estancia Los Alamos"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label style={{ ...styles.primerCampoLabel, marginTop: "12px" }} htmlFor="campo-modal-buscar">
          Ubicación (opcional)
        </label>
        <div style={styles.mapSearchRow}>
          <input
            id="campo-modal-buscar"
            style={styles.mapSearchInput}
            placeholder="Lugar o -34.6, -58.4"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                handleBuscar();
              }
            }}
          />
          <button
            type="button"
            style={styles.mapSearchBtn}
            onClick={handleBuscar}
            disabled={busy}
          >
            {busy ? "…" : "Ir"}
          </button>
        </div>
        {preview && (
          <p style={styles.primerCampoCoords}>
            Punto elegido: {preview.lat.toFixed(5)}, {preview.lng.toFixed(5)}
            {preview.label ? (
              <span style={{ display: "block", fontWeight: 600, marginTop: "4px", color: "#5a7058" }}>
                {preview.label}
              </span>
            ) : null}
          </p>
        )}
        {!preview && variant === "primer" && (
          <p style={styles.primerCampoHint}>
            Sin búsqueda se usará vista general de Argentina; después podés centrar con el buscador del mapa.
          </p>
        )}
        {!preview && variant === "adicional" && (
          <p style={styles.primerCampoHint}>
            Sin búsqueda se usará el centro del mapa actual. Podés mover el mapa antes de guardar o buscar un lugar.
          </p>
        )}
        {variant === "edit" && preview && !preview.searched && (
          <p style={styles.primerCampoHint}>
            Ubicación guardada del campo. Usá “Ir” arriba para buscar otra y recentrar.
          </p>
        )}
        {variant === "edit" && (
          <details style={{ marginTop: "14px" }}>
            <summary style={{ cursor: "pointer", fontWeight: 700, color: "#355c3b", fontSize: "14px" }}>
              Días base de descanso (motor inteligente)
            </summary>
            <p style={{ ...styles.primerCampoHint, marginTop: "8px", marginBottom: "10px" }}>
              Se aplican según el tipo de pasto de cada potrero (Festuca, Raigrás, etc.). Valores por defecto del sector; ajustalos a tu manejo.
            </p>
            <div style={{ display: "flex", flexDirection: "column", gap: "10px" }}>
              {[
                ...TIPOS_PASTO_OPTIONS,
                { id: DESCANSO_BASE_KEY_SIN_ESPECIFICAR, label: "Sin especificar" },
              ].map(({ id, label }) => (
                <label key={id} style={{ display: "block", fontSize: "13px", fontWeight: 600, color: "#2a3f2f" }}>
                  {label}
                  <input
                    type="number"
                    min={1}
                    max={500}
                    step={1}
                    style={{ ...styles.primerCampoInput, marginTop: "4px" }}
                    value={descansoBasesForm[id] ?? ""}
                    onChange={(e) => {
                      const v = Number(e.target.value);
                      setDescansoBasesForm((prev) => ({
                        ...prev,
                        [id]: Number.isFinite(v) && v >= 1 && v <= 500 ? v : prev[id],
                      }));
                    }}
                  />
                </label>
              ))}
            </div>
          </details>
        )}
        {error && (
          <p style={styles.primerCampoError}>{error}</p>
        )}
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            gap: "10px",
            marginTop: "18px",
          }}
        >
          {canDismiss && (
            <button
              type="button"
              style={styles.primerCampoCancel}
              onClick={() => { if (!saving) onClose(); }}
              disabled={saving}
            >
              Cancelar
            </button>
          )}
          <button
            type="button"
            style={{
              ...styles.primerCampoPrimary,
              opacity: saving ? 0.65 : 1,
              cursor: saving ? "wait" : "pointer",
              marginTop: 0,
            }}
            onClick={handleGuardar}
            disabled={saving}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

function MapaPotrero({ onLogout }) {
  const [drawingMode, setDrawingMode] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [draftVertices, setDraftVertices] = useState([]);
  const [previewTip, setPreviewTip] = useState(null);
  const [pendingRing, setPendingRing] = useState(null);
  const [potreros, setPotreros] = useState([]);
  const [campos, setCampos] = useState([]);
  const [loadingCampos, setLoadingCampos] = useState(true);
  const [selectedCampoId, setSelectedCampoId] = useState(null);
  const [campoNuevoModalOpen, setCampoNuevoModalOpen] = useState(false);
  const [campoEditModalOpen, setCampoEditModalOpen] = useState(false);
  const [mapCenter, setMapCenter] = useState(ARGENTINA_CENTER);
  const [mapZoom, setMapZoom] = useState(6);
  const vvBottomInsetPx = useVisualViewportBottomInset();
  const floatingBottomStyle = useMemo(
    () => ({
      bottom: `calc(14px + env(safe-area-inset-bottom, 0px) + ${vvBottomInsetPx}px)`,
    }),
    [vvBottomInsetPx],
  );
  const drawHintBottomStyle = useMemo(
    () => ({
      bottom: `calc(72px + env(safe-area-inset-bottom, 0px) + ${vvBottomInsetPx}px)`,
    }),
    [vvBottomInsetPx],
  );
  const drawHintAguadaBottomStyle = useMemo(
    () => ({
      bottom: `calc(76px + env(safe-area-inset-bottom, 0px) + ${vvBottomInsetPx}px)`,
    }),
    [vvBottomInsetPx],
  );
  const [locationQuery, setLocationQuery] = useState("");
  const [locationSearchBusy, setLocationSearchBusy] = useState(false);
  const [locationSearchError, setLocationSearchError] = useState(null);
  const [nombreInput, setNombreInput] = useState("");
  const [tipoPastoNuevo, setTipoPastoNuevo] = useState("");
  const [selectedPotrero, setSelectedPotrero] = useState(null);
  const [sheetEntered, setSheetEntered] = useState(false);
  const [showEventForm, setShowEventForm] = useState(false);
  const [savingPotrero, setSavingPotrero] = useState(false);
  const [savingEvento, setSavingEvento] = useState(false);
  const [loadingPotreros, setLoadingPotreros] = useState(false);
  const [potrerosReloadTick, setPotrerosReloadTick] = useState(0);
  const [showRotacionModal, setShowRotacionModal] = useState(false);
  const [showEditNombreDialog, setShowEditNombreDialog] = useState(false);
  const [editNombreSheet, setEditNombreSheet] = useState("");
  const [editTipoPastoSheet, setEditTipoPastoSheet] = useState("");
  const [savingEditNombre, setSavingEditNombre] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingPotrero, setDeletingPotrero] = useState(false);
  const [potreroSheetError, setPotreroSheetError] = useState(null);
  const ndviByIdRef = useRef({});
  const [ndviById, setNdviById] = useState({});
  const listosSectionRef = useRef(null);
  const [aguadas, setAguadas] = useState([]);
  const [loadingAguadas, setLoadingAguadas] = useState(false);
  const [aguadaPlacementMode, setAguadaPlacementMode] = useState(false);
  const [sheetTab, setSheetTab] = useState("resumen");
  const [historialRows, setHistorialRows] = useState([]);
  const [historialLoading, setHistorialLoading] = useState(false);
  const [historialError, setHistorialError] = useState(null);
  const [historialRefresh, setHistorialRefresh] = useState(0);
  const [listosBannerDismissed, setListosBannerDismissed] = useState(() => {
    try {
      return sessionStorage.getItem(LISTOS_BANNER_SESSION_KEY) === "1";
    } catch {
      return false;
    }
  });

  const draftVerticesRef = useRef(draftVertices);
  draftVerticesRef.current = draftVertices;

  useEffect(() => {
    ndviByIdRef.current = ndviById;
  }, [ndviById]);

  useEffect(() => {
    if (campoEditModalOpen && !selectedCampoId) setCampoEditModalOpen(false);
  }, [campoEditModalOpen, selectedCampoId]);

  // ── Campos del usuario ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingCampos(true);
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        if (!cancelled) {
          setLoadingCampos(false);
          setCampos([]);
        }
        return;
      }
      const { data, error } = await supabase
        .from("campos")
        .select("*")
        .order("created_at", { ascending: true });
      if (cancelled) return;
      setLoadingCampos(false);
      if (error) {
        console.error("Error cargando campos:", error);
        setCampos([]);
        return;
      }
      setCampos(data ?? []);
    })();
    return () => { cancelled = true; };
  }, []);

  useEffect(() => {
    if (loadingCampos) return;
    if (campos.length === 0) {
      setSelectedCampoId(null);
      setMapCenter(ARGENTINA_CENTER);
      setMapZoom(6);
      return;
    }
    setSelectedCampoId((prev) => {
      if (prev && campos.some((c) => c.id === prev)) return prev;
      const saved = localStorage.getItem(CAMPO_STORAGE_KEY);
      if (saved && campos.some((c) => c.id === saved)) return saved;
      return campos[0].id;
    });
  }, [loadingCampos, campos]);

  useEffect(() => {
    if (!selectedCampoId) return;
    const c = campos.find((x) => x.id === selectedCampoId);
    if (!c) return;
    const lat = Number(c.lat);
    const lng = Number(c.lng);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    setMapCenter([lat, lng]);
    const z = Number(c.zoom);
    setMapZoom(Number.isFinite(z) ? z : 14);
    localStorage.setItem(CAMPO_STORAGE_KEY, c.id);
  }, [selectedCampoId, campos]);

  useEffect(() => {
    setSelectedPotrero(null);
    setDrawingMode(false);
    setPendingRing(null);
    setDraftVertices([]);
    setPreviewTip(null);
    setSheetEntered(false);
    setShowEventForm(false);
    setShowEditNombreDialog(false);
    setShowDeleteConfirm(false);
    setAguadaPlacementMode(false);
  }, [selectedCampoId]);

  // ── Potreros del campo seleccionado ───────────────────────────────────────
  useEffect(() => {
    if (!selectedCampoId) {
      setPotreros([]);
      setLoadingPotreros(false);
      setNdviById({});
      return undefined;
    }

    let cancelled = false;

    const load = async () => {
      setLoadingPotreros(true);
      setNdviById({});

      const { data: { user } } = await supabase.auth.getUser();
      if (!user || cancelled) {
        if (!cancelled) setLoadingPotreros(false);
        return;
      }

      const { data: potrerosData, error } = await supabase
        .from("potreros")
        .select("*")
        .eq("campo_id", selectedCampoId)
        .order("created_at", { ascending: true });

      if (cancelled) return;

      if (error || !potrerosData) {
        console.error("Error cargando potreros:", error);
        setPotreros([]);
        setLoadingPotreros(false);
        return;
      }

      const ids = potrerosData.map((p) => p.id);
      const lastEvento = {};
      const ultimoMovByPotrero = {};
      const ultimoLluviaByPotrero = {};
      const movByPotrero = {};
      const lluviaMm30dByPot = {};

      if (ids.length > 0) {
        const { data: eventosData } = await supabase
          .from("eventos")
          .select("potrero_id, descripcion, fecha")
          .in("potrero_id", ids)
          .order("fecha", { ascending: false });

        if (eventosData) {
          for (const ev of eventosData) {
            if (!lastEvento[ev.potrero_id]) {
              lastEvento[ev.potrero_id] = ev.descripcion;
            }
          }
        }

        const { data: movData } = await supabase
          .from("eventos")
          .select("potrero_id, datos, fecha")
          .eq("tipo", "movimiento")
          .in("potrero_id", ids)
          .order("fecha", { ascending: false });

        if (movData) {
          for (const row of movData) {
            if (!movByPotrero[row.potrero_id]) movByPotrero[row.potrero_id] = [];
            movByPotrero[row.potrero_id].push(row);
          }
          for (const pid of Object.keys(movByPotrero)) {
            movByPotrero[pid].sort(
              (a, b) => new Date(b.fecha).getTime() - new Date(a.fecha).getTime(),
            );
          }
          for (const row of movData) {
            if (ultimoMovByPotrero[row.potrero_id]) continue;
            const dir = row.datos?.direccion;
            ultimoMovByPotrero[row.potrero_id] = {
              fecha: row.fecha,
              direccion: dir === "entrada" || dir === "salida" ? dir : undefined,
            };
          }
        }

        const cutoff30 = new Date();
        cutoff30.setHours(0, 0, 0, 0);
        cutoff30.setDate(cutoff30.getDate() - 30);
        const { data: lluv30Data } = await supabase
          .from("eventos")
          .select("potrero_id, datos, fecha")
          .eq("tipo", "lluvia")
          .in("potrero_id", ids)
          .gte("fecha", cutoff30.toISOString());

        for (const row of lluv30Data ?? []) {
          const mm = Number(row.datos?.mm);
          if (!Number.isFinite(mm) || mm <= 0) continue;
          lluviaMm30dByPot[row.potrero_id] = (lluviaMm30dByPot[row.potrero_id] ?? 0) + mm;
        }

        const { data: lluvData } = await supabase
          .from("eventos")
          .select("potrero_id, datos, fecha")
          .eq("tipo", "lluvia")
          .in("potrero_id", ids)
          .order("fecha", { ascending: false });

        if (lluvData) {
          for (const row of lluvData) {
            if (ultimoLluviaByPotrero[row.potrero_id]) continue;
            const rawMm = row.datos?.mm;
            const mmNum = rawMm !== undefined && rawMm !== "" ? Number(rawMm) : null;
            ultimoLluviaByPotrero[row.potrero_id] = {
              fecha: row.fecha,
              mm: Number.isFinite(mmNum) ? mmNum : null,
            };
          }
        }
      }

      if (cancelled) return;

      setPotreros(
        potrerosData.map((p) => ({
          id: p.id,
          name: p.name,
          tipoPasto: p.tipo_pasto ?? null,
          aguadaId: p.aguada_id ?? null,
          positions: p.positions,
          ultimoEvento: lastEvento[p.id] ?? null,
          ultimoMovimiento: ultimoMovByPotrero[p.id] ?? null,
          ultimoLluvia: ultimoLluviaByPotrero[p.id] ?? null,
          lluviaMm30d: lluviaMm30dByPot[p.id] ?? 0,
          pastoreoCabezasUltima: pastoreoCabezasUltimaAntesDeSalida(movByPotrero[p.id]),
        }))
      );
      setLoadingPotreros(false);
    };

    load();
    return () => { cancelled = true; };
  }, [selectedCampoId, potrerosReloadTick]);

  // ── Aguadas del campo ─────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedCampoId) {
      setAguadas([]);
      setLoadingAguadas(false);
      return undefined;
    }
    let cancelled = false;
    (async () => {
      setLoadingAguadas(true);
      const { data, error } = await supabase
        .from("aguadas")
        .select("*")
        .eq("campo_id", selectedCampoId)
        .order("created_at", { ascending: true });
      if (cancelled) return;
      setLoadingAguadas(false);
      if (error) {
        console.error("Error cargando aguadas:", error);
        setAguadas([]);
        return;
      }
      setAguadas(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [selectedCampoId]);

  // ── Historial de eventos (pestaña sheet) ─────────────────────────────────
  useEffect(() => {
    const pid = selectedPotrero?.id;
    if (!pid) {
      setHistorialRows([]);
      setHistorialError(null);
      setHistorialLoading(false);
      return undefined;
    }
    if (sheetTab !== "historial") return undefined;
    let cancelled = false;
    (async () => {
      setHistorialLoading(true);
      setHistorialError(null);
      const { data, error } = await supabase
        .from("eventos")
        .select("id, tipo, descripcion, fecha, datos")
        .eq("potrero_id", pid)
        .order("fecha", { ascending: false })
        .limit(10);
      if (cancelled) return;
      setHistorialLoading(false);
      if (error) {
        setHistorialError(error.message ?? "No se pudo cargar el historial.");
        setHistorialRows([]);
        return;
      }
      setHistorialRows(data ?? []);
    })();
    return () => { cancelled = true; };
  }, [selectedPotrero?.id, sheetTab, historialRefresh]);

  useEffect(() => {
    setSheetTab("resumen");
  }, [selectedPotrero?.id]);

  // ── NDVI para todos los potreros (badges de recomendación en el mapa) ─────
  useEffect(() => {
    if (loadingPotreros || potreros.length === 0) return undefined;

    let cancelled = false;

    const queue = async () => {
      for (const p of potreros) {
        if (cancelled) return;
        const cur = ndviByIdRef.current[p.id];
        if (cur?.status === "ok") continue;

        setNdviById((prev) => {
          if (prev[p.id]?.status === "ok") return prev;
          if (prev[p.id]?.status === "loading") return prev;
          return { ...prev, [p.id]: { status: "loading" } };
        });

        const result = await fetchPotreroNdvi(p.positions);
        if (cancelled) return;

        if (result.ok && typeof result.meanNdvi === "number") {
          const mean = Math.min(1, Math.max(0, result.meanNdvi));
          setNdviById((prev) => ({
            ...prev,
            [p.id]: {
              status: "ok",
              meanNdvi: mean,
              intervalTo: result.intervalTo ?? null,
              tier: ndviTier(mean),
            },
          }));
        } else {
          if (result.detail) {
            console.warn("NDVI proxy (detalle):", result.detail);
          }
          setNdviById((prev) => ({
            ...prev,
            [p.id]: {
              status: "error",
              code: result.error ?? "unknown",
            },
          }));
        }
      }
    };

    queue();
    return () => {
      cancelled = true;
    };
  }, [loadingPotreros, potreros]);

  // ── Dibujo ────────────────────────────────────────────────────────────────
  const startDrawing = useCallback(() => {
    setAguadaPlacementMode(false);
    setSelectedPotrero(null);
    setSheetEntered(false);
    setPendingRing(null);
    setNombreInput("");
    setTipoPastoNuevo("");
    setDraftVertices([]);
    setPreviewTip(null);
    setDrawingMode(true);
  }, []);

  const beginAguadaPlacement = useCallback(() => {
    setDrawingMode(false);
    setDraftVertices([]);
    setPreviewTip(null);
    setPendingRing(null);
    setSelectedPotrero(null);
    setSheetEntered(false);
    setAguadaPlacementMode(true);
  }, []);

  const cancelDrawing = useCallback(() => {
    setDrawingMode(false);
    setDraftVertices([]);
    setPreviewTip(null);
  }, []);

  const handleAddVertex = useCallback(([lat, lng]) => {
    setDraftVertices((prev) => [...prev, [lat, lng]]);
  }, []);

  const handleAttemptClosePolygon = useCallback(() => {
    const ring = draftVerticesRef.current;
    if (ring.length < 3) return;
    setPendingRing(ring.map(([lat, lng]) => [lat, lng]));
    setDrawingMode(false);
    setDraftVertices([]);
    setPreviewTip(null);
    setNombreInput("");
    setTipoPastoNuevo("");
  }, []);

  // ── Guardar potrero en Supabase ───────────────────────────────────────────
  const handleConfirmNombre = useCallback(async () => {
    const name = nombreInput.trim();
    const ring = pendingRing;
    if (!selectedCampoId || !ring || ring.length < 3 || name.length === 0) return;

    setSavingPotrero(true);
    const { data: { user } } = await supabase.auth.getUser();
    const tipoDb = isKnownTipoPastoId(tipoPastoNuevo) ? tipoPastoNuevo : null;
    const { data, error } = await supabase
      .from("potreros")
      .insert({
        name,
        positions: ring,
        user_id: user?.id,
        campo_id: selectedCampoId,
        tipo_pasto: tipoDb,
      })
      .select()
      .single();

    setSavingPotrero(false);
    if (error || !data) {
      console.error("Error guardando potrero:", error);
      return;
    }

    setPotreros((prev) => [
      ...prev,
      {
        id: data.id,
        name: data.name,
        tipoPasto: data.tipo_pasto ?? null,
        aguadaId: data.aguada_id ?? null,
        positions: data.positions,
        ultimoEvento: null,
        ultimoMovimiento: null,
        ultimoLluvia: null,
        lluviaMm30d: 0,
        pastoreoCabezasUltima: null,
      },
    ]);
    setPendingRing(null);
    setNombreInput("");
    setTipoPastoNuevo("");
  }, [nombreInput, tipoPastoNuevo, pendingRing, selectedCampoId]);

  const handleLocationSearch = useCallback(async () => {
    const q = locationQuery.trim();
    setLocationSearchError(null);
    if (!q) return;
    setLocationSearchBusy(true);
    try {
      const r = await geocodeFreeText(q);
      if (!r) {
        setLocationSearchError("No se encontró. Probá otro nombre o latitud, longitud.");
        return;
      }
      setMapCenter([r.lat, r.lng]);
      setMapZoom(15);
    } finally {
      setLocationSearchBusy(false);
    }
  }, [locationQuery]);

  const handleCancelNombre = useCallback(() => {
    setPendingRing(null);
    setNombreInput("");
    setTipoPastoNuevo("");
  }, []);

  // ── Guardar evento en Supabase ────────────────────────────────────────────
  const handleSaveEvento = useCallback(async (tipo, fields) => {
    const desc = formatEvento(tipo, fields);
    setSavingEvento(true);

    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("eventos").insert({
      potrero_id: selectedPotrero.id,
      tipo,
      datos: fields,
      descripcion: desc,
      fecha: new Date().toISOString(),
      user_id: user?.id,
    });

    setSavingEvento(false);
    if (error) {
      console.error("Error guardando evento:", error);
      return;
    }

    const fechaIso = new Date().toISOString();
    setPotreros((prev) =>
      prev.map((p) => {
        if (p.id !== selectedPotrero.id) return p;
        const next = { ...p, ultimoEvento: desc };
        if (tipo === "movimiento") {
          const dir = fields.direccion === "entrada" ? "entrada" : "salida";
          next.ultimoMovimiento = { fecha: fechaIso, direccion: dir };
        }
        if (tipo === "lluvia") {
          const mmNum = Number(fields.mm);
          next.ultimoLluvia = {
            fecha: fechaIso,
            mm: Number.isFinite(mmNum) ? mmNum : null,
          };
        }
        return next;
      })
    );
    setSelectedPotrero((prev) => {
      const next = { ...prev, ultimoEvento: desc };
      if (tipo === "movimiento") {
        const dir = fields.direccion === "entrada" ? "entrada" : "salida";
        next.ultimoMovimiento = { fecha: fechaIso, direccion: dir };
      }
      if (tipo === "lluvia") {
        const mmNum = Number(fields.mm);
        next.ultimoLluvia = {
          fecha: fechaIso,
          mm: Number.isFinite(mmNum) ? mmNum : null,
        };
      }
      return next;
    });
    setShowEventForm(false);
    setHistorialRefresh((x) => x + 1);
    setPotrerosReloadTick((t) => t + 1);
  }, [selectedPotrero]);

  // ── Bottom sheet ──────────────────────────────────────────────────────────
  useEffect(() => {
    if (!selectedPotrero) { setSheetEntered(false); return undefined; }
    setSheetEntered(false);
    const id = window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => setSheetEntered(true));
    });
    return () => window.cancelAnimationFrame(id);
  }, [selectedPotrero]);

  useEffect(() => {
    setPotreroSheetError(null);
  }, [selectedPotrero?.id]);

  const closePotreroSheet = useCallback(() => {
    setSheetEntered(false);
    setShowEventForm(false);
    setShowEditNombreDialog(false);
    setShowDeleteConfirm(false);
    setPotreroSheetError(null);
    window.setTimeout(() => setSelectedPotrero(null), 300);
  }, []);

  const handleConfirmEditNombrePotrero = useCallback(async () => {
    const name = editNombreSheet.trim();
    if (!name || !selectedPotrero) return;
    setSavingEditNombre(true);
    setPotreroSheetError(null);
    const tipoDb = isKnownTipoPastoId(editTipoPastoSheet) ? editTipoPastoSheet : null;
    let upd = supabase
      .from("potreros")
      .update({ name, tipo_pasto: tipoDb })
      .eq("id", selectedPotrero.id);
    if (selectedCampoId) upd = upd.eq("campo_id", selectedCampoId);
    const { data: updatedRows, error } = await upd.select("id");
    setSavingEditNombre(false);
    if (error) {
      console.error("Error actualizando potrero:", error);
      setPotreroSheetError(error.message ?? "No se pudo guardar el nombre.");
      return;
    }
    if (!updatedRows?.length) {
      setPotreroSheetError(
        "No se actualizó el nombre (sin permiso o potrero inexistente).",
      );
      return;
    }
    setPotreros((prev) =>
      prev.map((p) =>
        p.id === selectedPotrero.id ? { ...p, name, tipoPasto: tipoDb } : p,
      ),
    );
    setSelectedPotrero((prev) =>
      prev ? { ...prev, name, tipoPasto: tipoDb } : prev,
    );
    setShowEditNombreDialog(false);
  }, [editNombreSheet, editTipoPastoSheet, selectedPotrero, selectedCampoId]);

  const handleConfirmDeletePotrero = useCallback(async () => {
    if (!selectedPotrero) return;
    const id = selectedPotrero.id;
    setDeletingPotrero(true);
    setPotreroSheetError(null);

    const { error: eventosError } = await supabase
      .from("eventos")
      .delete()
      .eq("potrero_id", id);
    if (eventosError) {
      console.error("Error eliminando eventos del potrero:", eventosError);
      setDeletingPotrero(false);
      setPotreroSheetError(
        eventosError.message ?? "No se pudieron borrar los eventos (revisá permisos RLS).",
      );
      setShowDeleteConfirm(false);
      return;
    }

    let del = supabase.from("potreros").delete().eq("id", id);
    if (selectedCampoId) del = del.eq("campo_id", selectedCampoId);
    const { data: deletedRows, error } = await del.select("id");
    setDeletingPotrero(false);
    if (error) {
      console.error("Error eliminando potrero:", error);
      setPotreroSheetError(error.message ?? "No se pudo eliminar el potrero.");
      setShowDeleteConfirm(false);
      return;
    }
    if (!deletedRows?.length) {
      setPotreroSheetError(
        "No se eliminó el potrero (sin permiso o ya no existe).",
      );
      setShowDeleteConfirm(false);
      return;
    }
    setShowDeleteConfirm(false);
    setPotreros((prev) => prev.filter((p) => p.id !== id));
    setNdviById((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
    setSheetEntered(false);
    setSelectedPotrero(null);
  }, [selectedPotrero, selectedCampoId]);

  const ndviEntry = selectedPotrero ? ndviById[selectedPotrero.id] : null;

  const descansoBasesCampo = useMemo(
    () => mergeDescansoBasesDias(
      campos.find((c) => c.id === selectedCampoId)?.descanso_bases_dias,
    ),
    [campos, selectedCampoId],
  );

  const motorByPotreroId = useMemo(() => {
    const m = {};
    for (const p of potreros) {
      m[p.id] = computeDescansoInteligente({
        tipoPasto: p.tipoPasto,
        ultimoMovimiento: p.ultimoMovimiento,
        lluviaMm30d: p.lluviaMm30d ?? 0,
        pastoreoCabezasUltima: p.pastoreoCabezasUltima,
        basesDias: descansoBasesCampo,
      });
    }
    return m;
  }, [potreros, descansoBasesCampo]);

  const motorSheet = selectedPotrero
    ? motorByPotreroId[selectedPotrero.id]
    : null;

  const potrerosListos = useMemo(() => {
    const rows = [];
    for (const p of potreros) {
      const motor = motorByPotreroId[p.id];
      if (motor?.kind === "descanso" && motor.listo) {
        rows.push({ potrero: p, motor });
      }
    }
    rows.sort(
      (a, b) => (b.motor.diasTranscurridos ?? 0) - (a.motor.diasTranscurridos ?? 0),
    );
    return rows;
  }, [potreros, motorByPotreroId]);

  const dismissListosBanner = useCallback(() => {
    try {
      sessionStorage.setItem(LISTOS_BANNER_SESSION_KEY, "1");
    } catch {
      /* ignore */
    }
    setListosBannerDismissed(true);
  }, []);

  const scrollToListosPotreros = useCallback(() => {
    listosSectionRef.current?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, []);

  const listosBannerPotrerosCount = potrerosListos.length;
  const showListosBanner =
    potreros.length > 0 && listosBannerPotrerosCount > 0 && !listosBannerDismissed;

  const handlePlaceAguada = useCallback(async (lat, lng) => {
    if (!selectedCampoId || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;
    const { data, error } = await supabase
      .from("aguadas")
      .insert({
        campo_id: selectedCampoId,
        user_id: user.id,
        lat,
        lng,
        label: null,
      })
      .select()
      .single();
    if (error || !data) {
      console.error("Error creando aguada:", error);
      return;
    }
    setAguadas((prev) => [...prev, data]);
  }, [selectedCampoId]);

  const handleDeleteAguada = useCallback(async (aguadaId) => {
    if (!selectedCampoId) return;
    const { data: deleted, error } = await supabase
      .from("aguadas")
      .delete()
      .eq("id", aguadaId)
      .eq("campo_id", selectedCampoId)
      .select("id");
    if (error) {
      console.error("Error eliminando aguada:", error);
      return;
    }
    if (!deleted?.length) return;
    setAguadas((prev) => prev.filter((a) => a.id !== aguadaId));
    setPotreros((prev) =>
      prev.map((p) => (p.aguadaId === aguadaId ? { ...p, aguadaId: null } : p)),
    );
    setSelectedPotrero((prev) =>
      prev && prev.aguadaId === aguadaId ? { ...prev, aguadaId: null } : prev,
    );
  }, [selectedCampoId]);

  const handleAguadaAsignadaChange = useCallback(async (aguadaIdVal) => {
    if (!selectedPotrero || !selectedCampoId) return;
    const aguadaIdNorm = aguadaIdVal && aguadaIdVal !== "" ? aguadaIdVal : null;
    setPotreroSheetError(null);
    const { data: rows, error } = await supabase
      .from("potreros")
      .update({ aguada_id: aguadaIdNorm })
      .eq("id", selectedPotrero.id)
      .eq("campo_id", selectedCampoId)
      .select("id");
    if (error) {
      console.error("Error asignando aguada:", error);
      setPotreroSheetError(error.message ?? "No se pudo guardar la aguada.");
      return;
    }
    if (!rows?.length) {
      setPotreroSheetError(
        "No se actualizó el potrero (sin permiso, aguada inexistente o no pertenece a este campo).",
      );
      return;
    }
    setPotreros((prev) =>
      prev.map((p) =>
        p.id === selectedPotrero.id ? { ...p, aguadaId: aguadaIdNorm } : p,
      ),
    );
    setSelectedPotrero((prev) =>
      prev ? { ...prev, aguadaId: aguadaIdNorm } : prev,
    );
  }, [selectedPotrero, selectedCampoId]);

  const lastDraft = draftVertices[draftVertices.length - 1];
  const hoverSegment =
    drawingMode && previewTip && draftVertices.length > 0 && lastDraft
      ? [lastDraft, previewTip]
      : null;

  const isPrimerCampoBloqueo = !loadingCampos && campos.length === 0;
  const campoModalAbierto =
    isPrimerCampoBloqueo || campoNuevoModalOpen || campoEditModalOpen;
  const campoModalVariant = isPrimerCampoBloqueo
    ? "primer"
    : campoEditModalOpen
      ? "edit"
      : "adicional";
  const editingCampoFila =
    campoEditModalOpen && selectedCampoId
      ? campos.find((c) => c.id === selectedCampoId) ?? null
      : null;

  const closeCampoAuxModal = useCallback(() => {
    setCampoNuevoModalOpen(false);
    setCampoEditModalOpen(false);
  }, []);

  const compactMapHeader = useMediaQuery("(max-width: 720px)");

  const mapHeaderMenu = (
    <div style={{ position: "relative" }}>
      <button
        type="button"
        style={styles.menuButton}
        aria-label="Abrir menu"
        onClick={() => setMenuOpen((v) => !v)}
      >
        ☰
      </button>
      {menuOpen && (
        <>
          <div
            style={styles.menuOverlay}
            onClick={() => setMenuOpen(false)}
          />
          <div style={styles.menuDropdown}>
            {selectedCampoId && !aguadaPlacementMode && (
              <button
                type="button"
                style={styles.menuDropdownItem}
                onClick={() => {
                  setMenuOpen(false);
                  beginAguadaPlacement();
                }}
              >
                💧 Colocar aguadas
              </button>
            )}
            <button
              type="button"
              style={styles.menuDropdownItem}
              onClick={() => { setMenuOpen(false); onLogout(); }}
            >
              Cerrar sesión
            </button>
          </div>
        </>
      )}
    </div>
  );

  return (
    <main style={styles.mapPage}>
      <header
        className="rotia-map-header"
        style={{
          ...styles.topBar,
          ...(compactMapHeader ? styles.topBarCompact : {}),
        }}
      >
        {compactMapHeader ? (
          <>
            <div style={styles.topBarMobileRow1}>
              <div style={styles.topBrand}>
                <div style={styles.topLogo} aria-hidden="true">🌿</div>
                <strong style={styles.topTitle}>Rotia</strong>
              </div>
              <div style={styles.topBarActionsIcons}>
                {campos.length > 0 && (
                  <>
                    <button
                      type="button"
                      aria-label="Editar nombre y ubicación del campo"
                      title="Editar campo"
                      style={{
                        ...styles.headerIconBtn,
                        ...(!selectedCampoId ? styles.topCampoGearDisabled : {}),
                      }}
                      disabled={!selectedCampoId}
                      onClick={() => {
                        setMenuOpen(false);
                        setCampoNuevoModalOpen(false);
                        setCampoEditModalOpen(true);
                      }}
                    >
                      ⚙️
                    </button>
                    <button
                      type="button"
                      aria-label="Nuevo campo"
                      title="Nuevo campo"
                      style={styles.headerIconBtn}
                      onClick={() => {
                        setMenuOpen(false);
                        setCampoEditModalOpen(false);
                        setCampoNuevoModalOpen(true);
                      }}
                    >
                      ➕
                    </button>
                  </>
                )}
                <button
                  type="button"
                  aria-label="Rotación de potreros"
                  title="Rotación"
                  style={{
                    ...styles.headerIconBtn,
                    opacity: selectedCampoId ? 1 : 0.45,
                    cursor: selectedCampoId ? "pointer" : "not-allowed",
                  }}
                  disabled={!selectedCampoId}
                  onClick={() => {
                    setMenuOpen(false);
                    if (!selectedCampoId) return;
                    setShowRotacionModal(true);
                  }}
                >
                  🔄
                </button>
                {mapHeaderMenu}
              </div>
            </div>
            {campos.length > 0 && (
              <div style={styles.topCampoFullRow}>
                <select
                  aria-label="Campo activo"
                  style={styles.campoSelect}
                  value={selectedCampoId ?? ""}
                  onChange={(e) => setSelectedCampoId(e.target.value)}
                >
                  {campos.map((c) => (
                    <option key={c.id} value={c.id}>{c.name}</option>
                  ))}
                </select>
              </div>
            )}
          </>
        ) : (
          <>
            <div style={styles.topBrand}>
              <div style={styles.topLogo} aria-hidden="true">🌿</div>
              <strong style={styles.topTitle}>Rotia</strong>
            </div>
            {campos.length > 0 && (
              <div style={styles.topCampoRow}>
                <div style={styles.topCampoSelectWrap}>
                  <select
                    aria-label="Campo activo"
                    style={styles.campoSelect}
                    value={selectedCampoId ?? ""}
                    onChange={(e) => setSelectedCampoId(e.target.value)}
                  >
                    {campos.map((c) => (
                      <option key={c.id} value={c.id}>{c.name}</option>
                    ))}
                  </select>
                </div>
                <button
                  type="button"
                  aria-label="Editar nombre y ubicación del campo"
                  title="Editar campo"
                  style={{
                    ...styles.topCampoGear,
                    ...(!selectedCampoId ? styles.topCampoGearDisabled : {}),
                  }}
                  disabled={!selectedCampoId}
                  onClick={() => {
                    setMenuOpen(false);
                    setCampoNuevoModalOpen(false);
                    setCampoEditModalOpen(true);
                  }}
                >
                  ⚙️
                </button>
                <button
                  type="button"
                  style={styles.topCampoNuevoBtn}
                  onClick={() => {
                    setMenuOpen(false);
                    setCampoEditModalOpen(false);
                    setCampoNuevoModalOpen(true);
                  }}
                >
                  Nuevo campo
                </button>
              </div>
            )}
            <div style={{ ...styles.topBarActions, marginLeft: "auto" }}>
              <button
                type="button"
                style={{
                  ...styles.rotacionHeaderBtn,
                  opacity: selectedCampoId ? 1 : 0.45,
                  cursor: selectedCampoId ? "pointer" : "not-allowed",
                }}
                disabled={!selectedCampoId}
                onClick={() => {
                  setMenuOpen(false);
                  if (!selectedCampoId) return;
                  setShowRotacionModal(true);
                }}
              >
                Rotación
              </button>
              {mapHeaderMenu}
            </div>
          </>
        )}
      </header>

      {showListosBanner && (
        <div style={styles.listosBanner} role="status">
          <p style={styles.listosBannerText}>
            Tenés {listosBannerPotrerosCount}{" "}
            {listosBannerPotrerosCount === 1 ? "potrero listo" : "potreros listos"} para entrar
            {" "}(descanso necesario cumplido).
          </p>
          <div style={styles.listosBannerActions}>
            <button type="button" style={styles.listosBannerBtn} onClick={scrollToListosPotreros}>
              Ver listos
            </button>
            <button type="button" style={styles.listosBannerDismiss} onClick={dismissListosBanner}>
              Cerrar aviso
            </button>
          </div>
        </div>
      )}

      {potreros.length > 0 && (
        <section
          ref={listosSectionRef}
          style={styles.listosSection}
          aria-label="Potreros listos"
        >
          <div style={styles.listosHeaderRow}>
            <h2 style={styles.listosTitle}>Potreros listos</h2>
            <span style={styles.listosBadge}>Descanso cumplido</span>
          </div>
          {potrerosListos.length === 0 ? (
            <p style={styles.listosEmpty}>
              Ningún potrero cumple todavía los días de descanso necesarios para estar listo.
            </p>
          ) : (
            <div style={styles.listosScroll}>
              {potrerosListos.map(({ potrero: p, motor }) => (
                <button
                  key={p.id}
                  type="button"
                  style={styles.listosChip}
                  onClick={() => {
                    setMenuOpen(false);
                    setSelectedPotrero(p);
                  }}
                >
                  <span style={styles.listosChipName}>{p.name}</span>
                  <span style={styles.listosChipDays}>
                    Listo · {motor.diasTranscurridos ?? 0} días
                  </span>
                </button>
              ))}
            </div>
          )}
        </section>
      )}

      {selectedCampoId && (
        <div style={styles.mapSearchSection}>
          <label htmlFor="map-location-search" style={styles.mapSearchLabel}>
            Buscar en el mapa
          </label>
          <div style={styles.mapSearchRow}>
            <input
              id="map-location-search"
              style={styles.mapSearchInput}
              placeholder="Nombre del lugar o coordenadas (ej. -34.6, -58.4)"
              value={locationQuery}
              onChange={(e) => {
                setLocationQuery(e.target.value);
                setLocationSearchError(null);
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  handleLocationSearch();
                }
              }}
            />
            <button
              type="button"
              style={{
                ...styles.mapSearchBtn,
                opacity: locationSearchBusy ? 0.55 : 1,
                cursor: locationSearchBusy ? "wait" : "pointer",
              }}
              onClick={handleLocationSearch}
              disabled={locationSearchBusy}
            >
              {locationSearchBusy ? "…" : "Ir"}
            </button>
          </div>
          {locationSearchError && (
            <p style={styles.mapSearchError}>{locationSearchError}</p>
          )}
        </div>
      )}

      <section style={styles.mapStack} aria-label="Mapa de potreros">
        <div style={styles.mapStage}>
          <div style={styles.mapInner}>
            <div style={styles.mapGrow}>
              <MapContainer center={mapCenter} zoom={mapZoom} scrollWheelZoom style={styles.map}>
                <MapResizeNotifier
                  drawingMode={drawingMode}
                  selectedPotrero={selectedPotrero}
                  aguadaPlacementMode={aguadaPlacementMode}
                />
                <MapViewSync center={mapCenter} zoom={mapZoom} />
                <TileLayer
                  attribution='Tiles &copy; <a href="https://www.esri.com/">Esri</a> &mdash; Source: Esri, Maxar, Earthstar Geographics, and the GIS User Community'
                  url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
                />
                {/* Reference overlay (teselas transparentes) sobre el satelital: localidades, límites y referencias. */}
                <TileLayer
                  attribution='Reference: <a href="https://www.esri.com/">Esri</a>, HERE, Garmin, USGS, OpenStreetMap contributors, GIS User Community'
                  url="https://services.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
                />
                <DrawingMapUi crosshair={drawingMode || aguadaPlacementMode} />
                <DrawingClicks
                  active={drawingMode}
                  onAddVertex={handleAddVertex}
                  onAttemptClosePolygon={handleAttemptClosePolygon}
                  onHover={setPreviewTip}
                />
                <AguadaPlacementClicks active={aguadaPlacementMode} onPlace={handlePlaceAguada} />

                {draftVertices.map((coords, idx) => (
                  <CircleMarker key={`draft-${idx}`} center={coords} radius={6}
                    pathOptions={{ color: "#24632f", weight: 2, fillColor: "#46a858", fillOpacity: 0.95, interactive: false }} />
                ))}
                {draftVertices.length >= 2 && (
                  <Polyline positions={draftVertices} pathOptions={draftPolylineStyle} />
                )}
                {hoverSegment && (
                  <Polyline positions={hoverSegment} pathOptions={draftDashStyle} />
                )}
                {pendingRing && pendingRing.length >= 3 && (
                  <>
                    {pendingRing.map((coords, idx) => (
                      <CircleMarker key={`pend-${idx}`} center={coords} radius={6}
                        pathOptions={{ color: "#24632f", weight: 2, fillColor: "#46a858", fillOpacity: 0.95, interactive: false }} />
                    ))}
                    <Polygon positions={pendingRing} pathOptions={{ ...potreroStyle, interactive: false }} />
                  </>
                )}
                {potreros.map((pot) => (
                  <Polygon
                    key={pot.id}
                    positions={pot.positions}
                    pathOptions={polygonStyleForNdvi(
                      ndviById[pot.id],
                      !(drawingMode || !!pendingRing || aguadaPlacementMode),
                    )}
                    eventHandlers={{
                      click: (e) => {
                        if (drawingMode || pendingRing || aguadaPlacementMode) return;
                        const ev = e.originalEvent;
                        if (ev) L.DomEvent.stopPropagation(ev);
                        setSelectedPotrero(pot);
                      },
                    }}
                  />
                ))}
                {potreros.map((pot) => {
                  const reco = recomendacionRotacion(
                    ndviById[pot.id],
                    motorByPotreroId[pot.id],
                  );
                  return (
                    <RotacionRecoMarker
                      key={`reco-${pot.id}`}
                      pot={pot}
                      reco={reco}
                      interactive={!(drawingMode || !!pendingRing || aguadaPlacementMode)}
                      onSelect={setSelectedPotrero}
                    />
                  );
                })}
                {aguadas.map((a) => (
                  <Marker
                    key={`ag-${a.id}`}
                    position={[Number(a.lat), Number(a.lng)]}
                    icon={aguadaMarkerIcon}
                    zIndexOffset={800}
                  >
                    <Popup>
                      <div style={{ minWidth: "140px" }}>
                        <div style={{ fontWeight: 800, color: "#1a3d5c", fontSize: "14px" }}>Aguada</div>
                        {a.label ? (
                          <p style={{ margin: "6px 0 0", fontSize: "13px", color: "#2a3f2f" }}>{a.label}</p>
                        ) : null}
                        <button
                          type="button"
                          style={styles.aguadaPopupBtn}
                          onClick={() => { void handleDeleteAguada(a.id); }}
                        >
                          Eliminar aguada
                        </button>
                      </div>
                    </Popup>
                  </Marker>
                ))}
              </MapContainer>
            </div>

            {(loadingCampos || loadingPotreros || loadingAguadas) && (
              <div style={styles.loadingBadge}>
                {loadingCampos
                  ? "Cargando establecimientos…"
                  : loadingPotreros
                    ? "Cargando potreros…"
                    : "Cargando aguadas…"}
              </div>
            )}

            {!pendingRing && selectedCampoId && (
              drawingMode && !aguadaPlacementMode ? (
                <button
                  type="button"
                  style={{ ...styles.floatingButtonCancel, ...floatingBottomStyle }}
                  onClick={cancelDrawing}
                >
                  Cancelar dibujo
                </button>
              ) : !selectedPotrero ? (
                aguadaPlacementMode ? (
                  <div style={{ ...styles.floatingStack, ...floatingBottomStyle }}>
                    <button
                      type="button"
                      style={styles.floatingStackCancel}
                      onClick={() => setAguadaPlacementMode(false)}
                    >
                      Listo (aguadas)
                    </button>
                  </div>
                ) : (
                  <div style={{ ...styles.floatingStack, ...floatingBottomStyle }}>
                    <button type="button" style={styles.floatingStackPrimary} onClick={startDrawing}>
                      + Agregar potrero
                    </button>
                  </div>
                )
              ) : null
            )}

            {drawingMode && !aguadaPlacementMode && (
              <p style={{ ...styles.drawHint, ...drawHintBottomStyle }}>
                Doble click para cerrar el potrero
              </p>
            )}
            {aguadaPlacementMode && (
              <p
                style={{
                  ...styles.drawHint,
                  ...drawHintAguadaBottomStyle,
                  backgroundColor: "rgba(232, 244, 255, 0.95)",
                  color: "#1a4a6e",
                }}
              >
                Tocá el mapa para colocar una aguada
              </p>
            )}

            {pendingRing && (
              <dialog open style={styles.nameDialogBackdrop}>
                <div style={styles.nameDialog}>
                  <h2 style={styles.nameDialogTitle}>Nuevo potrero</h2>
                  <p style={styles.nameDialogText}>Nombre y, si querés, tipo de pasto.</p>
                  <input
                    autoFocus
                    style={styles.nameDialogInput}
                    type="text"
                    value={nombreInput}
                    placeholder="Ej. Los Algarrobos"
                    onChange={(e) => setNombreInput(e.target.value)}
                  />
                  <label style={styles.nameDialogFieldLabel} htmlFor="nuevo-tipo-pasto">
                    Tipo de pasto (opcional)
                  </label>
                  <select
                    id="nuevo-tipo-pasto"
                    style={styles.nameDialogSelect}
                    value={tipoPastoNuevo}
                    onChange={(e) => setTipoPastoNuevo(e.target.value)}
                  >
                    <option value="">Sin especificar</option>
                    {TIPOS_PASTO_OPTIONS.map((o) => (
                      <option key={o.id} value={o.id}>{o.label}</option>
                    ))}
                  </select>
                  <div style={styles.nameDialogActions}>
                    <button type="button" style={styles.nameDialogSecondary}
                      onClick={handleCancelNombre} disabled={savingPotrero}>
                      Cancelar
                    </button>
                    <button
                      type="button"
                      style={{
                        ...styles.nameDialogPrimary,
                        opacity: nombreInput.trim().length === 0 || savingPotrero ? 0.45 : 1,
                        cursor: nombreInput.trim().length === 0 || savingPotrero ? "not-allowed" : "pointer",
                      }}
                      onClick={handleConfirmNombre}
                      disabled={nombreInput.trim().length === 0 || savingPotrero}
                    >
                      {savingPotrero ? "Guardando…" : "Guardar"}
                    </button>
                  </div>
                </div>
              </dialog>
            )}
          </div>
        </div>
      </section>

      {selectedPotrero && (
        <>
          <div
            role="presentation"
            style={{
              ...styles.sheetBackdrop,
              opacity: sheetEntered ? 1 : 0,
              pointerEvents: sheetEntered ? "auto" : "none",
              transition: "opacity 280ms ease-out",
            }}
            aria-hidden="true"
            onClick={closePotreroSheet}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-labelledby="potrero-sheet-title"
            style={{
              ...styles.sheetPanel,
              pointerEvents: sheetEntered ? "auto" : "none",
              transform: sheetEntered ? "translateY(0)" : "translateY(100%)",
              transition: "transform 300ms cubic-bezier(0.22, 1, 0.36, 1), box-shadow 300ms ease-out",
            }}
          >
            <div style={styles.sheetHeader}>
              <h2 id="potrero-sheet-title" style={styles.sheetTitle}>
                {selectedPotrero.name}
              </h2>
              <button type="button" style={styles.sheetClose} onClick={closePotreroSheet}
                aria-label="Cerrar panel del potrero">×</button>
            </div>

            <div style={styles.sheetTabsRow} role="tablist" aria-label="Panel del potrero">
              <button
                type="button"
                role="tab"
                aria-selected={sheetTab === "resumen"}
                style={{
                  ...styles.sheetTab,
                  ...(sheetTab === "resumen" ? styles.sheetTabActive : {}),
                }}
                onClick={() => setSheetTab("resumen")}
              >
                Resumen
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={sheetTab === "historial"}
                style={{
                  ...styles.sheetTab,
                  ...(sheetTab === "historial" ? styles.sheetTabActive : {}),
                }}
                onClick={() => setSheetTab("historial")}
              >
                Historial
              </button>
            </div>

            {sheetTab === "resumen" ? (
            <div style={styles.sheetCards}>
              <div style={styles.sheetCard}>
                <span style={styles.sheetCardLabel}>Estado NDVI</span>
                {!ndviEntry || ndviEntry.status === "loading" ? (
                  <div style={styles.sheetNdviLoading}>Consultando satélite…</div>
                ) : ndviEntry.status === "ok" ? (
                  <div>
                    <div
                      style={{
                        ...styles.sheetNdviBadgeBase,
                        ...(ndviEntry.tier === "low"
                          ? styles.sheetNdviBadgeLow
                          : ndviEntry.tier === "mid"
                            ? styles.sheetNdviBadgeMid
                            : styles.sheetNdviBadgeHigh),
                      }}
                    >
                      NDVI {ndviEntry.meanNdvi.toFixed(2)}
                      {ndviEntry.tier === "low"
                        ? " · Pasto escaso"
                        : ndviEntry.tier === "mid"
                          ? " · Pasto medio"
                          : " · Pasto abundante"}
                    </div>
                    {formatNdviWindowDate(ndviEntry.intervalTo) && (
                      <p style={styles.sheetNdviMeta}>
                        Última ventana de datos:{" "}
                        {formatNdviWindowDate(ndviEntry.intervalTo)}
                      </p>
                    )}
                  </div>
                ) : (
                  <div style={styles.sheetNdviPlaceholder}>
                    Sin datos de satélite
                  </div>
                )}
              </div>
              <div style={styles.sheetCard}>
                <span style={styles.sheetCardLabel}>Tipo de pasto</span>
                <div style={styles.sheetCardValueNeutral}>
                  {labelTipoPasto(selectedPotrero.tipoPasto) ?? "Sin especificar"}
                </div>
              </div>
              <div style={styles.sheetCard}>
                <span style={styles.sheetCardLabel}>Aguada asignada</span>
                <select
                  aria-label="Aguada asignada al potrero"
                  style={styles.sheetAguadaSelect}
                  value={selectedPotrero.aguadaId ?? ""}
                  onChange={(e) => { void handleAguadaAsignadaChange(e.target.value); }}
                >
                  <option value="">Sin aguada</option>
                  {aguadas.map((a) => (
                    <option key={a.id} value={a.id}>
                      {a.label?.trim()
                        ? a.label
                        : `Aguada (${Number(a.lat).toFixed(4)}, ${Number(a.lng).toFixed(4)})`}
                    </option>
                  ))}
                </select>
                {aguadas.length === 0 && (
                  <p style={{ ...styles.sheetRecoHint, marginTop: "8px" }}>
                    No hay aguadas en el mapa. Menú (☰) → “💧 Colocar aguadas” y tocá el mapa.
                  </p>
                )}
              </div>
              <div style={styles.sheetCard}>
                <span style={styles.sheetCardLabel}>Último evento</span>
                <div style={styles.sheetCardValueNeutral}>
                  {selectedPotrero.ultimoEvento ?? "Sin registros"}
                </div>
              </div>
              <div style={styles.sheetCard}>
                <span style={styles.sheetCardLabel}>Descanso</span>
                {motorSheet?.kind === "sin_datos" ? (
                  <div style={styles.sheetCardValueNeutral}>Sin movimientos registrados</div>
                ) : motorSheet?.kind === "en_uso" ? (
                  <div style={styles.sheetCardValueNeutral}>Con hacienda</div>
                ) : motorSheet?.kind === "descanso" && motorSheet.listo ? (
                  <div
                    style={{
                      ...styles.sheetRecoBadgeBase,
                      ...styles.sheetRecoBadgeListo,
                      marginTop: "4px",
                    }}
                  >
                    Listo para entrar
                  </div>
                ) : motorSheet?.kind === "descanso" ? (
                  <div style={styles.sheetCardValueNeutral}>{motorSheet.primaryLine}</div>
                ) : (
                  <div style={styles.sheetCardValueNeutral}>Sin movimientos registrados</div>
                )}
                <p style={{ ...styles.sheetRecoLluvia, marginTop: "10px" }}>
                  🌧️ {formatUltimaLluviaLine(selectedPotrero.ultimoLluvia)}
                  {" · "}
                  Últimos 30 d. en este potrero: {selectedPotrero.lluviaMm30d ?? 0} mm acum.
                </p>
              </div>
            </div>
            ) : (
            <div style={styles.historialList} role="tabpanel">
              {historialLoading && (
                <p style={styles.historialEmpty}>Cargando historial…</p>
              )}
              {historialError && !historialLoading && (
                <p style={styles.sheetError}>{historialError}</p>
              )}
              {!historialLoading && !historialError && historialRows.length === 0 && (
                <p style={styles.historialEmpty}>Todavía no hay eventos en este potrero.</p>
              )}
              {!historialLoading && !historialError && historialRows.map((ev) => {
                const tipoLabel = EVENTO_TIPOS.find((t) => t.id === ev.tipo)?.label ?? ev.tipo;
                return (
                  <div key={ev.id} style={styles.historialRow}>
                    <span style={styles.historialIcon} aria-hidden="true">
                      {eventoTipoHistorialIcon(ev.tipo)}
                    </span>
                    <div style={styles.historialMain}>
                      <div style={styles.historialTipo}>{tipoLabel}</div>
                      <div style={styles.historialFecha}>{formatEventoHistorialFecha(ev.fecha)}</div>
                      {ev.descripcion ? (
                        <div style={styles.historialDesc}>{ev.descripcion}</div>
                      ) : null}
                      {ev.tipo === "foto" && (
                        <div style={styles.historialFotoNote}>
                          Vista previa: se mostrará acá cuando conectemos Supabase Storage (bloque aparte).
                        </div>
                      )}
                    </div>
                  </div>
                );
              })}
            </div>
            )}

            {potreroSheetError && (
              <p style={styles.sheetError}>{potreroSheetError}</p>
            )}

            <div style={styles.sheetSecondaryRow}>
              <button
                type="button"
                style={styles.sheetEditBtn}
                onClick={() => {
                  setPotreroSheetError(null);
                  setEditNombreSheet(selectedPotrero.name);
                  const t = selectedPotrero.tipoPasto;
                  setEditTipoPastoSheet(isKnownTipoPastoId(t) ? t : "");
                  setShowEditNombreDialog(true);
                }}
              >
                Editar potrero
              </button>
              <button
                type="button"
                style={styles.sheetDeleteBtn}
                onClick={() => {
                  setPotreroSheetError(null);
                  setShowDeleteConfirm(true);
                }}
              >
                Eliminar potrero
              </button>
            </div>

            <button type="button" style={styles.sheetActionButton}
              onClick={() => setShowEventForm(true)}>
              Registrar evento
            </button>
          </aside>

          {showEditNombreDialog && (
            <div
              role="presentation"
              style={styles.sheetNestedDialogBackdrop}
              onClick={() => {
                if (!savingEditNombre) setShowEditNombreDialog(false);
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="edit-pot-title"
                style={styles.sheetNestedDialog}
                onClick={(e) => e.stopPropagation()}
              >
                <h3 id="edit-pot-title" style={styles.sheetNestedTitle}>Editar potrero</h3>
                <label style={styles.sheetNestedFieldLabel} htmlFor="edit-pot-nombre">Nombre</label>
                <input
                  id="edit-pot-nombre"
                  autoFocus
                  style={styles.sheetNestedInputTight}
                  type="text"
                  value={editNombreSheet}
                  onChange={(e) => setEditNombreSheet(e.target.value)}
                  placeholder="Nombre del potrero"
                />
                <label style={styles.sheetNestedFieldLabel} htmlFor="edit-tipo-pasto">
                  Tipo de pasto (opcional)
                </label>
                <select
                  id="edit-tipo-pasto"
                  style={styles.sheetNestedSelect}
                  value={editTipoPastoSheet}
                  onChange={(e) => setEditTipoPastoSheet(e.target.value)}
                >
                  <option value="">Sin especificar</option>
                  {TIPOS_PASTO_OPTIONS.map((o) => (
                    <option key={o.id} value={o.id}>{o.label}</option>
                  ))}
                </select>
                <div style={styles.sheetNestedActions}>
                  <button
                    type="button"
                    style={styles.sheetNestedSecondary}
                    onClick={() => setShowEditNombreDialog(false)}
                    disabled={savingEditNombre}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    style={{
                      ...styles.sheetNestedPrimary,
                      opacity: editNombreSheet.trim().length === 0 || savingEditNombre ? 0.45 : 1,
                      cursor: editNombreSheet.trim().length === 0 || savingEditNombre ? "not-allowed" : "pointer",
                    }}
                    onClick={handleConfirmEditNombrePotrero}
                    disabled={editNombreSheet.trim().length === 0 || savingEditNombre}
                  >
                    {savingEditNombre ? "Guardando…" : "Guardar"}
                  </button>
                </div>
              </div>
            </div>
          )}

          {showDeleteConfirm && (
            <div
              role="presentation"
              style={styles.sheetNestedDialogBackdrop}
              onClick={() => {
                if (!deletingPotrero) setShowDeleteConfirm(false);
              }}
            >
              <div
                role="dialog"
                aria-modal="true"
                aria-labelledby="delete-pot-title"
                style={styles.sheetNestedDialog}
                onClick={(e) => e.stopPropagation()}
              >
                <h3 id="delete-pot-title" style={styles.sheetNestedTitle}>¿Eliminar potrero?</h3>
                <p style={styles.sheetDeleteText}>
                  Se va a borrar <strong>{selectedPotrero.name}</strong> y{" "}
                  <strong>todos sus eventos</strong>. Esta acción no se puede deshacer.
                </p>
                <div style={styles.sheetNestedActions}>
                  <button
                    type="button"
                    style={styles.sheetNestedSecondary}
                    onClick={() => setShowDeleteConfirm(false)}
                    disabled={deletingPotrero}
                  >
                    Cancelar
                  </button>
                  <button
                    type="button"
                    style={styles.sheetDeleteConfirmBtn}
                    onClick={handleConfirmDeletePotrero}
                    disabled={deletingPotrero}
                  >
                    {deletingPotrero ? "Eliminando…" : "Eliminar"}
                  </button>
                </div>
              </div>
            </div>
          )}
        </>
      )}

      {showEventForm && (
        <EventoForm
          onSave={handleSaveEvento}
          onClose={() => setShowEventForm(false)}
          saving={savingEvento}
        />
      )}

      <PlanificarRotacionModal
        open={showRotacionModal}
        onClose={() => setShowRotacionModal(false)}
        potreros={potreros}
        ndviById={ndviById}
      />

      <PrimerCampoModal
        open={campoModalAbierto}
        variant={campoModalVariant}
        editingCampo={editingCampoFila}
        onClose={isPrimerCampoBloqueo ? undefined : closeCampoAuxModal}
        onPreviewLocation={(lat, lng, zoom) => {
          setMapCenter([lat, lng]);
          setMapZoom(zoom);
        }}
        onCreated={(row) => {
          setCampos((prev) => [...prev, row]);
          setSelectedCampoId(row.id);
        }}
        onUpdated={(row) => {
          setCampos((prev) => prev.map((c) => (c.id === row.id ? row : c)));
          setMapCenter([Number(row.lat), Number(row.lng)]);
          setMapZoom(Number(row.zoom) || 14);
        }}
        fallbackMapCenter={mapCenter}
        fallbackMapZoom={mapZoom}
      />
    </main>
  );
}

function App() {
  const [session, setSession] = useState(null);
  const [loadingSession, setLoadingSession] = useState(true);

  useEffect(() => {
    supabase.auth.getSession().then(({ data: { session } }) => {
      setSession(session);
      setLoadingSession(false);
    });

    const { data: { subscription } } = supabase.auth.onAuthStateChange(
      (_event, session) => {
        setSession(session);
      }
    );

    return () => subscription.unsubscribe();
  }, []);

  const handleLogout = async () => {
    await supabase.auth.signOut();
  };

  if (loadingSession) return null;
  if (!session) return <LoginScreen />;
  return <MapaPotrero onLogout={handleLogout} />;
}

const styles = {
  page: {
    minHeight: "100vh",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "20px 16px",
    background: "linear-gradient(180deg, #eef4ea 0%, #dde8d7 100%)",
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    boxSizing: "border-box",
  },
  card: {
    width: "100%",
    maxWidth: "360px",
    backgroundColor: "#ffffff",
    borderRadius: "18px",
    padding: "28px 20px 24px",
    boxShadow: "0 10px 28px rgba(47, 84, 42, 0.16)",
    border: "1px solid #dce7d6",
  },
  brand: { display: "flex", flexDirection: "column", alignItems: "center", marginBottom: "22px" },
  logo: {
    width: "62px", height: "62px", borderRadius: "50%", backgroundColor: "#2f6a3a",
    display: "flex", alignItems: "center", justifyContent: "center",
    boxShadow: "0 8px 16px rgba(47, 106, 58, 0.28)", marginBottom: "10px",
  },
  logoLeaf: { fontSize: "28px" },
  title: { margin: 0, fontSize: "30px", color: "#244d2f", letterSpacing: "0.5px" },
  form: { display: "flex", flexDirection: "column", gap: "10px" },
  label: { fontSize: "14px", fontWeight: 600, color: "#355c3b" },
  input: {
    height: "44px", borderRadius: "12px", border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5", padding: "0 12px", fontSize: "15px",
    outline: "none", color: "#2a3f2f", marginBottom: "2px",
  },
  button: {
    marginTop: "8px", height: "46px", borderRadius: "12px", border: "none",
    backgroundColor: "#3d7f49", color: "#ffffff", fontSize: "16px", fontWeight: 700, cursor: "pointer",
  },
  buttonSecondary: {
    height: "46px", borderRadius: "12px", border: "1px solid #cddcc8",
    backgroundColor: "#f3f8f0", color: "#355c3b", fontSize: "16px", fontWeight: 600, cursor: "pointer",
  },
  loginMessage: {
    margin: "4px 0 0", fontSize: "13px", fontWeight: 500, lineHeight: 1.4,
  },
  mapPage: {
    boxSizing: "border-box", width: "100%", height: "100vh", minHeight: "100vh",
    background: "linear-gradient(180deg, #eef4ea 0%, #dde8d7 100%)",
    fontFamily: "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif",
    paddingLeft: "12px", paddingRight: "12px",
    paddingTop: "max(12px, env(safe-area-inset-top))",
    paddingBottom: "env(safe-area-inset-bottom, 0px)",
    display: "flex", flexDirection: "column", gap: "8px", overflow: "hidden",
  },
  topBar: {
    flexShrink: 0, height: "58px", backgroundColor: "#ffffff", backgroundImage: "none",
    border: "none", borderRadius: "14px", padding: "0 12px",
    display: "flex", alignItems: "center", gap: "10px",
    boxShadow: "0 2px 8px rgba(0, 0, 0, 0.06)", WebkitTapHighlightColor: "transparent",
  },
  topBarCompact: {
    height: "auto",
    minHeight: "52px",
    flexDirection: "column",
    alignItems: "stretch",
    paddingTop: "8px",
    paddingBottom: "8px",
    gap: "8px",
  },
  topBarMobileRow1: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    width: "100%",
    minHeight: "40px",
    gap: "8px",
  },
  topBarActionsIcons: {
    display: "flex",
    alignItems: "center",
    gap: "4px",
    flexShrink: 0,
  },
  topCampoFullRow: {
    width: "100%",
    minWidth: 0,
  },
  headerIconBtn: {
    width: "40px",
    height: "40px",
    borderRadius: "10px",
    border: "1px solid #cde5d2",
    backgroundColor: "#eaf4eb",
    color: "#1f3d28",
    fontSize: "18px",
    lineHeight: 1,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    WebkitTapHighlightColor: "transparent",
  },
  topCampoRow: {
    flex: "1 1 auto",
    minWidth: 0,
    display: "flex",
    alignItems: "center",
    gap: "8px",
    maxWidth: "min(440px, 58vw)",
  },
  topCampoSelectWrap: {
    flex: "1 1 auto",
    minWidth: 0,
  },
  topCampoGear: {
    flexShrink: 0,
    width: "38px",
    height: "38px",
    borderRadius: "10px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5",
    fontSize: "18px",
    lineHeight: 1,
    cursor: "pointer",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: 0,
    WebkitTapHighlightColor: "transparent",
  },
  topCampoGearDisabled: {
    opacity: 0.45,
    cursor: "not-allowed",
  },
  topCampoNuevoBtn: {
    flexShrink: 0,
    height: "38px",
    padding: "0 10px",
    borderRadius: "10px",
    border: "1px solid #cde5d2",
    backgroundColor: "#eaf4eb",
    color: "#1f3d28",
    fontSize: "12px",
    fontWeight: 800,
    cursor: "pointer",
    whiteSpace: "nowrap",
    WebkitTapHighlightColor: "transparent",
  },
  campoSelect: {
    width: "100%",
    height: "38px",
    borderRadius: "10px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5",
    padding: "0 10px",
    fontSize: "14px",
    fontWeight: 700,
    color: "#1f3d28",
    outline: "none",
  },
  mapSearchSection: {
    flexShrink: 0,
    backgroundColor: "#ffffff",
    borderRadius: "14px",
    padding: "10px 12px",
    border: "1px solid #dce7d6",
    boxShadow: "0 2px 10px rgba(47, 84, 42, 0.08)",
  },
  mapSearchLabel: {
    display: "block",
    fontSize: "12px",
    fontWeight: 700,
    color: "#355c3b",
    marginBottom: "6px",
  },
  mapSearchRow: {
    display: "flex",
    gap: "8px",
    alignItems: "center",
  },
  mapSearchInput: {
    flex: "1 1 auto",
    minWidth: 0,
    height: "42px",
    borderRadius: "12px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5",
    padding: "0 12px",
    fontSize: "15px",
    outline: "none",
    color: "#2a3f2f",
    boxSizing: "border-box",
  },
  mapSearchBtn: {
    flexShrink: 0,
    height: "42px",
    padding: "0 16px",
    borderRadius: "12px",
    border: "none",
    backgroundColor: "#3d7f49",
    color: "#ffffff",
    fontSize: "14px",
    fontWeight: 800,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  mapSearchError: {
    margin: "8px 0 0",
    fontSize: "12px",
    fontWeight: 600,
    color: "#b94040",
  },
  primerCampoBackdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 3200,
    backgroundColor: "rgba(18, 32, 24, 0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
    boxSizing: "border-box",
  },
  primerCampoDialog: {
    width: "100%",
    maxWidth: "400px",
    backgroundColor: "#ffffff",
    borderRadius: "20px",
    padding: "22px 18px 18px",
    boxShadow: "0 16px 48px rgba(24, 48, 32, 0.28)",
    border: "1px solid #dce7d6",
    boxSizing: "border-box",
  },
  primerCampoTitle: {
    margin: "0 0 8px",
    fontSize: "22px",
    fontWeight: 800,
    color: "#1f3d28",
  },
  primerCampoLead: {
    margin: "0 0 16px",
    fontSize: "13px",
    fontWeight: 600,
    color: "#4a6652",
    lineHeight: 1.45,
  },
  primerCampoLabel: {
    display: "block",
    fontSize: "13px",
    fontWeight: 700,
    color: "#355c3b",
    marginBottom: "6px",
  },
  primerCampoInput: {
    width: "100%",
    boxSizing: "border-box",
    height: "46px",
    borderRadius: "12px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5",
    padding: "0 12px",
    fontSize: "16px",
    outline: "none",
    color: "#2a3f2f",
  },
  primerCampoCoords: {
    margin: "10px 0 0",
    fontSize: "12px",
    fontWeight: 600,
    color: "#2f6a3a",
    lineHeight: 1.35,
  },
  primerCampoHint: {
    margin: "10px 0 0",
    fontSize: "12px",
    fontWeight: 600,
    color: "#7a8a76",
    lineHeight: 1.35,
  },
  primerCampoError: {
    margin: "12px 0 0",
    fontSize: "13px",
    fontWeight: 600,
    color: "#b94040",
  },
  primerCampoPrimary: {
    marginTop: "18px",
    width: "100%",
    height: "48px",
    borderRadius: "14px",
    border: "none",
    backgroundColor: "#3d7f49",
    color: "#ffffff",
    fontSize: "16px",
    fontWeight: 800,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  primerCampoCancel: {
    width: "100%",
    height: "44px",
    borderRadius: "12px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f3f8f0",
    color: "#355c3b",
    fontSize: "15px",
    fontWeight: 700,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  topBrand: { display: "flex", alignItems: "center", gap: "8px" },
  topLogo: {
    width: "34px", height: "34px", borderRadius: "50%", backgroundColor: "#2f6a3a",
    color: "#ffffff", display: "flex", alignItems: "center", justifyContent: "center", fontSize: "18px",
  },
  topTitle: { color: "#244d2f", fontSize: "21px", letterSpacing: "0.3px" },
  topBarActions: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    flexShrink: 0,
  },
  rotacionHeaderBtn: {
    height: "38px",
    padding: "0 12px",
    borderRadius: "10px",
    border: "1px solid #cde5d2",
    backgroundColor: "#eaf4eb",
    color: "#1f3d28",
    fontSize: "13px",
    fontWeight: 800,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  menuButton: {
    width: "38px", height: "38px", borderRadius: "10px", border: "1px solid #eeeeee",
    backgroundColor: "#ffffff", color: "#2f6a3a", fontSize: "20px", lineHeight: 1, cursor: "pointer",
  },
  menuOverlay: {
    position: "fixed", inset: 0, zIndex: 2999,
  },
  menuDropdown: {
    position: "absolute", right: 0, top: "calc(100% + 6px)", zIndex: 3000,
    backgroundColor: "#ffffff", borderRadius: "12px", border: "1px solid #e0e8da",
    boxShadow: "0 8px 24px rgba(47, 84, 42, 0.14)", minWidth: "160px", overflow: "hidden",
  },
  menuDropdownItem: {
    display: "block", width: "100%", padding: "12px 16px", border: "none",
    backgroundColor: "transparent", textAlign: "left",
    fontSize: "14px", fontWeight: 600, color: "#2a3f2f", cursor: "pointer",
  },
  rotacionBackdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 3100,
    backgroundColor: "rgba(18, 32, 24, 0.48)",
    display: "flex",
    alignItems: "flex-end",
    justifyContent: "center",
    padding: "12px",
    paddingBottom: "max(12px, env(safe-area-inset-bottom))",
    boxSizing: "border-box",
  },
  rotacionDialog: {
    width: "100%",
    maxWidth: "520px",
    maxHeight: "88vh",
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
    backgroundColor: "#ffffff",
    borderRadius: "20px",
    padding: "16px 16px 14px",
    boxSizing: "border-box",
    boxShadow: "0 -8px 40px rgba(24, 48, 32, 0.22)",
    border: "1px solid #dce7d6",
  },
  rotacionHeader: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "10px",
    marginBottom: "8px",
  },
  rotacionTitle: {
    margin: 0,
    fontSize: "20px",
    fontWeight: 800,
    color: "#1f3d28",
  },
  rotacionClose: {
    width: "36px",
    height: "36px",
    borderRadius: "10px",
    border: "1px solid #eeeeee",
    backgroundColor: "#ffffff",
    color: "#355c3b",
    fontSize: "22px",
    lineHeight: 1,
    cursor: "pointer",
    flexShrink: 0,
  },
  rotacionLead: {
    margin: "0 0 14px",
    fontSize: "13px",
    fontWeight: 600,
    color: "#4a6652",
    lineHeight: 1.45,
  },
  rotacionLabel: {
    display: "block",
    fontSize: "13px",
    fontWeight: 700,
    color: "#355c3b",
    marginBottom: "6px",
  },
  rotacionInput: {
    width: "100%",
    boxSizing: "border-box",
    height: "46px",
    borderRadius: "12px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5",
    padding: "0 12px",
    fontSize: "16px",
    outline: "none",
    color: "#2a3f2f",
  },
  rotacionSelect: {
    width: "100%",
    boxSizing: "border-box",
    height: "46px",
    borderRadius: "12px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5",
    padding: "0 10px",
    fontSize: "15px",
    fontWeight: 600,
    color: "#2a3f2f",
  },
  rotacionHint: {
    margin: "14px 0 0",
    fontSize: "14px",
    fontWeight: 600,
    color: "#5a7058",
  },
  rotacionSubTitle: {
    margin: "18px 0 10px",
    fontSize: "15px",
    fontWeight: 800,
    color: "#244d2f",
  },
  rotacionList: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
  },
  rotacionRow: {
    borderRadius: "12px",
    border: "1px solid #e8eee4",
    padding: "10px 12px",
    backgroundColor: "#fbfcfa",
  },
  rotacionRowMuted: {
    opacity: 0.72,
    backgroundColor: "#f5f5f5",
  },
  rotacionRowTop: {
    display: "flex",
    alignItems: "center",
    gap: "8px",
    marginBottom: "6px",
  },
  rotacionRank: {
    flexShrink: 0,
    fontSize: "13px",
    fontWeight: 800,
    color: "#3d7f49",
    minWidth: "28px",
  },
  rotacionNombre: {
    flex: "1 1 auto",
    fontSize: "15px",
    fontWeight: 800,
    color: "#1f3d28",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  rotacionDuracion: {
    flexShrink: 0,
    fontSize: "14px",
    fontWeight: 800,
    color: "#2f6a3a",
  },
  rotacionRowMeta: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px 12px",
    fontSize: "12px",
    fontWeight: 600,
    color: "#5a7058",
  },
  rotacionWarnAguada: {
    flex: "1 0 100%",
    fontSize: "12px",
    fontWeight: 800,
    color: "#9a5c1a",
  },
  rotacionDisclaimer: {
    margin: "14px 0 0",
    fontSize: "11px",
    fontWeight: 600,
    color: "#7a8a76",
    lineHeight: 1.45,
  },
  listosBanner: {
    flexShrink: 0,
    display: "flex",
    flexWrap: "wrap",
    alignItems: "center",
    gap: "10px 12px",
    padding: "10px 12px",
    borderRadius: "14px",
    border: "1px solid #e8c98a",
    backgroundColor: "#fff8e6",
    boxShadow: "0 2px 10px rgba(120, 90, 20, 0.08)",
  },
  listosBannerText: {
    margin: 0,
    flex: "1 1 200px",
    fontSize: "14px",
    fontWeight: 700,
    color: "#5c4010",
    lineHeight: 1.35,
  },
  listosBannerActions: {
    display: "flex",
    flexWrap: "wrap",
    gap: "8px",
    flexShrink: 0,
  },
  listosBannerBtn: {
    height: "36px",
    padding: "0 14px",
    borderRadius: "10px",
    border: "1px solid #d4a85c",
    backgroundColor: "#ffffff",
    color: "#5c4010",
    fontSize: "13px",
    fontWeight: 700,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  listosBannerDismiss: {
    height: "36px",
    padding: "0 12px",
    borderRadius: "10px",
    border: "none",
    backgroundColor: "transparent",
    color: "#7a6230",
    fontSize: "13px",
    fontWeight: 700,
    cursor: "pointer",
    textDecoration: "underline",
    WebkitTapHighlightColor: "transparent",
  },
  listosSection: {
    flexShrink: 0,
    backgroundColor: "#ffffff",
    borderRadius: "14px",
    padding: "10px 12px 12px",
    border: "1px solid #dce7d6",
    boxShadow: "0 2px 10px rgba(47, 84, 42, 0.08)",
  },
  listosHeaderRow: {
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    gap: "8px",
    marginBottom: "8px",
  },
  listosTitle: {
    margin: 0,
    fontSize: "16px",
    fontWeight: 700,
    color: "#1f3d28",
  },
  listosBadge: {
    flexShrink: 0,
    fontSize: "11px",
    fontWeight: 700,
    color: "#2f6a3a",
    backgroundColor: "#eaf4eb",
    padding: "4px 8px",
    borderRadius: "999px",
    border: "1px solid #cde5d2",
  },
  listosEmpty: {
    margin: 0,
    fontSize: "13px",
    fontWeight: 600,
    color: "#5a7058",
    lineHeight: 1.35,
  },
  listosScroll: {
    display: "flex",
    flexWrap: "nowrap",
    gap: "8px",
    overflowX: "auto",
    WebkitOverflowScrolling: "touch",
    paddingBottom: "2px",
  },
  listosChip: {
    flex: "0 0 auto",
    display: "flex",
    flexDirection: "column",
    alignItems: "flex-start",
    gap: "2px",
    padding: "8px 12px",
    borderRadius: "12px",
    border: "1px solid #cde5d2",
    backgroundColor: "#f7faf5",
    cursor: "pointer",
    textAlign: "left",
    minWidth: "120px",
    WebkitTapHighlightColor: "transparent",
  },
  listosChipName: {
    fontSize: "14px",
    fontWeight: 700,
    color: "#1f3d28",
    maxWidth: "200px",
    overflow: "hidden",
    textOverflow: "ellipsis",
    whiteSpace: "nowrap",
  },
  listosChipDays: {
    fontSize: "12px",
    fontWeight: 700,
    color: "#3d7f49",
  },
  mapStack: { flex: "1 1 auto", minHeight: 0, display: "flex", flexDirection: "column", overflow: "hidden" },
  mapStage: { flex: "1 1 auto", minHeight: 0, height: "100%", position: "relative", display: "flex", flexDirection: "column" },
  mapInner: {
    flex: "1 1 auto", minHeight: 0, height: "100%", width: "100%", position: "relative",
    display: "flex", flexDirection: "column", borderRadius: "16px", overflow: "hidden",
    border: "1px solid #dce7d6", boxShadow: "0 10px 22px rgba(47, 84, 42, 0.12)",
  },
  mapGrow: { flex: "1 1 auto", minHeight: 0, minWidth: 0, width: "100%", position: "relative" },
  map: { width: "100%", height: "100%", minHeight: 0, zIndex: 0 },
  loadingBadge: {
    position: "absolute", top: "12px", left: "50%", transform: "translateX(-50%)",
    padding: "6px 14px", borderRadius: "999px",
    backgroundColor: "rgba(244, 250, 240, 0.94)", color: "#2a3f2f",
    fontSize: "13px", fontWeight: 600, zIndex: 1000, pointerEvents: "none",
    boxShadow: "0 4px 12px rgba(47, 84, 42, 0.12)",
  },
  floatingButton: {
    position: "absolute", left: "50%", bottom: "calc(14px + env(safe-area-inset-bottom, 0px))",
    transform: "translateX(-50%)", minWidth: "230px", height: "48px", borderRadius: "999px",
    border: "none", backgroundColor: "#3d7f49", color: "#ffffff", fontSize: "16px", fontWeight: 700,
    boxShadow: "0 12px 22px rgba(45, 88, 40, 0.35)", cursor: "pointer", zIndex: 10050, pointerEvents: "auto",
  },
  floatingButtonCancel: {
    position: "absolute", left: "50%", bottom: "calc(14px + env(safe-area-inset-bottom, 0px))",
    transform: "translateX(-50%)", minWidth: "230px", height: "48px", borderRadius: "999px",
    border: "none", backgroundColor: "#5f4b32", color: "#ffffff", fontSize: "16px", fontWeight: 700,
    boxShadow: "0 12px 22px rgba(45, 88, 40, 0.35)", cursor: "pointer", zIndex: 10050, pointerEvents: "auto",
  },
  floatingStack: {
    position: "absolute",
    left: "50%",
    bottom: "calc(14px + env(safe-area-inset-bottom, 0px))",
    transform: "translateX(-50%)",
    display: "flex",
    flexDirection: "column",
    gap: "10px",
    width: "min(280px, 92vw)",
    zIndex: 10050,
    alignItems: "stretch",
  },
  floatingStackPrimary: {
    height: "48px",
    borderRadius: "999px",
    border: "none",
    backgroundColor: "#3d7f49",
    color: "#ffffff",
    fontSize: "16px",
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 12px 22px rgba(45, 88, 40, 0.35)",
    WebkitTapHighlightColor: "transparent",
  },
  floatingStackCancel: {
    height: "48px",
    borderRadius: "999px",
    border: "none",
    backgroundColor: "#5f4b32",
    color: "#ffffff",
    fontSize: "16px",
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 12px 22px rgba(45, 88, 40, 0.35)",
    WebkitTapHighlightColor: "transparent",
  },
  drawHint: {
    position: "absolute", left: "50%", bottom: "calc(72px + env(safe-area-inset-bottom, 0px))",
    transform: "translateX(-50%)", margin: 0, padding: "6px 12px", borderRadius: "999px",
    backgroundColor: "rgba(244, 250, 240, 0.92)", color: "#2a3f2f", fontSize: "13px", fontWeight: 600,
    boxShadow: "0 8px 16px rgba(47, 84, 42, 0.12)", zIndex: 10040, pointerEvents: "none", whiteSpace: "nowrap",
  },
  nameDialogBackdrop: {
    position: "fixed", inset: 0, border: "none", padding: "16px", margin: 0,
    backgroundColor: "rgba(28, 40, 32, 0.45)", zIndex: 2000,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  nameDialog: {
    width: "100%", maxWidth: "360px", backgroundColor: "#ffffff", borderRadius: "18px",
    padding: "20px", border: "1px solid #dce7d6",
    boxShadow: "0 16px 32px rgba(47, 84, 42, 0.2)", boxSizing: "border-box",
  },
  nameDialogTitle: { margin: "0 0 8px", fontSize: "20px", color: "#244d2f" },
  nameDialogText: { margin: "0 0 14px", fontSize: "14px", color: "#4a6652" },
  nameDialogInput: {
    width: "100%", boxSizing: "border-box", height: "44px", borderRadius: "12px",
    border: "1px solid #cddcc8", backgroundColor: "#f7faf5", padding: "0 12px",
    fontSize: "15px", marginBottom: "10px",
  },
  nameDialogFieldLabel: {
    display: "block",
    fontSize: "12px",
    fontWeight: 700,
    color: "#4a6652",
    marginBottom: "6px",
  },
  nameDialogSelect: {
    width: "100%",
    boxSizing: "border-box",
    height: "44px",
    borderRadius: "12px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5",
    padding: "0 10px",
    fontSize: "15px",
    fontWeight: 600,
    color: "#2a3f2f",
    marginBottom: "16px",
    outline: "none",
  },
  nameDialogActions: { display: "flex", gap: "10px", justifyContent: "flex-end" },
  nameDialogSecondary: {
    flex: "0 1 auto", height: "40px", padding: "0 16px", borderRadius: "10px",
    border: "1px solid #cddcc8", backgroundColor: "#f3f8f0", color: "#355c3b", fontWeight: 600, cursor: "pointer",
  },
  nameDialogPrimary: {
    flex: "0 1 auto", height: "40px", padding: "0 16px", borderRadius: "10px",
    border: "none", backgroundColor: "#3d7f49", color: "#ffffff", fontWeight: 700, cursor: "pointer", opacity: 1,
  },
  sheetBackdrop: {
    position: "fixed", inset: 0, zIndex: 2100, backgroundColor: "rgba(18, 32, 24, 0.35)",
  },
  sheetPanel: {
    position: "fixed", left: 0, right: 0, bottom: 0, zIndex: 2200,
    boxSizing: "border-box", width: "100%", maxHeight: "62vh", backgroundColor: "#ffffff",
    borderTopLeftRadius: "24px", borderTopRightRadius: "24px",
    padding: "8px 14px calc(10px + env(safe-area-inset-bottom, 0px))",
    border: "none", boxShadow: "0 -8px 40px rgba(24, 48, 32, 0.15)",
    display: "flex", flexDirection: "column", gap: "8px", overflow: "hidden",
  },
  sheetHeader: {
    display: "flex", alignItems: "flex-start", justifyContent: "space-between",
    gap: "8px", paddingTop: 0, flexShrink: 0,
  },
  sheetTitle: {
    margin: 0, flex: 1, fontSize: "24px", fontWeight: 600, lineHeight: 1.2,
    color: "#1f3d28", letterSpacing: "0.2px", paddingRight: "4px",
  },
  sheetClose: {
    flexShrink: 0, width: "36px", height: "36px", borderRadius: "10px",
    border: "1px solid #eeeeee", backgroundColor: "#ffffff", color: "#355c3b",
    fontSize: "22px", lineHeight: 1, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 0,
  },
  sheetTabsRow: {
    display: "flex",
    gap: "8px",
    flexShrink: 0,
    paddingBottom: "6px",
    borderBottom: "1px solid #edf2ec",
  },
  sheetTab: {
    flex: 1,
    height: "40px",
    borderRadius: "10px",
    border: "1px solid #dce7d6",
    backgroundColor: "#f7faf5",
    color: "#4a6652",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  sheetTabActive: {
    borderColor: "#3d7f49",
    backgroundColor: "#eaf4eb",
    color: "#1f3d28",
  },
  sheetCards: {
    display: "flex",
    flexDirection: "column",
    gap: "6px",
    flex: "1 1 auto",
    minHeight: 0,
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
  },
  sheetCard: {
    backgroundColor: "#ffffff", borderRadius: "12px", border: "1px solid #eeeeee",
    padding: "8px 10px", boxShadow: "none",
  },
  sheetCardLabel: {
    display: "block", fontSize: "12px", fontWeight: 700, color: "#4a6652",
    marginBottom: "4px", letterSpacing: "0.2px",
  },
  sheetNdviLoading: {
    fontSize: "14px", fontWeight: 600, color: "#5a7058",
  },
  sheetNdviBadgeBase: {
    display: "inline-block", fontSize: "13px", fontWeight: 800,
    borderRadius: "8px", padding: "6px 10px", lineHeight: 1.35,
  },
  sheetNdviBadgeLow: {
    color: "#6b1f1f", backgroundColor: "#ffd4d4", border: "1px solid #e8a0a0",
  },
  sheetNdviBadgeMid: {
    color: "#5c4800", backgroundColor: "#fff3b0", border: "1px solid #f5e08a",
  },
  sheetNdviBadgeHigh: {
    color: "#143d1c", backgroundColor: "#c8f0cf", border: "1px solid #7ecf8c",
  },
  sheetNdviMeta: {
    margin: "6px 0 0", fontSize: "12px", fontWeight: 600, color: "#5a7058",
  },
  sheetNdviPlaceholder: {
    fontSize: "14px", fontWeight: 700, color: "#6d7d6a",
  },
  sheetCardValueNeutral: { fontSize: "14px", fontWeight: 700, color: "#2a3f2f", lineHeight: 1.25 },
  sheetDescansoHint: {
    margin: "4px 0 0",
    fontSize: "12px",
    fontWeight: 600,
    color: "#5a7058",
    lineHeight: 1.3,
  },
  sheetRecoBadgeBase: {
    display: "inline-block",
    fontSize: "14px",
    fontWeight: 800,
    borderRadius: "10px",
    padding: "8px 12px",
    lineHeight: 1.3,
    marginTop: "2px",
  },
  sheetRecoBadgeListo: {
    color: "#143d1c",
    backgroundColor: "#c8f0cf",
    border: "1px solid #7ecf8c",
  },
  sheetRecoBadgeCasi: {
    color: "#5c4800",
    backgroundColor: "#fff3b0",
    border: "1px solid #f5e08a",
  },
  sheetRecoBadgeRecup: {
    color: "#6b1f1f",
    backgroundColor: "#ffd4d4",
    border: "1px solid #e8a0a0",
  },
  sheetRecoHint: {
    margin: "6px 0 0",
    fontSize: "12px",
    fontWeight: 600,
    color: "#5a7058",
    lineHeight: 1.35,
  },
  sheetRecoLluvia: {
    margin: "8px 0 0",
    fontSize: "12px",
    fontWeight: 600,
    color: "#3d5c44",
    lineHeight: 1.35,
  },
  sheetAguadaSelect: {
    width: "100%",
    minHeight: "44px",
    borderRadius: "12px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5",
    padding: "0 10px",
    fontSize: "15px",
    fontWeight: 600,
    color: "#2a3f2f",
    outline: "none",
    boxSizing: "border-box",
  },
  historialList: {
    display: "flex",
    flexDirection: "column",
    gap: "8px",
    flex: "1 1 auto",
    minHeight: 0,
    overflowY: "auto",
    WebkitOverflowScrolling: "touch",
    paddingBottom: "4px",
  },
  historialRow: {
    display: "flex",
    gap: "10px",
    alignItems: "flex-start",
    padding: "10px 10px",
    borderRadius: "12px",
    border: "1px solid #edf0ea",
    backgroundColor: "#fbfcfa",
  },
  historialIcon: {
    fontSize: "22px",
    lineHeight: 1,
    flexShrink: 0,
  },
  historialMain: {
    flex: "1 1 auto",
    minWidth: 0,
  },
  historialTipo: {
    fontSize: "11px",
    fontWeight: 800,
    color: "#5a7058",
    textTransform: "uppercase",
    letterSpacing: "0.04em",
  },
  historialFecha: {
    fontSize: "12px",
    fontWeight: 600,
    color: "#7a8a76",
    marginTop: "2px",
  },
  historialDesc: {
    fontSize: "14px",
    fontWeight: 600,
    color: "#1f3d28",
    marginTop: "6px",
    lineHeight: 1.35,
  },
  historialFotoNote: {
    fontSize: "12px",
    fontWeight: 600,
    color: "#9a7030",
    marginTop: "8px",
    fontStyle: "italic",
  },
  historialEmpty: {
    margin: 0,
    padding: "12px 4px",
    fontSize: "14px",
    fontWeight: 600,
    color: "#5a7058",
    textAlign: "center",
  },
  aguadaPopupBtn: {
    marginTop: "8px",
    width: "100%",
    height: "36px",
    borderRadius: "8px",
    border: "1px solid #c8d8e8",
    backgroundColor: "#fff5f5",
    color: "#8b2f2f",
    fontSize: "13px",
    fontWeight: 700,
    cursor: "pointer",
  },
  sheetError: {
    margin: 0,
    fontSize: "13px",
    fontWeight: 600,
    color: "#b94040",
    lineHeight: 1.35,
    flexShrink: 0,
  },
  sheetSecondaryRow: {
    display: "flex",
    gap: "8px",
    flexShrink: 0,
    marginTop: "4px",
  },
  sheetEditBtn: {
    flex: 1,
    height: "42px",
    borderRadius: "12px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f3f8f0",
    color: "#355c3b",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  sheetDeleteBtn: {
    flex: 1,
    height: "42px",
    borderRadius: "12px",
    border: "1px solid #e8a0a0",
    backgroundColor: "#fff0f0",
    color: "#8b2f2f",
    fontSize: "14px",
    fontWeight: 700,
    cursor: "pointer",
    WebkitTapHighlightColor: "transparent",
  },
  sheetNestedDialogBackdrop: {
    position: "fixed",
    inset: 0,
    zIndex: 2300,
    backgroundColor: "rgba(28, 40, 32, 0.55)",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    padding: "16px",
    boxSizing: "border-box",
  },
  sheetNestedDialog: {
    width: "100%",
    maxWidth: "360px",
    backgroundColor: "#ffffff",
    borderRadius: "18px",
    padding: "18px",
    border: "1px solid #dce7d6",
    boxShadow: "0 16px 32px rgba(47, 84, 42, 0.22)",
    boxSizing: "border-box",
  },
  sheetNestedTitle: {
    margin: "0 0 12px",
    fontSize: "18px",
    fontWeight: 800,
    color: "#1f3d28",
  },
  sheetNestedInput: {
    width: "100%",
    boxSizing: "border-box",
    height: "44px",
    borderRadius: "12px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5",
    padding: "0 12px",
    fontSize: "15px",
    marginBottom: "16px",
  },
  sheetNestedInputTight: {
    width: "100%",
    boxSizing: "border-box",
    height: "44px",
    borderRadius: "12px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5",
    padding: "0 12px",
    fontSize: "15px",
    marginBottom: "10px",
  },
  sheetNestedFieldLabel: {
    display: "block",
    fontSize: "12px",
    fontWeight: 700,
    color: "#4a6652",
    marginBottom: "6px",
  },
  sheetNestedSelect: {
    width: "100%",
    boxSizing: "border-box",
    height: "44px",
    borderRadius: "12px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5",
    padding: "0 10px",
    fontSize: "15px",
    fontWeight: 600,
    color: "#2a3f2f",
    marginBottom: "16px",
    outline: "none",
  },
  sheetNestedActions: {
    display: "flex",
    gap: "10px",
    justifyContent: "flex-end",
  },
  sheetNestedSecondary: {
    flex: "0 1 auto",
    height: "40px",
    padding: "0 16px",
    borderRadius: "10px",
    border: "1px solid #cddcc8",
    backgroundColor: "#f3f8f0",
    color: "#355c3b",
    fontWeight: 600,
    cursor: "pointer",
  },
  sheetNestedPrimary: {
    flex: "0 1 auto",
    height: "40px",
    padding: "0 16px",
    borderRadius: "10px",
    border: "none",
    backgroundColor: "#3d7f49",
    color: "#ffffff",
    fontWeight: 700,
    cursor: "pointer",
  },
  sheetDeleteText: {
    margin: "0 0 16px",
    fontSize: "14px",
    fontWeight: 600,
    color: "#4a6652",
    lineHeight: 1.45,
  },
  sheetDeleteConfirmBtn: {
    flex: "0 1 auto",
    height: "40px",
    padding: "0 16px",
    borderRadius: "10px",
    border: "none",
    backgroundColor: "#b94040",
    color: "#ffffff",
    fontWeight: 700,
    cursor: "pointer",
    boxShadow: "0 6px 14px rgba(185, 64, 64, 0.35)",
  },
  sheetActionButton: {
    width: "100%", height: "44px", borderRadius: "12px", border: "none",
    backgroundColor: "#3d7f49", color: "#ffffff", fontSize: "15px", fontWeight: 800,
    cursor: "pointer", boxShadow: "0 10px 20px rgba(45, 88, 40, 0.28)", marginTop: "2px", flexShrink: 0,
  },
  eventoBackdrop: {
    position: "fixed", inset: 0, zIndex: 3000, backgroundColor: "rgba(18, 32, 24, 0.52)",
    display: "flex", alignItems: "flex-end", justifyContent: "center",
  },
  eventoDialog: {
    width: "100%", maxWidth: "480px", backgroundColor: "#ffffff",
    borderTopLeftRadius: "22px", borderTopRightRadius: "22px",
    padding: "16px 16px calc(20px + env(safe-area-inset-bottom, 0px))",
    boxSizing: "border-box", boxShadow: "0 -8px 40px rgba(24, 48, 32, 0.2)",
    display: "flex", flexDirection: "column", gap: "14px",
    maxHeight: "90vh", overflowY: "auto",
  },
  eventoHeader: { display: "flex", alignItems: "center", justifyContent: "space-between" },
  eventoTitle: { margin: 0, fontSize: "20px", fontWeight: 700, color: "#1f3d28" },
  eventoClose: {
    width: "36px", height: "36px", borderRadius: "10px", border: "1px solid #eeeeee",
    backgroundColor: "#ffffff", color: "#355c3b", fontSize: "22px", lineHeight: 1, cursor: "pointer",
    display: "flex", alignItems: "center", justifyContent: "center", padding: 0, flexShrink: 0,
  },
  tipoGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "8px" },
  tipoChip: {
    display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center",
    gap: "4px", padding: "10px 8px", borderRadius: "12px", border: "2px solid #e4ede0",
    backgroundColor: "#f7faf5", cursor: "pointer",
  },
  tipoChipActive: { border: "2px solid #3d7f49", backgroundColor: "#eaf4eb" },
  tipoIcon: { fontSize: "22px", lineHeight: 1 },
  tipoLabel: { fontSize: "13px", fontWeight: 600, color: "#2a3f2f" },
  fieldsSection: { display: "flex", flexDirection: "column", gap: "4px" },
  fieldLabel: { fontSize: "13px", fontWeight: 600, color: "#355c3b", margin: 0 },
  fieldInput: {
    height: "44px", borderRadius: "12px", border: "1px solid #cddcc8",
    backgroundColor: "#f7faf5", padding: "0 12px", fontSize: "15px",
    outline: "none", color: "#2a3f2f", width: "100%", boxSizing: "border-box",
  },
  toggleRow: { display: "flex", gap: "8px" },
  toggleBtn: {
    flex: 1, height: "40px", borderRadius: "10px", border: "2px solid #e4ede0",
    backgroundColor: "#f7faf5", color: "#2a3f2f", fontSize: "14px", fontWeight: 600, cursor: "pointer",
  },
  toggleBtnActive: { border: "2px solid #3d7f49", backgroundColor: "#eaf4eb", color: "#1f3d28" },
  fileLabel: {
    display: "flex", height: "44px", borderRadius: "12px", border: "1px dashed #9dbfa5",
    backgroundColor: "#f7faf5", cursor: "pointer", alignItems: "center", justifyContent: "center",
  },
  fileLabelText: { fontSize: "14px", fontWeight: 600, color: "#3d7f49" },
  eventoActions: { display: "flex", gap: "10px", marginTop: "2px" },
  eventoSecondary: {
    flex: 1, height: "46px", borderRadius: "12px", border: "1px solid #cddcc8",
    backgroundColor: "#f3f8f0", color: "#355c3b", fontSize: "15px", fontWeight: 600, cursor: "pointer",
  },
  eventoPrimary: {
    flex: 2, height: "46px", borderRadius: "12px", border: "none",
    backgroundColor: "#3d7f49", color: "#ffffff", fontSize: "15px", fontWeight: 700,
    cursor: "pointer", boxShadow: "0 8px 18px rgba(45, 88, 40, 0.3)",
  },
};

export default App;
