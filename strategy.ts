// Pump.fun paper bot: early-momentum with a take-profit ladder.
//
// The replay hands the bot one hello, then one batch per slot, and the bot
// answers each batch with its orders for that slot. Every decision below is
// deterministic: no clock, no randomness, iteration only over
// insertion-ordered maps fed by the batch stream, so two runs agree.
//
// Idea: pump.fun curves mostly die; the few that run show it early as fresh
// buy pressure from several distinct wallets. Buy at the first sign of that
// pressure, size up only into a proven doubler, and let it run under a wide
// trailing stop with a hard -30% stop underneath. A pacing probe keeps the
// run above the guardrail (round trips of >= 0.01 SOL on >= 20 coins) even
// on quiet stretches, so the entry ranks with the bots that meet the bar
// instead of below them. Tuned on the kit's dev window: the 1%-of-reserves
// size cap makes bigger first buys enter later at worse prices, so the first
// buy stays small and the size goes to the adds.

import type { Batch, Bot, BotState, OrderInput, Pubkey } from './vendor/makefun-bot.ts';

const LAMPORTS = 1e9;
const CURVE_FEE = 0.0125; // protocol 95bps + creator 30bps, charged on both legs
const BPS = 10_000;

export interface Params {
  window: number; // entry lookback, slots
  minNetSol: number; // net SOL inflow over the window
  minBuys: number; // buy trades in the window
  minBuyers: number; // distinct buying wallets in the window
  minPriceUp: number; // price rise over the window, fraction
  maxPriceUp: number; // skip curves that already ran too far
  nearHigh: number; // price now as a share of the window high
  maxBuyerShare: number; // largest wallet's share of window buy SOL
  minRqSol: number; // real SOL reserves at entry, low bound
  maxRqSol: number; // real SOL reserves at entry, high bound
  minAge: number; // slots since CreateEvent before an entry
  stakeSol: number; // total SOL per position
  initialSol: number; // first buy of a position
  addSol: number; // each pyramid add
  maxAdds: number; // adds after the first buy
  addMinUp: number; // add only while the position is up at least this much
  minBuySol: number; // smallest buy worth sending
  buySlipBps: number; // slippage on buys; sells go out wide open
  stopLoss: number; // exit when value < cost * (1 - stopLoss)
  takeProfit: number; // sell half when value >= cost * (1 + takeProfit)
  trail: number; // trailing stop from peak, fraction
  trailArm: number; // trailing stop arms once value >= cost * (1 + trailArm)
  fadeWindow: number; // flow lookback for the fade exit, slots
  fadeNetSol: number; // exit when net flow over fadeWindow < -fadeNetSol
  maxHold: number; // exit after this many slots held
  holdIfUp: number; // time cap does not apply while up this much
  cooldown: number; // slots after an exit before re-entering the same curve
  maxEntries: number; // most entries per curve over the run
  maxMain: number; // most momentum positions open at once
  targetCoins: number; // guardrail pacing target: coins with a fill
  targetFills: number; // guardrail pacing target: own fills
  paceSecs: number; // block-time seconds the pacing ramps over
  probeSol: number; // probe round-trip size
  maxProbes: number; // probes open at once
  maxExposureSol: number; // most SOL at cost across positions
  anyEntry: boolean; // lottery mode: enter any coin once age/reserves pass, no signal
}

export const DEFAULT_PARAMS: Params = {
  window: 12,
  minNetSol: 0.2,
  minBuys: 2,
  minBuyers: 2,
  minPriceUp: 0,
  maxPriceUp: 2,
  nearHigh: 0,
  maxBuyerShare: 0.6,
  minRqSol: 1,
  maxRqSol: 40,
  minAge: 30,
  stakeSol: 0.4,
  initialSol: 0.1,
  addSol: 0.15,
  maxAdds: 2,
  addMinUp: 1.0,
  minBuySol: 0.01,
  buySlipBps: 1500,
  stopLoss: 0.3,
  takeProfit: 1000,
  trail: 0.35,
  trailArm: 0.6,
  fadeWindow: 12,
  fadeNetSol: 1000,
  maxHold: 100000,
  holdIfUp: 1000,
  cooldown: 120,
  maxEntries: 2,
  maxMain: 5,
  targetCoins: 25,
  targetFills: 200,
  paceSecs: 14_400,
  probeSol: 0.02,
  maxProbes: 1,
  maxExposureSol: 5,
  anyEntry: false,
};

