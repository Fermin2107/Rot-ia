import {
  COEFICIENTE_UTILIZACION,
  KG_MS_PER_HA_NDVI_FACTOR,
  ROTACION_UI_DIAS_ESTIMADOS_MAX,
} from "../constants";
import { leafletRingAreaHectares } from "./geo";
import { descansoFromUltimoMovimiento } from "./motorDescanso";

export function rotationRankTier(row) {
  if (row.enUso) return 4;
  if (row.ndviCargando) return 2;
  if (row.ndvi == null) return 3;
  return 1;
}

/**
 * @param {number} heads
 * @param {number} kgMsPorCabezaDia
 */
export function buildRotationRanking(potreros, ndviById, heads, kgMsPorCabezaDia) {
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
      heads > 0 &&
      kgMsPorCabezaDia > 0
    ) {
      const msPotrero = areaHa * ndvi * KG_MS_PER_HA_NDVI_FACTOR * COEFICIENTE_UTILIZACION;
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

export function formatDiasEstimados(d) {
  if (d == null || !Number.isFinite(d) || d < 0) return "—";
  if (d > ROTACION_UI_DIAS_ESTIMADOS_MAX) return "—";
  if (d >= 100) return `${Math.round(d)} días`;
  if (d >= 10) return `${d.toFixed(1)} días`;
  return `${d.toFixed(2)} días`;
}
