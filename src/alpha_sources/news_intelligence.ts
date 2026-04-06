// src/alpha_sources/news_intelligence.ts
//
// NEWS INTELLIGENCE PIPELINE
//
// The single biggest alpha source is information arriving before it's
// priced into the market. This module:
//
// 1. Scrapes RSS feeds every 2 minutes
// 2. Dedupes against items we've seen
// 3. Has Claude classify each new item:
//    - Relevance to active markets
//    - Urgency (breaking/recent/old)
//    - Direction (which way it pushes probabilities)
// 4. Emits trade signals when breaking news doesn't match current prices
// 5. Feeds into the Cognitive Council for immediate deliberation
//
// With this, the bot can trade BEFORE the market reprices, capturing
// the 30-second to 5-minute window that the winning bots exploit.

import Anthropic from "@anthropic-ai/sdk";
import { config } from "../core/config.js";
import { getDb } from "../core/db.js";

const client = new Anthropic({ apiKey: config.ANTHROPIC_API_KEY });

// Free RSS feeds across categories
const RSS_FEEDS = [
  // Breaking news
  { url: "https://feeds.reuters.com/reuters/topNews", category: "general", source: "Reuters" },
  { url: "https://feeds.bbci.co.uk/news/world/rss.xml", category: "general", source: "BBC" },
  { url: "https://feeds.apnews.com/rss/apf-topnews", category: "general", source: "AP" },
  // Politics
  { url: "https://feeds.politico.com/politico-news", category: "politics", source: "Politico" },
  { url: "https://thehill.com/news/feed/", category: "politics", source: "The Hill" },
  // Crypto
  { url: "https://cointelegraph.com/rss", category: "crypto", source: "Cointelegraph" },
  { url: "https://decrypt.co/feed", category: "crypto", source: "Decrypt" },
  { url: "https://www.coindesk.com/arc/outboundfeeds/rss/", category: "crypto", source: "Coindesk" },
  // Finance
  { url: "https://feeds.bloomberg.com/markets/news.rss", category: "finance", source: "Bloomberg" },
  // Tech
  { url: "https://techcrunch.com/feed/", category: "tech", source: "TechCrunch" },
];

export interface NewsItem {
  id: string;          // Hash of URL
  title: string;
  description: string;
  link: string;
  published: number;   // Timestamp
  source: string;
  category: string;
}

export interface NewsSignal {
  news_id: string;
  market_keywords: string[];
  urgency: "breaking" | "recent" | "stale";
  direction_push: "increases" | "decreases" | "neutral";
  probability_shift: number;  // Estimated shift in fair value
  confidence: number;
  reasoning: string;
  expires_at: number;
}

export function initNewsIntelligence() {
  const db = getDb();
  db.exec(`
    CREATE TABLE IF NOT EXISTS news_items (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      description TEXT,
      link TEXT NOT NULL,
      published INTEGER NOT NULL,
      source TEXT NOT NULL,
      category TEXT NOT NULL,
      discovered_at INTEGER NOT NULL,
      classified INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS idx_news_discovered ON news_items(discovered_at);
    CREATE INDEX IF NOT EXISTS idx_news_classified ON news_items(classified);

    CREATE TABLE IF NOT EXISTS news_signals (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      news_id TEXT NOT NULL,
      market_keywords TEXT NOT NULL,
      urgency TEXT NOT NULL,
      direction_push TEXT NOT NULL,
      probability_shift REAL NOT NULL,
      confidence REAL NOT NULL,
      reasoning TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER NOT NULL,
      acted_on INTEGER DEFAULT 0,
      FOREIGN KEY (news_id) REFERENCES news_items(id)
    );
  `);
}

