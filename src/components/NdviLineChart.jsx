export default function NdviLineChart({ history }) {
  if (!history || history.length < 2) return null;
  const W = 320;
  const H = 110;
  const PX = 28;
  const PY = 14;
  const iW = W - PX * 2;
  const iH = H - PY * 2;
  const means = history.map((p) => p.mean);
  const minV = Math.min(...means, 0);
  const maxV = Math.max(...means, 1);
  const range = maxV - minV || 1;
  const xOf = (i) => PX + (i / (history.length - 1)) * iW;
  const yOf = (v) => PY + iH - ((v - minV) / range) * iH;
  const pathD = history
    .map((p, i) => `${i === 0 ? "M" : "L"}${xOf(i).toFixed(1)},${yOf(p.mean).toFixed(1)}`)
    .join(" ");
  const firstDate = history[0].date.slice(5).replace("-", "/");
  const lastDate = history[history.length - 1].date.slice(5).replace("-", "/");
  const midIdx = Math.floor(history.length / 2);
  const midDate = history[midIdx].date.slice(5).replace("-", "/");
  return (
    <svg
      viewBox={`0 0 ${W} ${H}`}
      style={{ width: "100%", maxWidth: `${W}px`, display: "block", overflow: "visible" }}
    >
      {[0, 0.3, 0.5, 0.8].map((v) => {
        const y = yOf(v);
        if (y < PY - 2 || y > PY + iH + 2) return null;
        return (
          <g key={v}>
            <line x1={PX} y1={y} x2={PX + iW} y2={y} stroke="#e4ede0" strokeWidth="1" />
            <text x={PX - 4} y={y + 4} fontSize="9" fill="#9aaa96" textAnchor="end">
              {v.toFixed(1)}
            </text>
          </g>
        );
      })}
      <path
        d={pathD}
        fill="none"
        stroke="#3d7f49"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {history.map((p, i) => (
        <circle
          key={i}
          cx={xOf(i)}
          cy={yOf(p.mean)}
          r="3"
          fill="#3d7f49"
          stroke="#ffffff"
          strokeWidth="1.5"
        />
      ))}
      <text x={PX} y={H - 2} fontSize="9" fill="#9aaa96" textAnchor="middle">
        {firstDate}
      </text>
      <text x={PX + iW / 2} y={H - 2} fontSize="9" fill="#9aaa96" textAnchor="middle">
        {midDate}
      </text>
      <text x={PX + iW} y={H - 2} fontSize="9" fill="#9aaa96" textAnchor="middle">
        {lastDate}
      </text>
    </svg>
  );
}
