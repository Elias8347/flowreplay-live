// WebSocket server - bridges MyFundedPerps market streams to frontend clients

import express from 'express';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import cors from 'cors';
import dotenv from 'dotenv';
import { MfpAdapter, NewsAdapter } from './adapters';
import { getTapeHistory, isHistoryRateLimit } from './history';
import { Trade, OrderBook, Ticker, ClientMessage, ServerMessage } from './types';

dotenv.config();

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({
  server,
  maxPayload: 16 * 1024, // 16KB max message size
});

// Allow requests from the Vite dev server
app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:5173',
  credentials: true,
}));

app.use(express.json());

// Singleton adapter - we reuse one MFP stream connection for all clients
let marketAdapter: MfpAdapter | null = null;

// News adapter singleton
const newsAdapter = new NewsAdapter();

// Track what each client is subscribed to so we can clean up properly
const clientSubscriptions: Map<WebSocket, Set<string>> = new Map();

// Track which symbols have at least one subscriber (for cleanup)
const subscribedSymbols: Set<string> = new Set();

console.log('\nFlowReplay Live Server Starting...');
console.log('Data Source: MyFundedPerps market stream (read-only)');
console.log('Supported: MFP markets with a real trade tape\n');

/**
 * Lazy-initialize the MFP adapter
 * 
 * We don't connect until the first client subscribes. This avoids
 * wasting bandwidth if the server is running but no one's using it.
 */
async function initMarketAdapter(): Promise<MfpAdapter> {
  if (marketAdapter) return marketAdapter;
  
  marketAdapter = new MfpAdapter();
  
  // Wire up event handlers before connecting so no startup data is missed
  marketAdapter.onTrade((trade: Trade) => {
    broadcastToSubscribers(trade.symbol, {
      type: 'trade',
      data: trade,
      timestamp: Date.now(),
    });
  });
  
  marketAdapter.onOrderBook((orderBook: OrderBook) => {
    broadcastToSubscribers(orderBook.symbol, {
      type: 'orderbook',
      data: orderBook,
      timestamp: Date.now(),
    });
  });
  
  marketAdapter.onTicker((ticker: Ticker) => {
    broadcastToSubscribers(ticker.symbol, {
      type: 'ticker',
      data: ticker,
      timestamp: Date.now(),
    });
  });
  
  marketAdapter.onError((error: Error) => {
    console.error('[MFP] Error:', error.message);
  });
  
  marketAdapter.onDisconnect(() => {
    console.log('[MFP] Disconnected - will attempt reconnect');
  });
  
  await marketAdapter.connect();
  return marketAdapter;
}

/**
 * Send a message to all clients subscribed to a particular symbol
 */
function broadcastToSubscribers(symbol: string, message: ServerMessage): void {
  const upperSymbol = symbol.toUpperCase();
  
  for (const [client, subscriptions] of clientSubscriptions) {
    if (subscriptions.has(upperSymbol) && client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }
}

// Handle new client connections
wss.on('connection', (ws: WebSocket) => {
  console.log('Client connected');
  clientSubscriptions.set(ws, new Set());
  
  // Let the client know we're ready
  ws.send(JSON.stringify({
    type: 'connected',
    timestamp: Date.now(),
  }));
  
  ws.on('message', async (data: Buffer) => {
    try {
      const message: ClientMessage = JSON.parse(data.toString());
      
      // Route to appropriate handler based on message type
      switch (message.type) {
        case 'subscribe':
          await handleSubscribe(ws, message);
          break;
        case 'unsubscribe':
          await handleUnsubscribe(ws, message);
          break;
        case 'validate':
          await handleValidate(ws, message);
          break;
        case 'ping':
          // Simple heartbeat - client can use this to check latency
          ws.send(JSON.stringify({ type: 'pong', timestamp: Date.now() }));
          break;
      }
    } catch (error) {
      console.error('Error handling message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        error: 'Invalid message format',
        timestamp: Date.now(),
      }));
    }
  });
  
  ws.on('close', () => {
    console.log('Client disconnected');
    // Clean up: unsubscribe from any symbols this client was watching
    const subscriptions = clientSubscriptions.get(ws);
    clientSubscriptions.delete(ws);
    if (subscriptions) {
      for (const symbol of subscriptions) {
        cleanupSymbolSubscription(symbol);
      }
    }
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket error:', error);
  });
});

