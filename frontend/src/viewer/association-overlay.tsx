import type { DrawShape } from "./association-shapes";

/**
 * The geometry of one selected association over the page: the feature itself drawn thick
 * in the accent colour, the supporting evidence (leader, dimension line, arrowheads, the
 * text's box) thinner. Roles differ in line style as well as weight, so colour is never
 * the only cue. The layer takes no pointer events.
 */
export function AssociationOverlay({
  shapes,
  size,
  label,
}: {
  shapes: readonly DrawShape[];
  size: { width: number; height: number };
  label: string;
}) {
  return (
    <svg
      data-testid="association-layer"
      role="img"
      aria-label={label}
      width={size.width}
      height={size.height}
      viewBox={`0 0 ${size.width} ${size.height}`}
      className="pointer-events-none absolute inset-0 text-accent"
    >
      {shapes.map((shape, index) => (
        <Shape key={index} shape={shape} />
      ))}
    </svg>
  );
}

function Shape({ shape }: { shape: DrawShape }) {
  const points = shape.points.map(([x, y]) => `${x.toFixed(2)},${y.toFixed(2)}`).join(" ");
  const common = { "data-role": shape.role, "data-feature": shape.feature ? "true" : "false" } as const;
  if (shape.kind === "marker") {
    const [x, y] = shape.points[0]!;
    return <circle {...common} cx={x} cy={y} r={3.5} fill="currentColor" stroke="var(--surface, white)" strokeWidth={1} />;
  }
  const style = shape.feature
    ? { strokeWidth: 3.5, strokeDasharray: undefined }
    : shape.role === "text"
      ? { strokeWidth: 1.5, strokeDasharray: "4 3" }
      : { strokeWidth: 1.75, strokeDasharray: "7 3" };
  return shape.kind === "polygon" ? (
    <polygon {...common} points={points} fill="none" stroke="currentColor" {...style} strokeLinejoin="round" />
  ) : (
    <polyline {...common} points={points} fill="none" stroke="currentColor" {...style} strokeLinecap="round" strokeLinejoin="round" />
  );
}
