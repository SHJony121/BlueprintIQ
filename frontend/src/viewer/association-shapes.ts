// Geometry of a feature association, from the backend's page space to viewport pixels.
//
// Pure functions: the viewport transform is PDF.js's own, passed in, exactly as for the
// evidence boxes (geometry.ts), so rotation, scale and the crop-box offset are applied by
// the same code that paints the canvas. Curves are drawn as polylines of points that are
// each transformed, so the result is correct under any transform.
import type { FeatureAssociation, GeometryElement, PageInfo } from "@/api/types";
import { applyMatrix, pageToPdf, type Matrix } from "./geometry";

export type Point = readonly [number, number];

export interface DrawShape {
  role: GeometryElement["role"];
  /** Part of the associated feature itself (true) or supporting evidence (false). */
  feature: boolean;
  kind: "polyline" | "polygon" | "marker";
  points: readonly Point[];
}

const CIRCLE_STEPS = 72;
const ARC_STEPS = 48;

/** Everything to draw for one association, in viewport pixels. */
export function associationShapes(association: FeatureAssociation, page: PageInfo, transform: Matrix): DrawShape[] {
  const to = (x: number, y: number): Point => {
    const [px, py] = pageToPdf(page, x, y);
    return applyMatrix(transform, px, py);
  };
  const shapes: DrawShape[] = [];
  for (const [elements, feature] of [
    [association.evidence, false],
    [association.feature, true],
  ] as const) {
    for (const element of elements) shapes.push(shapeOf(element, feature, to));
  }
  return shapes;
}

function shapeOf(element: GeometryElement, feature: boolean, to: (x: number, y: number) => Point): DrawShape {
  const c = element.coords;
  const base = { role: element.role, feature };
  switch (element.shape) {
    case "line":
      return { ...base, kind: "polyline", points: [to(c[0]!, c[1]!), to(c[2]!, c[3]!)] };
    case "point":
      return { ...base, kind: "marker", points: [to(c[0]!, c[1]!)] };
    case "box":
      return {
        ...base,
        kind: "polygon",
        points: [to(c[0]!, c[1]!), to(c[2]!, c[1]!), to(c[2]!, c[3]!), to(c[0]!, c[3]!)],
      };
    case "circle":
      return { ...base, kind: "polygon", points: sample(c[0]!, c[1]!, c[2]!, 0, 2 * Math.PI, CIRCLE_STEPS, true, to) };
    case "arc": {
      const start = (c[3]! * Math.PI) / 180;
      const sweep = (c[4]! * Math.PI) / 180;
      return { ...base, kind: "polyline", points: sample(c[0]!, c[1]!, c[2]!, start, sweep, ARC_STEPS, false, to) };
    }
  }
}

function sample(
  cx: number,
  cy: number,
  r: number,
  start: number,
  sweep: number,
  steps: number,
  closed: boolean,
  to: (x: number, y: number) => Point,
): Point[] {
  const count = closed ? steps : steps + 1;
  return Array.from({ length: count }, (_, i) => {
    const t = start + (sweep * i) / steps;
    return to(cx + r * Math.cos(t), cy + r * Math.sin(t));
  });
}

/** The smallest rectangle (viewport pixels) holding every shape, or null for none. */
export function shapesBounds(shapes: readonly DrawShape[]): { left: number; top: number; right: number; bottom: number } | null {
  const points = shapes.flatMap((s) => s.points);
  if (points.length === 0) return null;
  const xs = points.map((p) => p[0]);
  const ys = points.map((p) => p[1]);
  return { left: Math.min(...xs), top: Math.min(...ys), right: Math.max(...xs), bottom: Math.max(...ys) };
}