/**
 * Subscribe a client to a symbol's market data
 * 
 * Markets are checked against MFP's catalog. Markets without a real trade
 * tape are rejected so the UI never shows made-up order flow.
 */
async function handleSubscribe(ws: WebSocket, message: ClientMessage): Promise<void> {
  const symbols = message.symbols || (message.symbol ? [message.symbol] : []);
  
  for (const symbol of symbols) {
    const upperSymbol = symbol.toUpperCase();
    
    const adapter = await initMarketAdapter();
    const market = await adapter.validateSymbol(upperSymbol);
    if (!market.valid) {
      ws.send(JSON.stringify({
        type: 'error',
        error: market.error,
        symbol: upperSymbol,
        timestamp: Date.now(),
      }));
      continue;
    }
    
    // Track this subscription for the client
    const subscriptions = clientSubscriptions.get(ws);
    if (subscriptions) {
      subscriptions.add(upperSymbol);
    }
    
    // Start streaming data from MFP
    await adapter.subscribe(upperSymbol, 'crypto');
    subscribedSymbols.add(upperSymbol);
    
    // Confirm subscription to client
    ws.send(JSON.stringify({
      type: 'subscribed',
      symbol: upperSymbol,
      source: 'mfp',
      assetType: 'crypto',
      timestamp: Date.now(),
    }));
    
    console.log(`Subscribed to ${upperSymbol}`);
  }
}

/**
 * Unsubscribe a client from a symbol
 */
async function handleUnsubscribe(ws: WebSocket, message: ClientMessage): Promise<void> {
  const symbols = message.symbols || (message.symbol ? [message.symbol] : []);
  
  for (const symbol of symbols) {
    const upperSymbol = symbol.toUpperCase();
    
    // Remove from this client's subscription list
    const subscriptions = clientSubscriptions.get(ws);
    if (subscriptions) {
      subscriptions.delete(upperSymbol);
    }
    
    // If no clients are watching this symbol anymore, stop its stream
    cleanupSymbolSubscription(upperSymbol);
    
    ws.send(JSON.stringify({
      type: 'unsubscribed',
      symbol: upperSymbol,
      timestamp: Date.now(),
    }));
    
    console.log(`Unsubscribed from ${upperSymbol}`);
  }
}

/**
 * Check if anyone is still watching a symbol, and if not, unsubscribe from it
 * 
 * This prevents us from keeping unnecessary streams open when all clients have
 * switched to different symbols.
 */
function cleanupSymbolSubscription(symbol: string): void {
  const upperSymbol = symbol.toUpperCase();
  
  // See if any client is still subscribed
  let hasSubscribers = false;
  for (const [_, subscriptions] of clientSubscriptions) {
    if (subscriptions.has(upperSymbol)) {
      hasSubscribers = true;
      break;
    }
  }
  
  // No one watching? Shut down the stream for this symbol
  if (!hasSubscribers && marketAdapter) {
    void marketAdapter.unsubscribe(upperSymbol);
    subscribedSymbols.delete(upperSymbol);
  }
}

/**
 * Validate a symbol before subscribing
 * 
 * Client can use this to check if a symbol exists and is actively trading
 * before committing to a subscription. Uses MFP's market catalog.
 */
async function handleValidate(ws: WebSocket, message: ClientMessage): Promise<void> {
  const symbol = message.symbol?.toUpperCase();
  
  if (!symbol) {
    ws.send(JSON.stringify({
      type: 'validation',
      data: { valid: false, error: 'No symbol provided' },
      timestamp: Date.now(),
    }));
    return;
  }
  
  try {
    const adapter = await initMarketAdapter();
    const validation = await adapter.validateSymbol(symbol);
    ws.send(JSON.stringify({
      type: 'validation',
      data: validation,
      timestamp: Date.now(),
    }));
  } catch (error: any) {
    ws.send(JSON.stringify({
      type: 'validation',
      data: {
        symbol,
        valid: false,
        error: error.message || 'Validation failed',
        assetType: 'crypto',
      },
      timestamp: Date.now(),
    }));
  }
}

// Simple health check - useful for monitoring and load balancers
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    dataSource: 'myfundedperps',
    activeConnections: clientSubscriptions.size,
    subscribedSymbols: Array.from(subscribedSymbols),
  });
});

