import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "IncidentLab — Тренируйте решения при сбоях", description: "Исследуйте сбой, проверяйте решения и возвращайтесь к той же ситуации. Поймите последствия в безопасной симуляции.", icons: { icon: "/incidentlab.svg" } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
