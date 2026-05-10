import { useState } from "react";
import { TIPOS_PASTO_OPTIONS, EVENTO_TIPOS, PARCELAS_MIN, PARCELAS_MAX } from "../constants";
import { sugerirProximaParcela } from "../utils/motorParcelas";
import { leafletRingAreaHectares } from "../utils/geo";
import {
  labelTipoPasto,
  isKnownTipoPastoId,
  formatNdviWindowDate,
  formatUltimaLluviaLine,
  formatEventoHistorialFecha,
  eventoTipoHistorialIcon,
} from "../utils/formatters";
import NdviLineChart from "./NdviLineChart";

const styles = {
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
  parcelasTab: {
    display: "flex", flexDirection: "column", gap: "10px", flex: "1 1 auto", minHeight: 0, overflowY: "auto",
    padding: "4px 0",
  },
  parcelasLead: { margin: 0, fontSize: "13px", fontWeight: 600, color: "#4a6652", lineHeight: 1.45 },
  parcelasLabel: { fontSize: "13px", fontWeight: 700, color: "#355c3b", display: "block" },
  parcelasInputRow: { display: "flex", gap: "8px", alignItems: "center" },
  parcelasInput: {
    width: "80px", height: "44px", borderRadius: "12px", border: "1px solid #cddcc8", backgroundColor: "#f7faf5",
    padding: "0 12px", fontSize: "16px", outline: "none", color: "#2a3f2f", boxSizing: "border-box",
  },
  parcelasPrimaryBtn: {
    flex: 1, height: "44px", borderRadius: "12px", border: "none", backgroundColor: "#3d7f49", color: "#ffffff",
    fontSize: "14px", fontWeight: 800, cursor: "pointer", WebkitTapHighlightColor: "transparent",
  },
  parcelasSugerencia: {
    margin: 0, fontSize: "13px", fontWeight: 600, color: "#1f3d28", lineHeight: 1.45, backgroundColor: "#eaf4eb",
    borderRadius: "10px", padding: "8px 10px",
  },
  parcelasList: { display: "flex", flexDirection: "column", gap: "6px" },
  parcelaChip: {
    display: "flex", justifyContent: "space-between", alignItems: "center", padding: "10px 12px", borderRadius: "12px",
    border: "1px solid #cddcc8", backgroundColor: "#f7faf5", cursor: "pointer", textAlign: "left",
    WebkitTapHighlightColor: "transparent",
  },
  parcelaChipSelected: { borderColor: "#1a5c8a", backgroundColor: "#e8f4ff" },
  parcelaChipName: { fontSize: "14px", fontWeight: 700, color: "#1f3d28" },
  parcelasDeleteBtn: {
    marginTop: "4px", height: "40px", borderRadius: "12px", border: "1px solid #e8a0a0", backgroundColor: "#fff0f0",
    color: "#8b2f2f", fontSize: "13px", fontWeight: 700, cursor: "pointer", WebkitTapHighlightColor: "transparent",
  },
};

/** Convierte positions de Supabase a anillo [lat, lng] para `leafletRingAreaHectares`. */
function leafletRingFromParcelPositions(positions) {
  if (!Array.isArray(positions) || positions.length < 3) return null;
  const out = [];
  for (const pt of positions) {
    if (Array.isArray(pt)) {
      const lat = Number(pt[0]);
      const lng = Number(pt[1]);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      out.push([lat, lng]);
    } else if (pt && typeof pt === "object" && "lat" in pt) {
      const lat = Number(pt.lat);
      const lng = Number(pt.lng);
      if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
      out.push([lat, lng]);
    } else return null;
  }
  return out;
}

