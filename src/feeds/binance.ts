// src/feeds/binance.ts — Real-time exchange price feed with resilient reconnection
//
// Binance WebSocket for live BTC/ETH/SOL prices.
// Falls back to REST polling when WebSocket is unavailable (e.g., Fly.io regions that block Binance).

import WebSocket from "ws";

export interface PriceSnapshot {
  symbol: string;
  price: number;
  timestamp: number;
  change5s: number;
  change30s: number;
  change60s: number;
  momentum: "surging_up" | "up" | "flat" | "down" | "surging_down";
}

const SYMBOLS = ["btcusdt", "ethusdt", "solusdt", "xrpusdt"];
const priceHistory: Map<string, { price: number; ts: number }[]> = new Map();
const latestPrices: Map<string, PriceSnapshot> = new Map();

let ws: WebSocket | null = null;
let reconnectAttempts = 0;
const MAX_RECONNECT_ATTEMPTS = 5;
const BASE_BACKOFF_MS = 3000;
let usingRestFallback = false;
let restPollTimer: ReturnType<typeof setInterval> | null = null;

export function startPriceFeed() {
  // Skip WebSocket entirely — Fly.io EWR blocks Binance WebSocket (wastes 48s on retries)
  // Go straight to REST polling for instant data availability
  console.log("[Binance] Starting REST polling directly (WebSocket blocked on Fly.io)");
  usingRestFallback = true;
  startRestPolling();
}

function connectWebSocket() {
  if (usingRestFallback) return;

  const streams = SYMBOLS.map((s) => `${s}@trade`).join("/");
  const url = `wss://stream.binance.com:9443/ws/${streams}`;

  try {
    ws = new WebSocket(url);
  } catch {
    handleWsFailure();
    return;
  }

  const connectTimeout = setTimeout(() => {
    if (ws && ws.readyState !== WebSocket.OPEN) {
      ws.terminate();
      handleWsFailure();
    }
  }, 10000);

  ws.on("open", () => {
    clearTimeout(connectTimeout);
    reconnectAttempts = 0;
    console.log("✅ Binance WebSocket connected");
  });

  ws.on("message", (data) => {
    try {
      const msg = JSON.parse(data.toString());
      if (msg.e !== "trade") return;
      updatePrice(msg.s.toLowerCase(), parseFloat(msg.p), msg.T);
    } catch {}
  });

  ws.on("error", () => {
    clearTimeout(connectTimeout);
  });

  ws.on("close", () => {
    clearTimeout(connectTimeout);
    handleWsFailure();
  });
}

function handleWsFailure() {
  reconnectAttempts++;

  if (reconnectAttempts > MAX_RECONNECT_ATTEMPTS) {
    console.log(`[Binance] WebSocket failed ${MAX_RECONNECT_ATTEMPTS} times — switching to REST polling (10s)`);
    usingRestFallback = true;
    startRestPolling();
    return;
  }

  const backoff = BASE_BACKOFF_MS * Math.pow(2, reconnectAttempts - 1);
  console.log(`[Binance] WebSocket reconnect ${reconnectAttempts}/${MAX_RECONNECT_ATTEMPTS} in ${(backoff / 1000).toFixed(0)}s`);
  setTimeout(connectWebSocket, backoff);
}

// ── REST fallback: poll Binance ticker API every 30s ──
function startRestPolling() {
  const poll = async () => {
    try {
      const symbols = SYMBOLS.map((s) => s.toUpperCase());
      // Try Binance US first (US-accessible), then CoinGecko as fallback
      let res: Response;
      try {
        res = await fetch(
          `https://api.binance.us/api/v3/ticker/price?symbols=${JSON.stringify(symbols)}`,
          { signal: AbortSignal.timeout(5000) },
        );
      } catch {
        // Binance US failed, try CoinGecko
        const cgIds = "bitcoin,ethereum,solana,ripple";
        const cgRes = await fetch(
          `https://api.coingecko.com/api/v3/simple/price?ids=${cgIds}&vs_currencies=usd`,
          { signal: AbortSignal.timeout(5000) },
        );
        if (cgRes.ok) {
          const data = await cgRes.json() as Record<string, { usd: number }>;
          const now = Date.now();
          if (data.bitcoin?.usd) updatePrice("btcusdt", data.bitcoin.usd, now);
          if (data.ethereum?.usd) updatePrice("ethusdt", data.ethereum.usd, now);
          if (data.solana?.usd) updatePrice("solusdt", data.solana.usd, now);
          if (data.ripple?.usd) updatePrice("xrpusdt", data.ripple.usd, now);
        }
        return;
      }
      if (!res.ok) {
        // If Binance US also fails (451/403), try CoinGecko
        if (res.status === 451 || res.status === 403) {
          try {
            const cgIds = "bitcoin,ethereum,solana,ripple";
            const cgRes = await fetch(
              `https://api.coingecko.com/api/v3/simple/price?ids=${cgIds}&vs_currencies=usd`,
              { signal: AbortSignal.timeout(5000) },
            );
            if (cgRes.ok) {
              const data = await cgRes.json() as Record<string, { usd: number }>;
              const now = Date.now();
              if (data.bitcoin?.usd) updatePrice("btcusdt", data.bitcoin.usd, now);
              if (data.ethereum?.usd) updatePrice("ethusdt", data.ethereum.usd, now);
              if (data.solana?.usd) updatePrice("solusdt", data.solana.usd, now);
              if (data.ripple?.usd) updatePrice("xrpusdt", data.ripple.usd, now);
              return;
            }
          } catch {}
        }
        console.error(`[Binance] REST poll failed: ${res.status} ${res.statusText}`);
        return;
      }
      const tickers = (await res.json()) as Array<{ symbol: string; price: string }>;
      const now = Date.now();
      for (const t of tickers) {
        updatePrice(t.symbol.toLowerCase(), parseFloat(t.price), now);
      }
    } catch (e: any) {
      console.error(`[Binance] REST poll error: ${e.message?.slice(0, 100)}`);
    }
  };

  poll(); // immediate first poll
  restPollTimer = setInterval(poll, 10000);
  console.log("✅ Binance REST polling active (10s interval)");
}

