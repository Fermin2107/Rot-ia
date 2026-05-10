import { useState, useEffect, useCallback, useMemo, useRef } from "react";
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
import { supabase } from "../supabaseClient";
import { fetchPotreroNdvi, ndviTier } from "../ndviApi";
import {
  ARGENTINA_CENTER,
  CLICK_DEBOUNCE_MS,
  CAMPO_STORAGE_KEY,
  LISTOS_BANNER_SESSION_KEY,
  TIPOS_PASTO_OPTIONS,
  PARCELAS_MIN,
  PARCELAS_MAX,
} from "../constants";
import { dividirEnFranjas, parcelaEsGrandeParagNDVI } from "../utils/motorParcelas";
import { geocodeFreeText, ringCentroid } from "../utils/geo";
import {
  mergeDescansoBasesDias,
  computeDescansoInteligente,
  pastoreoCabezasUltimaAntesDeSalida,
} from "../utils/motorDescanso";
import { formatEvent, isKnownTipoPastoId } from "../utils/formatters";
import { useVisualViewportBottomInset } from "../hooks/useVisualViewportBottomInset";
import { useMediaQuery } from "../hooks/useMediaQuery";
import EventoForm from "./EventoForm";
import PlanificarRotacionModal from "./PlanificarRotacionModal";
import PrimerCampoModal from "./PrimerCampoModal";
import PotreroSheet from "./PotreroSheet";

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

const aguadaMarkerIcon = L.divIcon({
  className: "rotia-aguada-m",
  html: '<div style="font-size:22px;line-height:1;text-align:center">💧</div>',
  iconSize: [28, 32],
  iconAnchor: [14, 32],
  popupAnchor: [0, -28],
});

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

/**
 * Normaliza un ring de coordenadas que puede venir de Supabase como:
 *   [{lat, lng}, ...] o [[lat, lng], ...]
 * Siempre devuelve [[lat, lng], ...]
 */
