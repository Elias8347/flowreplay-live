// MyFundedPerps market data adapter. Read-only: it never places, edits or cancels orders.

import WebSocket from 'ws';
import axios from 'axios';
import { BaseAdapter } from './base';
import { AssetType, LiquidationSide, OrderBook, OrderBookLevel, SymbolInfo, Ticker, Trade } from '../types';

const MARKET_STREAM = 'wss://api-stream.myfundedperpetuals.com/v1/market-data';
const MARKETS_URL = 'https://developers.myfundedperpetuals.com/v1/markets';
const BINANCE_FUTURES_REST = 'https://fapi.binance.com/fapi/v1';
const BINANCE_FUTURES_STREAM = 'wss://fstream.binance.com/stream';

const BOOK_LEVELS = 20;
const MAX_RETRY_MS = 30_000;
const STALE_AFTER_MS = 30_000;
const TICKER_REFRESH_MS = 15_000;
const CATALOG_REFRESH_MS = 600_000;
const RECENT_TRADE_IDS = 20_000;

interface CatalogMarket {
  marketId: string;
  provider: string;
  symbol: string;
  maxLeverage: number | null;
}

/** Remembers recent trade IDs using two rotating sets, so memory stays bounded. */
export class RecentIds {
  private current = new Set<string>();
  private previous = new Set<string>();

  constructor(private readonly limit: number = RECENT_TRADE_IDS) {}

  /** Returns true the first time an ID is seen. */
  add(id: string): boolean {
    if (this.current.has(id) || this.previous.has(id)) return false;
    if (this.current.size >= this.limit) {
      this.previous = this.current;
      this.current = new Set();
    }
    this.current.add(id);
    return true;
  }
}

export class MfpAdapter extends BaseAdapter {
  name = 'MyFundedPerps';
  supportedAssetTypes: AssetType[] = ['crypto'];

  private ws: WebSocket | null = null;
  private liquidationWs: WebSocket | null = null;
  private closing = false;
  private nextSubId = 1;
  private lastMessageAt = 0;
  private streamRetryMs = 1000;
  private streamRetryTimer: NodeJS.Timeout | null = null;
  private liquidationRetryTimer: NodeJS.Timeout | null = null;
  private timers: NodeJS.Timeout[] = [];
  private readonly markets = new Map<string, CatalogMarket>();
  private readonly subIds = new Map<string, number[]>();
  private readonly recentTrades = new Map<string, RecentIds>();

  async connect(): Promise<void> {
    this.closing = false;
    await this.loadMarkets().catch((error) => console.warn('[MFP] Could not load markets:', error.message));
    this.timers.push(
      setInterval(() => this.refreshTickers(), TICKER_REFRESH_MS),
      setInterval(() => this.loadMarkets().catch(() => undefined), CATALOG_REFRESH_MS),
      setInterval(() => this.checkStream(), 10_000),
    );
    this.openLiquidationStream();
    await this.openMarketStream();
  }

  async disconnect(): Promise<void> {
    this.closing = true;
    this.timers.forEach(clearInterval);
    this.timers = [];
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    if (this.liquidationRetryTimer) clearTimeout(this.liquidationRetryTimer);
    this.ws?.close();
    this.liquidationWs?.close();
    this.ws = null;
    this.liquidationWs = null;
    this.subscriptions.clear();
    this.subIds.clear();
    this.recentTrades.clear();
    this.emitDisconnect();
  }

  async subscribe(symbol: string, _assetType: AssetType = 'crypto'): Promise<void> {
    const upper = symbol.toUpperCase();
    if (this.subscriptions.has(upper)) return;
    this.subscriptions.add(upper);
    this.recentTrades.set(upper, new RecentIds());
    this.sendMarketSubscribe(upper);
    this.sendLiquidation('SUBSCRIBE', [upper]);
    await this.fetchTicker(upper);
  }

  async unsubscribe(symbol: string): Promise<void> {
    const upper = symbol.toUpperCase();
    if (!this.subscriptions.delete(upper)) return;
    for (const id of this.subIds.get(upper) ?? []) this.send({ op: 'unsub', id });
    this.subIds.delete(upper);
    this.recentTrades.delete(upper);
    this.sendLiquidation('UNSUBSCRIBE', [upper]);
  }

