// An illustration of sample B (the CAD-style plate), drawn as SVG so it stays sharp and light.
// It is a picture of what the site reports, not a live result: the caption says so.
export function DrawingPreview() {
  return (
    <figure className="m-0">
      <svg
        role="img"
        aria-labelledby="preview-title preview-desc"
        viewBox="0 0 420 300"
        className="h-auto w-full rounded-md border border-line bg-surface"
      >
        <title id="preview-title">Illustration of a dimensioned plate</title>
        <desc id="preview-desc">
          A plate outline with a round hole, three dimensions tied to the drawing lines and one
          dimension that could not be tied to them.
        </desc>
        <defs>
          <pattern id="preview-grid" width="20" height="20" patternUnits="userSpaceOnUse">
            <path d="M20 0H0V20" fill="none" stroke="var(--line)" strokeWidth="0.5" />
          </pattern>
          <marker
            id="preview-tip"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M0 1L10 5L0 9z" fill="var(--accent)" />
          </marker>
        </defs>
        <rect width="420" height="300" fill="url(#preview-grid)" />
        {/* Part outline and hole */}
        <rect x="80" y="80" width="260" height="130" fill="none" stroke="var(--foreground)" strokeWidth="1.6" />
        <circle cx="210" cy="145" r="26" fill="none" stroke="var(--foreground)" strokeWidth="1.6" />
        {/* Overall width, tied to its lines */}
        <path d="M80 214V250M340 214V250" stroke="var(--accent)" strokeWidth="1" />
        <path
          d="M80 244H340"
          stroke="var(--accent)"
          strokeWidth="1.2"
          markerStart="url(#preview-tip)"
          markerEnd="url(#preview-tip)"
        />
        <text x="210" y="238" textAnchor="middle" fontSize="13" fill="var(--foreground)" fontFamily="var(--font-mono)">
          120
        </text>
        {/* Height above with a plus-minus tolerance, tied to its lines */}
        <path d="M110 76V40M310 76V40" stroke="var(--accent)" strokeWidth="1" />
        <path
          d="M110 46H310"
          stroke="var(--accent)"
          strokeWidth="1.2"
          markerStart="url(#preview-tip)"
          markerEnd="url(#preview-tip)"
        />
        <text x="210" y="40" textAnchor="middle" fontSize="13" fill="var(--foreground)" fontFamily="var(--font-mono)">
          88 ±0.1
        </text>
        {/* Diameter leader, tied to the circle */}
        <path d="M228 127L262 93" stroke="var(--accent)" strokeWidth="1.2" markerStart="url(#preview-tip)" />
        <text x="266" y="96" fontSize="13" fill="var(--foreground)" fontFamily="var(--font-mono)">
          Ø20
        </text>
        {/* A dimension that cannot be tied to the drawing lines */}
        <path d="M352 115H408" stroke="var(--review)" strokeWidth="1.2" strokeDasharray="4 3" />
        <text x="372" y="110" fontSize="13" fill="var(--foreground)" fontFamily="var(--font-mono)">
          30
        </text>
      </svg>
      <figcaption className="mt-2 text-xs text-muted">
        Illustration of the CAD-style sample. Blue marks a dimension tied to the lines it refers to;
        the dashed amber one could not be tied and is reported as unresolved, not guessed.
      </figcaption>
    </figure>
  );
}
