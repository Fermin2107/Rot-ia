import {
  DEFAULT_DESCANSO_BASES_DIAS,
  DESCANSO_BASE_KEY_SIN_ESPECIFICAR,
} from "../constants";
import { calendarDaysBetween } from "./geo";

/**
 * Fusiona overrides de `campos.descanso_bases_dias` con defaults.
 * @param {unknown} dbJson
 * @returns {Record<string, number>}
 */
export function mergeDescansoBasesDias(dbJson) {
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

export function baseDiasDescansoForTipo(tipoPasto, bases) {
  if (tipoPasto && bases[tipoPasto] != null) return bases[tipoPasto];
  return bases[DESCANSO_BASE_KEY_SIN_ESPECIFICAR];
}

/** Hemisferio sur: primavera sep–nov, verano seco dic–feb, otoño mar–may, invierno jun–ago. */
export function seasonMultiplierDescanso(date) {
  const m = date.getMonth();
  if (m === 8 || m === 9 || m === 10) return 0.7;
  if (m === 11 || m === 0 || m === 1) return 1.3;
  if (m >= 2 && m <= 4) return 0.9;
  return 1.1;
}

/** @param {{ fecha: string, direccion?: string } | null | undefined} ultimo */
export function descansoFromUltimoMovimiento(ultimo) {
  if (!ultimo?.fecha) return { kind: "sin_datos" };
  const dir = ultimo.direccion;
  if (dir !== "entrada" && dir !== "salida") return { kind: "sin_datos" };
  if (dir === "entrada") return { kind: "en_uso" };
  const days = calendarDaysBetween(new Date(ultimo.fecha), new Date());
  return { kind: "descanso", days };
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
export function computeDescansoInteligente(p) {
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
export function pastoreoCabezasUltimaAntesDeSalida(movRowsDesc) {
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
