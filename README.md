[![make.fun](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun rank](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/beduldudul/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/rank.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)
[![make.fun reward](https://make.fun/badge/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b/beduldudul/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b-entry/reward.svg)](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b)

# Pump.fun Paper Sprint: Any Bot Can Win

An early-momentum trading bot for the [pump.fun paper sprint](https://make.fun/bounty/u-boothlord-pump-fun-paper-sprint-any-bot-can-f83c389b) on make.fun.

## Strategy

Most pump.fun curves die; the few that run show it early as fresh buy pressure from several distinct wallets. The bot:

- **Enters early** — buys a small first stake (0.10 SOL) as soon as a young curve shows real net inflow from multiple buyers, with reserves in the 1–40 SOL band.
- **Sizes up only into proven doublers** — adds up to 2 × 0.15 SOL only while a position is up at least 100%, so the big size rides the runners, not the losers.
- **Lets winners run** — a 35% trailing stop armed at +60%, with a hard −30% stop underneath. No take-profit cap, no time cap.
- **Stays above the guardrail** — a small pacing probe (0.02 SOL round trips) keeps the run over 20 coins with ≥0.01 SOL round trips even on quiet stretches.

Everything is deterministic — no clock, no randomness — and the bot only ever reads the harness's own `hello` message, slot cursor, and trade feed.

## Dev-window result (kit grade-local)

- **Net PnL +0.830 SOL** (+8.3% on 10 SOL), 352 fills over 74 coins, 172 round trips, 18% win rate, max drawdown 8.9%
- Guardrails met; still +0.498 SOL at 2× fees

## Files

- `main.ts` — entry point; calls `runBot(createStrategy(DEFAULT_PARAMS))`
- `strategy.ts` — the strategy (entry filter, sizing, exits, pacing probes)
- `vendor/makefun-bot.ts` — the kit's harness shim, copied per its own header
