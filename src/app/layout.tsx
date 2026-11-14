import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "IncidentLab — Practice incident decisions", description: "Practice incident decisions. Rewind. Understand the consequences. A simulated on-call workspace.", icons: { icon: "/incidentlab.svg" } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="en"><body>{children}</body></html>;
}
