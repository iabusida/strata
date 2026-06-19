# Kalshi Prediction Market API Integration

## Overview

This integration fetches real-time prediction market data from [Kalshi](https://kalshi.com), a regulated prediction market platform. The implementation uses the official Kalshi API at `https://external-api.kalshi.com/trade-api/v2`.

**Status:** ✅ **Live and Fully Integrated**
- Exchange connectivity verified
- Markets endpoint working
- Search functionality implemented
- TypeScript validated

## Files Added

### Services

- **[kalshi-service.ts](../kalshi-service.ts)**
  - Core Kalshi API client
  - Market fetching and searching
  - Price-to-probability conversion
  - Exchange status monitoring

### Routes

- **[routes/kalshi-api-v1.ts](../routes/kalshi-api-v1.ts)**
  - Express REST endpoints
  - Mounted at `/api/v1/kalshi`

## API Endpoints

### GET `/api/v1/kalshi/status`
Check Kalshi exchange operational status.

**Response:**
```json
{
  "timestamp": "2026-06-19T01:20:17.716Z",
  "exchange_active": true,
  "trading_active": true,
  "exchange_estimated_resume_time": null
}
```

### GET `/api/v1/kalshi/all-markets`
List all available prediction markets on Kalshi.

**Query Parameters:**
- `limit` (optional): Maximum number of markets to return (default: 50, max: 100)

**Response:**
```json
{
  "timestamp": "2026-06-19T01:20:17.716Z",
  "count": 50,
  "markets": [
    {
      "ticker": "KXMVESPORTSMULTIGAMEEXTENDED-S20261B30AEF8CCD-79ACAE5F235",
      "title": "yes Brian Gutierrez: 1+,no Over 1.5 goals scored",
      "yes_sub_title": "yes Brian Gutierrez: 1+",
      "no_sub_title": "no Over 1.5 goals scored",
      "yes_bid_dollars": "0.25",
      "yes_ask_dollars": "0.30",
      "no_bid_dollars": "0.70",
      "no_ask_dollars": "0.75",
      "status": "active",
      "expiration_time": "2026-07-03T01:00:00Z",
      "volume_24h_fp": "150.50"
    }
  ]
}
```

### GET `/api/v1/kalshi/search`
Search for prediction markets by keyword.

**Query Parameters:**
- `q` (required): Search query (e.g., "Brazil", "goals", "goals scored")

**Response:**
```json
{
  "timestamp": "2026-06-19T01:20:17.716Z",
  "query": "Brazil",
  "count": 25,
  "markets": [
    {
      "ticker": "KXWCTEAM-BRAZIL-123456",
      "title": "yes Brazil wins",
      "yes_sub_title": "Brazil",
      "yes_bid_dollars": "0.65",
      "yes_ask_dollars": "0.70",
      "status": "active",
      "expiration_time": "2026-06-21T23:00:00Z"
    }
  ]
}
```

### GET `/api/v1/kalshi/markets`
List hourly BTC price prediction markets (if available).

**Response:**
```json
{
  "timestamp": "2026-06-19T01:20:17.716Z",
  "count": 0,
  "markets": []
}
```
*Note: Returns empty if no BTC hourly markets are currently available.*

### GET `/api/v1/kalshi/btc-hourly`
Fetch BTC hourly price prediction probabilities (if available).

**Query Parameters:**
- `hours` (optional): Number of hours to look ahead (default: 24)

**Response:**
```json
{
  "timestamp": "2026-06-19T01:20:17.716Z",
  "count": 0,
  "error": "No hourly BTC markets found on Kalshi"
}
```

### GET `/api/v1/kalshi/market/:ticker`
Get detailed information for a specific market.

**Response:**
```json
{
  "timestamp": "2026-06-19T01:20:17.716Z",
  "market": {
    "ticker": "KXMVESPORTSMULTIGAMEEXTENDED-S20261B30AEF8CCD-79ACAE5F235",
    "title": "yes Brian Gutierrez: 1+,no Over 1.5 goals scored",
    "yes_sub_title": "yes Brian Gutierrez: 1+",
    "no_sub_title": "no Over 1.5 goals scored",
    "yes_bid_dollars": "0.25",
    "yes_ask_dollars": "0.30",
    "no_bid_dollars": "0.70",
    "no_ask_dollars": "0.75",
    "status": "active",
    "market_type": "binary",
    "event_ticker": "KXMVESPORTSMULTIGAMEEXTENDED-S20261B30AEF8CCD",
    "expiration_time": "2026-07-03T01:00:00Z",
    "created_time": "2026-06-19T01:19:44.283677Z"
  }
}
```

### GET `/api/v1/kalshi/debug`
Debug endpoint to inspect raw Kalshi API responses and connectivity.

## Data Model

### Market Structure
```typescript
interface KalshiMarket {
  ticker: string;                        // Market ID
  title: string;                         // Market title
  yes_sub_title?: string;                // YES side description
  no_sub_title?: string;                 // NO side description
  created_time: string;                  // ISO timestamp
  close_time: string;                    // ISO timestamp
  expiration_time: string;               // ISO timestamp
  yes_bid_dollars: string | number;      // YES bid price (0-1)
  yes_ask_dollars: string | number;      // YES ask price (0-1)
  no_bid_dollars: string | number;       // NO bid price (0-1)
  no_ask_dollars: string | number;       // NO ask price (0-1)
  status: string;                        // 'active', 'inactive', etc.
  market_type: string;                   // 'binary'
  event_ticker: string;                  // Event identifier
  last_price_dollars: string | number;   // Last traded price
  volume_fp?: string | number;           // Trading volume
  volume_24h_fp?: string | number;       // 24h trading volume
  liquidity_dollars: string | number;    // Market liquidity
}
```

### Probability Conversion

Market prices represent implied probabilities:
- YES price of `$0.30` = 30% probability
- NO price of `$0.70` = 70% probability
- Mid-price: `(yes_bid + yes_ask) / 2`

## Usage Examples

### cURL

```bash
# Check exchange status
curl http://localhost:8787/api/v1/kalshi/status

# Get all markets (limit 10)
curl "http://localhost:8787/api/v1/kalshi/all-markets?limit=10"

# Search for markets
curl "http://localhost:8787/api/v1/kalshi/search?q=Brazil"
curl "http://localhost:8787/api/v1/kalshi/search?q=goals"

# Get specific market details
curl "http://localhost:8787/api/v1/kalshi/market/KXMVESPORTSMULTIGAMEEXTENDED-S20261B30AEF8CCD-79ACAE5F235"

# Debug API connectivity
curl http://localhost:8787/api/v1/kalshi/debug
```

### TypeScript

```typescript
import * as kalshi from './kalshi-service';

// Check exchange status
const status = await kalshi.fetchExchangeStatus();
console.log(`Exchange active: ${status?.exchange_active}`);

// Fetch markets
const markets = await kalshi.fetchAllMarkets(20);
console.log(`Found ${markets.length} markets`);

// Search for specific markets
const brazilMarkets = await kalshi.searchMarkets("Brazil");
brazilMarkets.forEach(m => {
  const yesMidPrice = (Number(m.yes_bid_dollars) + Number(m.yes_ask_dollars)) / 2;
  console.log(`${m.title}: ${Math.round(yesMidPrice * 100)}% YES`);
});

// Get market details
const market = await kalshi.fetchMarketDetails("KXWCTEAM-BRAZIL-123456");
console.log(`Expiration: ${market?.expiration_time}`);
```

## Integration with Trade Engine

Use Kalshi markets as **sentiment/consensus indicators**:

```typescript
// Get consensus on upcoming events
const brazilMarkets = await kalshi.searchMarkets("Brazil");
const yesConsensus = brazilMarkets
  .map(m => (Number(m.yes_bid_dollars) + Number(m.yes_ask_dollars)) / 2)
  .reduce((a, b) => a + b, 0) / brazilMarkets.length;

// Use as risk/confidence indicator
if (yesConsensus > 0.7) {
  console.log("High market confidence in YES outcome");
} else if (yesConsensus < 0.3) {
  console.log("High market confidence in NO outcome");
} else {
  console.log("Market uncertain");
}
```

## Implementation Details

### Base URL
```
https://external-api.kalshi.com/trade-api/v2
```

### API Features
- ✅ Exchange status endpoint
- ✅ Markets listing with pagination
- ✅ Binary prediction markets
- ✅ Real-time bid/ask pricing
- ✅ 24-hour trading volume
- ✅ Market liquidity data

### Authentication
Currently **no authentication required** for public market data endpoints.

### Rate Limiting
Kalshi API rate limits are generous for public endpoints. Recommended approach:
- Cache market lists for 30-60 seconds
- Poll exchange status once per minute
- Search queries can be frequent

## Limitations & Future Enhancements

### Current Limitations
1. **Market Availability**: Hourly BTC price markets may not always be available
2. **Search**: Limited to title/subtitle text matching
3. **Pagination**: Currently fetches first 100 markets; full pagination not implemented
4. **Real-time**: Polling-based, not WebSocket-based

### Future Enhancements
- [ ] Implement pagination cursor support for 100+ market retrieval
- [ ] Add WebSocket streaming for real-time updates
- [ ] Store market snapshots in database for trend analysis
- [ ] Add sentiment scoring based on probability consensus
- [ ] Kalshi authentication for trading capabilities
- [ ] Implement market filters (status, category, expiration date)
- [ ] Add Telegram alerts for significant probability shifts

## Testing & Validation

```bash
# Test exchange connectivity
curl http://localhost:8787/api/v1/kalshi/status | jq .

# Test market fetching
curl "http://localhost:8787/api/v1/kalshi/all-markets?limit=5" | jq '.count'

# Test search functionality
curl "http://localhost:8787/api/v1/kalshi/search?q=Brazil" | jq '.count'

# View debug info
curl http://localhost:8787/api/v1/kalshi/debug | jq '.results'
```

## References

- [Kalshi API Documentation](https://docs.kalshi.com/api-reference)
- [Kalshi Official Website](https://kalshi.com)

