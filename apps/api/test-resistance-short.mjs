import { calculateRsi, calculateSupportLevel, calculateResistanceLevel, detectResistanceWick, generateMomentumSignal } from './dist/simple-momentum-engine.js';

// Simulate recent ETH candles from your trade
// Prices: bounce from ~1600 → test 1645 wick → pull back to 1630
const mockCandles = [
  { close: 1610, high: 1612, low: 1600 },
  { close: 1615, high: 1620, low: 1608 },
  { close: 1628, high: 1645, low: 1625 },  // Wick to 1645 (above resistance)
  { close: 1631, high: 1635, low: 1627 },  // Pullback, now at 1631
];

const currentPrice = 1629.6;  // Your current price

console.log('Mock Candles (closes):', mockCandles.map(c => c.close));
console.log('Current Price:', currentPrice);

const support = calculateSupportLevel(mockCandles);
const resistance = calculateResistanceLevel(mockCandles);
console.log('Support:', support);
console.log('Resistance:', resistance);

const wick = detectResistanceWick(mockCandles, currentPrice, resistance);
console.log('Resistance Wick Pattern:', wick);

// Simulate as Prisma MarketCandle objects
const prismaCandles = mockCandles.map(c => ({
  ...c,
  open: c.close,
  volume: 0,
  timestamp: new Date(),
  symbol: 'ETH',
  interval: '1h'
}));

const signal = generateMomentumSignal('ETH', prismaCandles, currentPrice);
console.log('Signal Generated:', JSON.stringify(signal, null, 2));
