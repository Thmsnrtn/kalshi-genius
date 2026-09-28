// src/strategies/kalshi/kalshi_strategies.ts — V3: Data-driven strategies
//
// KALSHI-NATIVE STRATEGIES with real data feeds:
// 1. HOURLY CLOSE SNIPER    — Binance live prices vs Kalshi strike prices
// 2. GROUPED MARKET ARB     — Monotonicity violations = guaranteed profit
// 3. ECONOMIC RELEASE       — FRED data edge on CPI/Fed/jobs markets
// 4. WEATHER EDGE           — NWS forecast data vs Kalshi weather markets
// 5. CROSS-PLATFORM MIRROR  — Polymarket price reference for Kalshi trades

import { KalshiClient, type KalshiMarket, centsToProbability } from "../../exchanges/kalshi/kalshi_client.js";
// ARCHIVED: import { getEconomicSnapshot, getEconomicEdge } from "../../feeds/fred.js";
// ARCHIVED: import { getWeatherEdge } from "../../feeds/nws.js";
const getEconomicSnapshot = () => null;
const getEconomicEdge = (_m: any, _s?: any) => ({ edge: 0, edge_estimate: 0, direction: "YES" as const, has_edge: false, confidence: 0, reasoning: "archived" });
const getWeatherEdge = (_m: any): any[] => [];
import { detectOddsMovements, getSmartMoneySignal, type OddsMovement } from "../../feeds/odds_movement.js";
import { detectCrossAssetCascade, predictSettlement, getPrice } from "../../feeds/binance.js";
import { yesProbabilityFromChosenSide, grossProbabilityEdge } from "../../core/forecast_math.js";

// ═══════════════════════════════════════════════════════════
// STRATEGY 1: HOURLY CLOSE SNIPER
// ═══════════════════════════════════════════════════════════

export interface HourlySniperSignal {
  ticker: string;
  market_question: string;
  direction: "YES" | "NO";
  contract_price: number;
  potential_return_pct: number;
  model_probability_yes?: number; // Absent on legacy heuristic signals; never substitute confidence
  gross_probability_edge?: number; // P(chosen side) - executable chosen-side price
  confidence: number;
  minutes_remaining: number;
  reasoning: string;
  smart_money_confirms: boolean;
  turbo_brain_size_multiplier?: number;  // Asymmetric Kelly sizing from TurboBrain
  ev_cents?: number;                     // V4: Expected value for signal ranking
}

// (was HOURLY_SERIES_TO_TRACK = ["KXBTCD", "KXETHD", "KXBTCH", "KXSPY", "KXSPX"])
// Three of those (KXBTCH, KXSPY, KXSPX) returned 0 markets. Now discovered dynamically.

// Dynamic series discovery — find active hourly/daily close series
let _cachedSeries: string[] = [];
let _lastSeriesRefresh = 0;
const SERIES_REFRESH_MS = 30 * 60 * 1000; // Refresh every 30 min

// Known series prefixes for close-price markets (crypto, indices, commodities)
// 15-min turbos (KXBTC15M etc.) = 96 cycles/day — primary compounding engine
// Hourly (KXBTCD etc.) = 24 cycles/day — secondary
// Indices + commodities = supplementary
const CLOSE_SERIES_PREFIXES = [
  // 15-minute turbo crypto (highest velocity — 96 cycles/day)
  "KXBTC15M", "KXETH15M", "KXSOL15M", "KXXRP15M",
  // Hourly crypto close
  "KXBTC", "KXETH", "KXSOL", "KXBTCD", "KXETHD", "KXSOLD",
  // Indices & commodities
  "KXSPY", "KXSPX", "KXNAS", "KXGOLD", "KXOIL", "KXDXY",
];

async function getActiveSeries(client: KalshiClient): Promise<string[]> {
  if (_cachedSeries.length > 0 && Date.now() - _lastSeriesRefresh < SERIES_REFRESH_MS) {
    return _cachedSeries;
  }

  const found: string[] = [];
  for (const prefix of CLOSE_SERIES_PREFIXES) {
    try {
      const { markets } = await client.getMarkets({ series_ticker: prefix, limit: 5 });
      if (markets.length > 0) found.push(prefix);
    } catch {}
  }

  if (found.length > 0) {
    _cachedSeries = found;
    _lastSeriesRefresh = Date.now();
    console.log(`[hourly_sniper] Active series discovered: ${found.join(", ")}`);
  }

  return _cachedSeries.length > 0 ? _cachedSeries : ["KXBTCD", "KXETHD"]; // fallback
}