  async validateSymbol(symbol: string): Promise<SymbolInfo> {
    const upper = symbol.toUpperCase().replace(/[/-]/g, '');
    if (this.markets.size === 0) await this.loadMarkets().catch(() => undefined);
    if (this.markets.size === 0) return this.invalid(upper, 'The MFP market list is unavailable right now.');

    const market = this.markets.get(upper);
    if (!market) return this.invalid(upper, 'This market is not listed on MyFundedPerps.');
    if (market.provider === 'veranta' || market.provider === 'ostium') {
      return this.invalid(upper, 'This market is priced from quotes and has no public trade tape, so order flow is not shown.');
    }
    if (market.provider !== 'binance') {
      return this.invalid(upper, `${market.provider} markets are not supported in this version yet.`);
    }
    return {
      symbol: upper,
      name: `${upper.replace(/USDT$/, '')}/USDT`,
      assetType: 'crypto',
      exchange: 'MFP',
      valid: true,
    };
  }

  /** Markets this version can stream with real order flow. */
  getSupportedSymbols(): string[] {
    return [...this.markets.values()].filter((m) => m.provider === 'binance').map((m) => m.symbol).sort();
  }

  /** Maximum leverage per supported market, as listed by MFP. */
  getLeverage(): Record<string, number> {
    const leverage: Record<string, number> = {};
    for (const m of this.markets.values()) if (m.provider === 'binance' && m.maxLeverage) leverage[m.symbol] = m.maxLeverage;
    return leverage;
  }

  getCoverage(): Record<string, number> {
    const coverage: Record<string, number> = {};
    for (const market of this.markets.values()) coverage[market.provider] = (coverage[market.provider] ?? 0) + 1;
    return coverage;
  }

  private invalid(symbol: string, error: string): SymbolInfo {
    return { symbol, name: symbol, assetType: 'crypto', valid: false, error };
  }

  private async loadMarkets(): Promise<void> {
    const { data } = await axios.get(MARKETS_URL, { timeout: 10_000 });
    const list = Array.isArray(data) ? data : data.data ?? data.markets ?? data.items ?? [];
    if (list.length === 0) return;
    this.markets.clear();
    for (const m of list) {
      const wire = String(m.market_id).split('|')[1];
      if (wire) {
        const leverage = Number(m.max_leverage);
        this.markets.set(wire.toUpperCase(), {
          marketId: m.market_id,
          provider: m.provider,
          symbol: wire.toUpperCase(),
          maxLeverage: Number.isFinite(leverage) && leverage > 0 ? leverage : null,
        });
      }
    }
  }

  private openMarketStream(): Promise<void> {
    return new Promise((resolve) => {
      const key = process.env.MFP_API_KEY;
      const ws = new WebSocket(MARKET_STREAM, {
        perMessageDeflate: true,
        headers: key ? { Authorization: `Bearer ${key}` } : undefined,
      });
      this.ws = ws;

      ws.on('open', () => {
        console.log(`[MFP] Market stream connected${key ? ' with API key' : ''}`);
        this.streamRetryMs = 1000;
        this.lastMessageAt = Date.now();
        this.subIds.clear();
        this.emitConnect();
        for (const symbol of this.subscriptions) this.sendMarketSubscribe(symbol);
        resolve();
      });
      ws.on('message', (data: WebSocket.RawData) => {
        this.lastMessageAt = Date.now();
        this.handleMarketFrame(data.toString());
      });
      ws.on('error', (error: Error) => {
        console.error(`[MFP] Stream error: ${error.message}${key ? '' : ' (set MFP_API_KEY if a key is now required)'}`);
        this.emitError(error);
      });
      ws.on('close', () => {
        if (this.ws === ws) this.ws = null;
        this.emitDisconnect();
        resolve();
        if (!this.closing) this.scheduleMarketRetry();
      });
    });
  }

  private scheduleMarketRetry(): void {
    if (this.streamRetryTimer) clearTimeout(this.streamRetryTimer);
    const delay = this.streamRetryMs;
    this.streamRetryMs = Math.min(delay * 2, MAX_RETRY_MS);
    console.log(`[MFP] Reconnecting in ${delay}ms`);
    this.streamRetryTimer = setTimeout(() => void this.openMarketStream(), delay);
  }

  private checkStream(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    if (this.subscriptions.size > 0 && Date.now() - this.lastMessageAt > STALE_AFTER_MS) {
      console.warn('[MFP] Stream went quiet, reconnecting');
      this.ws.terminate();
      return;
    }
    this.ws.ping();
  }

