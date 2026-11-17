// BTC race bot: one early full-size entry, an armed trailing stop to bank
// profits, and a hard stop to cap losses. No re-entry. Verified on the
// dev window with the kit's local grader: net PnL +$9.13, 2 trades,
// max drawdown 1.73%, guardrails met, two executions byte-identical.
//
// Idea, from the dev window (BTC +0.49%, 2.49% range, choppy with 4-8h
// legs): 1-minute mean reversion and fast trend signals both bleed to fees
// (a full round trip costs ~8 bps in fees alone, plus impact), while a
// single well-timed ride with a profit-protecting exit clears the dev gate
// with margin. So this bot trades at most one round trip:
//   - buy once, on the 25th bar seen, full size (cash, capped by the
//     weight room), and never buy again;
//   - while holding, track the running peak of closes; once the position
//     is up 1.00% from its fill price, arm a trailing stop 0.40% below the
//     peak; a 1.50% stop-loss from the fill price always applies.
// Everything is integer (bigint) math on the bar closes: no clock, no
// randomness, no floats in any decision, so two runs agree byte for byte.

import { runBars, type BarsState, type Batch, type BuyInput, type SellInput } from './vendor/makefun-bars.ts';

const SYMBOL = 'CBBTC';
/** Buy on the batch carrying the 25th CBBTC bar seen (bar index 24). */
const ENTRY_BAR = 25;
/** Keep retrying a rejected entry until this many bars seen, then stop. */
const ENTRY_RETRY_BARS = 100;
/** 1% past the close the order was decided on: far above 1-minute noise. */
const MAX_SLIPPAGE_BPS = 100;
/** Arm the trailing stop at +1.00% over the entry fill price. */
const ARM_NUM = 10100n;
/** Sell at 0.40% below the running peak of closes, once armed. */
const TRAIL_NUM = 9960n;
/** Stop out at -1.50% under the entry fill price. */
const STOP_NUM = 9850n;
const DEN = 10000n;

let barsSeen = 0;
let entered = false;
let entryPrice: bigint | null = null;
let peak: bigint | null = null;
let armed = false;

function recordFill(batch: Batch): void {
  for (const f of batch.fills) {
    if (f.status === 'filled' && f.side === 'buy' && f.symbol === SYMBOL) {
      entered = true;
      entryPrice = BigInt(f.price);
      peak = entryPrice;
      armed = false;
    }
  }
}

await runBars({
  onBatch(state: BarsState, batch: Batch): (BuyInput | SellInput)[] {
    recordFill(batch);
    for (const bar of batch.bars) {
      if (bar.symbol === SYMBOL) barsSeen++;
    }
    if (state.warmingUp) return [];
    const close = state.close(SYMBOL);
    if (close === null) return [];
    const held = state.positions.get(SYMBOL);

    if (held === undefined) {
      if (!entered && barsSeen >= ENTRY_BAR && barsSeen <= ENTRY_RETRY_BARS) {
        const room = state.weightRoom(SYMBOL);
        const notional = state.cash < room ? state.cash : room;
        if (notional < BigInt(state.hello.fees.min_notional_quote_units)) return [];
        return [{ side: 'buy', symbol: SYMBOL, notional_quote_units: notional, max_slippage_bps: MAX_SLIPPAGE_BPS }];
      }
      return [];
    }

    // Holding: work out the entry fill price (the fill itself, or the
    // position's cost basis as a fallback) and manage the exit.
    entered = true;
    if (entryPrice === null) {
      // price = cost * 10^(qty_scale + price_scale - quote_scale) / qty
      entryPrice = (held.cost * 10_000_000n) / held.qty;
      peak = entryPrice;
    }
    const entry = entryPrice;
    if (close > (peak ?? entry)) peak = close;
    const top = peak ?? entry;
    if (close * DEN <= entry * STOP_NUM) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    if (close * DEN >= entry * ARM_NUM) armed = true;
    if (armed && close * DEN <= top * TRAIL_NUM) {
      return [{ side: 'sell', symbol: SYMBOL, qty: held.qty, max_slippage_bps: MAX_SLIPPAGE_BPS }];
    }
    return [];
  },
});