// ── Shared price update logic ──
let _firstPriceLogged = false;
function updatePrice(symbol: string, price: number, ts: number) {
  if (!_firstPriceLogged && symbol === "btcusdt") {
    _firstPriceLogged = true;
    console.log(`[Binance] First BTC price: $${price.toFixed(0)} at ${new Date(ts).toISOString()}`);
  }
  if (!priceHistory.has(symbol)) priceHistory.set(symbol, []);
  const hist = priceHistory.get(symbol)!;
  hist.push({ price, ts });

  // Trim to 900 seconds (15 min), cap at 2000 entries — needed for full contract lifecycle analysis
  const cutoff = ts - 900_000;
  while (hist.length > 0 && (hist[0].ts < cutoff || hist.length > 2000)) hist.shift();

  const ago5s = findPriceAt(hist, ts - 5_000);
  const ago30s = findPriceAt(hist, ts - 30_000);
  const ago60s = findPriceAt(hist, ts - 60_000);

  const change5s = ago5s ? ((price - ago5s) / ago5s) * 100 : 0;
  const change30s = ago30s ? ((price - ago30s) / ago30s) * 100 : 0;
  const change60s = ago60s ? ((price - ago60s) / ago60s) * 100 : 0;

  // Use change5s when data is fresh, fall back to change30s when polling interval > 10s
  // (REST polling at 10s means change5s has no data points within 5s of each other)
  const have5sData = hist.length >= 2 && (ts - hist[hist.length - 2].ts) <= 10_000;
  let momentum: PriceSnapshot["momentum"] = "flat";
  if (have5sData) {
    // WebSocket mode: use 5s thresholds
    if (change5s > 0.15) momentum = "surging_up";
    else if (change5s > 0.05) momentum = "up";
    else if (change5s < -0.15) momentum = "surging_down";
    else if (change5s < -0.05) momentum = "down";
  } else {
    // REST polling mode: use 30s thresholds (3-5x larger window)
    if (change30s > 0.45) momentum = "surging_up";
    else if (change30s > 0.15) momentum = "up";
    else if (change30s < -0.45) momentum = "surging_down";
    else if (change30s < -0.15) momentum = "down";
  }

  latestPrices.set(symbol, {
    symbol,
    price,
    timestamp: ts,
    change5s: Math.round(change5s * 1000) / 1000,
    change30s: Math.round(change30s * 1000) / 1000,
    change60s: Math.round(change60s * 1000) / 1000,
    momentum,
  });
}

export function getPrice(symbol: string): PriceSnapshot | null {
  return latestPrices.get(symbol.toLowerCase()) ?? null;
}

export function getAllPrices(): PriceSnapshot[] {
  return Array.from(latestPrices.values());
}

// V6: Expose raw price history for dashboard charts
export function getPriceHistoryRaw(symbol: string): Array<{ price: number; ts: number }> {
  return priceHistory.get(symbol.toLowerCase()) ?? [];
}

