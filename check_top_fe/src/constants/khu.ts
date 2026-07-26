// ── Shared KHU / Department definitions (from production data) ────────────────

export interface Dept {
  id: string;
  name: string;
  /** Tailwind badge class */
  color: string;
  keywords: string[];
  /**
   * Proxy assigned to this KHU — format: "host:port:user:pass"
   * Sent to app as items[].proxy[0] and encoded inside requestId slot[2].
   * If set, overrides the manual proxy input in the modal.
   */
  proxy?: string;
}

// ── Default proxy (can be overridden per KHU below) ─────────────────────────
const DEFAULT_PROXY = "171.229.227.95:48759:ishpo_itweb:QTEaoURA";

export const DEPTS: Dept[] = [
  {
    id: "b74f5303-7e3e-45f6-9cba-10d8e2391406",
    name: "KHU A",
    color: "bg-purple-900/50 text-purple-300 border border-purple-700/30",
    keywords: ["Jun88", "NEW88", "OKVIP", "QQ88", "C168", "78win"],
    proxy: DEFAULT_PROXY,
  },
  {
    id: "626c785e-c6a3-4677-a1dc-20c284928870",
    name: "KHU B",
    color: "bg-blue-900/50 text-blue-300 border border-blue-700/30",
    keywords: ["OPEN88", "socolive", "luongsontv", "cakhiatv", "SC88", "lương sơn tv", "trực tiếp bóng đá"],
    proxy: DEFAULT_PROXY,
  },
  {
    id: "986866b3-0ef3-466a-a2cf-f0fb45120578",
    name: "KHU C",
    color: "bg-emerald-900/50 text-emerald-300 border border-emerald-700/30",
    keywords: ["F168", "SHBET", "CM88"],
    proxy: DEFAULT_PROXY,
  },
  {
    id: "ffdb590a-39ed-4cfe-a91d-a9c52a458f71",
    name: "KHU D",
    color: "bg-orange-900/50 text-orange-300 border border-orange-700/30",
    keywords: ["Hi88", "FLY88", "78win", "F168", "MB66", "78WIN", "789BET", "NEW88", "MK8"],
    proxy: DEFAULT_PROXY,
  },
  {
    id: "f2ae49b5-7fb5-443a-b856-77ca56e20765",
    name: "KHU E",
    color: "bg-pink-900/50 text-pink-300 border border-pink-700/30",
    keywords: ["MB66", "OK8386", "789BET", "phimhayok", "phimmoi", "motphim", "motchill", "phim moi", "rophim"],
    proxy: DEFAULT_PROXY,
  },
];

/** Map KHU name (uppercase) → Tailwind badge class */
export const KHU_BADGE: Record<string, string> = Object.fromEntries(
  DEPTS.map((d) => [d.name.toUpperCase(), d.color])
);

/** Look up dept by id */
export function deptById(id: string): Dept | undefined {
  return DEPTS.find((d) => d.id === id);
}
