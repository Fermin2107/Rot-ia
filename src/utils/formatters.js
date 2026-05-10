import { EVENTO_TIPOS, TIPOS_PASTO_OPTIONS } from "../constants";

export function formatNdviWindowDate(iso) {
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

export function formatUltimaLluviaLine(ultimoLluvia) {
  if (!ultimoLluvia?.fecha) return "Sin registro de lluvia en este potrero.";
  const mm =
    ultimoLluvia.mm != null && Number.isFinite(Number(ultimoLluvia.mm))
      ? `${ultimoLluvia.mm} mm · `
      : "";
  const fechaStr = formatNdviWindowDate(ultimoLluvia.fecha);
  return `${mm}${fechaStr ?? ""}`.trim() || "Lluvia registrada.";
}

export function formatEventoHistorialFecha(iso) {
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

export function eventoTipoHistorialIcon(tipo) {
  return EVENTO_TIPOS.find((t) => t.id === tipo)?.icon ?? "📌";
}

export function labelTipoPasto(tipoPasto) {
  if (!tipoPasto) return null;
  const o = TIPOS_PASTO_OPTIONS.find((x) => x.id === tipoPasto);
  return o ? o.label : tipoPasto;
}

export function isKnownTipoPastoId(id) {
  return Boolean(id && TIPOS_PASTO_OPTIONS.some((o) => o.id === id));
}

export function formatEvent(tipo, fields) {
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
