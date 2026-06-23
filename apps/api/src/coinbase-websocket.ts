import WebSocket from 'ws';
import { logger } from './logger.js';

export interface CoinbaseTickerMessage {
  type: 'ticker' | 'heartbeat' | 'subscriptions';
  product_id?: string;
  price?: string;
  time?: string;
  sequence?: number;
  side?: string;
  last_size?: string;
  best_bid?: string;
  best_ask?: string;
  channels?: { name: string; product_ids: string[] }[];
}

class CoinbaseWebSocketClient {
  private ws: WebSocket | null = null;
  private reconnectAttempts = 0;
  private maxReconnectAttempts = 5;
  private reconnectDelay = 1000;
  private heartbeatTimeout: NodeJS.Timeout | null = null;
  private subscribedProducts: Set<string> = new Set();
  private priceCache: Map<string, { price: string; timestamp: number }> = new Map();
  private messageHandlers: ((msg: CoinbaseTickerMessage) => void)[] = [];

  private readonly WS_URL = 'wss://ws-feed.exchange.coinbase.com';

  async connect(productIds: string[]): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        logger.info(`[Coinbase WS] Connecting to ${this.WS_URL}...`);
        
        this.ws = new WebSocket(this.WS_URL);

        this.ws.on('open', () => {
          logger.info('[Coinbase WS] Connected');
          this.reconnectAttempts = 0;
          this.subscribe(productIds);
          resolve();
        });

        this.ws.on('message', (data: string) => {
          this.handleMessage(data);
        });

        this.ws.on('error', (error: Error) => {
          logger.error('[Coinbase WS] Error:', error.message);
          reject(error);
        });

        this.ws.on('close', () => {
          logger.warn('[Coinbase WS] Disconnected');
          this.clearHeartbeat();
          this.reconnect(productIds);
        });

        // Set initial timeout for connection
        setTimeout(() => {
          if (this.ws?.readyState !== WebSocket.OPEN) {
            reject(new Error('Connection timeout'));
          }
        }, 5000);
      } catch (error) {
        reject(error);
      }
    });
  }

  private subscribe(productIds: string[]): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      logger.warn('[Coinbase WS] Cannot subscribe - not connected');
      return;
    }

    const subscribeMsg = {
      type: 'subscribe',
      product_ids: productIds,
      channels: ['ticker_batch', 'heartbeat'],
    };

    logger.info('[Coinbase WS] Subscribing to:', productIds);
    this.ws.send(JSON.stringify(subscribeMsg));
    this.subscribedProducts = new Set(productIds);

    // Setup heartbeat monitoring
    this.setupHeartbeat();
  }

  /**
   * Add product subscriptions without reconnecting.
   */
  addProductSubscriptions(productIds: string[]): void {
    if (!Array.isArray(productIds) || productIds.length === 0) {
      return;
    }

    const normalized = productIds
      .map((item) => String(item).trim().toUpperCase())
      .filter(Boolean);
    const toAdd = normalized.filter((id) => !this.subscribedProducts.has(id));
    if (toAdd.length === 0) {
      return;
    }

    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // Remember desired subscriptions so they are applied on the next connect.
      toAdd.forEach((id) => this.subscribedProducts.add(id));
      return;
    }

    const subscribeMsg = {
      type: 'subscribe',
      product_ids: toAdd,
      channels: ['ticker_batch', 'heartbeat'],
    };

    logger.info('[Coinbase WS] Adding subscriptions:', toAdd);
    this.ws.send(JSON.stringify(subscribeMsg));
    toAdd.forEach((id) => this.subscribedProducts.add(id));
  }

  private setupHeartbeat(): void {
    this.clearHeartbeat();
    this.heartbeatTimeout = setTimeout(() => {
      logger.warn('[Coinbase WS] Heartbeat timeout - reconnecting');
      this.reconnect(Array.from(this.subscribedProducts));
    }, 30000); // 30 second timeout
  }

  private clearHeartbeat(): void {
    if (this.heartbeatTimeout) {
      clearTimeout(this.heartbeatTimeout);
      this.heartbeatTimeout = null;
    }
  }

  private handleMessage(data: string): void {
    try {
      const msg: CoinbaseTickerMessage = JSON.parse(data);

      // Reset heartbeat on any message
      if (msg.type === 'heartbeat') {
        this.setupHeartbeat();
      }

      // Cache ticker prices
      if (msg.type === 'ticker' && msg.product_id && msg.price) {
        this.priceCache.set(msg.product_id, {
          price: msg.price,
          timestamp: Date.now(),
        });
      }

      // Notify all message handlers
      this.messageHandlers.forEach(handler => {
        try {
          handler(msg);
        } catch (err) {
          logger.error('[Coinbase WS] Handler error:', err);
        }
      });
    } catch (error) {
      logger.error('[Coinbase WS] Parse error:', error);
    }
  }

  private reconnect(productIds: string[]): void {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) {
      logger.error('[Coinbase WS] Max reconnection attempts reached');
      return;
    }

    const delay = this.reconnectDelay * Math.pow(2, this.reconnectAttempts);
    this.reconnectAttempts++;

    logger.info(`[Coinbase WS] Reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

    setTimeout(() => {
      this.connect(productIds).catch(err => {
        logger.error('[Coinbase WS] Reconnection failed:', err.message);
      });
    }, delay);
  }

  /**
   * Subscribe to ticker updates from a handler function
   */
  onMessage(handler: (msg: CoinbaseTickerMessage) => void): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
    };
  }

  /**
   * Get cached price for a product
   */
  getPrice(productId: string): string | null {
    const cached = this.priceCache.get(productId);
    // Return price only if recent (less than 1 minute old)
    if (cached && Date.now() - cached.timestamp < 60000) {
      return cached.price;
    }
    return null;
  }

  /**
   * Get all cached prices
   */
  getPrices(): Map<string, string> {
    const result = new Map<string, string>();
    const now = Date.now();
    this.priceCache.forEach((value, key) => {
      if (now - value.timestamp < 60000) {
        result.set(key, value.price);
      }
    });
    return result;
  }

  /**
   * Check connection status
   */
  isConnected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /**
   * Gracefully close connection
   */
  close(): void {
    this.clearHeartbeat();
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Singleton instance
let instance: CoinbaseWebSocketClient | null = null;

export function getCoinbaseWebSocketClient(): CoinbaseWebSocketClient {
  if (!instance) {
    instance = new CoinbaseWebSocketClient();
  }
  return instance;
}

export function initializeCoinbaseWebSocket(productIds: string[]): Promise<void> {
  const client = getCoinbaseWebSocketClient();
  return client.connect(productIds);
}

export async function closeCoinbaseWebSocket(): Promise<void> {
  if (instance) {
    instance.close();
    instance = null;
  }
}
