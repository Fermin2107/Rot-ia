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
} from "react-leaflet";
import area from "@turf/area";
import { polygon } from "@turf/helpers";
import { supabase } from "./supabaseClient";
import { fetchPotreroNdvi, ndviTier } from "./ndviApi";

/*
  Supabase — esquema esperado por la app:

  - Tabla campos: id, user_id (FK auth.users), name, lat, lng, zoom (default 14), created_at.
    RLS: todas las filas visibles/mutables sólo si auth.uid() = user_id.

  - Tabla potreros: debe incluir user_id, campo_id (FK campos ON DELETE CASCADE), name, positions, created_at.
    RLS acorde (dueño del potrero / del campo).

  - Tabla eventos: potrero_id FK potreros ON DELETE CASCADE; user_id si la app lo envía.

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

function DrawingMapUi({ drawingMode }) {
  const map = useMap();
  useEffect(() => {
    const el = map.getContainer();
    if (drawingMode) { map.doubleClickZoom.disable(); el.style.cursor = "crosshair"; }
    else { map.doubleClickZoom.enable(); el.style.cursor = ""; }
    return () => { try { map.doubleClickZoom.enable(); } catch { /* */ } };
  }, [drawingMode, map]);
  return null;
}

function MapResizeNotifier({ drawingMode, selectedPotrero }) {
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
  }, [map, drawingMode, selectedPotrero]);
  return null;
}

const EVENTO_TIPOS = [
  { id: "lluvia", label: "Lluvia", icon: "🌧️" },
  { id: "fertilizacion", label: "Fertilización", icon: "🌱" },
  { id: "movimiento", label: "Movimiento", icon: "🐄" },
  { id: "foto", label: "Foto", icon: "📷" },
];

const DESCANSO_LISTO_MIN_DIAS = 60;

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
  if (d == null || !Number.isFinite(d)) return "—";
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
                      {row.areaHa != null ? `${row.areaHa.toFixed(2)} ha` : "— ha"}
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
        </p>
      </div>
    </div>
  );
}

/**
 * Bloque 3: NDVI + descanso (última salida) + contexto de lluvia en copy.
 * @returns {{ tier: "listo"|"casi"|"recup", label: string, mapShort: string, hint?: string }}
 */