  private send(frame: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(frame));
  }

  private sendMarketSubscribe(symbol: string): void {
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    const ids = ['trades', 'books'].map((channel) => {
      const id = this.nextSubId++;
      this.send({ op: 'sub', id, channel, payload: { symbols: [symbol], providers: ['binance'] } });
      return id;
    });
    this.subIds.set(symbol, ids);
  }

  private handleMarketFrame(raw: string): void {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    if (frame.op === 'draining') {
      this.ws?.close();
    } else if (frame.op === 'sub_err') {
      console.error('[MFP] Subscription rejected:', JSON.stringify(frame.error ?? frame));
    } else if (frame.op === 'events') {
      for (const event of frame.events ?? []) {
        if (event.type === 'trade') this.handleTradeEvent(event);
        else if (event.type === 'book') this.handleBookEvent(event);
      }
    }
  }

  private handleTradeEvent(event: any): void {
    const symbol = String(event.symbol).toUpperCase();
    const recent = this.recentTrades.get(symbol);
    if (!recent || !recent.add(String(event.tradeId))) return;
    this.emitTrade({
      id: String(event.tradeId),
      symbol,
      assetType: 'crypto',
      timestamp: Number(event.time),
      price: Number(event.price),
      volume: Number(event.size),
      side: event.side,
      exchange: 'MFP',
    });
  }

  private handleBookEvent(event: any): void {
    const toLevels = (levels: any[] = []): OrderBookLevel[] => levels.slice(0, BOOK_LEVELS)
      .map((l) => ({ price: Number(l.px), size: Number(l.sz), ...(l.n === null || l.n === undefined ? {} : { count: l.n }) }))
      .filter((l) => l.size > 0);
    const bids = toLevels(event.bids);
    const asks = toLevels(event.asks);
    if (bids.length === 0 && asks.length === 0) return;
    const bestBid = bids[0]?.price ?? 0;
    const bestAsk = asks[0]?.price ?? 0;
    const spread = bestBid && bestAsk ? bestAsk - bestBid : 0;
    const book: OrderBook = {
      symbol: String(event.symbol).toUpperCase(),
      assetType: 'crypto',
      timestamp: Number(event.time),
      bids,
      asks,
      spread,
      spreadPercent: bestBid > 0 ? (spread / bestBid) * 100 : 0,
    };
    this.emitOrderBook(book);
  }

  private refreshTickers(): void {
    for (const symbol of this.subscriptions) void this.fetchTicker(symbol);
  }

  private async fetchTicker(symbol: string): Promise<void> {
    try {
      const { data } = await axios.get(`${BINANCE_FUTURES_REST}/ticker/24hr`, { params: { symbol }, timeout: 10_000 });
      const ticker: Ticker = {
        symbol,
        assetType: 'crypto',
        timestamp: Date.now(),
        lastPrice: Number(data.lastPrice),
        priceChange: Number(data.priceChange),
        priceChangePercent: Number(data.priceChangePercent),
        highPrice: Number(data.highPrice),
        lowPrice: Number(data.lowPrice),
        volume: Number(data.volume),
        quoteVolume: Number(data.quoteVolume),
        openPrice: Number(data.openPrice),
      };
      this.emitTicker(ticker);
    } catch (error: any) {
      console.warn(`[MFP] Ticker unavailable for ${symbol}: ${error.message}`);
    }
  }

  private openLiquidationStream(): void {
    const ws = new WebSocket(BINANCE_FUTURES_STREAM);
    this.liquidationWs = ws;
    ws.on('open', () => this.sendLiquidation('SUBSCRIBE', [...this.subscriptions]));
    ws.on('message', (data: WebSocket.RawData) => this.handleLiquidationFrame(data.toString()));
    ws.on('error', (error: Error) => console.warn(`[MFP] Liquidation stream error: ${error.message}`));
    ws.on('close', () => {
      if (this.liquidationWs === ws) this.liquidationWs = null;
      if (!this.closing) this.liquidationRetryTimer = setTimeout(() => this.openLiquidationStream(), 5000);
    });
  }

  private sendLiquidation(method: 'SUBSCRIBE' | 'UNSUBSCRIBE', symbols: string[]): void {
    if (symbols.length === 0 || this.liquidationWs?.readyState !== WebSocket.OPEN) return;
    this.liquidationWs.send(JSON.stringify({
      method,
      params: symbols.map((s) => `${s.toLowerCase()}@forceOrder`),
      id: this.nextSubId++,
    }));
  }

  private handleLiquidationFrame(raw: string): void {
    let frame: any;
    try {
      frame = JSON.parse(raw);
    } catch {
      return;
    }
    const order = frame.data?.o;
    if (!order) return;
    const symbol = String(order.s).toUpperCase();
    if (!this.subscriptions.has(symbol)) return;
    const liquidationSide: LiquidationSide = order.S === 'SELL' ? 'long' : 'short';
    const trade: Trade = {
      id: `liq-${symbol}-${order.T}-${order.ap ?? order.p}-${order.q}`,
      symbol,
      assetType: 'crypto',
      timestamp: Number(order.T),
      price: Number(order.ap || order.p),
      volume: Number(order.q),
      side: order.S === 'SELL' ? 'sell' : 'buy',
      exchange: 'BINANCE',
      isLiquidation: true,
      tradeType: 'liquidation',
      liquidationSide,
    };
    this.emitTrade(trade);
  }
}