export async function scanHourlySniper(
  client: KalshiClient,
  binanceProvider: () => { btc?: number; eth?: number; sol?: number; xrp?: number }
): Promise<HourlySniperSignal[]> {
  const signals: HourlySniperSignal[] = [];
  const now = Date.now();
  const livePrices = binanceProvider();

  const activeSeries = await getActiveSeries(client);
  let _marketsScanned = 0;
  let _marketsInWindow = 0;
  let _noLivePrice = 0;
  let _noPriceMatch = 0;
  let _skippedConfidenceLog = 0; // Track how many confidence-skip logs we've emitted
  let _debugCount = 0;
  let _turboLog = 0; // Diagnostic logging for turbo markets
  for (const series of activeSeries) {
    try {
      const { markets } = await client.getMarkets({ series_ticker: series, limit: 100 });
      _marketsScanned += markets.length;

      // Turbo diagnostic: log first market details for 15M series
      if (series.includes("15M") && markets.length > 0 && _turboLog < 2) {
        const inWindow = markets.filter(m => {
          const ct = new Date(m.close_time).getTime();
          return (ct - now) / 60000 > 0 && (ct - now) / 60000 <= 60;
        });
        const freshOnes = inWindow.filter(m => {
          const ct = new Date(m.close_time).getTime();
          const minLeft = (ct - now) / 60000;
          return minLeft >= 10 && minLeft <= 16; // Just opened this cycle
        });
        if (inWindow.length > 0) {
          const first = inWindow[0];
          const minLeft = (new Date(first.close_time).getTime() - now) / 60000;
          console.log(`  📡 [Turbo] ${series}: ${inWindow.length} in window, ${freshOnes.length} fresh(10-16m left). Nearest: ${first.ticker} ${minLeft.toFixed(1)}m left YES=${first.yes_ask_precise?.toFixed(4)}`);
        }
        _turboLog++;
      }

      for (const m of markets) {
        const closeTime = new Date(m.close_time).getTime();
        const minutesRemaining = (closeTime - now) / 60000;
        // Wide window: catch everything closing within 60 min (hourly + 15-min turbos)
        if (minutesRemaining < 0 || minutesRemaining > 60) continue;
        _marketsInWindow++;

        const titleLower = m.title.toLowerCase();
        // Use sub-cent precision for turbo markets (critical: Math.round(0.002*100)=0 but actual price is 0.2¢)
        const yesAskPrice = m.yes_ask_precise ?? (m.yes_ask / 100);
        const noAskPrice = m.no_ask_precise ?? (m.no_ask / 100);
        const yesBidPrice = m.yes_bid_precise ?? (m.yes_bid / 100);
        const noBidPrice = m.no_bid_precise ?? (m.no_bid / 100);

        // For turbo markets: trade if recently opened (within first 5 min) even at extreme prices
        // NOTE: open_time is the series-level open, NOT the cycle open. For 15M markets,
        // detect freshness by: close_time is 10-15 min away → market just opened this cycle
        const isTurboSeries = series.includes("15M");
        const isFreshOpen = isTurboSeries
          ? (minutesRemaining >= 8 && minutesRemaining <= 16) // 15M market with 8-16 min left = opened 0-7 min ago
          : (() => {
              const openTime = m.open_time ? new Date(m.open_time).getTime() : 0;
              const minutesSinceOpen = openTime > 0 ? (now - openTime) / 60000 : 999;
              return minutesSinceOpen >= 0 && minutesSinceOpen <= 5;
            })();

        // Skip if no liquidity — but use precise prices and allow turbo fresh opens
        if (!isFreshOpen && (yesAskPrice <= 0.02 || yesAskPrice >= 0.98)) {
          if (_debugCount < 3) { console.log(`  🔍 [Sniper] Skip ${m.ticker}: price extreme (YES ${(yesAskPrice*100).toFixed(1)}¢)`); _debugCount++; }
          continue;
        }
        // For fresh opens at extreme prices, log but continue (momentum-based trading)
        if (isFreshOpen && _debugCount < 5) {
          console.log(`  🆕 [Sniper] Fresh open ${m.ticker}: YES=${(yesAskPrice*100).toFixed(1)}¢ NO=${(noAskPrice*100).toFixed(1)}¢ (${minutesRemaining.toFixed(1)}m left) "${m.title?.slice(0, 100)}"`);
          _debugCount++;
        }

        // Identify asset
        let livePrice: number | undefined;
        let assetName = "Asset";
        if (titleLower.includes("bitcoin") || titleLower.includes("btc")) { livePrice = livePrices.btc; assetName = "BTC"; }
        else if (titleLower.includes("ethereum") || titleLower.includes("eth")) { livePrice = livePrices.eth; assetName = "ETH"; }
        else if (titleLower.includes("solana") || titleLower.includes("sol")) { livePrice = livePrices.sol; assetName = "SOL"; }
        else if (titleLower.includes("xrp") || titleLower.includes("ripple")) { livePrice = livePrices.xrp; assetName = "XRP"; }

        const smartMoney = getSmartMoneySignal(m.ticker);
        const isTurbo = series.includes("15M");

        // ── TYPE A: "Up or Down" / directional 15-min markets ──
        // These don't have strike prices — they ask "Will BTC go up or down?"
        // Edge comes from momentum: if BTC is surging up, YES (up) is underpriced
        if (titleLower.includes("up") || titleLower.includes("down") || titleLower.includes("higher") || titleLower.includes("lower")) {
          if (!livePrice) {
            _noLivePrice++;
            if (isFreshOpen && _noLivePrice <= 3) console.log(`  ⚠️ [Sniper] ${m.ticker}: No live ${assetName} price — Binance feed may not be ready`);
            continue;
          }

          // Detect momentum from Binance feed
          const { detectCryptoSignal } = await import("../../feeds/binance.js");
          const symbol = assetName === "BTC" ? "btcusdt" : assetName === "ETH" ? "ethusdt" : assetName === "SOL" ? "solusdt" : "xrpusdt";
          const momentum = detectCryptoSignal(symbol);
          if (!momentum) continue; // No price data yet

          // Log momentum state for Type A markets when fresh or has signal
          if (isFreshOpen || momentum.signal !== "none") {
            console.log(`  📊 [Sniper] Type A: ${m.ticker} YES=${(yesAskPrice*100).toFixed(1)}¢ ${assetName} mom=${momentum.signal} conf=${momentum.confidence.toFixed(2)} ${momentum.details.slice(0, 60)}`);
          }

          // "Up" market: YES = price goes up
          const isUpMarket = titleLower.includes("up") || titleLower.includes("higher");

          // Price caps: only trade at favorable risk/reward
          // Below 60¢ = risking 60¢ to win 40¢ (need ~60% accuracy)
          // Above 60¢ = terrible odds (80¢ to win 20¢ needs 80% accuracy)
          const yesMaxPrice = isTurboSeries ? 0.60 : 0.75;
          const noMaxPrice = isTurboSeries ? 0.60 : 0.75;

          // ── FRESH TURBO: Turbo Brain multi-signal analysis ──
          // Replaces simple momentum checks with 8-signal composite scoring:
          // mean reversion, BTC lead-lag, volume confirmation, Kalshi divergence,
          // optimal timing, multi-cycle memory, asymmetric Kelly, smart exits
          if (isTurboSeries && isFreshOpen && yesAskPrice > 0.15 && yesAskPrice < 0.85) {
            const {
              analyzeTurboOpportunity, recordKalshiPrice, notifyBrainCycleScanned,
              recordKalshiFlow, analyzePreMarket, calculateEV, registerActivePosition,
            } = await import("./turbo_brain.js");

            // V2 #17: Feed Kalshi price to opponent modeling
            const minutesIn = 15 - minutesRemaining;
            recordKalshiPrice(assetName, minutesIn, yesAskPrice);

            // V4 #4: Feed Kalshi order flow
            recordKalshiFlow(assetName, yesBidPrice, yesAskPrice);

            // V4 #6: Pre-market analysis (runs every scan, builds signal before cycle opens)
            analyzePreMarket();

            // V3: Notify brain that we scanned a cycle (for activity pressure)
            notifyBrainCycleScanned();

            const decision = analyzeTurboOpportunity({
              ticker: m.ticker,
              asset: assetName,
              kalshiYesPrice: yesAskPrice,
              kalshiNoPrice: noAskPrice,
              kalshiYesBid: yesBidPrice,
              kalshiNoBid: noBidPrice,
              minutesRemaining,
              isFreshOpen,
              isUpMarket,
            });

            if (decision.trade && decision.signal) {
              const sig = decision.signal;
              const tradeType = decision.explore ? "EXPLORE" : "TRADE";
              const ev = calculateEV(sig.price, sig.confidence, sig.score);
              console.log(`  🧠 [TurboBrain] ${tradeType}: ${m.ticker} ${sig.direction}@${(sig.price*100).toFixed(0)}¢ score=${sig.score.toFixed(2)} conf=${sig.confidence.toFixed(2)} size=${sig.size_multiplier.toFixed(2)}x EV=${(ev*100).toFixed(1)}¢ | ${sig.reasoning.slice(0, 100)}`);

              // V4 #9: Register active position for correlation guard
              registerActivePosition(assetName, sig.direction);

              // V4 #8: Tag signal with EV for ranking
              signals.push({
                ticker: m.ticker, market_question: m.title, direction: sig.direction,
                contract_price: sig.price,
                potential_return_pct: (1 - sig.price) / sig.price,
                model_probability_yes: yesProbabilityFromChosenSide(sig.model_prob_win, sig.direction),
                gross_probability_edge: grossProbabilityEdge(sig.model_prob_win, sig.price),
                confidence: sig.confidence, minutes_remaining: minutesRemaining,
                reasoning: `[TurboBrain] ${sig.reasoning} | signals: ${sig.signal_sources.join(",")}`,
                smart_money_confirms: false,
                turbo_brain_size_multiplier: sig.size_multiplier,
                ev_cents: ev * 100, // V4: for ranking
              });
              // V4 #3: Don't continue — allow multiple assets to signal in same cycle
            } else if (decision.skip_reason) {
              console.log(`  🧠 [TurboBrain] SKIP: ${m.ticker} — ${decision.skip_reason}`);
            }
            // V5: Brain-only mode for turbos — skip legacy momentum code entirely
            // Legacy code was causing 2-5x duplicate entries per market per cycle
            continue;
          }

          if ((momentum.signal === "strong_up" || momentum.signal === "moderate_up") && isUpMarket && yesAskPrice < yesMaxPrice) {
            let confidence = momentum.confidence;
            if (momentum.signal === "moderate_up") confidence *= 0.85; // Discount moderate signals
            if (isTurbo && minutesRemaining < 10) confidence = Math.min(0.98, confidence * 1.15);
            const smConfirms = smartMoney.signal === "buy_yes";
            if (smConfirms) confidence = Math.min(0.98, confidence * 1.10);
            if (confidence < 0.35) {
              if (_skippedConfidenceLog < 3) {
                console.log(`  [Sniper] SKIP Type A "${m.title.slice(0, 60)}": confidence ${confidence.toFixed(2)} < 0.35`);
                _skippedConfidenceLog++;
              }
              continue;
            }

            signals.push({
              ticker: m.ticker, market_question: m.title, direction: "YES",
              contract_price: yesAskPrice,
              potential_return_pct: (1 - yesAskPrice) / yesAskPrice,
              confidence, minutes_remaining: minutesRemaining,
              reasoning: `${assetName} surging up (${momentum.signal}), ${minutesRemaining.toFixed(0)}m left. YES at ${(yesAskPrice * 100).toFixed(0)}¢.${smConfirms ? " Smart money confirms." : ""}`,
              smart_money_confirms: smConfirms,
            });
          } else if ((momentum.signal === "strong_down" || momentum.signal === "moderate_down") && isUpMarket && noAskPrice < noMaxPrice) {
            let confidence = momentum.confidence;
            if (momentum.signal === "moderate_down") confidence *= 0.85;
            if (isTurbo && minutesRemaining < 10) confidence = Math.min(0.98, confidence * 1.15);
            const smConfirms = smartMoney.signal === "buy_no";
            if (smConfirms) confidence = Math.min(0.98, confidence * 1.10);
            if (confidence < 0.35) {
              if (_skippedConfidenceLog < 3) {
                console.log(`  [Sniper] SKIP Type A "${m.title.slice(0, 60)}": confidence ${confidence.toFixed(2)} < 0.35`);
                _skippedConfidenceLog++;
              }
              continue;
            }

            signals.push({
              ticker: m.ticker, market_question: m.title, direction: "NO",
              contract_price: noAskPrice,
              potential_return_pct: (1 - noAskPrice) / noAskPrice,
              confidence, minutes_remaining: minutesRemaining,
              reasoning: `${assetName} dropping (${momentum.signal}), ${minutesRemaining.toFixed(0)}m left. NO (down) at ${(noAskPrice * 100).toFixed(0)}¢.${smConfirms ? " Smart money confirms." : ""}`,
              smart_money_confirms: smConfirms,
            });
          } else if ((momentum.signal === "strong_up" || momentum.signal === "moderate_up") && !isUpMarket && noAskPrice < noMaxPrice) {
            // "Down" market + price going up → NO is the play
            let confidence = momentum.confidence;
            if (momentum.signal === "moderate_up") confidence *= 0.85;
            if (isTurbo && minutesRemaining < 10) confidence = Math.min(0.98, confidence * 1.15);
            const smConfirms = smartMoney.signal === "buy_no";
            if (smConfirms) confidence = Math.min(0.98, confidence * 1.10);
            if (confidence < 0.35) {
              if (_skippedConfidenceLog < 3) {
                console.log(`  [Sniper] SKIP Type A "${m.title.slice(0, 60)}": confidence ${confidence.toFixed(2)} < 0.35`);
                _skippedConfidenceLog++;
              }
              continue;
            }

            signals.push({
              ticker: m.ticker, market_question: m.title, direction: "NO",
              contract_price: noAskPrice,
              potential_return_pct: (1 - noAskPrice) / noAskPrice,
              confidence, minutes_remaining: minutesRemaining,
              reasoning: `${assetName} surging up but market asks "down?" — NO at ${(noAskPrice * 100).toFixed(0)}¢.${smConfirms ? " Smart money confirms." : ""}`,
              smart_money_confirms: smConfirms,
            });
          } else if ((momentum.signal === "strong_down" || momentum.signal === "moderate_down") && !isUpMarket && yesAskPrice < yesMaxPrice) {
            let confidence = momentum.confidence;
            if (momentum.signal === "moderate_down") confidence *= 0.85;
            if (isTurbo && minutesRemaining < 10) confidence = Math.min(0.98, confidence * 1.15);
            const smConfirms = smartMoney.signal === "buy_yes";
            if (smConfirms) confidence = Math.min(0.98, confidence * 1.10);
            if (confidence < 0.35) {
              if (_skippedConfidenceLog < 3) {
                console.log(`  [Sniper] SKIP Type A "${m.title.slice(0, 60)}": confidence ${confidence.toFixed(2)} < 0.35`);
                _skippedConfidenceLog++;
              }
              continue;
            }

            signals.push({
              ticker: m.ticker, market_question: m.title, direction: "YES",
              contract_price: yesAskPrice,
              potential_return_pct: (1 - yesAskPrice) / yesAskPrice,
              confidence, minutes_remaining: minutesRemaining,
              reasoning: `${assetName} dropping and market asks "down?" — YES at ${(yesAskPrice * 100).toFixed(0)}¢.${smConfirms ? " Smart money confirms." : ""}`,
              smart_money_confirms: smConfirms,
            });
          }
          continue; // Skip strike-based logic for directional markets
        }

        // ── TYPE B: Strike-price markets ("BTC above $85,000?") ──
        if (!livePrice) { _noLivePrice++; continue; }

        const strikeMatch = m.title.match(/\$?([\d,]+(?:\.\d+)?)/);
        if (!strikeMatch) { _noPriceMatch++; continue; }
        const strike = parseFloat(strikeMatch[1].replace(/,/g, ""));

        const distancePct = (livePrice - strike) / strike;

        // ── TURBO OPEN for Type B: momentum + distance from strike ──
        // Fresh 15M opens — use Binance momentum to confirm direction
        if (isTurboSeries && isFreshOpen) {
          console.log(`  🔬 [Turbo B] Checking ${m.ticker}: ${assetName}=$${livePrice?.toFixed(0)} strike=$${strike.toFixed(0)} dist=${(distancePct*100).toFixed(3)}% YES=${(yesAskPrice*100).toFixed(1)}¢`);
        }
        if (isTurboSeries && isFreshOpen) {
          const { getPrice: getBinPrice } = await import("../../feeds/binance.js");
          const symbol = assetName === "BTC" ? "btcusdt" : assetName === "ETH" ? "ethusdt" : assetName === "SOL" ? "solusdt" : "xrpusdt";
          const snap = getBinPrice(symbol);
          if (snap) {
            const change30s = snap.change30s ?? 0;
            // Price above strike AND moving up → strong YES
            // Price below strike AND moving down → strong NO
            // Momentum opposing position → skip (don't fight the trend)
            const momentumAgreesWithPosition = (distancePct > 0 && change30s >= 0) || (distancePct < 0 && change30s <= 0);
            const momentumOpposes = (distancePct > 0 && change30s < -0.05) || (distancePct < 0 && change30s > 0.05);
            if (!momentumOpposes) {
              const dir = distancePct >= 0 ? "YES" : "NO";
              const price = dir === "YES" ? yesAskPrice : noAskPrice;
              if (price > 0.02 && price < 0.95) {
                // Distance is the primary signal, momentum confirms
                let conf = 0.30 + Math.min(0.30, Math.abs(distancePct) * 30) + Math.abs(change30s) * 2;
                if (momentumAgreesWithPosition) conf += 0.08;
                conf = Math.min(0.80, conf);
                if (conf >= 0.30) {
                  console.log(`  🚀 [Sniper] TURBO B: ${m.ticker} ${dir}@${(price*100).toFixed(0)}¢ ${assetName}=$${livePrice.toFixed(0)} strike=$${strike.toFixed(0)} dist=${(distancePct*100).toFixed(3)}% Δ30s=${(change30s*100).toFixed(3)}% conf=${conf.toFixed(2)}`);
                  signals.push({
                    ticker: m.ticker, market_question: m.title, direction: dir,
                    contract_price: price,
                    potential_return_pct: (1 - price) / price,
                    confidence: conf, minutes_remaining: minutesRemaining,
                    reasoning: `${assetName} $${livePrice.toFixed(0)} vs strike $${strike.toFixed(0)} (${(distancePct*100).toFixed(2)}%) with momentum Δ30s=${(change30s*100).toFixed(3)}%. Fresh turbo open, ${dir} at ${(price*100).toFixed(0)}¢.`,
                    smart_money_confirms: false,
                  });
                  continue;
                }
              }
            }
          }
        }

        // YES SIGNAL — price above strike
        if (distancePct > 0.001 && yesAskPrice < 0.97 && yesAskPrice > 0.05) {
          const timeFactorScore = Math.max(0, 1 - minutesRemaining / 60);
          const distanceScore = Math.min(1, Math.abs(distancePct) * 100);
          let confidence = (timeFactorScore * 0.5 + distanceScore * 0.5);
          const smConfirms = smartMoney.signal === "buy_yes";
          if (smConfirms) confidence = Math.min(0.98, confidence * 1.15);
          if (minutesRemaining < 20) confidence = Math.min(0.98, confidence * 1.10);
          if (isTurbo && minutesRemaining < 10) confidence = Math.min(0.98, confidence * 1.10);
          if (confidence < 0.30) {
              if (_skippedConfidenceLog < 3) {
                console.log(`  [Sniper] SKIP Type B "${m.title.slice(0, 60)}": confidence ${confidence.toFixed(2)} < 0.30`);
                _skippedConfidenceLog++;
              }
              continue;
            }

          signals.push({
            ticker: m.ticker, market_question: m.title, direction: "YES",
            contract_price: yesAskPrice,
            potential_return_pct: (1 - yesAskPrice) / yesAskPrice,
            confidence, minutes_remaining: minutesRemaining,
            reasoning: `${assetName} at $${livePrice.toFixed(0)} is ${(distancePct * 100).toFixed(2)}% above strike $${strike.toFixed(0)} with ${minutesRemaining.toFixed(1)}m left. YES at ${(yesAskPrice * 100).toFixed(0)}¢.${smConfirms ? " Smart money confirms." : ""}`,
            smart_money_confirms: smConfirms,
          });
        }

        // NO SIGNAL — price below strike
        if (distancePct < -0.001 && noAskPrice < 0.97 && noAskPrice > 0.05) {
          const timeFactorScore = Math.max(0, 1 - minutesRemaining / 60);
          const distanceScore = Math.min(1, Math.abs(distancePct) * 100);
          let confidence = (timeFactorScore * 0.5 + distanceScore * 0.5);
          const smConfirms = smartMoney.signal === "buy_no";
          if (smConfirms) confidence = Math.min(0.98, confidence * 1.15);
          if (minutesRemaining < 20) confidence = Math.min(0.98, confidence * 1.10);
          if (isTurbo && minutesRemaining < 10) confidence = Math.min(0.98, confidence * 1.10);
          if (confidence < 0.30) {
              if (_skippedConfidenceLog < 3) {
                console.log(`  [Sniper] SKIP Type B "${m.title.slice(0, 60)}": confidence ${confidence.toFixed(2)} < 0.30`);
                _skippedConfidenceLog++;
              }
              continue;
            }

          signals.push({
            ticker: m.ticker, market_question: m.title, direction: "NO",
            contract_price: noAskPrice,
            potential_return_pct: (1 - noAskPrice) / noAskPrice,
            confidence, minutes_remaining: minutesRemaining,
            reasoning: `${assetName} at $${livePrice.toFixed(0)} is ${(Math.abs(distancePct) * 100).toFixed(2)}% below strike $${strike.toFixed(0)} with ${minutesRemaining.toFixed(1)}m left. NO at ${(noAskPrice * 100).toFixed(0)}¢.${smConfirms ? " Smart money confirms." : ""}`,
            smart_money_confirms: smConfirms,
          });
        }

        // If neither YES nor NO signal was generated for this Type B market, log why
        if (Math.abs(distancePct) <= 0.001 && _debugCount < 5) {
          console.log(`  🔍 [Sniper] ${m.ticker}: ${assetName} $${livePrice.toFixed(0)} vs strike $${strike.toFixed(0)}, dist ${(distancePct*100).toFixed(3)}% — too close to strike`);
          _debugCount++;
        }
      }
    } catch (err: any) {
      // Log series discovery failures so we can debug ticker names
      console.log(`  ⚡ [Sniper] ${series}: ${err.message?.slice(0, 80)}`);
    }
  }

  // ── Settlement window confidence boost ──
  // For signals in the final 3 minutes, use the settlement predictor to refine confidence
  for (const sig of signals) {
    if (sig.minutes_remaining <= 3) {
      const titleLower = sig.market_question.toLowerCase();
      const symbol = titleLower.includes("btc") ? "btcusdt" : titleLower.includes("eth") ? "ethusdt" : titleLower.includes("sol") ? "solusdt" : "xrpusdt";
      const settlement = predictSettlement(symbol);
      if (settlement && settlement.confidence > 0.6) {
        // If settlement prediction agrees with our direction, boost confidence
        const directionAgrees = (sig.direction === "YES" && settlement.trend_direction === "up") ||
                                (sig.direction === "NO" && settlement.trend_direction === "down");
        if (directionAgrees) {
          sig.confidence = Math.min(0.98, sig.confidence * 1.15);
          sig.reasoning += ` Settlement predictor confirms (${(settlement.confidence * 100).toFixed(0)}% conf).`;
        }
      }
    }
  }

  // ── Cross-asset cascade signals ──
  // When BTC spikes but ETH/SOL/XRP haven't caught up, flag those contracts
  const cascades = detectCrossAssetCascade();
  if (cascades.length > 0) {
    console.log(`  🔗 [Cascade] ${cascades.map(c => `${c.leader}→${c.follower} ${c.direction} (gap ${c.gap_pct.toFixed(2)}%)`).join(", ")}`);
    // Boost confidence on matching signals for the lagging asset
    for (const cascade of cascades) {
      for (const sig of signals) {
        const sigAsset = sig.market_question.toLowerCase();
        const matchesFollower = (cascade.follower === "ETH" && sigAsset.includes("eth")) ||
                                (cascade.follower === "SOL" && sigAsset.includes("sol")) ||
                                (cascade.follower === "XRP" && sigAsset.includes("xrp"));
        const directionMatches = (cascade.direction === "up" && sig.direction === "YES") ||
                                 (cascade.direction === "down" && sig.direction === "NO");
        if (matchesFollower && directionMatches) {
          sig.confidence = Math.min(0.98, sig.confidence * 1.20); // 20% boost from cross-asset confirmation
          sig.reasoning += ` Cross-asset: ${cascade.leader} leading ${cascade.follower} ${cascade.direction}.`;
        }
      }
    }
  }

  console.log(`  ⚡ [Sniper] ${activeSeries.length} series, ${_marketsScanned} mkts, ${_marketsInWindow} in window, ${signals.length} signals (${_noLivePrice} no-price, ${_noPriceMatch} no-strike)`);

  return signals.sort((a, b) =>
    (b.confidence * b.potential_return_pct) - (a.confidence * a.potential_return_pct)
  );
}

