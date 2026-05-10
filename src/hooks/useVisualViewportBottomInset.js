import { useState, useEffect } from "react";

const VISUAL_VIEWPORT_BOTTOM_BUFFER_PX = 12;

/**
 * Píxeles entre el borde inferior del layout viewport y el del visual viewport
 * (teclado + chrome inferior en Safari móvil). Sumar al `bottom` de UI `position: fixed`.
 */
export function useVisualViewportBottomInset() {
  const [insetPx, setInsetPx] = useState(0);

  useEffect(() => {
    if (typeof window === "undefined") return undefined;
    const vv = window.visualViewport;
    if (!vv) return undefined;

    const compute = () => {
      const layoutH = window.innerHeight;
      const visibleBottom = vv.offsetTop + vv.height;
      const overlap = Math.max(0, layoutH - visibleBottom);
      setInsetPx(Math.round(overlap + VISUAL_VIEWPORT_BOTTOM_BUFFER_PX));
    };

    compute();
    vv.addEventListener("resize", compute);
    vv.addEventListener("scroll", compute);
    window.addEventListener("resize", compute);

    return () => {
      vv.removeEventListener("resize", compute);
      vv.removeEventListener("scroll", compute);
      window.removeEventListener("resize", compute);
    };
  }, []);

  return insetPx;
}