// ── Simple RSS parser (no external dependency) ──
async function fetchRSS(url: string): Promise<NewsItem[]> {
  try {
    const res = await fetch(url, { 
      headers: { 
        "User-Agent": "Mozilla/5.0 (Polymarket Intelligence Bot)",
        "Accept": "application/rss+xml, application/xml, text/xml",
      },
      signal: AbortSignal.timeout(10000),
    });
    if (!res.ok) return [];
    const xml = await res.text();

    // Parse XML items with regex (good enough for RSS)
    const items: NewsItem[] = [];
    const itemRegex = /<item>([\s\S]*?)<\/item>/g;
    let match;
    while ((match = itemRegex.exec(xml)) !== null) {
      const itemXml = match[1];
      const title = extractXmlTag(itemXml, "title");
      const description = extractXmlTag(itemXml, "description");
      const link = extractXmlTag(itemXml, "link");
      const pubDate = extractXmlTag(itemXml, "pubDate");
      if (!title || !link) continue;

      const published = pubDate ? new Date(pubDate).getTime() : Date.now();
      const id = hashString(link);

      items.push({
        id, title, description: description || "",
        link, published,
        source: "", category: "",
      });
    }
    return items;
  } catch {
    return [];
  }
}

function extractXmlTag(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)</${tag}>`, "i");
  const cdataRegex = new RegExp(`<${tag}[^>]*><!\\[CDATA\\[([\\s\\S]*?)\\]\\]></${tag}>`, "i");
  const cdataMatch = xml.match(cdataRegex);
  if (cdataMatch) return cdataMatch[1].trim();
  const match = xml.match(regex);
  return match ? match[1].replace(/<[^>]+>/g, "").trim() : "";
}

function hashString(s: string): string {
  let hash = 0;
  for (let i = 0; i < s.length; i++) {
    const chr = s.charCodeAt(i);
    hash = ((hash << 5) - hash) + chr;
    hash |= 0;
  }
  return Math.abs(hash).toString(36);
}

// ── Fetch all feeds, dedupe, store ──
export async function fetchAllFeeds(): Promise<number> {
  const db = getDb();
  let newItemCount = 0;

  const existing = new Set((db.prepare(`SELECT id FROM news_items`).all() as any[]).map((r) => r.id));

  const results = await Promise.all(RSS_FEEDS.map(async (feed) => {
    const items = await fetchRSS(feed.url);
    return items.map((i) => ({ ...i, source: feed.source, category: feed.category }));
  }));

  const allItems = results.flat();
  for (const item of allItems) {
    if (existing.has(item.id)) continue;
    // Only keep items from last 24 hours
    if (Date.now() - item.published > 24 * 60 * 60 * 1000) continue;
    try {
      db.prepare(`
        INSERT INTO news_items (id, title, description, link, published, source, category, discovered_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      `).run(item.id, item.title, item.description.slice(0, 500), item.link, item.published, item.source, item.category, Date.now());
      newItemCount++;
    } catch {}
  }
  return newItemCount;
}

// ── Claude classifies unclassified items ──
export async function classifyNewItems(activeMarketQuestions: string[]): Promise<NewsSignal[]> {
  const db = getDb();
  const unclassified = db.prepare(`
    SELECT * FROM news_items 
    WHERE classified = 0 
    ORDER BY published DESC LIMIT 15
  `).all() as NewsItem[];

  if (unclassified.length === 0 || activeMarketQuestions.length === 0) return [];

  const newsText = unclassified.map((n, i) => 
    `${i + 1}. [${n.source}] ${n.title}\n   ${n.description.slice(0, 200)}`
  ).join("\n");

  const marketsText = activeMarketQuestions.slice(0, 30).map((q, i) => `${i + 1}. ${q}`).join("\n");

  try {
    const res = await client.messages.create({
      model: config.CLAUDE_MODEL,
      max_tokens: 3000,
      system: `You are a news-to-market intelligence analyst.
For each news item, determine:
1. Is it relevant to ANY active Polymarket market?
2. How urgent is it? (breaking = just happened, recent = past few hours, stale = older)
3. Which direction does it push probabilities? (increases/decreases/neutral)
4. How big is the shift? (small < 0.05, medium 0.05-0.15, large > 0.15)

Only report items that are BOTH relevant and have non-neutral directional impact.
You MUST call the "signals" tool.`,
      tools: [{
        name: "signals",
        description: "News-to-market signals",
        input_schema: {
          type: "object" as const,
          properties: {
            signals: {
              type: "array",
              items: {
                type: "object",
                properties: {
                  news_index: { type: "number" },
                  market_indices: { type: "array", items: { type: "number" } },
                  urgency: { type: "string", enum: ["breaking", "recent", "stale"] },
                  direction: { type: "string", enum: ["increases", "decreases", "neutral"] },
                  probability_shift: { type: "number" },
                  confidence: { type: "number" },
                  reasoning: { type: "string" },
                },
                required: ["news_index", "market_indices", "urgency", "direction", "probability_shift", "confidence", "reasoning"],
              },
            },
          },
          required: ["signals"],
        },
      }],
      messages: [{
        role: "user",
        content: `NEWS ITEMS:\n${newsText}\n\nACTIVE MARKETS:\n${marketsText}\n\nWhich news items would move which markets, and in what direction?`,
      }],
    });

    const toolUse = res.content.find((b) => b.type === "tool_use");
    if (!toolUse || toolUse.type !== "tool_use") return [];

    const input = toolUse.input as { signals: any[] };
    const newSignals: NewsSignal[] = [];

    for (const sig of input.signals ?? []) {
      const newsItem = unclassified[sig.news_index - 1];
      if (!newsItem || sig.direction === "neutral" || sig.confidence < 0.5) continue;

      const marketKeywords = (sig.market_indices ?? [])
        .map((idx: number) => activeMarketQuestions[idx - 1])
        .filter(Boolean)
        .map((q: string) => q.slice(0, 80));

      if (marketKeywords.length === 0) continue;

      // Signal expires based on urgency
      const expirationMs = sig.urgency === "breaking" ? 15 * 60 * 1000 
        : sig.urgency === "recent" ? 60 * 60 * 1000
        : 4 * 60 * 60 * 1000;

      const signal: NewsSignal = {
        news_id: newsItem.id,
        market_keywords: marketKeywords,
        urgency: sig.urgency,
        direction_push: sig.direction,
        probability_shift: sig.probability_shift,
        confidence: sig.confidence,
        reasoning: sig.reasoning,
        expires_at: Date.now() + expirationMs,
      };

      db.prepare(`
        INSERT INTO news_signals 
        (news_id, market_keywords, urgency, direction_push, probability_shift, confidence, reasoning, created_at, expires_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        signal.news_id, JSON.stringify(signal.market_keywords),
        signal.urgency, signal.direction_push, signal.probability_shift,
        signal.confidence, signal.reasoning, Date.now(), signal.expires_at
      );

      newSignals.push(signal);
    }

    // Mark all processed items as classified
    for (const item of unclassified) {
      db.prepare(`UPDATE news_items SET classified = 1 WHERE id = ?`).run(item.id);
    }

    return newSignals;
  } catch (err: any) {
    console.error(`  News classification error: ${err.message}`);
    return [];
  }
}

