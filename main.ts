// Steady tape-scalper for the pump.fun Sharpe sprint.
//
// Idea: hourly Sharpe rewards many small, controlled wins and punishes
// variance, so this bot never chases a moonshot. It buys a new bonding
// curve only while real buyers are still arriving (net SOL inflow over a
// short tape window, several distinct buyers, price rising but not yet
// parabolic and sitting near its window high), stakes a small fixed
// amount, and exits whole on the first of: a modest take-profit, a tight
// stop-loss, a trailing stop once the trade is up, a fade in buy flow,
// or a short time limit that recycles the slot for the next coin.
// Everything is deterministic: no clock, no randomness, iteration only
// over insertion-ordered maps fed by the batch stream.
//
// The harness drives this file as `node /bot/main.ts`; the wire shim in
// vendor/makefun-bot.ts owns stdin/stdout and calls onBatch once per
// batch (one slot's worth of hello/batch/orders traffic).

import {
  LAMPORTS_PER_SOL,
  runBot,
  type BotState,
  type Batch,
  type BuyInput,
  type OrderInput,
  type Pubkey,
  type SellInput,
} from './vendor/makefun-bot.ts';

// ------------------------------------------------------------------ tuning

const SOL = Number(LAMPORTS_PER_SOL);

// Tape window, in slots, for the entry signal and the fade exit.
const WINDOW_SLOTS = 300;
// A curve must be this old (slots since its CreateEvent) before entry:
// the first seconds are mostly bundled launches that get dumped.
const MIN_AGE_SLOTS = 25;
// Entry needs at least this net SOL (buys minus sells) over the window.
const MIN_NET_SOL = 0.6;
// ... at least this many buy trades, from this many distinct buyers.
const MIN_BUYS = 4;
const MIN_BUYERS = 4;
// Price rise over the window: at least this, at most this (no chasing).
// v5: back to the v1 shape (buy after a confirmed small rise, tight
// exits) — v4 proved early entries mostly buy coins that die, and v2
// proved letting winners run only lets them reverse. v5 tightens the
// entry filter a notch (more inflow, one more distinct buyer) to cut
// the weakest v1 entries while keeping v1's exits.
const MIN_PRICE_UP = 0.03;
const MAX_PRICE_UP = 0.8;
// Price must sit at least this close to the window high.
const NEAR_HIGH = 0.92;
// Real SOL reserves at entry: liquid enough to trade, early enough to move.
const MIN_RQ_SOL = 0.3;
const MAX_RQ_SOL = 40;
// Fixed stake per position. 0.08 SOL clears the 0.01 SOL round-trip bar
// with room for fees, and five slots keep at most 0.4 SOL at risk.
const STAKE_LAMPORTS = (LAMPORTS_PER_SOL * 8n) / 100n;
// Most entries into the same curve over the whole run.
const MAX_ENTRIES_PER_CURVE = 2;
// Slots to wait after an exit before the same curve may be bought again.
const COOLDOWN_SLOTS = 600;
// Exits (v1 shape): a modest take-profit, a tight stop-loss, a trailing
// stop once the trade is up, a fade exit and a short time limit that
// recycles the slot for the next coin.
const TAKE_PROFIT = 1.25; // value / cost
const STOP_LOSS = 0.85; // value / cost
const TRAIL_ARM = 1.12; // trailing stop arms once value reaches cost * this
const TRAIL_DROP = 0.9; // ... then sells when value falls to this of its peak
const MAX_HOLD_SLOTS = 1200; // time limit: recycle the slot
const FADE_NET_SOL = -0.5; // sell when window net flow turns this negative
// Slippage: buys tight enough to dodge a bad fill in the 2-slot latency,
// sells wide open so an exit is never refused for the price moving.
const BUY_SLIPPAGE_BPS = 2000;
const SELL_SLIPPAGE_BPS = 10000;

// ------------------------------------------------------------------ tape

interface TapeTrade {
  slot: number;
  /** Signed SOL flow in lamports: +buy, -sell. */
  sol: bigint;
  isBuy: boolean;
  user: Pubkey;
}

