#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response } from "express";
import cors from "cors";
import { z } from "zod";
import coinsData from "../coins.json";

// ── Coin / Network normalization ──────────────────────────────────────────────

/** Maps lowercase name or ticker → canonical lowercase ticker */
const coinAliasToTicker = new Map<string, string>();
/** Maps lowercase network value or coin name (single-network) → canonical lowercase network */
const networkAliasToNetwork = new Map<string, string>();
/** Set of valid "ticker:network" pairs */
const validPairs = new Set<string>();

// Count networks per ticker to detect single-network coins
const tickerNetworks = new Map<string, Set<string>>();
for (const c of coinsData) {
  const t = c.ticker.toLowerCase();
  if (!tickerNetworks.has(t)) tickerNetworks.set(t, new Set());
  tickerNetworks.get(t)!.add(c.network.toLowerCase());
}

for (const c of coinsData) {
  const ticker = c.ticker.toLowerCase();
  const name = c.name.toLowerCase();
  const network = c.network.toLowerCase();

  coinAliasToTicker.set(ticker, ticker);
  coinAliasToTicker.set(name, ticker); // e.g. "monero" → "xmr"

  networkAliasToNetwork.set(network, network);
  // For single-network coins, also accept the coin name/ticker as a network alias
  if (tickerNetworks.get(ticker)!.size === 1) {
    networkAliasToNetwork.set(name, network);   // "monero" → "xmr"
    networkAliasToNetwork.set(ticker, network);  // "xmr"   → "xmr"
  }

  validPairs.add(`${ticker}:${network}`);
}

function normalizeCoin(input: string): string {
  return coinAliasToTicker.get(input.toLowerCase()) ?? input.toLowerCase();
}

function normalizeNetwork(input: string): string {
  return networkAliasToNetwork.get(input.toLowerCase()) ?? input.toLowerCase();
}

/** Returns an error string if the pair is invalid, or null if OK. */
function validatePair(coin: string, network: string, label: string): string | null {
  const key = `${coin}:${network}`;
  if (validPairs.has(key)) return null;

  const validNets = [...tickerNetworks.get(coin) ?? []].sort();
  if (validNets.length > 0) {
    return (
      `Invalid network "${network}" for ${label} coin "${coin}". ` +
      `Supported networks for ${coin}: ${validNets.join(", ")}`
    );
  }

  const allTickers = [...new Set(coinsData.map(c => c.ticker))].sort().join(", ");
  return (
    `Unknown ${label} coin "${coin}". ` +
    `Supported tickers: ${allTickers}`
  );
}

/** Normalize + validate a coin/network pair. Throws on error. */
function resolvePair(coin: string, network: string, label: string): { coin: string; network: string } {
  const c = normalizeCoin(coin);
  const n = normalizeNetwork(network);
  const err = validatePair(c, n, label);
  if (err) throw new Error(err);
  return { coin: c, network: n };
}

const BASE_URL = process.env.CYPHERGOAT_API_URL ?? "https://api.cyphergoat.com";
const API_KEY = process.env.CYPHERGOAT_API_KEY ?? "";
const PORT = parseInt(process.env.PORT ?? "4242", 10);

async function apiRequest(
  path: string,
  method: "GET" | "POST",
  params?: Record<string, string | number | boolean>,
  body?: unknown
): Promise<unknown> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (API_KEY) {
    headers["Authorization"] = `Bearer ${API_KEY}`;
  }

  let url = `${BASE_URL}${path}`;

  if (method === "GET" && params) {
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) {
      if (v !== undefined && v !== null && v !== "") {
        qs.set(k, String(v));
      }
    }
    const qstr = qs.toString();
    if (qstr) url += `?${qstr}`;
  }

  const res = await fetch(url, {
    method,
    headers,
    body: method === "POST" ? JSON.stringify(body) : undefined,
  });

  const text = await res.text();
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(
      `HTTP ${res.status}: ${typeof data === "object" ? JSON.stringify(data) : text}`
    );
  }

  return data;
}