function normalizeRing(positions) {
  if (!Array.isArray(positions) || positions.length < 3) return [];
  return positions.map((p) => {
    if (Array.isArray(p)) return [Number(p[0]), Number(p[1])];
    if (p && typeof p === "object" && "lat" in p) return [Number(p.lat), Number(p.lng)];
    return null;
  }).filter((p) => p !== null && Number.isFinite(p[0]) && Number.isFinite(p[1]));
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

export default function MapaPotrero({ onLogout }) {
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
  const ndviByParcelaRef = useRef({});
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
  const [parcelasByPotrero, setParcelasByPotrero] = useState({}); // { [potreroId]: parcela[] }
  const [ndviByParcela, setNdviByParcela] = useState({}); // { [parcelaId]: ndviEntry }
  const [selectedParcela, setSelectedParcela] = useState(null);
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
    ndviByParcelaRef.current = ndviByParcela;
  }, [ndviByParcela]);

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
    setParcelasByPotrero({});
    setNdviByParcela({});
    setSelectedParcela(null);
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

  useEffect(() => {
    if (!selectedCampoId || potreros.length === 0) {
      setParcelasByPotrero({});
      return undefined;
    }
    let cancelled = false;
    (async () => {
      const ids = potreros.map((p) => p.id);
      const { data, error } = await supabase
        .from("parcelas")
        .select("*")
        .in("potrero_id", ids)
        .order("orden", { ascending: true });
      if (cancelled) return;
      if (error) { console.error("Error cargando parcelas:", error); return; }
      const byPotrero = {};
      for (const p of data ?? []) {
        if (!byPotrero[p.potrero_id]) byPotrero[p.potrero_id] = [];
        byPotrero[p.potrero_id].push(p);
      }
      setParcelasByPotrero(byPotrero);
    })();
    return () => { cancelled = true; };
  }, [selectedCampoId, potreros]);

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
              history: Array.isArray(result.history) ? result.history : [],
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

  useEffect(() => {
    const todasParcelas = Object.values(parcelasByPotrero).flat();
    if (todasParcelas.length === 0) return undefined;
    let cancelled = false;

    const queue = async () => {
      for (const p of todasParcelas) {
        if (cancelled) return;

        const cur = ndviByParcelaRef.current[p.id];
        if (cur?.status === "ok" || cur?.status === "loading") continue;

        const ring = normalizeRing(p.positions);
        if (ring.length < 3) {
          console.error(`Parcela ${p.id} tiene positions inválidas:`, p.positions);
          setNdviByParcela((prev) => ({
            ...prev,
            [p.id]: { status: "error", code: "invalid-positions" },
          }));
          continue;
        }

        if (!parcelaEsGrandeParagNDVI(ring)) {
          const padreNdvi = ndviByIdRef.current[p.potrero_id];
          if (padreNdvi?.status === "ok") {
            setNdviByParcela((prev) => ({
              ...prev,
              [p.id]: { ...padreNdvi, heredado: true },
            }));
            continue;
          }
          continue;
        }

        setNdviByParcela((prev) => {
          if (prev[p.id]?.status === "ok" || prev[p.id]?.status === "loading") return prev;
          return { ...prev, [p.id]: { status: "loading" } };
        });

        try {
          const result = await fetchPotreroNdvi(ring);
          if (cancelled) return;
          if (result.ok && typeof result.meanNdvi === "number") {
            const mean = Math.min(1, Math.max(0, result.meanNdvi));
            setNdviByParcela((prev) => ({
              ...prev,
              [p.id]: {
                status: "ok",
                meanNdvi: mean,
                intervalTo: result.intervalTo ?? null,
                tier: ndviTier(mean),
                history: Array.isArray(result.history) ? result.history : [],
              },
            }));
          } else {
            console.error(`NDVI parcela ${p.id} error:`, result.error);
            setNdviByParcela((prev) => ({
              ...prev,
              [p.id]: { status: "error", code: result.error ?? "unknown" },
            }));
          }
        } catch (err) {
          console.error(`NDVI parcela ${p.id} excepción:`, err);
          if (!cancelled) {
            setNdviByParcela((prev) => ({
              ...prev,
              [p.id]: { status: "error", code: "exception" },
            }));
          }
        }
      }
    };

    queue();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- ndviByParcela vía ref; ndviById para re-ejecutar cuando el padre cargue
  }, [parcelasByPotrero, ndviById]);

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
    const desc = formatEvent(tipo, fields);
    setSavingEvento(true);

    const { data: { user } } = await supabase.auth.getUser();
    const { error } = await supabase.from("eventos").insert({
      potrero_id: selectedPotrero.id,
      tipo,
      datos: fields,
      descripcion: desc,
      fecha: new Date().toISOString(),
      user_id: user?.id,
      parcela_id: tipo === "movimiento" && fields.parcelaId ? fields.parcelaId : null,
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

  const handleCrearParcelas = useCallback(async (potreroId, ring, nParcelas, angleDeg = null) => {
    if (!selectedCampoId || !potreroId || nParcelas < PARCELAS_MIN || nParcelas > PARCELAS_MAX) return;
    const { data: { user } } = await supabase.auth.getUser();
    if (!user) return;

    const { error: deleteError } = await supabase
      .from("parcelas")
      .delete()
      .eq("potrero_id", potreroId)
      .eq("user_id", user.id);

    if (deleteError) {
      console.error("Error borrando parcelas anteriores:", deleteError);
      return;
    }

    const { count } = await supabase
      .from("parcelas")
      .select("*", { count: "exact", head: true })
      .eq("potrero_id", potreroId);
    console.log("[handleCrearParcelas] parcelas restantes tras DELETE:", count);

    const franjas = dividirEnFranjas(ring, nParcelas, angleDeg);
    if (!franjas.length) return;
    const rows = franjas.map((positions, i) => ({
      potrero_id: potreroId,
      campo_id: selectedCampoId,
      user_id: user.id,
      name: `Parcela ${i + 1}`,
      positions,
      orden: i,
    }));
    const { data, error } = await supabase.from("parcelas").insert(rows).select();
    if (error) { console.error("Error creando parcelas:", error); return; }
    setParcelasByPotrero((prev) => ({
      ...prev,
      [potreroId]: data ?? [],
    }));
    setNdviByParcela((prev) => {
      const next = { ...prev };
      for (const p of data ?? []) delete next[p.id];
      return next;
    });
  }, [selectedCampoId]);

  const handleEliminarParcelas = useCallback(async (potreroId) => {
    if (!potreroId) return;
    await supabase.from("parcelas").delete().eq("potrero_id", potreroId);
    setParcelasByPotrero((prev) => { const n = { ...prev }; delete n[potreroId]; return n; });
    setNdviByParcela((prev) => {
      const n = { ...prev };
      const ids = (parcelasByPotrero[potreroId] ?? []).map((p) => p.id);
      for (const id of ids) delete n[id];
      return n;
    });
  }, [parcelasByPotrero]);

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
                {Object.values(parcelasByPotrero).flat().map((parc) => {
                  const isSelected = selectedParcela?.id === parc.id;
                  const ndviE = ndviByParcela[parc.id];
                  const pathOptions = isSelected
                    ? styles.parcelaPolygonSelected
                    : ndviE?.tier === "low"
                      ? { ...styles.parcelaPolygon, fillColor: "#d47272", color: "#8b2f2f" }
                      : ndviE?.tier === "high"
                        ? { ...styles.parcelaPolygon, fillColor: "#46a858", color: "#1f5c2e" }
                        : styles.parcelaPolygon;
                  return (
                    <Polygon
                      key={`parc-${parc.id}`}
                      positions={parc.positions}
                      pathOptions={{
                        ...pathOptions,
                        interactive: !(drawingMode || !!pendingRing || aguadaPlacementMode),
                      }}
                      eventHandlers={{
                        click: (e) => {
                          if (drawingMode || pendingRing || aguadaPlacementMode) return;
                          const ev = e.originalEvent;
                          if (ev) L.DomEvent.stopPropagation(ev);
                          // Abrir el potrero padre primero
                          const potrePadre = potreros.find((p) => p.id === parc.potrero_id);
                          if (potrePadre) setSelectedPotrero(potrePadre);
                          setSelectedParcela(parc);
                        },
                      }}
                    />
                  );
                })}
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
        <PotreroSheet
          selectedPotrero={selectedPotrero}
          sheetEntered={sheetEntered}
          sheetTab={sheetTab}
          setSheetTab={setSheetTab}
          ndviEntry={ndviEntry}
          motorSheet={motorSheet}
          aguadas={aguadas}
          historialRows={historialRows}
          historialLoading={historialLoading}
          historialError={historialError}
          potreroSheetError={potreroSheetError}
          showEditNombreDialog={showEditNombreDialog}
          setShowEditNombreDialog={setShowEditNombreDialog}
          editNombreSheet={editNombreSheet}
          setEditNombreSheet={setEditNombreSheet}
          editTipoPastoSheet={editTipoPastoSheet}
          setEditTipoPastoSheet={setEditTipoPastoSheet}
          savingEditNombre={savingEditNombre}
          showDeleteConfirm={showDeleteConfirm}
          setShowDeleteConfirm={setShowDeleteConfirm}
          deletingPotrero={deletingPotrero}
          onClose={closePotreroSheet}
          onSaveEdit={handleConfirmEditNombrePotrero}
          onConfirmDelete={handleConfirmDeletePotrero}
          onAguadaChange={handleAguadaAsignadaChange}
          onRegistrarEvento={() => setShowEventForm(true)}
          setPotreroSheetError={setPotreroSheetError}
          parcelas={parcelasByPotrero[selectedPotrero?.id] ?? []}
          ndviByParcela={ndviByParcela}
          onCrearParcelas={handleCrearParcelas}
          onEliminarParcelas={handleEliminarParcelas}
          selectedParcela={selectedParcela}
          onSelectParcela={setSelectedParcela}
        />
      )}

      {showEventForm && (
        <EventoForm
          onSave={handleSaveEvento}
          onClose={() => setShowEventForm(false)}
          saving={savingEvento}
          parcelas={parcelasByPotrero[selectedPotrero?.id] ?? []}
          parcelaIdInicial={selectedParcela?.id ?? null}
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

const styles = {
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
  parcelaPolygon: {
    color: "#1a5c8a",
    weight: 1.5,
    fillColor: "#4a9fd4",
    fillOpacity: 0.18,
    dashArray: "5 4",
  },
  parcelaPolygonEnUso: {
    color: "#8a3a1a",
    weight: 1.5,
    fillColor: "#d4714a",
    fillOpacity: 0.22,
    dashArray: "5 4",
  },
  parcelaPolygonSelected: {
    color: "#1a5c8a",
    weight: 2.5,
    fillColor: "#4a9fd4",
    fillOpacity: 0.35,
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
};