function recomendacionRotacion(ndviEntry, descansoState) {
  const ndvi = ndviEntry?.status === "ok" ? ndviEntry.meanNdvi : null;
  const desc = descansoState;
  const descDias = desc.kind === "descanso" ? desc.days : null;

  if (
    ndvi !== null &&
    ndvi > 0.5 &&
    desc.kind === "descanso" &&
    descDias !== null &&
    descDias > 60
  ) {
    return { tier: "listo", label: "Listo para entrar", mapShort: "Listo" };
  }

  if (desc.kind === "en_uso") {
    return {
      tier: "recup",
      label: "En recuperación",
      mapShort: "Recup.",
      hint: "Hay hacienda en el potrero.",
    };
  }

  if (ndvi !== null && ndvi < 0.3) {
    return { tier: "recup", label: "En recuperación", mapShort: "Recup." };
  }

  if (desc.kind === "descanso" && descDias !== null && descDias < 45) {
    return { tier: "recup", label: "En recuperación", mapShort: "Recup." };
  }

  if (ndvi !== null && ndvi >= 0.3 && ndvi <= 0.5) {
    return { tier: "casi", label: "Casi listo", mapShort: "Casi" };
  }

  if (desc.kind === "descanso" && descDias !== null && descDias >= 45 && descDias <= 60) {
    return { tier: "casi", label: "Casi listo", mapShort: "Casi" };
  }

  if (
    ndvi !== null &&
    ndvi > 0.5 &&
    desc.kind === "descanso" &&
    descDias !== null &&
    descDias <= 60
  ) {
    return { tier: "casi", label: "Casi listo", mapShort: "Casi" };
  }

  if (desc.kind === "sin_datos") {
    return {
      tier: "casi",
      label: "Casi listo",
      mapShort: "Casi",
      hint: "Registrá movimientos de hacienda para calcular el descanso.",
    };
  }

  return { tier: "casi", label: "Casi listo", mapShort: "Casi" };
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

function PrimerCampoModal({ open, onCreated, onPreviewLocation }) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState(null);
  const [busy, setBusy] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    if (!open) {
      setName("");
      setQuery("");
      setPreview(null);
      setError(null);
      setBusy(false);
      setSaving(false);
    }
  }, [open]);

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
      setPreview({ lat: r.lat, lng: r.lng, label: r.label });
      onPreviewLocation(r.lat, r.lng, 14);
    } finally {
      setBusy(false);
    }
  };

  const handleCrear = async () => {
    const n = name.trim();
    setError(null);
    if (!n) {
      setError("Ingresá el nombre del establecimiento.");
      return;
    }
    const lat = preview?.lat ?? ARGENTINA_CENTER[0];
    const lng = preview?.lng ?? ARGENTINA_CENTER[1];
    const zoom = preview ? 14 : 6;
    setSaving(true);
    try {
      const { data: { user } } = await supabase.auth.getUser();
      if (!user) {
        setError("Sesión no válida.");
        return;
      }
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
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div style={styles.primerCampoBackdrop}>
      <div
        style={styles.primerCampoDialog}
        role="dialog"
        aria-modal="true"
        aria-labelledby="primer-campo-title"
      >
        <h2 id="primer-campo-title" style={styles.primerCampoTitle}>
          Tu primer establecimiento
        </h2>
        <p style={styles.primerCampoLead}>
          Creá un campo para dibujar potreros. Podés buscar la ubicación en el mapa o usar el centro de Argentina por defecto.
        </p>
        <label style={styles.primerCampoLabel} htmlFor="primer-campo-nombre">Nombre</label>
        <input
          id="primer-campo-nombre"
          style={styles.primerCampoInput}
          placeholder="Ej. Estancia Los Alamos"
          value={name}
          onChange={(e) => setName(e.target.value)}
        />
        <label style={{ ...styles.primerCampoLabel, marginTop: "12px" }} htmlFor="primer-campo-buscar">
          Ubicación (opcional)
        </label>
        <div style={styles.mapSearchRow}>
          <input
            id="primer-campo-buscar"
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
        {!preview && (
          <p style={styles.primerCampoHint}>
            Sin búsqueda se usará vista general de Argentina; después podés centrar con el buscador del mapa.
          </p>
        )}
        {error && (
          <p style={styles.primerCampoError}>{error}</p>
        )}
        <button
          type="button"
          style={{
            ...styles.primerCampoPrimary,
            opacity: saving ? 0.65 : 1,
            cursor: saving ? "wait" : "pointer",
          }}
          onClick={handleCrear}
          disabled={saving}
        >
          {saving ? "Creando…" : "Crear establecimiento"}
        </button>
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
  const [mapCenter, setMapCenter] = useState(ARGENTINA_CENTER);
  const [mapZoom, setMapZoom] = useState(6);
  const [locationQuery, setLocationQuery] = useState("");
  const [locationSearchBusy, setLocationSearchBusy] = useState(false);
  const [locationSearchError, setLocationSearchError] = useState(null);
  const [nombreInput, setNombreInput] = useState("");
  const [selectedPotrero, setSelectedPotrero] = useState(null);
  const [sheetEntered, setSheetEntered] = useState(false);
  const [showEventForm, setShowEventForm] = useState(false);
  const [savingPotrero, setSavingPotrero] = useState(false);
  const [savingEvento, setSavingEvento] = useState(false);
  const [loadingPotreros, setLoadingPotreros] = useState(false);
  const [showRotacionModal, setShowRotacionModal] = useState(false);
  const [showEditNombreDialog, setShowEditNombreDialog] = useState(false);
  const [editNombreSheet, setEditNombreSheet] = useState("");
  const [savingEditNombre, setSavingEditNombre] = useState(false);
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);
  const [deletingPotrero, setDeletingPotrero] = useState(false);
  const [potreroSheetError, setPotreroSheetError] = useState(null);
  const ndviByIdRef = useRef({});
  const [ndviById, setNdviById] = useState({});

  const draftVerticesRef = useRef(draftVertices);
  draftVerticesRef.current = draftVertices;

  useEffect(() => {
    ndviByIdRef.current = ndviById;
  }, [ndviById]);

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
            if (ultimoMovByPotrero[row.potrero_id]) continue;
            const dir = row.datos?.direccion;
            ultimoMovByPotrero[row.potrero_id] = {
              fecha: row.fecha,
              direccion: dir === "entrada" || dir === "salida" ? dir : undefined,
            };
          }
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
          positions: p.positions,
          ultimoEvento: lastEvento[p.id] ?? null,
          ultimoMovimiento: ultimoMovByPotrero[p.id] ?? null,
          ultimoLluvia: ultimoLluviaByPotrero[p.id] ?? null,
        }))
      );
      setLoadingPotreros(false);
    };

    load();
    return () => { cancelled = true; };
  }, [selectedCampoId]);

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
    setSelectedPotrero(null);
    setSheetEntered(false);
    setPendingRing(null);
    setNombreInput("");
    setDraftVertices([]);
    setPreviewTip(null);
    setDrawingMode(true);
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
  }, []);

  // ── Guardar potrero en Supabase ───────────────────────────────────────────
  const handleConfirmNombre = useCallback(async () => {
    const name = nombreInput.trim();
    const ring = pendingRing;
    if (!selectedCampoId || !ring || ring.length < 3 || name.length === 0) return;

    setSavingPotrero(true);
    const { data: { user } } = await supabase.auth.getUser();
    const { data, error } = await supabase
      .from("potreros")
      .insert({
        name,
        positions: ring,
        user_id: user?.id,
        campo_id: selectedCampoId,
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
        positions: data.positions,
        ultimoEvento: null,
        ultimoMovimiento: null,
        ultimoLluvia: null,
      },
    ]);
    setPendingRing(null);
    setNombreInput("");
  }, [nombreInput, pendingRing, selectedCampoId]);

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
    const { data: updatedRows, error } = await supabase
      .from("potreros")
      .update({ name })
      .eq("id", selectedPotrero.id)
      .select("id");
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
      prev.map((p) => (p.id === selectedPotrero.id ? { ...p, name } : p)),
    );
    setSelectedPotrero((prev) => (prev ? { ...prev, name } : prev));
    setShowEditNombreDialog(false);
  }, [editNombreSheet, selectedPotrero]);

  const handleConfirmDeletePotrero = useCallback(async () => {
    if (!selectedPotrero) return;
    const id = selectedPotrero.id;
    setDeletingPotrero(true);
    setPotreroSheetError(null);
    const { data: deletedRows, error } = await supabase
      .from("potreros")
      .delete()
      .eq("id", id)
      .select("id");
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
  }, [selectedPotrero]);

  const ndviEntry = selectedPotrero ? ndviById[selectedPotrero.id] : null;

  const recoSheet = selectedPotrero
    ? recomendacionRotacion(
      ndviEntry,
      descansoFromUltimoMovimiento(selectedPotrero.ultimoMovimiento),
    )
    : null;

  const potrerosListos = useMemo(() => {
    const rows = [];
    for (const p of potreros) {
      const st = descansoFromUltimoMovimiento(p.ultimoMovimiento);
      if (st.kind === "descanso" && st.days > DESCANSO_LISTO_MIN_DIAS) {
        rows.push({ potrero: p, days: st.days });
      }
    }
    rows.sort((a, b) => b.days - a.days);
    return rows;
  }, [potreros]);

  const lastDraft = draftVertices[draftVertices.length - 1];
  const hoverSegment =
    drawingMode && previewTip && draftVertices.length > 0 && lastDraft
      ? [lastDraft, previewTip]
      : null;

  return (
    <main style={styles.mapPage}>
      <header className="rotia-map-header" style={styles.topBar}>
        <div style={styles.topBrand}>
          <div style={styles.topLogo} aria-hidden="true">🌿</div>
          <strong style={styles.topTitle}>Rotia</strong>
        </div>
        {campos.length > 0 && (
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
          <div style={{ position: "relative" }}>
          <button
            style={styles.menuButton}
            aria-label="Abrir menu"
            onClick={() => setMenuOpen((v) => !v)}
          >☰</button>
          {menuOpen && (
            <>
              <div
                style={styles.menuOverlay}
                onClick={() => setMenuOpen(false)}
              />
              <div style={styles.menuDropdown}>
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
        </div>
      </header>

      {potreros.length > 0 && (
        <section style={styles.listosSection} aria-label="Potreros listos">
          <div style={styles.listosHeaderRow}>
            <h2 style={styles.listosTitle}>Potreros listos</h2>
            <span style={styles.listosBadge}>+{DESCANSO_LISTO_MIN_DIAS} días sin hacienda</span>
          </div>
          {potrerosListos.length === 0 ? (
            <p style={styles.listosEmpty}>
              Ningún potrero lleva más de {DESCANSO_LISTO_MIN_DIAS} días sin animales (último movimiento: salida).
            </p>
          ) : (
            <div style={styles.listosScroll}>
              {potrerosListos.map(({ potrero: p, days }) => (
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
                  <span style={styles.listosChipDays}>{days} días</span>
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
                <MapResizeNotifier drawingMode={drawingMode} selectedPotrero={selectedPotrero} />
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
                <DrawingMapUi drawingMode={drawingMode} />
                <DrawingClicks
                  active={drawingMode}
                  onAddVertex={handleAddVertex}
                  onAttemptClosePolygon={handleAttemptClosePolygon}
                  onHover={setPreviewTip}
                />

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
                      !(drawingMode || !!pendingRing),
                    )}
                    eventHandlers={{
                      click: (e) => {
                        if (drawingMode || pendingRing) return;
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
                    descansoFromUltimoMovimiento(pot.ultimoMovimiento),
                  );
                  return (
                    <RotacionRecoMarker
                      key={`reco-${pot.id}`}
                      pot={pot}
                      reco={reco}
                      interactive={!(drawingMode || !!pendingRing)}
                      onSelect={setSelectedPotrero}
                    />
                  );
                })}
              </MapContainer>
            </div>

            {(loadingCampos || loadingPotreros) && (
              <div style={styles.loadingBadge}>
                {loadingCampos ? "Cargando establecimientos…" : "Cargando potreros…"}
              </div>
            )}

            {!pendingRing && selectedCampoId && (
              !drawingMode ? (
                <button type="button" style={styles.floatingButton} onClick={startDrawing}>
                  + Agregar potrero
                </button>
              ) : (
                <button type="button" style={styles.floatingButtonCancel} onClick={cancelDrawing}>
                  Cancelar dibujo
                </button>
              )
            )}

            {drawingMode && (
              <p style={styles.drawHint}>Doble click para cerrar el potrero</p>
            )}

            {pendingRing && (
              <dialog open style={styles.nameDialogBackdrop}>
                <div style={styles.nameDialog}>
                  <h2 style={styles.nameDialogTitle}>Nombre del potrero</h2>
                  <p style={styles.nameDialogText}>Elegí un nombre para este potrero.</p>
                  <input
                    autoFocus
                    style={styles.nameDialogInput}
                    type="text"
                    value={nombreInput}
                    placeholder="Ej. Los Algarrobos"
                    onChange={(e) => setNombreInput(e.target.value)}
                  />
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
                <span style={styles.sheetCardLabel}>Último evento</span>
                <div style={styles.sheetCardValueNeutral}>
                  {selectedPotrero.ultimoEvento ?? "Sin registros"}
                </div>
              </div>
              <div style={styles.sheetCard}>
                <span style={styles.sheetCardLabel}>Días en descanso</span>
                {(() => {
                  const st = descansoFromUltimoMovimiento(selectedPotrero.ultimoMovimiento);
                  if (st.kind === "sin_datos") {
                    return (
                      <div style={styles.sheetCardValueNeutral}>Sin datos</div>
                    );
                  }
                  if (st.kind === "en_uso") {
                    return (
                      <>
                        <div style={styles.sheetCardValueNeutral}>Con hacienda</div>
                        <p style={styles.sheetDescansoHint}>Último movimiento: entrada</p>
                      </>
                    );
                  }
                  return (
                    <div style={styles.sheetCardValueNeutral}>
                      {st.days} días en descanso
                    </div>
                  );
                })()}
              </div>
              <div style={styles.sheetCard}>
                <span style={styles.sheetCardLabel}>Recomendación</span>
                <div
                  style={{
                    ...styles.sheetRecoBadgeBase,
                    ...(recoSheet.tier === "listo"
                      ? styles.sheetRecoBadgeListo
                      : recoSheet.tier === "casi"
                        ? styles.sheetRecoBadgeCasi
                        : styles.sheetRecoBadgeRecup),
                  }}
                >
                  {recoSheet.label}
                </div>
                {recoSheet.hint && (
                  <p style={styles.sheetRecoHint}>{recoSheet.hint}</p>
                )}
                <p style={styles.sheetRecoLluvia}>
                  🌧️ {formatUltimaLluviaLine(selectedPotrero.ultimoLluvia)}
                </p>
              </div>
            </div>

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
                  setShowEditNombreDialog(true);
                }}
              >
                Editar nombre
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
                <h3 id="edit-pot-title" style={styles.sheetNestedTitle}>Editar nombre</h3>
                <input
                  autoFocus
                  style={styles.sheetNestedInput}
                  type="text"
                  value={editNombreSheet}
                  onChange={(e) => setEditNombreSheet(e.target.value)}
                  placeholder="Nombre del potrero"
                />
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
        open={!loadingCampos && campos.length === 0}
        onPreviewLocation={(lat, lng, zoom) => {
          setMapCenter([lat, lng]);
          setMapZoom(zoom);
        }}
        onCreated={(row) => {
          setCampos((prev) => [...prev, row]);
          setSelectedCampoId(row.id);
        }}
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
  topCampoSelectWrap: {
    flex: "1 1 auto",
    minWidth: 0,
    maxWidth: "min(320px, 42vw)",
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
  rotacionDisclaimer: {
    margin: "14px 0 0",
    fontSize: "11px",
    fontWeight: 600,
    color: "#7a8a76",
    lineHeight: 1.45,
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
    boxShadow: "0 12px 22px rgba(45, 88, 40, 0.35)", cursor: "pointer", zIndex: 1000, pointerEvents: "auto",
  },
  floatingButtonCancel: {
    position: "absolute", left: "50%", bottom: "calc(14px + env(safe-area-inset-bottom, 0px))",
    transform: "translateX(-50%)", minWidth: "230px", height: "48px", borderRadius: "999px",
    border: "none", backgroundColor: "#5f4b32", color: "#ffffff", fontSize: "16px", fontWeight: 700,
    boxShadow: "0 12px 22px rgba(45, 88, 40, 0.35)", cursor: "pointer", zIndex: 1000, pointerEvents: "auto",
  },
  drawHint: {
    position: "absolute", left: "50%", bottom: "calc(72px + env(safe-area-inset-bottom, 0px))",
    transform: "translateX(-50%)", margin: 0, padding: "6px 12px", borderRadius: "999px",
    backgroundColor: "rgba(244, 250, 240, 0.92)", color: "#2a3f2f", fontSize: "13px", fontWeight: 600,
    boxShadow: "0 8px 16px rgba(47, 84, 42, 0.12)", zIndex: 1000, pointerEvents: "none", whiteSpace: "nowrap",
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
    fontSize: "15px", marginBottom: "16px",
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