// ── Server factory ────────────────────────────────────────────────────────────
// Each connection gets its own McpServer instance.

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "cyphergoat",
    version: "1.0.0",
  });

  // ── Swap / Estimate tools ───────────────────────────────────────────────────

  server.tool(
    "get_estimate",
    "Get swap rate estimates across all supported exchanges for a cryptocurrency pair and amount. Returns a ranked list of offers with receive amounts, KYC scores.",
    {
      coin1: z.string().describe("Source cryptocurrency ticker (e.g. 'btc', 'eth')"),
      coin2: z.string().describe("Destination cryptocurrency ticker (e.g. 'xmr', 'usdt')"),
      amount: z.number().positive().describe("Amount of coin1 to swap"),
      network1: z.string().describe("Network for source coin (e.g. 'btc', 'eth', 'erc20')"),
      network2: z.string().describe("Network for destination coin"),
      best: z.boolean().optional().describe("Return only the single best estimate"),
    },
    async ({ coin1, coin2, amount, network1, network2, best }) => {
      const p1 = resolvePair(coin1, network1, "source");
      const p2 = resolvePair(coin2, network2, "destination");
      const data = await apiRequest("/estimate", "GET", {
        coin1: p1.coin, network1: p1.network,
        coin2: p2.coin, network2: p2.network,
        amount,
        ...(best !== undefined ? { best } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_swap",
    "Create a cryptocurrency swap transaction with a chosen exchange partner. Returns transaction details including the deposit address and tracking information.",
    {
      coin1: z.string().describe("Source cryptocurrency ticker"),
      coin2: z.string().describe("Destination cryptocurrency ticker"),
      amount: z.number().positive().describe("Amount of coin1 to swap"),
      network1: z.string().describe("Network for source coin"),
      network2: z.string().describe("Network for destination coin"),
      partner: z.string().describe("Exchange provider to use (e.g. 'ChangeNow')"),
      address: z.string().describe("Destination wallet address to receive coin2"),
      estimateid: z.string().optional().describe("Estimate ID from a prior get_estimate call"),
      affiliate: z.string().optional().describe("Affiliate referral code"),
    },
    async ({ coin1, coin2, amount, network1, network2, partner, address, estimateid, affiliate }) => {
      const p1 = resolvePair(coin1, network1, "source");
      const p2 = resolvePair(coin2, network2, "destination");
      const data = await apiRequest("/swap", "GET", {
        coin1: p1.coin, network1: p1.network,
        coin2: p2.coin, network2: p2.network,
        amount,
        partner,
        address,
        ...(estimateid ? { estimateid } : {}),
        ...(affiliate ? { affiliate } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "get_transaction",
    "Look up the current status and details of a CypherGoat swap transaction by its ID (CGID).",
    {
      id: z.string().describe("CypherGoat transaction ID (CGID)"),
    },
    async ({ id }) => {
      const data = await apiRequest("/transaction", "GET", { id });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  // ── Payment tools ───────────────────────────────────────────────────────────

  server.tool(
    "get_payment_estimate",
    "Get estimates for a CypherGoat Pay payment where a customer pays in one coin and the merchant receives a specific amount in another coin.",
    {
      coin1: z.string().describe("Customer's payment cryptocurrency ticker"),
      coin2: z.string().describe("Merchant's receive cryptocurrency ticker"),
      amount: z.number().positive().describe("Amount the merchant wants to receive (in coin2)"),
      network1: z.string().describe("Network for customer's payment coin"),
      network2: z.string().describe("Network for merchant's receive coin"),
    },
    async ({ coin1, coin2, amount, network1, network2 }) => {
      const p1 = resolvePair(coin1, network1, "source");
      const p2 = resolvePair(coin2, network2, "destination");
      const data = await apiRequest("/payments/estimate", "GET", {
        coin1: p1.coin, network1: p1.network,
        coin2: p2.coin, network2: p2.network,
        amount,
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_payment",
    "Create a CypherGoat Pay payment transaction using a specific exchange provider.",
    {
      coin1: z.string().describe("Customer's payment cryptocurrency ticker"),
      coin2: z.string().describe("Merchant's receive cryptocurrency ticker"),
      amount: z.number().positive().describe("Amount the merchant wants to receive (in coin2)"),
      partner: z.string().describe("Exchange provider to use"),
      network1: z.string().describe("Network for customer's payment coin"),
      network2: z.string().describe("Network for merchant's receive coin"),
      address: z.string().describe("Merchant's wallet address to receive coin2"),
      affiliate: z.string().optional().describe("Affiliate referral code"),
    },
    async ({ coin1, coin2, amount, partner, network1, network2, address, affiliate }) => {
      const p1 = resolvePair(coin1, network1, "source");
      const p2 = resolvePair(coin2, network2, "destination");
      const data = await apiRequest("/payments/create", "GET", {
        coin1: p1.coin, network1: p1.network,
        coin2: p2.coin, network2: p2.network,
        amount,
        partner,
        address,
        ...(affiliate ? { affiliate } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  server.tool(
    "create_quick_payment",
    "Create a CypherGoat Pay payment transaction with automatic best-rate exchange selection.",
    {
      coin1: z.string().describe("Customer's payment cryptocurrency ticker"),
      coin2: z.string().describe("Merchant's receive cryptocurrency ticker"),
      amount: z.number().positive().describe("Amount the merchant wants to receive (in coin2)"),
      network1: z.string().describe("Network for customer's payment coin"),
      network2: z.string().describe("Network for merchant's receive coin"),
      address: z.string().describe("Merchant's wallet address to receive coin2"),
      affiliate: z.string().optional().describe("Affiliate referral code"),
    },
    async ({ coin1, coin2, amount, network1, network2, address, affiliate }) => {
      const p1 = resolvePair(coin1, network1, "source");
      const p2 = resolvePair(coin2, network2, "destination");
      const data = await apiRequest("/payments/quick", "GET", {
        coin1: p1.coin, network1: p1.network,
        coin2: p2.coin, network2: p2.network,
        amount,
        address,
        ...(affiliate ? { affiliate } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// ── Transport selection ───────────────────────────────────────────────────────
// Set MCP_TRANSPORT=stdio to use stdio (for Claude Code / CLI hosts).
// Default is HTTP server mode.

if (process.env.MCP_TRANSPORT === "stdio") {
  // ── Stdio mode (Claude Code, CLI hosts) ──────────────────────────────────
  (async () => {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
} else {
  // ── HTTP server mode ──────────────────────────────────────────────────────
  const app = express();
  app.use(cors());
  app.use(express.json());

  const sseSessions: Record<string, SSEServerTransport> = {};

  app.post("/mcp", async (req: Request, res: Response) => {
    const transport = new StreamableHTTPServerTransport({
      sessionIdGenerator: undefined, // stateless
    });
    res.on("close", () => transport.close());
    const server = createMcpServer();
    await server.connect(transport);
    await transport.handleRequest(req, res, req.body);
  });

  app.get("/sse", async (_req: Request, res: Response) => {
    const transport = new SSEServerTransport("/messages", res);
    sseSessions[transport.sessionId] = transport;
    res.on("close", () => delete sseSessions[transport.sessionId]);
    const server = createMcpServer();
    await server.connect(transport);
  });

  app.post("/messages", async (req: Request, res: Response) => {
    const sessionId = req.query.sessionId as string;
    const transport = sseSessions[sessionId];
    if (!transport) {
      res.status(404).json({ error: "Session not found" });
      return;
    }
    await transport.handlePostMessage(req, res, req.body);
  });

  app.get("/health", (_req: Request, res: Response) => {
    res.json({ status: "ok", server: "cyphergoat-mcp", version: "1.0.0" });
  });

  app.listen(PORT, () => {
    console.log(`CypherGoat MCP server listening on port ${PORT}`);
    console.log(`  Streamable HTTP : POST http://localhost:${PORT}/mcp`);
    console.log(`  SSE (legacy)    : GET  http://localhost:${PORT}/sse`);
  });
}