// ═══════════════════════════════════════════════════════════
// STRATEGY 2: GROUPED MARKET ARBITRAGE
// ═══════════════════════════════════════════════════════════

export interface MonotonicityViolation {
  event_ticker: string;
  market_a: { ticker: string; question: string; yes_ask: number };
  market_b: { ticker: string; question: string; yes_bid: number };
  edge_cents: number;
  reasoning: string;
}

export async function scanMonotonicityArb(client: KalshiClient): Promise<MonotonicityViolation[]> {
  const violations: MonotonicityViolation[] = [];

  try {
    const data: any = await client.getEvents({ with_nested_markets: true, limit: 50 });

    for (const event of data.events ?? []) {
      const markets: KalshiMarket[] = event.markets ?? [];
      if (markets.length < 2) continue;

      const withStrikes = markets.map((m) => {
        const match = m.title.match(/(\$?[\d,]+(?:\.\d+)?)/);
        const strike = match ? parseFloat(match[1].replace(/[\$,]/g, "")) : NaN;
        return { market: m, strike };
      }).filter((x) => !isNaN(x.strike))
        .sort((a, b) => a.strike - b.strike);

      if (withStrikes.length < 2) continue;

      for (let i = 0; i < withStrikes.length - 1; i++) {
        const lower = withStrikes[i];
        const higher = withStrikes[i + 1];

        if (higher.market.yes_ask < lower.market.yes_bid) {
          const edgeCents = lower.market.yes_bid - higher.market.yes_ask;
          if (edgeCents >= 2) {
            violations.push({
              event_ticker: event.event_ticker ?? event.ticker,
              market_a: { ticker: higher.market.ticker, question: higher.market.title, yes_ask: higher.market.yes_ask },
              market_b: { ticker: lower.market.ticker, question: lower.market.title, yes_bid: lower.market.yes_bid },
              edge_cents: edgeCents,
              reasoning: `Higher strike YES (${higher.market.yes_ask}¢) cheaper than lower strike YES (${lower.market.yes_bid}¢) — violates monotonicity by ${edgeCents}¢`,
            });
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`Monotonicity scan error: ${err.message}`);
  }

  return violations.sort((a, b) => b.edge_cents - a.edge_cents);
}

// ═══════════════════════════════════════════════════════════
// STRATEGY 3: ECONOMIC RELEASE TRADER (now with FRED data!)
// ═══════════════════════════════════════════════════════════

export interface EconomicSignal {
  ticker: string;
  release_name: string;
  category: "fed" | "cpi" | "jobs" | "gdp" | "other";
  market_implied_prob: number;
  fred_implied_direction: "YES" | "NO";
  edge: number;
  confidence: number;
  reasoning: string;
  minutes_until_close: number;
}

const ECONOMIC_KEYWORDS: Array<[RegExp, string]> = [
  [/federal reserve|fed.*rate|interest rate/i, "fed"],
  [/cpi|consumer price|inflation/i, "cpi"],
  [/jobs|nonfarm|unemployment/i, "jobs"],
  [/gdp|gross domestic/i, "gdp"],
];

export async function scanEconomicMarkets(client: KalshiClient): Promise<EconomicSignal[]> {
  const signals: EconomicSignal[] = [];
  const now = Date.now();

  try {
    const { markets } = await client.getMarkets({ limit: 200 });

    // Get FRED economic snapshot
    const snapshot = await getEconomicSnapshot();

    for (const m of markets) {
      let category: EconomicSignal["category"] | null = null;
      for (const [regex, cat] of ECONOMIC_KEYWORDS) {
        if (regex.test(m.title) || regex.test(m.subtitle ?? "")) {
          category = cat as any;
          break;
        }
      }
      if (!category) continue;

      const closeTime = new Date(m.close_time).getTime();
      const minutesUntilClose = (closeTime - now) / 60000;
      if (minutesUntilClose < 0) continue;

      const marketProb = m.yes_ask > 0 ? m.yes_ask / 100 : 0.50;

      // Get FRED-based edge
      const fredEdge = getEconomicEdge(m.title, snapshot);
      if (!fredEdge || !fredEdge.has_edge) continue;

      // Check smart money confirmation
      const smartMoney = getSmartMoneySignal(m.ticker);
      let confidence = 0.60;
      if (smartMoney.signal === `buy_${fredEdge.direction.toLowerCase()}`) {
        confidence = Math.min(0.90, confidence + 0.15);
      }

      signals.push({
        ticker: m.ticker,
        release_name: m.title,
        category,
        market_implied_prob: marketProb,
        fred_implied_direction: fredEdge.direction,
        edge: fredEdge.edge_estimate,
        confidence,
        reasoning: `${fredEdge.reasoning}${smartMoney.signal !== "none" ? ` Smart money: ${smartMoney.signal}` : ""}`,
        minutes_until_close: minutesUntilClose,
      });
    }
  } catch (err: any) {
    console.error(`Economic scan error: ${err.message}`);
  }

  return signals.sort((a, b) => Math.abs(b.edge) - Math.abs(a.edge));
}

// ═══════════════════════════════════════════════════════════
// STRATEGY 4: WEATHER EDGE (now with real NWS data!)
// ═══════════════════════════════════════════════════════════

export interface WeatherMarketSignal {
  ticker: string;
  question: string;
  market_implied_prob: number;
  forecast_implied_prob: number;
  edge: number;
  direction: "YES" | "NO";
  confidence: number;
  reasoning: string;
}

export async function scanWeatherMarkets(client: KalshiClient): Promise<WeatherMarketSignal[]> {
  try {
    const { markets } = await client.getMarkets({ limit: 200 });
    const weatherMarkets = markets.filter((m) =>
      /weather|temperature|snow|rain|hurricane|storm|snowfall|°F|°C|inches/i.test(m.title) ||
      /weather|temperature|snow|rain|hurricane|storm/i.test(m.subtitle ?? "")
    );

    if (weatherMarkets.length === 0) return [];

    // Use real NWS data for edge calculation
    const nwsEdges = await getWeatherEdge(weatherMarkets.map(m => ({
      ticker: m.ticker,
      title: m.title,
      yes_ask: m.yes_ask / 100,  // Convert cents → 0-1 probability for edge calculation
      subtitle: m.subtitle,
      close_time: m.close_time,
    })));

    return nwsEdges.map(e => ({
      ticker: e.ticker,
      question: e.market_question,
      market_implied_prob: e.market_implied_prob,
      forecast_implied_prob: e.nws_implied_prob,
      edge: e.edge,
      direction: e.direction,
      confidence: e.confidence,
      reasoning: e.reasoning,
    }));
  } catch (err: any) {
    console.error(`Weather scan error: ${err.message}`);
    return [];
  }
}

// ═══════════════════════════════════════════════════════════
// STRATEGY 5: CROSS-PLATFORM DIVERGENCE
// ═══════════════════════════════════════════════════════════

export interface CrossPlatformDivergence {
  kalshi_ticker: string;
  polymarket_question: string;
  kalshi_yes_price: number;
  polymarket_yes_price: number;
  divergence: number;
  trade_direction: "YES" | "NO";
  confidence: number;
  reasoning: string;
}

export async function scanCrossPlatformDivergences(client: KalshiClient): Promise<CrossPlatformDivergence[]> {
  const divergences: CrossPlatformDivergence[] = [];

  try {
    const { markets: kalshiMarkets } = await client.getMarkets({ limit: 100 });

    const polyRes = await fetch("https://gamma-api.polymarket.com/markets?active=true&closed=false&limit=100", {
      signal: AbortSignal.timeout(10000),
    });
    if (!polyRes.ok) return [];
    const polyMarkets = (await polyRes.json() as any[]) ?? [];

    for (const km of kalshiMarkets) {
      const kalshiKeywords = km.title.toLowerCase().split(/\s+/).filter((w: string) => w.length > 4);

      for (const pm of polyMarkets) {
        const pmTitle = (pm.question ?? "").toLowerCase();
        const overlapCount = kalshiKeywords.filter((kw: string) => pmTitle.includes(kw)).length;
        if (overlapCount < 3) continue;

        const kalshiYes = km.yes_ask / 100;
        const polyYes = parseFloat(pm.outcomePrices?.[0] ?? "0.5");
        if (polyYes <= 0 || polyYes >= 1) continue;

        const divergence = kalshiYes - polyYes;
        if (Math.abs(divergence) >= 0.06) {  // Lowered from 8 to 6 cents
          // Check smart money for confirmation
          const smartMoney = getSmartMoneySignal(km.ticker);
          const tradeDir = divergence > 0 ? "NO" : "YES";
          let confidence = 0.65 + Math.min(0.25, Math.abs(divergence));
          if (smartMoney.signal === `buy_${tradeDir.toLowerCase()}`) {
            confidence = Math.min(0.95, confidence + 0.10);
          }

          divergences.push({
            kalshi_ticker: km.ticker,
            polymarket_question: pm.question,
            kalshi_yes_price: kalshiYes,
            polymarket_yes_price: polyYes,
            divergence,
            trade_direction: tradeDir as "YES" | "NO",
            confidence,
            reasoning: `Kalshi ${(kalshiYes * 100).toFixed(0)}¢ vs Poly ${(polyYes * 100).toFixed(0)}¢ — gap ${(Math.abs(divergence) * 100).toFixed(0)}¢${smartMoney.signal !== "none" ? ` (smart money: ${smartMoney.signal})` : ""}`,
          });
        }
      }
    }
  } catch (err: any) {
    console.error(`Cross-platform scan error: ${err.message}`);
  }

  return divergences.sort((a, b) => Math.abs(b.divergence) - Math.abs(a.divergence));
}

// ═══════════════════════════════════════════════════════════
// UTILITY: Get odds movements for all cached markets
// ═══════════════════════════════════════════════════════════

export function getOddsMovementSignals(markets: Array<{condition_id: string; question: string; yes_price: number; no_price: number; volume_24h?: number}>): OddsMovement[] {
  return detectOddsMovements(markets);
}

// ═══════════════════════════════════════════════════════════
// STRATEGY 6: HIGH-CONFIDENCE NEAR-CLOSE (85-94¢ strategy)
// ═══════════════════════════════════════════════════════════
//
// Research-backed: buy YES shares at 85-94¢ on markets closing
// within 12 hours. High win rate, small profit per trade,
// rapid turnover. Zero API cost — purely mechanical.

export interface HighConfidenceSignal {
  ticker: string;
  question: string;
  direction: "YES" | "NO";
  price: number;          // 0-1 format
  expected_profit_pct: number;
  confidence: number;
  hours_to_close: number;
  reasoning: string;
}

export async function scanHighConfidence(client: KalshiClient, cachedMarkets?: Array<{ condition_id: string; question: string; yes_price: number; no_price: number; end_date?: string; volume?: number }>): Promise<HighConfidenceSignal[]> {
  const signals: HighConfidenceSignal[] = [];
  const now = Date.now();
  let totalChecked = 0;
  let totalInWindow = 0;
  let totalPriceMatch = 0;

  try {
    // Use cached markets if available (pre-filtered, known-liquid)
    // Fall back to series-based API calls for crypto turbo markets
    const marketsToCheck: Array<{ ticker: string; title: string; yes_ask: number; no_ask: number; yes_bid: number; no_bid: number; close_time: string }> = [];

    // Add cached markets (from events endpoint — known active & liquid)
    if (cachedMarkets && cachedMarkets.length > 0) {
      for (const m of cachedMarkets) {
        // Use raw Kalshi close_time if available (end_date may come from expected_expiration_time which is often empty)
        const rawCloseTime = (m as any).raw?.close_time || m.end_date || "";
        marketsToCheck.push({
          ticker: m.condition_id,
          title: m.question,
          yes_ask: Math.round(m.yes_price * 100),
          no_ask: Math.round(m.no_price * 100),
          yes_bid: Math.round(m.yes_price * 100) - 2, // Approximate bid (2¢ spread estimate)
          no_bid: Math.round(m.no_price * 100) - 2,
          close_time: rawCloseTime,
        });
      }
    }

    // Also check crypto turbo series directly for near-term opportunities
    for (const series of ["KXBTC15M", "KXETH15M", "KXSOL15M", "KXBTCD", "KXETHD"]) {
      try {
        const { markets } = await client.getMarkets({ series_ticker: series, limit: 50 });
        for (const m of markets) {
          if (m.yes_ask > 0) { // Only add if there's actual liquidity
            marketsToCheck.push(m);
          }
        }
      } catch {}
    }

    totalChecked = marketsToCheck.length;

    let _noCloseTime = 0;
    for (const m of marketsToCheck) {
      if (!m.close_time) { _noCloseTime++; continue; }
      const closeTime = new Date(m.close_time).getTime();
      const hoursToClose = (closeTime - now) / (1000 * 60 * 60);

      // Only markets closing within 24 hours (expanded from 12)
      if (hoursToClose < 0.25 || hoursToClose > 24) continue;
      totalInWindow++;

      const yesAskProb = m.yes_ask / 100;
      const noAskProb = m.no_ask / 100;

      // YES side: price 75-96¢ → market thinks highly likely YES (expanded from 85-94)
      if (yesAskProb >= 0.75 && yesAskProb <= 0.96 && m.yes_ask > 0 && m.yes_bid > 0) {
        totalPriceMatch++;
        const spread = m.yes_ask - m.yes_bid;
        if (spread > 10) continue; // Skip illiquid markets (>10¢ spread)

        const timeBoost = hoursToClose < 2 ? 0.05 : hoursToClose < 6 ? 0.02 : 0;
        const confidence = Math.min(0.95, yesAskProb + timeBoost);
        const expectedProfit = (1 - yesAskProb) / yesAskProb;

        signals.push({
          ticker: m.ticker,
          question: m.title,
          direction: "YES",
          price: yesAskProb,
          expected_profit_pct: expectedProfit,
          confidence,
          hours_to_close: hoursToClose,
          reasoning: `YES at ${(yesAskProb * 100).toFixed(0)}¢, ${hoursToClose.toFixed(1)}h to close, spread ${spread}¢. Expected ${(expectedProfit * 100).toFixed(1)}% return if correct.`,
        });
      }

      // NO side: same logic (expanded from 85-94 to 75-96)
      if (noAskProb >= 0.75 && noAskProb <= 0.96 && m.no_ask > 0 && m.no_bid > 0) {
        totalPriceMatch++;
        const spread = m.no_ask - m.no_bid;
        if (spread > 10) continue;

        const timeBoost = hoursToClose < 2 ? 0.05 : hoursToClose < 6 ? 0.02 : 0;
        const confidence = Math.min(0.95, noAskProb + timeBoost);
        const expectedProfit = (1 - noAskProb) / noAskProb;

        signals.push({
          ticker: m.ticker,
          question: m.title,
          direction: "NO",
          price: noAskProb,
          expected_profit_pct: expectedProfit,
          confidence,
          hours_to_close: hoursToClose,
          reasoning: `NO at ${(noAskProb * 100).toFixed(0)}¢, ${hoursToClose.toFixed(1)}h to close, spread ${spread}¢. Expected ${(expectedProfit * 100).toFixed(1)}% return if correct.`,
        });
      }
    }

    console.log(`  [HighConf] ${totalChecked} markets checked, ${_noCloseTime} no-close-time, ${totalInWindow} closing <24h, ${totalPriceMatch} in 75-96¢ range, ${signals.length} signals`);
  } catch (err: any) {
    console.error(`High-confidence scan error: ${err.message}`);
  }

  // Sort by: closer to close + higher price (higher confidence) first
  return signals.sort((a, b) => {
    const scoreA = a.confidence * (1 / Math.max(0.5, a.hours_to_close));
    const scoreB = b.confidence * (1 / Math.max(0.5, b.hours_to_close));
    return scoreB - scoreA;
  });
}

// Legacy exports for backward compat
export { type EconomicSignal as EconomicReleaseEvent };
export async function findEconomicEvents(client: KalshiClient) {
  return scanEconomicMarkets(client);
}
