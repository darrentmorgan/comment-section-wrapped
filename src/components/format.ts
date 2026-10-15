const nf = new Intl.NumberFormat("en-US");
export const fmtInt = (n: number) => nf.format(Math.round(n));

export function fmtMoney(n: number, dp?: number): string {
  if (dp !== undefined) return `$${n.toLocaleString("en-US", { minimumFractionDigits: dp, maximumFractionDigits: dp })}`;
  if (n >= 100) return `$${n.toLocaleString("en-US", { maximumFractionDigits: 0 })}`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  return `$${n.toFixed(4)}`;
}

export function fmtDuration(ms: number): string {
  const s = ms / 1000;
  if (s < 90) return `${s.toFixed(1)} sec`;
  const m = s / 60;
  if (m < 90) return `${Math.round(m)} min`;
  const h = m / 60;
  if (h < 48) return `${h.toFixed(1)} hours`;
  return `${Math.round(h / 24)} days`;
}

export function fmtMonth(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString("en-US", { month: "short", year: "2-digit" }).replace(" ", " '");
}

export function pct(n: number, total: number): number {
  return total ? (n / total) * 100 : 0;
}
