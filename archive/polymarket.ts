// src/polymarket.ts — Polymarket CLOB API client

import { config } from "./config.js";
import { Wallet } from "ethers";

export interface Market {
  condition_id: string;
  question: string;
  description: string;
  market_slug: string;
  active: boolean;
  closed: boolean;
  tokens: { token_id: string; outcome: string; price: number }[];
  volume: number;
  liquidity: number;
  end_date_iso: string;
  category: string;
}

export interface OrderPayload {
  tokenID: string;
  price: number;
  size: number;
  side: "BUY" | "SELL";
  feeRateBps: number;
}

// ── Fetch active markets from Gamma API ──
export async function fetchActiveMarkets(limit = 50): Promise<Market[]> {
  const url = new URL(`${config.GAMMA_API_URL}/markets`);
  url.searchParams.set("limit", String(limit));
  url.searchParams.set("active", "true");
  url.searchParams.set("closed", "false");
  url.searchParams.set("order", "volume");
  url.searchParams.set("ascending", "false");

  const res = await fetch(url.toString());
  if (!res.ok) throw new Error(`Gamma API error: ${res.status} ${await res.text()}`);

  const raw: any[] = await res.json();

  return raw
    .filter((m) => m.tokens && m.tokens.length === 2 && !m.closed)
    .map((m) => ({
      condition_id: m.conditionId ?? m.condition_id ?? "",
      question: m.question ?? "",
      description: m.description ?? "",
      market_slug: m.slug ?? m.market_slug ?? "",
      active: m.active ?? true,
      closed: m.closed ?? false,
      tokens: (m.tokens ?? []).map((t: any) => ({
        token_id: t.token_id ?? "",
        outcome: t.outcome ?? "",
        price: parseFloat(t.price ?? "0.5"),
      })),
      volume: parseFloat(m.volume ?? "0"),
      liquidity: parseFloat(m.liquidity ?? "0"),
      end_date_iso: m.end_date_iso ?? m.endDate ?? "",
      category: m.category ?? "unknown",
    }));
}

// ── Fetch orderbook for a specific token ──
export async function fetchOrderbook(tokenId: string) {
  const url = `${config.CLOB_API_URL}/book?token_id=${tokenId}`;
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Orderbook error: ${res.status}`);
  return await res.json();
}

// ── Get CLOB API key (required for placing orders) ──
async function getClobApiKey(): Promise<string> {
  // Polymarket uses a derived API key flow:
  // 1. Request a nonce from /auth/nonce
  // 2. Sign it with your wallet
  // 3. Exchange for an API key via /auth/api-key

  const nonceRes = await fetch(`${config.CLOB_API_URL}/auth/nonce`, {
    method: "GET",
  });
  if (!nonceRes.ok) throw new Error("Failed to get nonce");

  // For production, implement the full CLOB auth flow per docs.polymarket.com
  // This is a simplified placeholder — Claude Code can flesh this out with your private key
  throw new Error(
    "CLOB auth not yet configured. Run Claude Code to implement the full signing flow for your wallet."
  );
}

// ── Place a limit order (live mode only) ──
export async function placeLimitOrder(order: OrderPayload): Promise<any> {
  if (config.DRY_RUN) {
    return { status: "dry_run", order };
  }

  const wallet = new Wallet(config.POLYMARKET_PRIVATE_KEY);

  // The full order placement flow requires:
  // 1. Getting/caching a CLOB API key via the auth flow
  // 2. Building the order struct
  // 3. Signing with EIP-712
  // 4. POST to /order
  //
  // The py-clob-client reference implementation:
  //   github.com/Polymarket/py-clob-client
  //
  // For now, log what would be placed:
  console.log(`[LIVE ORDER] ${order.side} ${order.size} shares @ $${order.price}`);
  console.log(`  Token: ${order.tokenID}`);

  // TODO: Implement full signing + POST /order
  // Claude Code prompt: "Implement the Polymarket CLOB order signing flow
  //   using ethers.js EIP-712 typed data signing per docs.polymarket.com/api/signing"
  return { status: "not_yet_implemented", order };
}

// ── Helper: get YES/NO prices from a market ──
export function getMarketPrices(market: Market) {
  const yes = market.tokens.find((t) => t.outcome.toLowerCase() === "yes");
  const no = market.tokens.find((t) => t.outcome.toLowerCase() === "no");
  return {
    yesPrice: yes?.price ?? 0.5,
    noPrice: no?.price ?? 0.5,
    yesTokenId: yes?.token_id ?? "",
    noTokenId: no?.token_id ?? "",
  };
}