export function detectCryptoSignal(symbol: string): {
  signal: "strong_up" | "strong_down" | "moderate_up" | "moderate_down" | "none";
  confidence: number;
  details: string;
} | null {
  const snap = getPrice(symbol);
  if (!snap) return null;

  // ── Multi-timeframe momentum scoring ──
  // Each timeframe votes with a weight. More timeframes agreeing = higher confidence.
  const tf5s  = snap.change5s;
  const tf30s = snap.change30s;
  const tf60s = snap.change60s;

  // Compute 5-minute and 15-minute changes from history
  const hist = priceHistory.get(symbol.toLowerCase());
  const now = snap.timestamp;
  const ago5m  = hist ? findPriceAt(hist, now - 300_000) : null;
  const ago15m = hist ? findPriceAt(hist, now - 900_000) : null;
  const tf5m  = ago5m  ? ((snap.price - ago5m) / ago5m) * 100 : 0;
  const tf15m = ago15m ? ((snap.price - ago15m) / ago15m) * 100 : 0;

  // Detect if we're in REST polling mode (no data points within 10s of each other)
  const isRestMode = !hist || hist.length < 2 || (now - hist[hist.length - 2].ts) > 10_000;

  // ── Volatility-adaptive thresholds ──
  // In high-vol environments, require larger moves. In quiet, smaller moves are significant.
  const recentVol = hist && hist.length > 20
    ? Math.sqrt(hist.slice(-60).reduce((sum, h, i, arr) => {
        if (i === 0) return 0;
        const ret = (h.price - arr[i-1].price) / arr[i-1].price;
        return sum + ret * ret;
      }, 0) / Math.min(60, hist.length)) * 100
    : 0.10; // Default moderate volatility
  const volMultiplier = Math.max(0.5, Math.min(2.0, recentVol / 0.10)); // Normalize around 0.10% base

  const upThreshold5s  = 0.05 * volMultiplier;   // Adaptive: 0.025-0.10%
  const upThreshold30s = 0.08 * volMultiplier;
  const upThreshold60s = 0.10 * volMultiplier;

  // ── Score each timeframe ──
  let upVotes = 0, downVotes = 0;

  if (isRestMode) {
    // REST polling mode: change5s is always 0, so redistribute its weight to change30s
    // Use adapted thresholds for 30s (3-5x the 5s thresholds)
    const weights = { tf30s: 0.50, tf60s: 0.20, tf5m: 0.20, tf15m: 0.10 };
    const restThreshold30s = 0.15 * volMultiplier; // ~3x the 5s threshold

    if (tf30s > restThreshold30s)  upVotes += weights.tf30s;
    if (tf30s < -restThreshold30s) downVotes += weights.tf30s;
    if (tf60s > upThreshold60s)    upVotes += weights.tf60s;
    if (tf60s < -upThreshold60s)   downVotes += weights.tf60s;
    if (tf5m > 0.10)  upVotes += weights.tf5m;
    if (tf5m < -0.10) downVotes += weights.tf5m;
    if (tf15m > 0.15) upVotes += weights.tf15m;
    if (tf15m < -0.15) downVotes += weights.tf15m;
  } else {
    // WebSocket mode: all timeframes available
    const weights = { tf5s: 0.25, tf30s: 0.25, tf60s: 0.20, tf5m: 0.20, tf15m: 0.10 };

    if (tf5s > upThreshold5s)   upVotes += weights.tf5s;
    if (tf5s < -upThreshold5s)  downVotes += weights.tf5s;
    if (tf30s > upThreshold30s) upVotes += weights.tf30s;
    if (tf30s < -upThreshold30s) downVotes += weights.tf30s;
    if (tf60s > upThreshold60s) upVotes += weights.tf60s;
    if (tf60s < -upThreshold60s) downVotes += weights.tf60s;
    if (tf5m > 0.10)  upVotes += weights.tf5m;
    if (tf5m < -0.10) downVotes += weights.tf5m;
    if (tf15m > 0.15) upVotes += weights.tf15m;
    if (tf15m < -0.15) downVotes += weights.tf15m;
  }

  // ── Generate signal ──
  // Need at least 40% of weighted votes in one direction (was effectively 50% before)
  const modeTag = isRestMode ? " [REST]" : "";
  const details = `${symbol}${modeTag} 5s:${tf5s > 0 ? "+" : ""}${tf5s.toFixed(3)}% 30s:${tf30s > 0 ? "+" : ""}${tf30s.toFixed(3)}% 60s:${tf60s > 0 ? "+" : ""}${tf60s.toFixed(3)}% 5m:${tf5m > 0 ? "+" : ""}${tf5m.toFixed(2)}% vol:${recentVol.toFixed(3)}%`;

  // In REST mode, use tf30s for confidence scaling instead of tf5s
  const primaryTf = isRestMode ? tf30s : tf5s;

  if (upVotes >= 0.40) {
    // Confidence scales with how many timeframes agree
    const conf = Math.min(0.95, 0.50 + upVotes * 0.5 + Math.abs(primaryTf) * 1.5);
    return { signal: "strong_up", confidence: conf, details };
  }

  if (downVotes >= 0.40) {
    const conf = Math.min(0.95, 0.50 + downVotes * 0.5 + Math.abs(primaryTf) * 1.5);
    return { signal: "strong_down", confidence: conf, details };
  }

  // Moderate signals: 25%+ weighted votes (less conviction but still directional)
  if (upVotes >= 0.25) {
    const conf = Math.min(0.80, 0.35 + upVotes * 0.4 + Math.abs(primaryTf) * 1.0);
    return { signal: "moderate_up", confidence: conf, details };
  }

  if (downVotes >= 0.25) {
    const conf = Math.min(0.80, 0.35 + downVotes * 0.4 + Math.abs(primaryTf) * 1.0);
    return { signal: "moderate_down", confidence: conf, details };
  }

  return { signal: "none", confidence: 0, details };
}

