# Token Credit Payment Implementation Plan

## Goal

Launch a card-first checkout where users can optionally apply project tokens for a discount, while AI usage remains metered in stable app credits.

## Product Decision

- Primary payment rail: credit card subscription or top-up
- Optional discount rail: token balance applied at checkout
- Unified service meter: app credits (USD-pegged internal unit)
- AI agent usage is billed from app credits, not direct token price

## Why This Model

- Keeps conversion high because users can pay with card immediately
- Gives token real utility without forcing wallet-only UX
- Protects AI margins from token volatility
- Simplifies accounting and pricing consistency

## Scope V1

1. Card checkout supports optional token discount input
2. Discount engine computes token value and applies capped discount
3. Remaining amount charged to card
4. Purchased value and discount value converted into app credits
5. AI requests consume app credits by usage policy
6. Usage and billing events are auditable in DB

## Non-Goals V1

- No direct on-chain-only checkout flow
- No promise tied to token market value
- No token-based AI pricing without app-credit normalization

## Pricing and Billing Rules

- Define base card price in USD
- Define token discount rate in backend runtime settings
- Apply per-transaction discount cap (example: 20 percent)
- Apply per-user daily and monthly discount caps
- Convert final paid amount into app credits using fixed conversion rules
- Maintain separate ledger entries for:
  - Card charge amount
  - Token discount amount
  - Credits granted
  - Credits consumed

## Architecture Plan

### 1) Data Model

Add entities (or equivalent tables) for:

- BillingAccount
  - userId
  - creditBalance
  - status
- TokenDiscountPolicy
  - enabled
  - tokenToUsdRateSource
  - maxDiscountPercent
  - dailyDiscountCapUsd
  - monthlyDiscountCapUsd
- CheckoutSession
  - userId
  - subtotalUsd
  - tokenDiscountUsd
  - finalChargeUsd
  - creditsGranted
  - status
- CreditLedgerEntry
  - userId
  - type (grant, consume, adjust)
  - amount
  - source (card_payment, token_discount, ai_agent_usage)
  - referenceId
- AiUsageEvent
  - userId
  - model
  - tokensIn
  - tokensOut
  - estimatedCostUsd
  - creditsCharged
  - requestId

### 2) API Surface

- POST /api/billing/checkout/quote
  - Input: planId, tokenAmountApplied
  - Output: subtotalUsd, tokenDiscountUsd, finalChargeUsd, creditsGranted
- POST /api/billing/checkout/confirm
  - Input: quoteId, paymentMethodId
  - Output: receipt, ledger updates, new credit balance
- GET /api/billing/credits
  - Output: current balance and recent ledger
- POST /api/billing/credits/estimate-ai-cost
  - Input: model and request profile
  - Output: estimated credits

### 3) Runtime Controls

Add runtime settings for:

- BILLING_TOKEN_DISCOUNT_ENABLED
- BILLING_TOKEN_DISCOUNT_MAX_PERCENT
- BILLING_TOKEN_DISCOUNT_DAILY_CAP_USD
- BILLING_TOKEN_DISCOUNT_MONTHLY_CAP_USD
- BILLING_CREDIT_USD_RATE
- AI_AGENT_CREDITS_PER_REQUEST_BASE
- AI_AGENT_CREDITS_PER_1K_TOKENS

## AI Agent Separation Rules

- Token utility only affects checkout discount
- AI request authorization checks app credit balance only
- AI cost accounting is based on model usage cost profile
- If user has insufficient credits, return paywall response with quote link

## Security and Abuse Controls

- Per-user rate limits on quote and confirm endpoints
- Signature verification for payment callbacks
- Discount replay prevention via one-time quote IDs
- Ledger idempotency keys on all balance writes
- Audit trail for every credit mutation

## Rollout Plan

### Phase 1: Foundation

- Add data schema and migrations
- Add credit ledger service
- Add runtime settings and admin controls

### Phase 2: Checkout + Discount

- Build quote endpoint with token discount logic
- Build confirm endpoint with card payment integration
- Write ledger entries for every billing event

### Phase 3: AI Metering Integration

- Enforce credit checks before AI inference
- Charge credits after successful response
- Record usage metrics and cost telemetry

### Phase 4: UX

- Add checkout UI with token discount toggle
- Show live savings and final charge
- Add credit balance widget in app and Telegram responses

### Phase 5: Guardrails and Monitoring

- Alerting on abnormal discount or credit burn patterns
- Daily reconciliation report for card revenue, discounts, and credits
- Admin kill switch for token discount

## Acceptance Criteria

- User can complete checkout with card and optional token discount
- Discount caps are correctly enforced
- Credit balance updates are correct and auditable
- AI requests are blocked when credits are insufficient
- AI spend and user credits reconcile within accepted tolerance

## Open Questions

- Exact token valuation source and refresh interval
- Discount cap targets for launch
- Whether discount applies to subscriptions, top-ups, or both
- Initial AI credit pricing table per model

## Immediate Next Build Tasks

1. Add schema draft for BillingAccount, CheckoutSession, CreditLedgerEntry, and AiUsageEvent
2. Add runtime settings keys for token discount and AI credit rates
3. Implement POST /api/billing/checkout/quote with deterministic discount caps
4. Implement credit balance read endpoint and ledger service
5. Wire AI agent pre-check to require sufficient credits before inference