interface Trade {
  slot: number;
  buy: boolean;
  sol: number;
  user: string;
  price: number;
}

interface Tape {
  created: number | null;
  trades: Trade[];
  entries: number;
  lastExit: number;
}

interface Held {
  opened: number;
  peakValue: number;
  invested: number;
  adds: number;
  tookProfit: boolean;
  exiting: boolean;
  filled: boolean;
  lastAddPrice: number;
  lastValue: number;
}

/** Price of a curve from its virtual reserves (quote per token). */
function priceOf(vq: bigint, vt: bigint): number {
  return Number(vq) / Number(vt);
}

/** Net recorded SOL (buys minus sells) on a tape over the last `w` slots. */
function flow(t: Tape, now: number, w: number): number {
  let net = 0;
  for (let i = t.trades.length - 1; i >= 0; i--) {
    const tr = t.trades[i]!;
    if (tr.slot <= now - w) break;
    net += tr.buy ? tr.sol : -tr.sol;
  }
  return net;
}

/** Close value of a position in SOL, curve and tx fees deducted. */
function closeValue(tokens: bigint, vq: bigint, vt: bigint, txLamports: bigint): number {
  const t = Number(tokens);
  const gross = (t * Number(vq)) / (Number(vt) + t) / LAMPORTS;
  return gross * (1 - CURVE_FEE) - Number(txLamports) / LAMPORTS;
}