// API info for humans poking around
app.get('/api/info', (req, res) => {
  res.json({
    name: 'FlowReplay Live',
    dataSource: 'MyFundedPerps market stream',
    supportedPairs: 'MFP markets with a real trade tape',
    features: [
      'Real-time trades',
      'Level 2 order book (20 levels)',
      '24hr ticker statistics',
      'Cryptocurrency news feed',
    ],
  });
});

// News endpoint - fetch crypto news by symbol
app.get('/api/news/:symbol?', async (req, res) => {
  try {
    const symbol = req.params.symbol || 'BTC';
    const forceRefresh = req.query.refresh === 'true';
    
    const news = await newsAdapter.getNews(symbol, forceRefresh);
    
    res.json({
      symbol: symbol.toUpperCase().replace('USDT', ''),
      count: news.length,
      items: news,
      cached: !forceRefresh,
      timestamp: Date.now(),
    });
  } catch (error: any) {
    res.status(500).json({
      error: 'Failed to fetch news',
      message: error.message,
      timestamp: Date.now(),
    });
  }
});

// News stats endpoint
app.get('/api/news-stats', (req, res) => {
  res.json({
    ...newsAdapter.getStats(),
    timestamp: Date.now(),
  });
});

// Binance Futures API proxy endpoints
// These proxy requests to avoid CORS issues when fetching from the frontend
const BINANCE_FUTURES_API = 'https://fapi.binance.com/fapi/v1';

// Input validation for Binance API proxy
const SYMBOL_REGEX = /^[A-Z0-9]{2,20}$/;
const VALID_PERIODS = ['5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d'];
const MAX_LIMIT = 500;

function validateSymbol(symbol: unknown): string | null {
  if (typeof symbol !== 'string') return null;
  const upper = symbol.toUpperCase().replace(/[^A-Z0-9]/g, '');
  return SYMBOL_REGEX.test(upper) ? upper : null;
}

// Simple in-memory rate limiter for Binance proxy endpoints
const rateLimitMap = new Map<string, { count: number; resetTime: number }>();
const RATE_LIMIT_WINDOW_MS = 60000;
const RATE_LIMIT_MAX_REQUESTS = 30;

function checkRateLimit(ip: string): boolean {
  const now = Date.now();
  const record = rateLimitMap.get(ip);

  if (!record || now > record.resetTime) {
    rateLimitMap.set(ip, { count: 1, resetTime: now + RATE_LIMIT_WINDOW_MS });
    return true;
  }

  if (record.count >= RATE_LIMIT_MAX_REQUESTS) {
    return false;
  }

  record.count++;
  return true;
}

app.get('/api/binance/openInterest', async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const symbol = validateSymbol(req.query.symbol);
    if (!symbol) {
      return res.status(400).json({ error: 'Invalid symbol format' });
    }

    const url = new URL(`${BINANCE_FUTURES_API}/openInterest`);
    url.searchParams.set('symbol', symbol);

    const response = await fetch(url.toString());
    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    console.error('[Binance Proxy] openInterest error:', error.message);
    res.status(500).json({ error: 'Failed to fetch open interest' });
  }
});

app.get('/api/binance/longShortRatio', async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const symbol = validateSymbol(req.query.symbol);
    if (!symbol) {
      return res.status(400).json({ error: 'Invalid symbol format' });
    }

    const period = VALID_PERIODS.includes(req.query.period as string)
      ? req.query.period as string
      : '5m';
    const limitNum = Math.min(Math.max(1, parseInt(req.query.limit as string) || 1), MAX_LIMIT);

    const url = new URL(`${BINANCE_FUTURES_API}/globalLongShortAccountRatio`);
    url.searchParams.set('symbol', symbol);
    url.searchParams.set('period', period);
    url.searchParams.set('limit', String(limitNum));

    const response = await fetch(url.toString());
    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    console.error('[Binance Proxy] longShortRatio error:', error.message);
    res.status(500).json({ error: 'Failed to fetch long/short ratio' });
  }
});

app.get('/api/binance/premiumIndex', async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(clientIp)) {
    return res.status(429).json({ error: 'Rate limit exceeded' });
  }

  try {
    const symbol = validateSymbol(req.query.symbol);
    if (!symbol) {
      return res.status(400).json({ error: 'Invalid symbol format' });
    }

    const url = new URL(`${BINANCE_FUTURES_API}/premiumIndex`);
    url.searchParams.set('symbol', symbol);

    const response = await fetch(url.toString());
    const data = await response.json();
    res.json(data);
  } catch (error: any) {
    console.error('[Binance Proxy] premiumIndex error:', error.message);
    res.status(500).json({ error: 'Failed to fetch premium index' });
  }
});

