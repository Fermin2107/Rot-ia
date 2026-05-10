import { useState, useEffect } from "react";
import { supabase } from "../supabaseClient";
import {
  ARGENTINA_CENTER,
  TIPOS_PASTO_OPTIONS,
  DEFAULT_DESCANSO_BASES_DIAS,
  DESCANSO_BASE_KEY_SIN_ESPECIFICAR,
} from "../constants";
import { mergeDescansoBasesDias } from "../utils/motorDescanso";
import { geocodeFreeText } from "../utils/geo";

const styles = {
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
};

/**
 * @param {"primer"|"adicional"|"edit"} variant
 * @param {object | null} editingCampo — fila `campos` cuando variant === "edit"
 */
export default function PrimerCampoModal({
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