interface CurveTape {
  createdSlot: number | null;
  trades: TapeTrade[];
  /** Price samples (slot, quote-per-token as a float) for window math. */
  prices: { slot: number; price: number }[];
  entries: number;
  lastExitSlot: number;
}

interface OpenTrade {
  mint: Pubkey;
  costLamports: bigint;
  buySlot: number;
  peakValueLamports: bigint;
}

const tapes = new Map<Pubkey, CurveTape>();
const open = new Map<Pubkey, OpenTrade>();
const pendingSell = new Set<Pubkey>();

function tapeFor(mint: Pubkey): CurveTape {
  let t = tapes.get(mint);
  if (t === undefined) {
    t = { createdSlot: null, trades: [], prices: [], entries: 0, lastExitSlot: -1 };
    tapes.set(mint, t);
  }
  return t;
}

/** Quote (SOL) per token from the curve's virtual reserves. */
function priceOf(state: BotState, mint: Pubkey): number | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  if (c.virtual_token_reserves === 0n) return null;
  return Number(c.virtual_quote_reserves) / Number(c.virtual_token_reserves);
}

/** Mark-to-market value of a holding in lamports, from virtual reserves. */
function valueOf(state: BotState, mint: Pubkey, tokens: bigint): bigint | null {
  const c = state.curves.get(mint);
  if (c === undefined) return null;
  if (c.virtual_token_reserves === 0n) return null;
  return (tokens * c.virtual_quote_reserves) / c.virtual_token_reserves;
}

function prune(tape: CurveTape, slot: number): void {
  const cutoff = slot - WINDOW_SLOTS;
  while (tape.trades.length > 0 && tape.trades[0].slot < cutoff) tape.trades.shift();
  while (tape.prices.length > 0 && tape.prices[0].slot < cutoff) tape.prices.shift();
}

/** Window stats for one curve: net SOL flow, buy count, distinct buyers. */
function windowStats(tape: CurveTape): { netSol: number; buys: number; buyers: number } {
  let net = 0n;
  let buys = 0;
  const buyers = new Set<Pubkey>();
  for (const t of tape.trades) {
    net += t.sol;
    if (t.isBuy) {
      buys += 1;
      buyers.add(t.user);
    }
  }
  return { netSol: Number(net) / SOL, buys, buyers: buyers.size };
}

function windowPriceMove(tape: CurveTape): { up: number; nearHigh: number } | null {
  if (tape.prices.length < 2) return null;
  const first = tape.prices[0].price;
  const last = tape.prices[tape.prices.length - 1].price;
  if (first <= 0 || last <= 0) return null;
  let high = 0;
  for (const p of tape.prices) if (p.price > high) high = p.price;
  return { up: last / first - 1, nearHigh: last / high };
}

// ------------------------------------------------------------------ bot

