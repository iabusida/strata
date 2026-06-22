# STRATA Navigation Refactor

## Overview

The navigation has been refactored to follow a clear hierarchy:
- **Primary Navigation**: Controls WHAT the user is doing (main page/view)
- **Secondary Filter Bar**: Controls WHERE the user is applying it (market type)

This eliminates confusion between navigation and filtering, making the product feel more professional.

## New Structure

### Primary Navigation (`PrimaryNav.tsx`)
Located at the top of the application header, provides four main tabs:

- **Opportunities** → Token scanning and signal detection
- **Forecast** → Market momentum forecasts
- **Pre-Pump** → Early signal detection
- **Simulate** → Trading simulation and backtesting

**Characteristics:**
- Larger, bold font (sm weight, font-semibold)
- Strong visual emphasis on active tab (blue background with shadow)
- Only one tab active at a time
- Horizontal flex layout with spacing
- Indicates current section to the user

### Secondary Filter Bar (`MarketFilter.tsx`)
Located below the primary navigation, provides market selection:

- **Crypto** | **Stocks** toggle
- Smaller visual weight than primary nav
- Future: Profile selector (Scalper/Day/Swing)

**Characteristics:**
- Smaller font and controls than primary nav
- Subtle styling with soft borders
- Persists selected market in localStorage
- Dispatches storage events to notify other components
- Feels like a "filter", not navigation

## File Structure

```
apps/web/components/
├── navigation/
│   ├── PrimaryNav.tsx       # Main navigation tabs
│   └── MarketFilter.tsx     # Market selector
└── app-header-nav.tsx       # Updated header to use new components

apps/web/app/
├── markets/
│   ├── opportunities/
│   │   └── page.tsx         # NEW: Unified opportunities view
│   ├── crypto/
│   │   └── page.tsx         # UPDATED: Sets market filter to CRYPTO
│   ├── stocks/
│   │   └── page.tsx         # UPDATED: Sets market filter to STOCKS
│   └── forecast/
│       └── page.tsx         # Unchanged
├── pre-pump/
│   ├── page.tsx             # UPDATED: Unified pre-pump view
│   ├── crypto/
│   │   └── page.tsx         # Still exists for backward compat
│   └── stocks/
│       └── page.tsx         # Still exists for backward compat
└── test-simulation/
    └── page.tsx             # Unchanged
```

## Implementation Details

### Market Filter Persistence

The `MarketFilter` component stores the selected market in localStorage:
```javascript
localStorage.setItem("strata-market-filter", "CRYPTO" | "STOCKS")
```

When the market changes, it dispatches a storage event that other components can listen to:
```javascript
window.addEventListener("storage", handleStorageChange)
```

### Unified Pages

The new unified pages (`opportunities`, `pre-pump`) listen for market changes:

1. Load initial market preference from localStorage
2. Set up storage event listener
3. Re-render with appropriate dashboard component based on market
4. Clean up listeners on unmount

Example from `opportunities/page.tsx`:
```typescript
const [market, setMarket] = useState<MarketType>("CRYPTO");

useEffect(() => {
  const stored = localStorage.getItem("strata-market-filter");
  if (stored && (stored === "CRYPTO" || stored === "STOCKS")) {
    setMarket(stored);
  }
}, []);

useEffect(() => {
  const handleMarketChange = (event: StorageEvent) => {
    if (event.key === "strata-market-filter" && event.newValue) {
      setMarket(event.newValue as MarketType);
    }
  };
  window.addEventListener("storage", handleMarketChange);
  return () => window.removeEventListener("storage", handleMarketChange);
}, []);

return market === "CRYPTO" ? <Dashboard /> : <StocksDashboard />;
```

### Backward Compatibility

- Old routes (`/markets/crypto`, `/markets/stocks`, `/pre-pump/crypto`, `/pre-pump/stocks`) still work
- They set the appropriate market filter when visited
- Navigation links have been updated to point to new unified routes by default

## Visual Hierarchy

### Primary Nav Styling
```css
/* Active State */
bg-[#2F7BFF] text-white shadow-lg shadow-[#2F7BFF]/30

/* Inactive State */
text-[#9FB3C8] hover:text-[#E6EDF3] hover:bg-white/5

/* Font Size */
text-sm font-semibold uppercase tracking-[0.08em]
```

### Secondary Filter Styling
```css
/* Active Button */
bg-[#3EC6FF]/20 text-[#E6EDF3]

/* Inactive Button */
text-[#6B859E] hover:text-[#9FB3C8]

/* Font Size */
text-xs font-medium uppercase tracking-[0.08em]
```

## Usage

### For Users
1. Click a primary tab to navigate to that section (Opportunities, Forecast, etc.)
2. Use the Market filter below to switch between Crypto and Stocks
3. The selected market will persist across page reloads and navigation

### For Developers

To add a new primary nav item:
1. Update `NAV_ITEMS` in `PrimaryNav.tsx`
2. Update `getActivePrimaryTab()` to recognize the new route
3. Create the new page/route

To extend market filter options:
1. Update `MarketType` type in `MarketFilter.tsx`
2. Add new button to the filter bar
3. Update components that listen to the market filter

## Future Enhancements

- [ ] Add Profile toggle (Scalper, Day, Swing) to secondary filter
- [ ] Add keyboard navigation (arrow keys to switch tabs)
- [ ] Add smooth fade/slide transitions when switching tabs
- [ ] Add analytics to track which primary tab is most used
- [ ] Consider URL-based market preference (e.g., `/opportunities?market=stocks`)
- [ ] Add "favorite" or "pinned" market preference per user profile

## Migration Notes

This refactor maintains backward compatibility while improving UX. The main changes for existing users:

1. The "Scan" tab is now called "Opportunities"
2. Crypto/Stocks are now a filter, not separate navigation items
3. Visual hierarchy is clearer (less confusion between nav and filters)
4. Market preference persists across sessions

## Testing Checklist

- [ ] Primary nav tabs navigate correctly
- [ ] Market filter persists on page reload
- [ ] Market filter applies to all applicable pages
- [ ] Old routes redirect/work correctly
- [ ] Active tab highlighting works
- [ ] Active market filter button highlighting works
- [ ] Storage events fire correctly when market changes
- [ ] Cross-tab communication works (open app in two tabs, change market in one, see it update in the other)
