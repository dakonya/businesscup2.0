import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = { title: "IncidentLab — Сервис тормозит. Попробуй разобраться.", description: "Посмотри метрики, измени настройку и проверь результат. Можно вернуться назад и попробовать другое решение при той же нагрузке.", authors: [{ name: "nexelle" }], icons: { icon: "/incidentlab.svg" } };
export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return <html lang="ru"><body>{children}</body></html>;
}