await runBot({
  onBatch(state: BotState, batch: Batch): OrderInput[] {
    const orders: OrderInput[] = [];
    const slot = batch.slot;
    const caps = state.hello.caps;
    const tx = state.txFeeLamports();
    let free = state.freeCashLamports();
    let slots = caps.max_open_positions - state.committedPositionCount();

    // --- fold this batch's events into the tapes ---------------------
    for (const e of batch.events) {
      const tape = tapeFor(e.mint);
      if (e.event === 'CreateEvent') {
        if (tape.createdSlot === null) tape.createdSlot = e.slot;
      } else if (e.event === 'TradeEvent') {
        tape.trades.push({
          slot: e.slot,
          sol: e.is_buy ? BigInt(e.sol_amount) : -BigInt(e.sol_amount),
          isBuy: e.is_buy,
          user: e.user,
        });
      }
    }
    // One price sample per curve that moved or was created this batch.
    const seen = new Set<Pubkey>();
    for (const e of batch.events) seen.add(e.mint);
    for (const mint of seen) {
      const tape = tapes.get(mint);
      const p = priceOf(state, mint);
      if (tape !== undefined && p !== null && p > 0) {
        tape.prices.push({ slot, price: p });
        prune(tape, slot);
      }
    }

    // --- exits first: free slots and lock in results -----------------
    for (const [mint, holding] of state.positions) {
      if (pendingSell.has(mint)) continue;
      const trade = open.get(mint);
      const value = valueOf(state, mint, holding.token_amount);
      if (value === null) continue;
      const cost = holding.cost_lamports;
      if (trade !== undefined && value > trade.peakValueLamports) {
        trade.peakValueLamports = value;
      }
      const ratio = Number(value) / Number(cost);
      let exit = false;
      if (ratio >= TAKE_PROFIT) exit = true; // modest win: bank it
      else if (ratio <= STOP_LOSS) exit = true; // tight stop: cut it
      else if (trade !== undefined) {
        if (Number(trade.peakValueLamports) >= Number(cost) * TRAIL_ARM) {
          if (Number(value) <= Number(trade.peakValueLamports) * TRAIL_DROP) exit = true;
        }
        if (slot - trade.buySlot >= MAX_HOLD_SLOTS) exit = true; // time limit
      }
      if (!exit) {
        const tape = tapes.get(mint);
        if (tape !== undefined && windowStats(tape).netSol <= FADE_NET_SOL) exit = true;
      }
      if (!exit) continue;
      const sell: SellInput = {
        side: 'sell',
        mint,
        token_amount: holding.token_amount,
        max_slippage_bps: SELL_SLIPPAGE_BPS,
      };
      orders.push(sell);
      pendingSell.add(mint);
      const t = tapes.get(mint);
      if (t !== undefined) t.lastExitSlot = slot;
      open.delete(mint);
    }

    // --- entries: fresh curves with real buy flow --------------------
    for (const mint of seen) {
      if (orders.length >= caps.max_orders_per_batch) break;
      if (slots <= 0) break;
      const tape = tapes.get(mint);
      const curve = state.curves.get(mint);
      if (tape === undefined || curve === undefined || curve.complete) continue;
      if (state.positions.has(mint)) continue;
      if (pendingSell.has(mint)) continue;
      if (tape.entries >= MAX_ENTRIES_PER_CURVE) continue;
      if (tape.lastExitSlot >= 0 && slot - tape.lastExitSlot < COOLDOWN_SLOTS) continue;
      // Skip a curve with a buy already in flight.
      let buyPending = false;
      for (const p of state.pending.values()) {
        if (p.order.side === 'buy' && p.order.mint === mint) {
          buyPending = true;
          break;
        }
      }
      if (buyPending) continue;
      const age =
        tape.createdSlot === null ? Number.MAX_SAFE_INTEGER : slot - tape.createdSlot;
      if (age < MIN_AGE_SLOTS) continue;
      const rqSol = Number(curve.real_quote_reserves) / SOL;
      if (rqSol < MIN_RQ_SOL || rqSol > MAX_RQ_SOL) continue;
      const stats = windowStats(tape);
      if (stats.netSol < MIN_NET_SOL) continue;
      if (stats.buys < MIN_BUYS || stats.buyers < MIN_BUYERS) continue;
      const move = windowPriceMove(tape);
      if (move === null) continue;
      if (move.up < MIN_PRICE_UP || move.up > MAX_PRICE_UP) continue;
      if (move.nearHigh < NEAR_HIGH) continue;
      const cap = state.maxBuyLamports(mint);
      if (cap <= 0n) continue;
      const amount = cap < STAKE_LAMPORTS ? cap : STAKE_LAMPORTS;
      if (free < amount + tx) continue;
      const buy: BuyInput = {
        side: 'buy',
        mint,
        quote_lamports: amount,
        max_slippage_bps: BUY_SLIPPAGE_BPS,
      };
      orders.push(buy);
      tape.entries += 1;
      free -= amount + tx;
      slots -= 1;
    }

    // --- track fills that landed: open trades and freed sell slots ---
    for (const f of batch.fills) {
      if (f.status !== 'filled') {
        if (f.side === 'sell') pendingSell.delete(f.mint);
        continue;
      }
      if (f.side === 'buy') {
        const cost = BigInt(f.quote_lamports);
        open.set(f.mint, {
          mint: f.mint,
          costLamports: cost,
          buySlot: slot,
          peakValueLamports: cost,
        });
      } else {
        pendingSell.delete(f.mint);
      }
    }

    return orders;
  },
});
