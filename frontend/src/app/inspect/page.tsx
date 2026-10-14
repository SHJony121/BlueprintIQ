import type { Metadata } from "next";
import { InspectionDashboard } from "@/components/inspection-dashboard";

export const metadata: Metadata = {
  title: "Inspect a drawing",
  description:
    "Upload a one-page engineering drawing PDF, or try a sample, and see its measurements, dimensions and tolerances with the evidence behind each result.",
};

export default function InspectPage() {
  return (
    <main id="main" className="flex flex-1 flex-col">
      <InspectionDashboard />
    </main>
  );
}
