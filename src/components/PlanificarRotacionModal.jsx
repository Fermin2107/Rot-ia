import { useState, useEffect, useMemo } from "react";
import {
  CATEGORIAS_HACIENDA,
  CONSUMO_MS_CABEZA_DIA_MIN,
  CONSUMO_MS_CABEZA_DIA_MAX,
  CONSUMO_MS_CABEZA_DIA_DEFAULT,
  KG_MS_PER_HA_NDVI_FACTOR,
  ROTACION_UI_DIAS_ESTIMADOS_MAX,
} from "../constants";
import { buildRotationRanking, formatDiasEstimados } from "../utils/motorRotacion";

const styles = {
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
};

export default function PlanificarRotacionModal({ open, onClose, potreros, ndviById }) {
  const [categorias, setCategorias] = useState(
    () => Object.fromEntries(CATEGORIAS_HACIENDA.map((c) => [c.id, ""])),
  );
  const [kgDia, setKgDia] = useState(CONSUMO_MS_CABEZA_DIA_DEFAULT);

  useEffect(() => {
    if (open) {
      setCategorias(Object.fromEntries(CATEGORIAS_HACIENDA.map((c) => [c.id, ""])));
      setKgDia(CONSUMO_MS_CABEZA_DIA_DEFAULT);
    }
  }, [open]);

  const evTotal = CATEGORIAS_HACIENDA.reduce((acc, cat) => {
    const n = parseInt(categorias[cat.id], 10);
    return acc + (Number.isFinite(n) && n > 0 ? n * cat.ev : 0);
  }, 0);
  const evValido = evTotal > 0;

  const ranking = useMemo(() => {
    if (!evValido) return [];
    return buildRotationRanking(potreros, ndviById, evTotal, kgDia);
  }, [potreros, ndviById, evTotal, kgDia, evValido]);

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
          Ingresá la hacienda por categoría (equivalente vaca). Ordenamos los potreros con más días de descanso y mejor NDVI primero
          y estimamos cuántos días podría alimentar el lote según la biomasa aproximada.
        </p>
        <p style={styles.rotacionLabel}>Hacienda por categoría</p>
        {CATEGORIAS_HACIENDA.map((cat) => (
          <div
            key={cat.id}
            style={{ display: "flex", alignItems: "center", gap: "10px", marginBottom: "8px" }}
          >
            <label
              style={{
                flex: "1 1 auto",
                fontSize: "13px",
                fontWeight: 600,
                color: "#355c3b",
              }}
            >
              {cat.label}
              <span style={{ fontWeight: 400, color: "#7a8a76", marginLeft: "4px" }}>
                ({cat.ev} EV)
              </span>
            </label>
            <input
              type="number"
              min="0"
              step="1"
              inputMode="numeric"
              placeholder="0"
              style={{ ...styles.rotacionInput, width: "90px", flexShrink: 0 }}
              value={categorias[cat.id]}
              onChange={(e) =>
                setCategorias((prev) => ({ ...prev, [cat.id]: e.target.value }))
              }
            />
          </div>
        ))}
        {evValido && (
          <p style={{ fontSize: "13px", fontWeight: 700, color: "#2f6a3a", margin: "4px 0 12px" }}>
            Total: {evTotal.toFixed(2)} EV
          </p>
        )}
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

        {!evValido ? (
          <p style={styles.rotacionHint}>Ingresá al menos una categoría para ver el ranking.</p>
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
          {" "}
          Coeficiente de utilización aplicado: 70%.
        </p>
      </div>
    </div>
  );
}
