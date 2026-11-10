# TradeX

Strategy backtesting for NIFTY 50 and BANK NIFTY on 5, 15 and 30 minute candles from January 2024, with a Pine-style editor and a detailed report.

## Run on your computer

1. Install Node.js 18 or newer from nodejs.org.
2. Double-click `Start TradeX.bat` (or run `node server/index.js`).
3. Open http://localhost:8080

Nothing else needs installing. The first start downloads the candle history into the `data` folder; later starts are quick.

## Folders

- `server/` the data server (history, 15 and 30 minute candles, live price)
- `web/` the website (landing page and workspace)
- `data/` saved 5 minute candles
- `PLAN.txt` what was built and why, `DEPLOY.txt` how to host it

See `DEPLOY.txt` for GitHub, Render and Cloudflare steps.