// ── Cross-asset lead-lag detection ──
// BTC leads ETH/SOL/XRP by 5-15 seconds. When BTC spikes, the others haven't moved yet.
export function detectCrossAssetCascade(): Array<{
  leader: string;
  follower: string;
  direction: "up" | "down";
  leader_change: number;
  follower_change: number;
  gap_pct: number;
  confidence: number;
}> {
  const cascades: Array<{ leader: string; follower: string; direction: "up" | "down"; leader_change: number; follower_change: number; gap_pct: number; confidence: number }> = [];

  const btc = getPrice("btcusdt");
  const followers = [
    { symbol: "ethusdt", name: "ETH" },
    { symbol: "solusdt", name: "SOL" },
    { symbol: "xrpusdt", name: "XRP" },
  ];

  if (!btc) return cascades;

  for (const f of followers) {
    const fSnap = getPrice(f.symbol);
    if (!fSnap) continue;

    // BTC moved significantly in 5-30s but follower hasn't caught up
    const btcMove = Math.max(Math.abs(btc.change5s), Math.abs(btc.change30s));
    const fMove = Math.max(Math.abs(fSnap.change5s), Math.abs(fSnap.change30s));

    // BTC moved >0.10% and follower moved <50% as much
    if (btcMove > 0.10 && fMove < btcMove * 0.5) {
      const direction = btc.change5s > 0 ? "up" as const : "down" as const;
      const gap = btcMove - fMove;
      const confidence = Math.min(0.90, 0.55 + gap * 2);

      cascades.push({
        leader: "BTC",
        follower: f.name,
        direction,
        leader_change: btc.change5s,
        follower_change: fSnap.change5s,
        gap_pct: gap,
        confidence,
      });
    }
  }

  return cascades;
}

// ── Settlement window predictor ──
// Models the CF Benchmarks trimmed mean: 60 data points, trim top/bottom 20%
export function predictSettlement(symbol: string): {
  predicted_price: number;
  current_price: number;
  trend_direction: "up" | "down" | "flat";
  confidence: number;
} | null {
  const hist = priceHistory.get(symbol.toLowerCase());
  if (!hist || hist.length < 30) return null;

  const current = hist[hist.length - 1].price;

  // Take last 60 readings (approximating the settlement window)
  const window = hist.slice(-60).map(h => h.price);

  // Simulate trimmed mean: remove top/bottom 20%
  const sorted = [...window].sort((a, b) => a - b);
  const trimCount = Math.floor(sorted.length * 0.2);
  const trimmed = sorted.slice(trimCount, sorted.length - trimCount);
  const trimmedMean = trimmed.reduce((a, b) => a + b, 0) / trimmed.length;

  // Trend: is price accelerating toward or away from the trimmed mean?
  const recent5 = hist.slice(-5).map(h => h.price);
  const avgRecent = recent5.reduce((a, b) => a + b, 0) / recent5.length;

  const trendDirection = avgRecent > trimmedMean * 1.0001 ? "up" as const
    : avgRecent < trimmedMean * 0.9999 ? "down" as const
    : "flat" as const;

  // Confidence: how stable is the trimmed mean? Low spread = high confidence
  const trimmedStd = Math.sqrt(trimmed.reduce((sum, p) => sum + (p - trimmedMean) ** 2, 0) / trimmed.length);
  const spreadPct = trimmedStd / trimmedMean * 100;
  const confidence = Math.min(0.95, Math.max(0.40, 1 - spreadPct * 10));

  return {
    predicted_price: trimmedMean,
    current_price: current,
    trend_direction: trendDirection,
    confidence,
  };
}

function findPriceAt(hist: { price: number; ts: number }[], targetTs: number): number | null {
  for (let i = hist.length - 1; i >= 0; i--) {
    if (hist[i].ts <= targetTs) return hist[i].price;
  }
  return null;
}

export function stopPriceFeed() {
  ws?.close();
  if (restPollTimer) clearInterval(restPollTimer);
}