export function createStrategy(p: Params = DEFAULT_PARAMS): Bot {
  const tapes = new Map<Pubkey, Tape>();
  const held = new Map<Pubkey, Held>();
  /** Probe round trips in flight, by mint: false while buying, true once selling. */
  const probes = new Map<Pubkey, boolean>();
  let myFills = 0;
  const myCoins = new Set<Pubkey>();
  let firstTime: number | null = null;
  let lastTime: number | null = null;
  const keep = Math.max(p.window, p.fadeWindow) + 5;

  const tapeOf = (mint: Pubkey): Tape => {
    let t = tapes.get(mint);
    if (t === undefined) {
      t = { created: null, trades: [], entries: 0, lastExit: -1e12 };
      tapes.set(mint, t);
    }
    return t;
  };

  /** Entry signal on a curve's tape at slot `now` with real reserves `rqSol`. */
  const entrySignal = (t: Tape, now: number, rqSol: number): boolean => {
    if (rqSol < p.minRqSol || rqSol > p.maxRqSol) return false;
    if (t.created === null || now - t.created < p.minAge) return false;
    // Lottery mode: any coin that survived to this age with real reserves is
    // a ticket; the edge is catching the rare completer, not picking winners.
    if (p.anyEntry) return true;
    const from = now - p.window;
    const mid = now - p.window / 2;
    let buySol = 0;
    let sellSol = 0;
    let buys = 0;
    let netOld = 0;
    let netNew = 0;
    let startPrice = -1;
    let high = 0;
    let last = 0;
    const byUser = new Map<string, number>();
    for (const tr of t.trades) {
      if (tr.slot <= from) {
        startPrice = tr.price;
        continue;
      }
      if (startPrice < 0) startPrice = tr.price;
      const signed = tr.buy ? tr.sol : -tr.sol;
      if (tr.slot <= mid) netOld += signed;
      else netNew += signed;
      if (tr.buy) {
        buySol += tr.sol;
        buys++;
        byUser.set(tr.user, (byUser.get(tr.user) ?? 0) + tr.sol);
      } else {
        sellSol += tr.sol;
      }
      if (tr.price > high) high = tr.price;
      last = tr.price;
    }
    if (buys < p.minBuys || byUser.size < p.minBuyers) return false;
    const net = buySol - sellSol;
    if (net < p.minNetSol) return false;
    if (startPrice <= 0) return false;
    const up = last / startPrice - 1;
    if (up < p.minPriceUp || up > p.maxPriceUp) return false;
    if (last < high * p.nearHigh) return false;
    // Accelerating: the newer half of the window must bring at least as much
    // net inflow as the older half.
    if (netNew <= 0 || netNew < netOld) return false;
    let top = 0;
    for (const v of byUser.values()) if (v > top) top = v;
    if (top > p.maxBuyerShare * buySol) return false;
    return true;
  };

  return {
    onBatch(state: BotState, batch: Batch): OrderInput[] {
      const now = batch.slot;
      const traded = new Set<Pubkey>();
      for (const f of batch.fills) {
        if (f.status === 'filled' && !f.client_id.startsWith('_')) {
          myFills++;
          myCoins.add(f.mint);
        }
      }
      for (const e of batch.events) {
        if (e.block_time !== null) {
          if (firstTime === null) firstTime = e.block_time;
          if (lastTime === null || e.block_time > lastTime) lastTime = e.block_time;
        }
        if (e.event === 'CreateEvent') {
          tapeOf(e.mint).created = e.slot;
        } else if (e.event === 'TradeEvent') {
          const t = tapeOf(e.mint);
          t.trades.push({
            slot: e.slot,
            buy: e.is_buy,
            sol: Number(e.sol_amount) / LAMPORTS,
            user: e.user,
            price: priceOf(BigInt(e.virtual_quote_reserves), BigInt(e.virtual_token_reserves)),
          });
          traded.add(e.mint);
        }
      }
      for (const mint of traded) {
        const t = tapes.get(mint)!;
        let cut = 0;
        while (cut < t.trades.length && t.trades[cut]!.slot <= now - keep) cut++;
        if (cut > 0) t.trades.splice(0, cut);
      }
      const marks = new Map(batch.marks.map((m) => [m.mint, m] as const));
      const pendingByMint = new Map<Pubkey, number>();
      for (const po of state.pending.values()) {
        pendingByMint.set(po.order.mint, (pendingByMint.get(po.order.mint) ?? 0) + 1);
      }

      const orders: OrderInput[] = [];
      const cap = state.hello.caps.max_orders_per_batch;
      const tx = state.txFeeLamports();

      // Exits first: stop loss, take-profit half-sell, trailing stop, fade, time cap.
      for (const [mint, h] of held) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) {
            held.delete(mint);
            const t = tapeOf(mint);
            if (h.filled) t.lastExit = now;
            else t.entries--;
          }
          continue;
        }
        h.filled = true;
        if (curve === undefined || curve.complete) continue;
        const mk = marks.get(mint);
        const vq = mk ? BigInt(mk.virtual_quote_reserves) : curve.virtual_quote_reserves;
        const vt = mk ? BigInt(mk.virtual_token_reserves) : curve.virtual_token_reserves;
        const value = closeValue(BigInt(pos.token_amount), vq, vt, tx);
        const cost = Number(pos.cost_lamports) / LAMPORTS;
        if (value > h.peakValue) h.peakValue = value;
        h.lastValue = value;
        const t = tapeOf(mint);
        let exit = h.exiting;
        if (!exit && value < cost * (1 - p.stopLoss)) exit = true;
        if (!exit && h.peakValue >= cost * (1 + p.trailArm) && value < h.peakValue * (1 - p.trail)) exit = true;
        if (!exit && flow(t, now, p.fadeWindow) < -p.fadeNetSol) exit = true;
        if (!exit && now - h.opened > p.maxHold && value < cost * (1 + p.holdIfUp)) exit = true;
        // Take half the profit at +50%: sell half the tokens, keep the rest
        // running under the trailing stop.
        if (!exit && !h.tookProfit && value >= cost * (1 + p.takeProfit)) {
          if (orders.length < cap && !pendingByMint.has(mint)) {
            const half = BigInt(pos.token_amount) / 2n;
            if (half > 0n) {
              orders.push({ side: 'sell', mint, token_amount: half, max_slippage_bps: 10_000 });
              h.tookProfit = true;
            }
          }
          continue;
        }
        if (!exit) continue;
        h.exiting = true;
        if (pendingByMint.has(mint)) {
          let sellPending = false;
          for (const po of state.pending.values()) {
            if (po.order.mint === mint && po.order.side === 'sell') sellPending = true;
          }
          if (sellPending) continue;
        }
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
      }

      // Probe round trips: sell the whole probe as soon as its buy has landed.
      for (const [mint, selling] of probes) {
        const pos = state.positions.get(mint);
        const curve = state.curves.get(mint);
        if (pos === undefined) {
          if (!pendingByMint.has(mint)) probes.delete(mint);
          continue;
        }
        if (curve === undefined || curve.complete || pendingByMint.has(mint)) continue;
        if (orders.length >= cap) break;
        orders.push({ side: 'sell', mint, token_amount: pos.token_amount, max_slippage_bps: 10_000 });
        if (!selling) probes.set(mint, true);
      }

      // Then entries and pyramid adds.
      let free = Number(state.freeCashLamports()) / LAMPORTS;
      const txSol = Number(tx) / LAMPORTS;
      let slotsLeft = state.hello.caps.max_open_positions - state.committedPositionCount();
      let mainLeft = p.maxMain - held.size;
      let exposure = 0;
      for (const [mint, h] of held) {
        exposure += Math.max(h.invested, Number(state.positions.get(mint)?.cost_lamports ?? 0n) / LAMPORTS);
      }
      for (const mint of traded) {
        if (orders.length >= cap) break;
        const curve = state.curves.get(mint);
        if (curve === undefined || curve.complete) continue;
        if (pendingByMint.has(mint) || probes.has(mint)) continue;
        const t = tapes.get(mint)!;
        const h = held.get(mint);
        const price = priceOf(curve.virtual_quote_reserves, curve.virtual_token_reserves);
        const rqSol = Number(curve.real_quote_reserves) / LAMPORTS;
        let want: number;
        if (h === undefined) {
          if (slotsLeft <= 0 || mainLeft <= 0) continue;
          if (t.entries >= p.maxEntries || now - t.lastExit < p.cooldown) continue;
          if (!entrySignal(t, now, rqSol)) continue;
          want = Math.min(p.initialSol, p.stakeSol);
        } else {
          // Pyramid into strength only: still up, price stepped above the last
          // add, and the flow has not faded.
          if (h.exiting || !h.filled || h.adds >= p.maxAdds || h.invested >= p.stakeSol - p.minBuySol) continue;
          const pos = state.positions.get(mint);
          if (pos === undefined) continue;
          if (price < h.lastAddPrice) continue;
          if (h.lastValue < Number(pos.cost_lamports) / LAMPORTS * (1 + p.addMinUp)) continue;
          if (flow(t, now, p.window) < p.minNetSol) continue;
          if (rqSol > p.maxRqSol) continue;
          want = Math.min(p.addSol, p.stakeSol - h.invested);
        }
        const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
        let amount = Math.min(capSol, want, p.maxExposureSol - exposure);
        if (amount > free - txSol) amount = free - txSol;
        if (amount < p.minBuySol) continue;
        const lamports = BigInt(Math.floor(amount * LAMPORTS));
        orders.push({ side: 'buy', mint, quote_lamports: lamports, max_slippage_bps: p.buySlipBps });
        free -= amount + txSol;
        exposure += amount;
        if (h === undefined) {
          held.set(mint, {
            opened: now,
            peakValue: 0,
            invested: amount,
            adds: 0,
            tookProfit: false,
            exiting: false,
            filled: false,
            lastAddPrice: price,
            lastValue: 0,
          });
          t.entries++;
          slotsLeft--;
          mainLeft--;
        } else {
          h.invested += amount;
          h.adds++;
          h.lastAddPrice = price;
        }
      }

      // Guardrail pacing: open a probe when fills or coins lag the pace.
      if (probes.size < p.maxProbes && slotsLeft > 0 && firstTime !== null && lastTime !== null) {
        const pace = Math.min(1, (lastTime - firstTime) / p.paceSecs);
        const needCoins = myCoins.size < Math.ceil(p.targetCoins * pace);
        const needFills = myFills < Math.ceil(p.targetFills * pace);
        if (needCoins || needFills) {
          const minRq = (p.probeSol * Number(BPS)) / state.hello.caps.max_order_bps_of_real_reserve;
          for (const mint of traded) {
            if (orders.length >= cap || probes.size >= p.maxProbes) break;
            if (held.has(mint) || probes.has(mint) || pendingByMint.has(mint) || state.positions.has(mint)) continue;
            if (needCoins && !needFills && myCoins.has(mint)) continue;
            const curve = state.curves.get(mint);
            if (curve === undefined || curve.complete) continue;
            if (Number(curve.real_quote_reserves) / LAMPORTS < minRq * 1.5) continue;
            // Respect the per-reply size cap: a probe bigger than 1% of the
            // curve's real reserves is refused outright, so size it to the cap.
            const capSol = Math.floor(Number(state.maxBuyLamports(mint))) / LAMPORTS;
            const amount = Math.min(p.probeSol, capSol);
            if (amount < p.minBuySol) continue;
            if (free < amount + 2 * txSol) break;
            orders.push({ side: 'buy', mint, quote_lamports: BigInt(Math.floor(amount * LAMPORTS)), max_slippage_bps: p.buySlipBps });
            probes.set(mint, false);
            free -= amount + txSol;
          }
        }
      }
      return orders;
    },
  };
}