function ParcelasTab({
  potrero, parcelas, ndviByParcela, selectedParcela, onSelectParcela, onCrearParcelas, onEliminarParcelas,
}) {
  const [nStr, setNStr] = useState("3");
  const [creando, setCreando] = useState(false);
  const [angleDeg, setAngleDeg] = useState(null); // null = automático
  const [angleInputStr, setAngleInputStr] = useState("");

  const n = parseInt(nStr, 10);
  const nValido = Number.isFinite(n) && n >= PARCELAS_MIN && n <= PARCELAS_MAX;
  const tieneParcelas = parcelas.length > 0;

  const sugerencia = tieneParcelas
    ? sugerirProximaParcela(parcelas.map((p) => ({
      id: p.id,
      name: p.name,
      ndvi: ndviByParcela[p.id]?.meanNdvi ?? null,
      diasDescanso: null, // se enriquecerá en Bloque D
      enUso: false, // se enriquecerá con eventos
    })))
    : null;

  const handleCrear = async () => {
    if (!nValido || creando) return;
    setCreando(true);
    await onCrearParcelas(potrero.id, potrero.positions, n, angleDeg);
    setCreando(false);
  };

  return (
    <div style={styles.parcelasTab}>
      {!tieneParcelas ? (
        <>
          <p style={styles.parcelasLead}>
            Dividí este potrero en franjas paralelas. Cada parcela tendrá su propio NDVI y estado de descanso.
          </p>
          <label style={styles.parcelasLabel}>Cantidad de parcelas</label>
          <div style={styles.parcelasInputRow}>
            <input
              type="number"
              min={PARCELAS_MIN}
              max={PARCELAS_MAX}
              step="1"
              inputMode="numeric"
              style={styles.parcelasInput}
              value={nStr}
              onChange={(e) => setNStr(e.target.value)}
            />
          </div>
          <div style={{ marginBottom: 10 }}>
            <label style={{ fontSize: 13, color: "#555", display: "block", marginBottom: 4 }}>
              Orientación de franjas
            </label>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <input
                type="number"
                min="-90"
                max="90"
                placeholder="Auto"
                value={angleInputStr}
                onChange={(e) => {
                  setAngleInputStr(e.target.value);
                  const v = parseFloat(e.target.value);
                  setAngleDeg(Number.isFinite(v) ? v : null);
                }}
                style={{
                  width: 72,
                  padding: "6px 8px",
                  borderRadius: 8,
                  border: "1px solid #ccc",
                  fontSize: 14,
                }}
              />
              <span style={{ fontSize: 12, color: "#888" }}>
                grados (vacío = automático según forma del lote)
              </span>
            </div>
          </div>
          <button
            type="button"
            style={{
              ...styles.parcelasPrimaryBtn,
              width: "100%",
              opacity: nValido && !creando ? 1 : 0.45,
              cursor: nValido && !creando ? "pointer" : "not-allowed",
            }}
            onClick={handleCrear}
            disabled={!nValido || creando}
          >
            {creando ? "Creando…" : "Dividir potrero"}
          </button>
        </>
      ) : (
        <>
          {sugerencia && (
            <p style={styles.parcelasSugerencia}>
              ✅ Sugerencia: entrá a <strong>{parcelas.find((p) => p.id === sugerencia)?.name}</strong> (mejor NDVI disponible).
            </p>
          )}
          <div style={styles.parcelasList}>
            {parcelas.map((p, idx) => {
              const ndviEntry = ndviByParcela[p.id];
              const isSelected = selectedParcela?.id === p.id;
              const ndviDisplay =
                !ndviEntry || ndviEntry.status === "loading" ? "…"
                  : ndviEntry.status === "error" ? "Error"
                    : ndviEntry.meanNdvi != null ? ndviEntry.meanNdvi.toFixed(2)
                      : "—";
              const ndviColor =
                ndviEntry?.tier === "high" ? "#2e7d32"
                  : ndviEntry?.tier === "mid" ? "#f57c00"
                    : ndviEntry?.tier === "low" ? "#c62828" : "#888";
              const esHeredado = ndviEntry?.heredado === true;
              const ringForArea = leafletRingFromParcelPositions(p.positions);
              const areaHa = ringForArea ? leafletRingAreaHectares(ringForArea) : null;
              const areaStr = areaHa != null ? `${areaHa.toFixed(1)} ha` : "";
              return (
                <button
                  key={p.id}
                  type="button"
                  style={{
                    ...styles.parcelaChip,
                    ...(isSelected ? styles.parcelaChipSelected : {}),
                  }}
                  onClick={() => onSelectParcela(isSelected ? null : p)}
                >
                  <span
                    style={{
                      display: "flex",
                      flexDirection: "column",
                      alignItems: "flex-start",
                      gap: 2,
                      textAlign: "left",
                    }}
                  >
                    <span style={styles.parcelaChipName}>#{idx + 1} {p.name}</span>
                    <span style={{ fontSize: 11, color: "#888" }}>{areaStr}</span>
                  </span>
                  <span style={{ fontSize: "13px", color: "#1f3d28" }}>
                    NDVI{" "}
                    <span style={{ fontWeight: 600, color: ndviColor }}>
                      {ndviDisplay}
                      {esHeredado && (
                        <span style={{ fontSize: 10, color: "#999", fontWeight: 400, marginLeft: 4 }}>
                          (lote)
                        </span>
                      )}
                    </span>
                  </span>
                </button>
              );
            })}
          </div>
          <button
            type="button"
            style={styles.parcelasDeleteBtn}
            onClick={() => onEliminarParcelas(potrero.id)}
          >
            Eliminar parcelas
          </button>
        </>
      )}
    </div>
  );
}

