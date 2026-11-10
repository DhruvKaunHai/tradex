/* Starter strategies shown in the editor library. */
(function (root) {
const SAMPLES = [
{ name: 'EMA crossover', code: `//@version=5
strategy("EMA crossover", overlay=true, initial_capital=500000, default_qty_value=75)

fastLen = input.int(9, "Fast EMA", minval=1)
slowLen = input.int(21, "Slow EMA", minval=2)
squareOff = input.bool(true, "Square off at 3:15 pm")

fast = ta.ema(close, fastLen)
slow = ta.ema(close, slowLen)
plot(fast, "Fast EMA", color=color.orange)
plot(slow, "Slow EMA", color=color.blue)

inDay = not squareOff or (hour < 15 or (hour == 15 and minute < 15))

if ta.crossover(fast, slow) and inDay
    strategy.entry("Long", strategy.long)
if ta.crossunder(fast, slow) and inDay
    strategy.entry("Short", strategy.short)
if not inDay
    strategy.close_all(comment="Day end")
` },
{ name: 'Supertrend flip', code: `//@version=5
strategy("Supertrend flip", overlay=true, initial_capital=500000, default_qty_value=75)

factor = input.float(3.0, "Factor", step=0.1)
atrLen = input.int(10, "ATR length", minval=1)

[st, dir] = ta.supertrend(factor, atrLen)
plot(st, "Supertrend", color = dir < 0 ? color.teal : color.red, linewidth=2)

dayEnd = hour == 15 and minute >= 15

if ta.change(dir) < 0 and not dayEnd
    strategy.entry("Long", strategy.long)
if ta.change(dir) > 0 and not dayEnd
    strategy.entry("Short", strategy.short)
if dayEnd
    strategy.close_all(comment="Day end")
` },
{ name: 'Opening range breakout', code: `//@version=5
strategy("Opening range breakout", overlay=true, initial_capital=500000, default_qty_value=75)

rangeMins = input.int(15, "Opening range (minutes)", minval=5, step=5)
targetX   = input.float(1.5, "Target as multiple of range", step=0.1)

mins = (hour - 9) * 60 + minute - 15
newDay = ta.change(dayofmonth) != 0

var float orHigh = na
var float orLow  = na
var bool traded  = false

if newDay
    orHigh := high
    orLow  := low
    traded := false
else if mins < rangeMins
    orHigh := math.max(orHigh, high)
    orLow  := math.min(orLow, low)

rangeDone = mins >= rangeMins
plot(rangeDone ? orHigh : na, "Range high", color=color.teal, style=plot.style_linebr)
plot(rangeDone ? orLow : na, "Range low", color=color.red, style=plot.style_linebr)

size = orHigh - orLow
canTrade = rangeDone and not traded and hour < 14 and strategy.position_size == 0

if canTrade and close > orHigh
    strategy.entry("Long", strategy.long)
    strategy.exit("Long exit", "Long", stop=orLow, limit=close + size * targetX)
    traded := true
if canTrade and close < orLow
    strategy.entry("Short", strategy.short)
    strategy.exit("Short exit", "Short", stop=orHigh, limit=close - size * targetX)
    traded := true

if hour == 15 and minute >= 15
    strategy.close_all(comment="Day end")
` },
{ name: 'RSI pullback', code: `//@version=5
strategy("RSI pullback", overlay=false, initial_capital=500000, default_qty_value=75)

len      = input.int(14, "RSI length", minval=2)
lowLine  = input.int(30, "Buy below")
highLine = input.int(70, "Sell above")
stopPts  = input.float(60, "Stop loss (points)")

r = ta.rsi(close, len)
plot(r, "RSI", color=color.purple)
hline(highLine, "Upper", color=color.gray)
hline(lowLine, "Lower", color=color.gray)

dayEnd = hour == 15 and minute >= 15

if ta.crossover(r, lowLine) and not dayEnd
    strategy.entry("Long", strategy.long)
if ta.crossunder(r, highLine) and not dayEnd
    strategy.entry("Short", strategy.short)

strategy.exit("Long stop", "Long", loss=stopPts / syminfo.mintick)
strategy.exit("Short stop", "Short", loss=stopPts / syminfo.mintick)

if dayEnd
    strategy.close_all(comment="Day end")
` },
{ name: 'Bollinger squeeze with trailing stop', code: `//@version=5
strategy("Bollinger breakout", overlay=true, initial_capital=500000, default_qty_value=75)

len   = input.int(20, "Length")
mult  = input.float(2.0, "Deviation", step=0.1)
trail = input.float(40, "Trailing stop (points)")

[basis, upper, lower] = ta.bb(close, len, mult)
plot(basis, "Basis", color=color.gray)
plot(upper, "Upper", color=color.teal)
plot(lower, "Lower", color=color.red)

dayEnd = hour == 15 and minute >= 15
flat = strategy.position_size == 0

if flat and ta.crossover(close, upper) and not dayEnd
    strategy.entry("Long", strategy.long)
if flat and ta.crossunder(close, lower) and not dayEnd
    strategy.entry("Short", strategy.short)

strategy.exit("Trail L", "Long", trail_points=0, trail_offset=trail / syminfo.mintick)
strategy.exit("Trail S", "Short", trail_points=0, trail_offset=trail / syminfo.mintick)

if dayEnd
    strategy.close_all(comment="Day end")
` }
];
if (typeof module !== 'undefined' && module.exports) module.exports = SAMPLES; else root.TX_SAMPLES = SAMPLES;
})(typeof self !== 'undefined' ? self : this);
