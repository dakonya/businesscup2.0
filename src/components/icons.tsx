import type { ReactNode } from "react";

export type IconName =
  | "play" | "pause" | "rewind" | "arrow" | "right" | "check"
  | "clock" | "save" | "chevron" | "close" | "sparkles" | "search"
  | "external" | "plus" | "terminal" | "chart" | "activity"
  | "settings" | "refresh" | "database" | "server";

const paths: Record<IconName, ReactNode> = {
  play: <path d="m9 5 11 7-11 7V5Z" />,
  pause: <><path d="M8 5v14M16 5v14" /></>,
  rewind: <><path d="M8 8H3V3M3.5 8a9 9 0 1 1-.5 7" /><path d="M12 7v5l3 2" /></>,
  arrow: <path d="M4 12h16m-6-6 6 6-6 6" />,
  right: <path d="m9 5 7 7-7 7" />,
  check: <path d="m5 12 4 4L19 6" />,
  clock: <><circle cx="12" cy="12" r="9" /><path d="M12 7v5l3 2" /></>,
  save: <><path d="M5 3h12l4 4v14H3V3h2Zm1 0v6h11V3M7 21v-8h10v8" /></>,
  chevron: <path d="m6 9 6 6 6-6" />,
  close: <path d="m6 6 12 12M6 18 18 6" />,
  sparkles: <><path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5L12 3Z" /><path d="m20 2 .5 1.5L22 4l-1.5.5L20 6l-.5-1.5L18 4l1.5-.5L20 2Z" /></>,
  search: <><circle cx="10.5" cy="10.5" r="6.5" /><path d="m16 16 5 5" /></>,
  external: <><path d="M14 3h7v7M21 3 10 14M10 3H3v18h18v-7" /></>,
  plus: <path d="M12 5v14M5 12h14" />,
  terminal: <><rect x="3" y="4" width="18" height="16" rx="3" /><path d="m7 9 3 3-3 3m6 0h4" /></>,
  chart: <><path d="M4 4v16h17M8 15l4-5 4 2 5-7" /></>,
  activity: <path d="M2 12h5l3-8 4 16 3-8h5" />,
  settings: <><path d="M4 6h4m6 0h6M4 12h10m6 0h0M4 18h2m6 0h8" /><circle cx="11" cy="6" r="3" /><circle cx="17" cy="12" r="3" /><circle cx="9" cy="18" r="3" /></>,
  refresh: <><path d="M20 8a8.5 8.5 0 0 0-14-3L3 8m0-5v5h5M4 16a8.5 8.5 0 0 0 14 3l3-3m0 5v-5h-5" /></>,
  database: <><ellipse cx="12" cy="5" rx="8" ry="3" /><path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" /></>,
  server: <><rect x="3" y="3" width="18" height="7" rx="2" /><rect x="3" y="14" width="18" height="7" rx="2" /><path d="M7 6.5h.01M7 17.5h.01M12 6.5h5m-5 11h5" /></>,
};

export function Icon({ name, size = 20, className }: {
  name: IconName;
  size?: number;
  className?: string;
}) {
  return <svg className={className} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{paths[name]}</svg>;
}

export function IncidentLogo({ className }: { className?: string }) {
  return (
    <svg className={className} width="38" height="38" viewBox="0 0 40 40" fill="none" aria-label="IncidentLab" role="img">
      <rect width="40" height="40" rx="11" fill="currentColor" />
      <path d="M10 12h7m-3.5 0v16M10 28h7m5-16v16h8" stroke="white" strokeWidth="2.8" strokeLinecap="square" strokeLinejoin="round" />
      <path d="M28 10h3v3" stroke="#B7D0FF" strokeWidth="2" />
    </svg>
  );
}