export default function PotreroSheet({
  selectedPotrero, sheetEntered, sheetTab, setSheetTab,
  ndviEntry, motorSheet, aguadas, historialRows, historialLoading, historialError,
  potreroSheetError, showEditNombreDialog, setShowEditNombreDialog,
  editNombreSheet, setEditNombreSheet, editTipoPastoSheet, setEditTipoPastoSheet,
  savingEditNombre, showDeleteConfirm, setShowDeleteConfirm, deletingPotrero,
  onClose, onSaveEdit, onConfirmDelete, onAguadaChange, onRegistrarEvento,
  setPotreroSheetError = () => {},
  parcelas = [],
  ndviByParcela = {},
  onCrearParcelas,
  onEliminarParcelas,
  selectedParcela = null,
  onSelectParcela,
}) {
  return (
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
        onClick={onClose}
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
          <button type="button" style={styles.sheetClose} onClick={onClose}
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
          <button
            type="button"
            role="tab"
            aria-selected={sheetTab === "parcelas"}
            style={{
              ...styles.sheetTab,
              ...(sheetTab === "parcelas" ? styles.sheetTabActive : {}),
            }}
            onClick={() => setSheetTab("parcelas")}
          >
            Parcelas
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
                  {ndviEntry.history?.length >= 2 && (
                    <div style={{ marginTop: "10px" }}>
                      <p
                        style={{
                          margin: "0 0 6px",
                          fontSize: "11px",
                          fontWeight: 700,
                          color: "#5a7058",
                        }}
                      >
                        NDVI últimos 90 días
                      </p>
                      <NdviLineChart history={ndviEntry.history} />
                    </div>
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
                onChange={(e) => { void onAguadaChange(e.target.value); }}
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
        ) : sheetTab === "historial" ? (
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
        ) : null}

        {sheetTab === "parcelas" && (
          <ParcelasTab
            potrero={selectedPotrero}
            parcelas={parcelas}
            ndviByParcela={ndviByParcela}
            selectedParcela={selectedParcela}
            onSelectParcela={onSelectParcela}
            onCrearParcelas={onCrearParcelas}
            onEliminarParcelas={onEliminarParcelas}
          />
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
          onClick={onRegistrarEvento}>
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
                onClick={onSaveEdit}
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
                onClick={onConfirmDelete}
                disabled={deletingPotrero}
              >
                {deletingPotrero ? "Eliminando…" : "Eliminar"}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}
