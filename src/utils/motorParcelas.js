import { leafletRingAreaHectares } from "./geo";

export { leafletRingAreaHectares };

/**
 * Devuelve true si el polígono es suficientemente grande para
 * consultar Sentinel-2 directamente.
 */
export function parcelaEsGrandeParagNDVI(positions) {
  const ha = leafletRingAreaHectares(positions);
  return ha != null && ha >= 5;
}

// ─── Álgebra 2D en coordenadas planas ────────────────────────────────────────
// Convertimos lat/lng a metros locales para que las distancias sean correctas.
// Origen = centroide del polígono.

function toMeters(ring) {
  const latC = ring.reduce((s, p) => s + p[0], 0) / ring.length;
  const lngC = ring.reduce((s, p) => s + p[1], 0) / ring.length;
  const mPerLat = 111320;
  const mPerLng = 111320 * Math.cos((latC * Math.PI) / 180);
  return {
    pts: ring.map(([lat, lng]) => [
      (lng - lngC) * mPerLng,
      (lat - latC) * mPerLat,
    ]),
    latC,
    lngC,
    mPerLat,
    mPerLng,
  };
}

function fromMeters(pts, latC, lngC, mPerLat, mPerLng) {
  return pts.map(([x, y]) => [y / mPerLat + latC, x / mPerLng + lngC]);
}

/** Proyecta punto p sobre eje unitario u */
function dot(p, u) { return p[0] * u[0] + p[1] * u[1]; }

/**
 * Calcula el ángulo (rad) del eje más largo del polígono usando PCA
 * sobre los vértices. Devuelve el ángulo del primer componente principal.
 * @param {number[][]} pts - puntos en metros [x, y]
 * @returns {number} ángulo en radianes
 */
function mainAxisAngle(pts) {
  const n = pts.length;
  const mx = pts.reduce((s, p) => s + p[0], 0) / n;
  const my = pts.reduce((s, p) => s + p[1], 0) / n;
  let sxx = 0, sxy = 0, syy = 0;
  for (const [x, y] of pts) {
    const dx = x - mx, dy = y - my;
    sxx += dx * dx; sxy += dx * dy; syy += dy * dy;
  }
  // Eigenvector del mayor eigenvalor de [[sxx,sxy],[sxy,syy]]
  const angle = 0.5 * Math.atan2(2 * sxy, sxx - syy);
  return angle;
}

// ─── Sutherland-Hodgman en coordenadas proyectadas ───────────────────────────

/**
 * Clip de polígono 2D contra semiplano: side='left' mantiene puntos
 * con proyección sobre u >= threshold; side='right' <= threshold.
 */
function clipAgainstPlane(poly, u, threshold, side) {
  if (poly.length === 0) return [];
  const inside = (p) =>
    side === "left" ? dot(p, u) >= threshold : dot(p, u) <= threshold;
  const intersect = (a, b) => {
    const da = dot(a, u), db = dot(b, u);
    const t = (threshold - da) / (db - da);
    return [a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])];
  };
  const closed = [...poly];
  if (closed[0][0] !== closed[closed.length-1][0] ||
      closed[0][1] !== closed[closed.length-1][1]) closed.push(closed[0]);

  const out = [];
  for (let j = 0; j < closed.length - 1; j++) {
    const cur = closed[j], nxt = closed[j+1];
    const ci = inside(cur), ni = inside(nxt);
    if (ci && ni)       out.push(nxt);
    else if (ci && !ni) out.push(intersect(cur, nxt));
    else if (!ci && ni) { out.push(intersect(cur, nxt)); out.push(nxt); }
  }
  return out;
}

/**
 * Divide el polígono en N franjas paralelas al eje principal (o al ángulo dado).
 * @param {number[][]} ring  - [lat, lng][] cerrado o abierto
 * @param {number} n
 * @param {number} [angleDeg=null] - ángulo en grados (0=horizontal). null = automático
 * @returns {number[][][]}   - N anillos [lat, lng][]
 */
export function dividirEnFranjas(ring, n, angleDeg = null) {
  if (!ring || ring.length < 3 || n < 2) return [];

  const { pts, latC, lngC, mPerLat, mPerLng } = toMeters(ring);

  // Eje principal: perpendicular a las franjas
  let angle;
  if (angleDeg !== null) {
    angle = (angleDeg * Math.PI) / 180;
  } else {
    // PCA: eje largo del polígono → las franjas corren paralelas a él
    // El eje de corte es el perpendicular
    angle = mainAxisAngle(pts) + Math.PI / 2;
  }

  // Vector unitario perpendicular a las franjas (eje de división)
  const u = [Math.cos(angle), Math.sin(angle)];

  // Proyecciones de todos los vértices sobre u
  const projs = pts.map(p => dot(p, u));
  const minP = Math.min(...projs);
  const maxP = Math.max(...projs);
  const step = (maxP - minP) / n;

  const result = [];
  for (let i = 0; i < n; i++) {
    const pLow  = minP + i * step;
    const pHigh = minP + (i + 1) * step;
    let clipped = clipAgainstPlane(pts, u, pLow,  'left');
    clipped      = clipAgainstPlane(clipped, u, pHigh, 'right');
    if (clipped.length >= 3) {
      result.push(fromMeters(clipped, latC, lngC, mPerLat, mPerLng));
    }
  }
  return result;
}

/**
 * Dado un array de parcelas con su NDVI y días de descanso,
 * devuelve el id de la parcela sugerida para entrar.
 */
export function sugerirProximaParcela(parcelas) {
  const candidatas = parcelas.filter(p => !p.enUso);
  if (candidatas.length === 0) return null;
  candidatas.sort((a, b) => {
    const da = a.diasDescanso ?? -1, db = b.diasDescanso ?? -1;
    if (da !== db) return db - da;
    return (b.ndvi ?? -1) - (a.ndvi ?? -1);
  });
  return candidatas[0].id;
}

/**
 * Genera texto de sugerencia de callejón (se mantiene para uso futuro).
 */
export function sugerirCallejon(ring, nParcelas) {
  const area = leafletRingAreaHectares(ring);
  if (!area || nParcelas < 2) return "";
  const lngs = ring.map(([, lng]) => lng);
  const anchoM = Math.round((Math.max(...lngs) - Math.min(...lngs)) * 85000);
  const anchoCallejon = Math.max(4, Math.round(anchoM * 0.03));
  return `Sugerencia: callejón de aprox. ${anchoCallejon} m de ancho.`;
}
