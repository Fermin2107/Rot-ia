import { useState } from "react";
import { EVENTO_TIPOS } from "../constants";

const styles = {
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

export default function EventoForm({ onSave, onClose, saving, parcelas = [], parcelaIdInicial = null }) {
  const [tipo, setTipo] = useState(null);
  const [mm, setMm] = useState("");
  const [producto, setProducto] = useState("");
  const [dosis, setDosis] = useState("");
  const [cantidad, setCantidad] = useState("");
  const [direccion, setDireccion] = useState("entrada");
  const [nota, setNota] = useState("");
  const [fotoName, setFotoName] = useState("");
  const [parcelaId, setParcelaId] = useState(parcelaIdInicial ?? "");

  const canSave = tipo && (
    (tipo === "lluvia" && mm !== "") ||
    (tipo === "fertilizacion" && producto.trim() !== "" && dosis !== "") ||
    (tipo === "movimiento" && cantidad !== "") ||
    (tipo === "foto")
  );

  const handleSave = () => {
    if (!canSave || saving) return;
    onSave(tipo, { mm, producto, dosis, cantidad, direccion, nota, fotoName, parcelaId: parcelaId || null });
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
            {parcelas.length > 0 && (
              <>
                <label style={styles.fieldLabel}>Parcela (opcional)</label>
                <select
                  style={{ ...styles.fieldInput, height: "44px" }}
                  value={parcelaId}
                  onChange={(e) => setParcelaId(e.target.value)}
                >
                  <option value="">Sin parcela específica</option>
                  {parcelas.map((p) => (
                    <option key={p.id} value={p.id}>{p.name}</option>
                  ))}
                </select>
              </>
            )}
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
