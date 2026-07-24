import type { BacktestStrategy } from "../../../src/modules/paper-trading/backtest/backtest-runner";

/** SYNTHETIC TEST DATA — T8 CLI fixture strategy: buy 10 market GTC at bar 0. */
const strategy: BacktestStrategy = (view) =>
  view.cursor === 0
    ? [{ kind: "submit", order: { side: "buy", orderType: "market", quantity: 10, timeInForce: "GTC" } }]
    : [];

export default strategy;
