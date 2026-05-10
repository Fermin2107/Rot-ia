export const ARGENTINA_CENTER = [-38.4161, -63.6167];
export const CLICK_DEBOUNCE_MS = 280;
export const CAMPO_STORAGE_KEY = "rotia_campo_id";

/** sessionStorage: no volver a mostrar el aviso de potreros listos en esta sesión. */
export const LISTOS_BANNER_SESSION_KEY = "rotia_listos_descanso_banner_dismissed";

/** Clave en `campos.descanso_bases_dias` para potreros sin tipo_pasto / otro. */
export const DESCANSO_BASE_KEY_SIN_ESPECIFICAR = "sin_especificar";

export const EVENTO_TIPOS = [
  { id: "lluvia", label: "Lluvia", icon: "🌧️" },
  { id: "fertilizacion", label: "Fertilización", icon: "🌱" },
  { id: "movimiento", label: "Movimiento", icon: "🐄" },
  { id: "foto", label: "Foto", icon: "📷" },
];

/** Valores persistidos en potreros.tipo_pasto (text, opcional). */
export const TIPO_PASTO_IDS = {
  FESTUCA: "festuca",
  RAIGRAS: "raigras",
  CAMPO_NATURAL: "campo_natural",
  VERDEO: "verdeo",
  OTRO: "otro",
};

export const TIPOS_PASTO_OPTIONS = [
  { id: TIPO_PASTO_IDS.FESTUCA, label: "Festuca" },
  { id: TIPO_PASTO_IDS.RAIGRAS, label: "Raigrás" },
  { id: TIPO_PASTO_IDS.CAMPO_NATURAL, label: "Campo natural" },
  { id: TIPO_PASTO_IDS.VERDEO, label: "Verdeo" },
  { id: TIPO_PASTO_IDS.OTRO, label: "Otro" },
];

/** Defaults del motor de descanso (días); editables por campo en ⚙️. */
export const DEFAULT_DESCANSO_BASES_DIAS = {
  [TIPO_PASTO_IDS.FESTUCA]: 75,
  [TIPO_PASTO_IDS.RAIGRAS]: 52,
  [TIPO_PASTO_IDS.CAMPO_NATURAL]: 105,
  [TIPO_PASTO_IDS.VERDEO]: 37,
  [DESCANSO_BASE_KEY_SIN_ESPECIFICAR]: 60,
};

export const CATEGORIAS_HACIENDA = [
  { id: "vaca_toro", label: "Vaca de cría / Toro", ev: 1.00 },
  { id: "novillo_2mas", label: "Novillo/Vaquillona +2 años", ev: 0.90 },
  { id: "novillo_1a2", label: "Novillo/Vaquillona 1-2 años", ev: 0.70 },
  { id: "ternero", label: "Ternero/a -1 año", ev: 0.40 },
];

export const COEFICIENTE_UTILIZACION = 0.70;

/** Por encima de este umbral los días estimados del motor de rotación se muestran como "—" (UI). */
export const ROTACION_UI_DIAS_ESTIMADOS_MAX = 365;

/** kg materia seca/hectárea ≈ NDVI × este factor (aproximación inicial). */
export const KG_MS_PER_HA_NDVI_FACTOR = 3000;

export const CONSUMO_MS_CABEZA_DIA_MIN = 10;
export const CONSUMO_MS_CABEZA_DIA_MAX = 12;
export const CONSUMO_MS_CABEZA_DIA_DEFAULT = 11;

/** Identificación para políticas de uso de Nominatim (el navegador puede sobrescribir User-Agent). */
export const NOMINATIM_APP_ID = "RotiaCampoApp/1.0";

export const PARCELAS_MAX = 20; // máximo de parcelas por potrero
export const PARCELAS_MIN = 2; // mínimo para dividir