// MFP markets this version can show with real order flow
app.get('/api/mfp/markets', async (_req, res) => {
  try {
    const adapter = await initMarketAdapter();
    await adapter.validateSymbol('BTCUSDT');
    res.json({ symbols: adapter.getSupportedSymbols(), coverage: adapter.getCoverage() });
  } catch (error: any) {
    console.error('[MFP] Market list error:', error.message);
    res.status(502).json({ error: 'Failed to load MFP markets' });
  }
});

const KLINE_INTERVALS = ['1m', '5m', '15m', '1h', '4h'];

// Perpetual snapshots, so charts and books match the venue behind MFP's Binance markets
async function proxyFutures(req: express.Request, res: express.Response, path: string, params: Record<string, string>): Promise<void> {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(`${clientIp}:snapshot`)) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }
  try {
    const url = new URL(`${BINANCE_FUTURES_API}/${path}`);
    Object.entries(params).forEach(([key, value]) => url.searchParams.set(key, value));
    const response = await fetch(url.toString());
    res.status(response.status).json(await response.json());
  } catch (error: any) {
    console.error(`[Binance Proxy] ${path} error:`, error.message);
    res.status(502).json({ error: `Failed to fetch ${path}` });
  }
}

app.get('/api/binance/depth', async (req, res) => {
  const symbol = validateSymbol(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'Invalid symbol format' });
    return;
  }
  const requested = parseInt(req.query.limit as string) || 20;
  const limit = [5, 10, 20, 50, 100].find((n) => n >= requested) ?? 100;
  await proxyFutures(req, res, 'depth', { symbol, limit: String(limit) });
});

app.get('/api/binance/klines', async (req, res) => {
  const symbol = validateSymbol(req.query.symbol);
  const interval = req.query.interval as string;
  if (!symbol || !KLINE_INTERVALS.includes(interval)) {
    res.status(400).json({ error: 'Invalid symbol or interval' });
    return;
  }
  const limit = Math.min(Math.max(1, parseInt(req.query.limit as string) || 200), MAX_LIMIT);
  await proxyFutures(req, res, 'klines', { symbol, interval, limit: String(limit) });
});

// Exact recent tape for MFP's Binance-sourced markets, rebuilt from the public venue history
app.get('/api/mfp/history', async (req, res) => {
  const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
  if (!checkRateLimit(`${clientIp}:history`)) {
    res.status(429).json({ error: 'Rate limit exceeded' });
    return;
  }
  const symbol = validateSymbol(req.query.symbol);
  if (!symbol) {
    res.status(400).json({ error: 'Invalid symbol format' });
    return;
  }
  const minutes = Math.min(Math.max(1, parseInt(req.query.minutes as string) || 30), 60);
  try {
    const adapter = await initMarketAdapter();
    const market = await adapter.validateSymbol(symbol);
    if (!market.valid) {
      res.status(422).json({ error: market.error });
      return;
    }
    res.json(await getTapeHistory(symbol, minutes));
  } catch (error: any) {
    console.error(`[History] ${symbol} error:`, error.message);
    res.status(isHistoryRateLimit(error) ? 503 : 502).json({ error: 'Trade history is unavailable right now' });
  }
});

// Wire up news broadcaster to WebSocket
newsAdapter.onNews((item) => {
  const message: ServerMessage = {
    type: 'news',
    data: item,
    timestamp: Date.now(),
  };
  
  // Broadcast to all connected clients
  for (const [client, _] of clientSubscriptions) {
    if (client.readyState === WebSocket.OPEN) {
      client.send(JSON.stringify(message));
    }
  }
});

// Fire it up
const PORT = Number(process.env.PORT) || 3001;
// Local only by default, because this process can hold a trader's API key
const HOST = process.env.HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log(`FlowReplay Live Server running on ${HOST}:${PORT}`);
  console.log(`WebSocket: ws://localhost:${PORT}`);
  console.log(`Health: http://localhost:${PORT}/health\n`);
});

// Clean shutdown - close client connections and the market stream gracefully
process.on('SIGINT', async () => {
  console.log('\nShutting down...');
  
  for (const [client, _] of clientSubscriptions) {
    client.close();
  }
  
  if (marketAdapter) {
    await marketAdapter.disconnect();
  }
  
  server.close(() => {
    console.log('Server closed');
    process.exit(0);
  });
});
