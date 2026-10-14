import { ImageResponse } from "next/og";

export const dynamic = "force-static";

const size = { width: 1200, height: 630 };

// The social-preview image, generated once at build time. Plain shapes and system fonts only.
// The root layout links it only when NEXT_PUBLIC_SITE_URL gives it an absolute address.
export function GET() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "center",
          padding: 80,
          background: "#f4f5f7",
          color: "#14181f",
        }}
      >
        <div style={{ display: "flex", fontSize: 30, color: "#23549f", letterSpacing: 4 }}>
          ENGINEERING DRAWING INSPECTION
        </div>
        <div style={{ display: "flex", fontSize: 92, fontWeight: 700, marginTop: 24 }}>BlueprintIQ</div>
        <div style={{ display: "flex", fontSize: 38, marginTop: 28, color: "#566170", maxWidth: 900 }}>
          Check a drawing against your limits, with the evidence beside every result.
        </div>
        <div style={{ display: "flex", fontSize: 26, marginTop: 56, color: "#566170" }}>
          Assistive prototype. Not certified compliance software.
        </div>
      </div>
    ),
    size,
  );
}
