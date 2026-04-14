#!/usr/bin/env node

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { SSEServerTransport } from "@modelcontextprotocol/sdk/server/sse.js";
import express, { Request, Response } from "express";
import { z } from "zod";

const BASE_URL = process.env.CYPHERGOAT_API_URL ?? "https://api.cyphergoat.com";
const API_KEY = process.env.CYPHERGOAT_API_KEY ?? "";
const PORT = parseInt(process.env.PORT ?? "3000", 10);

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
    "Get swap rate estimates across all supported exchanges for a cryptocurrency pair and amount. Returns a ranked list of offers with receive amounts, KYC scores, and SafeRoute reliability scores.",
    {
      coin1: z.string().describe("Source cryptocurrency ticker (e.g. 'btc', 'eth')"),
      coin2: z.string().describe("Destination cryptocurrency ticker (e.g. 'xmr', 'usdt')"),
      amount: z.number().positive().describe("Amount of coin1 to swap"),
      network1: z.string().describe("Network for source coin (e.g. 'btc', 'eth', 'erc20')"),
      network2: z.string().describe("Network for destination coin"),
      best: z.boolean().optional().describe("Return only the single best estimate"),
    },
    async ({ coin1, coin2, amount, network1, network2, best }) => {
      const data = await apiRequest("/estimate", "GET", {
        coin1,
        coin2,
        amount,
        network1,
        network2,
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
      const data = await apiRequest("/swap", "GET", {
        coin1,
        coin2,
        amount,
        network1,
        network2,
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
      const data = await apiRequest("/payments/estimate", "GET", {
        coin1,
        coin2,
        amount,
        network1,
        network2,
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
      const data = await apiRequest("/payments/create", "GET", {
        coin1,
        coin2,
        amount,
        partner,
        network1,
        network2,
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
      const data = await apiRequest("/payments/quick", "GET", {
        coin1,
        coin2,
        amount,
        network1,
        network2,
        address,
        ...(affiliate ? { affiliate } : {}),
      });
      return { content: [{ type: "text", text: JSON.stringify(data, null, 2) }] };
    }
  );

  return server;
}

// ── Transport selection ───────────────────────────────────────────────────────
// When stdin is not a TTY (i.e. launched by Claude Code / an MCP host), use
// stdio transport.  Otherwise start the HTTP server for manual / remote use.

if (!process.stdin.isTTY) {
  // ── Stdio mode (Claude Code, CLI hosts) ──────────────────────────────────
  (async () => {
    const server = createMcpServer();
    const transport = new StdioServerTransport();
    await server.connect(transport);
  })();
} else {
  // ── HTTP server mode ──────────────────────────────────────────────────────
  const app = express();
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