// ── Get unacted signals that haven't expired ──
export function getActiveNewsSignals(): NewsSignal[] {
  const db = getDb();
  const now = Date.now();
  const rows = db.prepare(`
    SELECT * FROM news_signals 
    WHERE expires_at > ? AND acted_on = 0
    ORDER BY created_at DESC LIMIT 20
  `).all(now) as any[];

  return rows.map((r) => ({
    news_id: r.news_id,
    market_keywords: JSON.parse(r.market_keywords),
    urgency: r.urgency,
    direction_push: r.direction_push,
    probability_shift: r.probability_shift,
    confidence: r.confidence,
    reasoning: r.reasoning,
    expires_at: r.expires_at,
  }));
}

export function markSignalActedOn(newsId: string) {
  const db = getDb();
  db.prepare(`UPDATE news_signals SET acted_on = 1 WHERE news_id = ?`).run(newsId);
}

// ── Main loop: fetch + classify ──
export async function runNewsIntelligenceCycle(getActiveMarkets: () => string[]): Promise<{ new_items: number; new_signals: number }> {
  const newItems = await fetchAllFeeds();
  if (newItems === 0) return { new_items: 0, new_signals: 0 };

  const markets = getActiveMarkets();
  const signals = await classifyNewItems(markets);

  return { new_items: newItems, new_signals: signals.length };
}
