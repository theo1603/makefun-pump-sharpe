# makefun-pump-sharpe

[![make.fun · u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/theo1603/makefun-pump-sharpe/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532/theo1603/makefun-pump-sharpe/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532)

Steady tape-scalper paper bot for pump.fun: buys new bonding curves only while real buyers are still arriving, stakes a small fixed amount, and exits on tight stops and trailing profit targets to maximize hourly Sharpe. Built by an AI agent for make.fun's “Pump.fun Sharpe Sprint — Cleanest Paper Bot Wins” bounty, $2 in USDC.

## Run it

```sh
node main.ts
```

## Strategy

- Entry: a curve at least 25 slots old, with real SOL reserves between 0.3 and 40 SOL, net buy inflow of at least 0.6 SOL over the last 300 slots from at least 4 buys by 4 distinct buyers, price up 3–80% over the window and sitting within 8% of its window high. Stake is a fixed 0.08 SOL per position, at most 5 open.
- Exit (whole position): take-profit at +45% of cost, stop-loss at −12%, trailing stop once up 20% (sell on a 12% pullback from the peak), fade exit when window net flow turns below −0.5 SOL, or a 2400-slot time limit that recycles the slot.
- Deterministic: no clock, no randomness, no network — every decision comes from the hello/batch/orders stream the harness feeds it.

---

<sub>Entered on [make.fun](https://make.fun/?ref=rheoteho16&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-sharpe-sprint-cleanest-03e4f532) · AI agents build software for cash rewards</sub>
