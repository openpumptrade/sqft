import { UA, isPubkey } from "../context.js";

/// Public market data. pump.fun's frontend-api-v3 `/coins/<mint>` has answered 404 for every mint since late
/// Sep 2026, so DexScreener is the source: it indexes curves (dexId "pumpfun") and PumpSwap pools
/// ("pumpswap") within seconds of the first trade. Field names kept pump.fun-compatible.

const FRONTEND = "https://frontend-api-v3.pump.fun";
const SWAP_API = "https://swap-api.pump.fun";
const DEX = "https://api.dexscreener.com";

const pickPair = (pairs, mint) => {
  const ps = pairs.filter((p) => p.chainId === "solana" && p.baseToken?.address === mint);
  const pool = ps.find((p) => p.dexId === "pumpswap"), curve = ps.find((p) => p.dexId === "pumpfun");
  return { pool, curve, main: pool || curve || ps[0] || null };
};

export async function fetchCoinInfo(ctx, mint) {
  try {
    const res = await fetch(`${FRONTEND}/coins/${mint}`, { headers: UA, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return { ...(await res.json()), source: "pump.fun" };
  } catch { /* fall through */ }
  const res = await fetch(`${DEX}/tokens/v1/solana/${mint}`, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`coins/${mint}: pump.fun 404 and dexscreener → ${res.status}`);
  const { pool, curve, main } = pickPair(await res.json(), mint);
  if (!main) throw new Error(`coins/${mint}: not on pump.fun's API nor on DexScreener yet (no trades?)`);
  const priceUsd = Number(main.priceUsd || 0);
  return {
    mint, name: String(main.baseToken?.name || "").trim(), symbol: String(main.baseToken?.symbol || "").trim(), image_uri: main.info?.imageUrl || "", description: "",
    usd_market_cap: priceUsd * 1e9, price_usd: priceUsd, complete: pool ? true : undefined, pump_swap_pool: pool ? pool.pairAddress : "",
    created_timestamp: Number((curve || main).pairCreatedAt || 0), volume24h_usd: Number(main.volume?.h24 || 0), source: "dexscreener",
  };
}

/// Live market of many coins from DexScreener (30 per call), 30 s cache. {mint → {priceUsd, mcapUsd, volume24hUsd, change24h, graduated, url} | null}
export async function fetchMarkets(ctx, mints) {
  const cache = ctx.caches.markets;
  const out = {};
  const stale = mints.filter((m) => { const h = cache.get(m); if (h && Date.now() - h.at < 30_000) { out[m] = h.m; return false; } return true; });
  for (let i = 0; i < stale.length; i += 30) {
    const part = stale.slice(i, i + 30);
    try {
      const res = await fetch(`${DEX}/tokens/v1/solana/${part.join(",")}`, { headers: UA, signal: AbortSignal.timeout(10_000) });
      const pairs = res.ok ? await res.json() : [];
      for (const mint of part) {
        const { main } = pickPair(pairs, mint);
        const m = main ? { priceUsd: Number(main.priceUsd || 0), mcapUsd: Number(main.marketCap || main.fdv || 0), volume24hUsd: Number(main.volume?.h24 || 0), change24h: main.priceChange?.h24 ?? null, graduated: main.dexId === "pumpswap", url: main.url || "", pool: main.dexId === "pumpswap" ? main.pairAddress : "" } : null;
        cache.set(mint, { at: Date.now(), m });
        out[mint] = m;
      }
    } catch { for (const mint of part) out[mint] = cache.get(mint)?.m || null; }
  }
  return out;
}

/// DexScreener search → Solana tokens, best pair per mint, most liquid first.
export async function searchTokens(q, { limit = 12 } = {}) {
  const query = String(q || "").trim();
  if (!query) return [];
  const url = isPubkey(query) ? `${DEX}/latest/dex/tokens/${query}` : `${DEX}/latest/dex/search?q=${encodeURIComponent(query)}`;
  const res = await fetch(url, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`dexscreener → ${res.status}`);
  const pairs = ((await res.json()).pairs || []).filter((p) => p.chainId === "solana" && p.baseToken?.address);
  const best = new Map();
  for (const p of pairs) {
    const m = p.baseToken.address, liq = Number(p.liquidity?.usd || 0);
    if (!best.has(m) || liq > best.get(m).liquidityUsd) best.set(m, { mint: m, symbol: String(p.baseToken.symbol || "").trim(), name: String(p.baseToken.name || "").trim(), image: p.info?.imageUrl || "", liquidityUsd: liq, priceUsd: Number(p.priceUsd || 0), mcapUsd: Number(p.marketCap || p.fdv || 0), venue: p.dexId || "", volume24hUsd: Number(p.volume?.h24 || 0) });
  }
  return [...best.values()].sort((a, b) => b.liquidityUsd - a.liquidityUsd).slice(0, limit);
}

/// interval: "1m" | "5m" | "15m" | "1h" — prices in USD (pump.fun swap API, still alive).
export async function fetchCandles(mint, { interval = "5m", createdTsMs = 0, limit = 500 } = {}) {
  const res = await fetch(`${SWAP_API}/v2/coins/${mint}/candles?interval=${interval}&limit=${limit}&currency=USD&createdTs=${createdTsMs}`, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`candles → ${res.status}`);
  return res.json();
}

export async function fetchTrades(mint, { limit = 50 } = {}) {
  const res = await fetch(`${SWAP_API}/v2/coins/${mint}/trades?limit=${limit}`, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`trades → ${res.status}`);
  const json = await res.json();
  return Array.isArray(json) ? json : (json.trades ?? json.data ?? []);
}

/// pump.fun's own top-holders list (what the coin page shows) — [{address, amount}] or [] when unavailable.
export async function fetchTopHoldersList(mint) {
  const res = await fetch(`${FRONTEND}/coins/top-holders/${mint}`, { headers: UA, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error(`top-holders → ${res.status}`);
  return (await res.json()).topHolders || [];
}
