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
` },
{
  name: "Apex - Trend-Momentum Symphony v2",
  code: `// This Pine Script™ code is subject to the terms of the Mozilla Public License 2.0 at https://mozilla.org/MPL/2.0/
// © NSE Quant Studio — #1 Apex Trend-Momentum Symphony v2 (Trade ID Sync & Smart Expiry)

//@version=5
strategy("Apex Trend-Momentum Symphony v2 [NSE Quant Studio]", shorttitle="Apex Symphony v2", overlay=true, initial_capital=500000, default_qty_type=strategy.fixed, default_qty_value=75, currency=currency.INR, commission_type=strategy.commission.cash_per_order, commission_value=0.0, calc_on_every_tick=false, process_orders_on_close=true, max_labels_count=500, max_lines_count=500)

// ============================================================================
// 1. TIMEFRAME PROFILE & STRATEGY INPUTS
// ============================================================================
grp_prof     = "0. Timeframe Optimization Profile"
profileMode  = input.string("Auto (5m & 15m+ Optimized)", "Parameter Profile Mode", options=["Auto (5m & 15m+ Optimized)", "Force 5m Scalper Profile", "Force 15m Swing Profile", "Custom Manual Inputs"], group=grp_prof)

grp_st       = "1. Supertrend Settings (Manual Override)"
stPeriodIn   = input.int(14, "Supertrend ATR Length (5m=14, 15m=10)", minval=1, group=grp_st)
stMultIn     = input.float(3.5, "Supertrend Multiplier (5m=3.5, 15m=3.0)", minval=0.5, step=0.1, group=grp_st)

grp_ema      = "2. 3-EMA Trend Ribbon (Manual Override)"
emaFastIn    = input.int(9, "Fast EMA Length (5m=9, 15m=8)", minval=1, group=grp_ema)
emaSlowIn    = input.int(21, "Slow EMA Length (21)", minval=1, group=grp_ema)
emaMacIn     = input.int(50, "Macro EMA Length (5m=50, 15m=55)", minval=1, group=grp_ema)

grp_mom      = "3. Intraday VWAP, RSI & ADX Chop Filter"
rsiLen       = input.int(14, "RSI Length", minval=1, group=grp_mom)
rsiLongIn    = input.float(58.0, "RSI Long Threshold (5m=58, 15m=52)", minval=50.0, maxval=80.0, step=0.5, group=grp_mom)
rsiShortIn   = input.float(42.0, "RSI Short Threshold (5m=42, 15m=48)", minval=20.0, maxval=50.0, step=0.5, group=grp_mom)
adxLen       = input.int(14, "ADX Chop Filter Length", minval=1, group=grp_mom)
adxMinIn     = input.float(16.0, "Minimum ADX Trend Strength (0 = Off)", minval=0.0, maxval=50.0, step=1.0, group=grp_mom)
maxLegIn     = input.int(2, "Max Entries Per Supertrend Wave", minval=1, maxval=20, group=grp_mom)
vwapMode     = input.string("Equal-Weighted (Nifty Spot)", "Intraday Anchor Mode", options=["Equal-Weighted (Nifty Spot)", "Volume-Weighted VWAP"], group=grp_mom)

grp_risk     = "4. Two-Stage Ratchet, Target & Trailing Stop"
atrLen       = input.int(14, "Stop ATR Length", minval=1, group=grp_risk)
slAtrIn      = input.float(1.8, "Initial Stop Loss x ATR (5m=1.8, 15m=1.6)", minval=0.2, step=0.1, group=grp_risk)
minAtrFloor  = input.float(15.0, "Minimum ATR Floor (Nifty Pts)", minval=0.0, step=1.0, group=grp_risk)
beTrigIn     = input.float(1.0, "Stage-1 Breakeven Trigger (x R)", minval=0.0, step=0.1, group=grp_risk)
beOffIn      = input.float(0.25, "Stage-1 Breakeven Lock Offset (+x R)", minval=0.0, step=0.05, group=grp_risk)
lock2TrigIn  = input.float(2.0, "Stage-2 Profit-Lock Trigger (x R)", minval=0.0, step=0.1, group=grp_risk)
lock2OffIn   = input.float(1.10, "Stage-2 Profit-Lock Offset (+x R)", minval=0.0, step=0.05, group=grp_risk)
tpRIn        = input.float(3.5, "Profit Target Multiple (x R, 5m=3.5, 15m=4.5, 0=Off)", minval=0.0, step=0.1, group=grp_risk)
useStTrail   = input.bool(true, "Enable Live Supertrend Trailing Stop", group=grp_risk)

grp_exp      = "5. Day-Specific Expiry Management"
forceExpiry  = input.bool(true, "Force Square-off Open Trades on Expiry Day", group=grp_exp)
expiryDay    = input.string("Tuesday", "Select Contract Expiry Day", options=["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"], group=grp_exp)
expiryTime   = input.int(1515, "Square-off Time (HHMM IST)", group=grp_exp)

grp_vis      = "6. Visual Callout Engine & HUD"
showCallouts = input.bool(true, "Show Entry/Exit Badges & Trade Connectors", group=grp_vis)
entryStyle   = input.string("Solid Blue", "Entry Badge Color Theme", options=["Solid Blue", "Green Call / Red Put"], group=grp_vis)
displayLots  = input.int(1, "Badge Display Qty (Lots)", minval=1, group=grp_vis)
lotSize      = input.int(75, "Nifty Lot Size (Units per Lot)", minval=1, group=grp_vis)
showRibbons  = input.bool(false, "Show Background EMA Ribbon Lines", group=grp_vis)
showStLine   = input.bool(true, "Show Supertrend Spine Line", group=grp_vis)
showTradeLvls= input.bool(true, "Show Active Entry / Stop / Target Lines", group=grp_vis)
showHud      = input.bool(true, "Show Quant Studio Telemetry HUD Table", group=grp_vis)
intradayOnly = input.bool(false, "Strict Everyday MIS Mode (Flat Everyday)", group=grp_vis)

// ============================================================================
// 2. AUTO-ADAPTIVE PARAMETER RESOLUTION (5m vs 15m+)
// ============================================================================
is5mChart = timeframe.isminutes and timeframe.multiplier <= 5
use5mProf = (profileMode == "Force 5m Scalper Profile") or (profileMode == "Auto (5m & 15m+ Optimized)" and is5mChart)
use15mProf= (profileMode == "Force 15m Swing Profile") or (profileMode == "Auto (5m & 15m+ Optimized)" and not is5mChart)

stPeriod    = use5mProf ? 14   : use15mProf ? 10   : stPeriodIn
stMult      = use5mProf ? 3.5  : use15mProf ? 3.0  : stMultIn
emaFastP    = use5mProf ? 9    : use15mProf ? 8    : emaFastIn
emaSlowP    = use5mProf ? 21   : use15mProf ? 21   : emaSlowIn
emaMacP     = use5mProf ? 50   : use15mProf ? 55   : emaMacIn
rsiLong     = use5mProf ? 58.0 : use15mProf ? 52.0 : rsiLongIn
rsiShort    = use5mProf ? 42.0 : use15mProf ? 48.0 : rsiShortIn
adxMin      = use5mProf ? 16.0 : use15mProf ? 16.0 : adxMinIn
maxLegTrades= use5mProf ? 2    : use15mProf ? 2    : maxLegIn
slAtrMult   = use5mProf ? 1.8  : use15mProf ? 1.6  : slAtrIn
beTriggerR  = use5mProf ? 1.0  : use15mProf ? 1.1  : beTrigIn
beOffsetR   = use5mProf ? 0.25 : use15mProf ? 0.20 : beOffIn
lock2TrigR  = use5mProf ? 2.0  : use15mProf ? 2.2  : lock2TrigIn
lock2OffR   = use5mProf ? 1.10 : use15mProf ? 1.20 : lock2OffIn
tpR         = use5mProf ? 3.5  : use15mProf ? 4.5  : tpRIn

// ============================================================================
// 3. CORE INDICATORS (SUPERTREND, 3-EMA, INTRADAY VWAP, RSI, ADX)
// ============================================================================
emaFast = ta.ema(close, emaFastP)
emaSlow = ta.ema(close, emaSlowP)
emaMac  = ta.ema(close, emaMacP)
rsiVal  = ta.rsi(close, rsiLen)

trVal   = ta.tr(true)
atr14   = ta.rma(trVal, atrLen)
curAtr  = math.max(nz(atr14, minAtrFloor), minAtrFloor)

upMove   = high - nz(high[1], high)
dnMove   = nz(low[1], low) - low
plusDm   = (upMove > dnMove and upMove > 0) ? upMove : 0.0
minusDm  = (dnMove > upMove and dnMove > 0) ? dnMove : 0.0
adxAtr   = nz(ta.rma(trVal, adxLen), 1.0)
plusDi   = 100.0 * nz(ta.rma(plusDm, adxLen), 0.0) / math.max(adxAtr, 0.0001)
minusDi  = 100.0 * nz(ta.rma(minusDm, adxLen), 0.0) / math.max(adxAtr, 0.0001)
diSum    = plusDi + minusDi
dxVal    = diSum > 0 ? (100.0 * math.abs(plusDi - minusDi) / diSum) : 0.0
adxVal   = nz(ta.rma(dxVal, adxLen), 0.0)

stAtr      = ta.rma(trVal, stPeriod)
hl2Val     = (high + low) / 2.0
basicUpper = hl2Val + (stMult * nz(stAtr, 0.0))
basicLower = hl2Val - (stMult * nz(stAtr, 0.0))

var float upperBand = na
var float lowerBand = na
var int   stTrend   = 1
var float stLine    = na
var int   legTrades = 0

if na(stAtr) or na(upperBand[1]) or bar_index <= stPeriod
    upperBand := basicUpper
    lowerBand := basicLower
    stTrend   := 1
    stLine    := basicLower
else
    upperBand := (basicUpper < upperBand[1] or close[1] > upperBand[1]) ? basicUpper : upperBand[1]
    lowerBand := (basicLower > lowerBand[1] or close[1] < lowerBand[1]) ? basicLower : lowerBand[1]
    if stTrend[1] == 1
        stTrend := close < lowerBand ? -1 : 1
    else
        stTrend := close > upperBand ? 1 : -1
    stLine := stTrend == 1 ? lowerBand : upperBand

if stTrend != stTrend[1]
    legTrades := 0

isNewDay = timeframe.change("D")
var float cumHlc3 = 0.0
var int   cumBars = 0
var float cumPv   = 0.0
var float cumVol  = 0.0
volSafe = nz(volume, 0.0)

if isNewDay or bar_index == 0
    cumHlc3 := hlc3
    cumBars := 1
    cumPv   := hlc3 * volSafe
    cumVol  := volSafe
else
    cumHlc3 += hlc3
    cumBars += 1
    cumPv   += hlc3 * volSafe
    cumVol  += volSafe

eqWeightedVwap  = cumHlc3 / cumBars
volWeightedVwap = cumVol > 0 ? (cumPv / cumVol) : eqWeightedVwap
intradayVwap    = (vwapMode == "Equal-Weighted (Nifty Spot)") ? eqWeightedVwap : volWeightedVwap

istHour        = hour(time, "Asia/Kolkata")
istMinute      = minute(time, "Asia/Kolkata")
tInt           = istHour * 100 + istMinute

closeHour      = hour(time_close, "Asia/Kolkata")
closeMinute    = minute(time_close, "Asia/Kolkata")
closeTimeInt   = closeHour * 100 + closeMinute

expDayNum      = expiryDay == "Monday" ? dayofweek.monday : expiryDay == "Tuesday" ? dayofweek.tuesday : expiryDay == "Wednesday" ? dayofweek.wednesday : expiryDay == "Thursday" ? dayofweek.thursday : dayofweek.friday
isExpiryDay    = (dayofweek == expDayNum)

forceSquareOffNow = (intradayOnly and closeTimeInt >= 1515) or (forceExpiry and isExpiryDay and closeTimeInt >= expiryTime)
inEntryWindow     = (not intradayOnly or (tInt >= 920 and tInt <= 1430)) and not forceSquareOffNow

// ============================================================================
// 4. ENTRY & TWO-STAGE RATCHET EXIT ENGINE
// ============================================================================
var float entryPrice  = na
var float initRisk    = na
var float activeStop  = na
var float activeTp    = na
var int   ratchetStage= 0
var int   tradeNum    = 0  // Global ID counter for linking entries to exits

inLong  = strategy.position_size > 0
inShort = strategy.position_size < 0
inPos   = strategy.position_size != 0

if forceSquareOffNow and inPos
    strategy.close_all(comment="Auto Time-Squareoff", immediately=true)

if inLong and not forceSquareOffNow
    if beTriggerR > 0 and not na(entryPrice) and not na(initRisk) and high >= (entryPrice + initRisk * beTriggerR)
        longBeStop = math.round((entryPrice + initRisk * beOffsetR) * 100.0) / 100.0
        if na(activeStop) or longBeStop > activeStop
            activeStop   := longBeStop
            ratchetStage := math.max(ratchetStage, 1)
    if lock2TrigR > 0 and not na(entryPrice) and not na(initRisk) and high >= (entryPrice + initRisk * lock2TrigR)
        longL2Stop = math.round((entryPrice + initRisk * lock2OffR) * 100.0) / 100.0
        if na(activeStop) or longL2Stop > activeStop
            activeStop   := longL2Stop
            ratchetStage := math.max(ratchetStage, 2)
    if useStTrail and stTrend == 1 and not na(stLine) and (na(activeStop) or stLine > activeStop)
        activeStop := math.round(stLine * 100.0) / 100.0
    if tpR > 0 and not na(activeTp)
        strategy.exit("Long Exit", from_entry="Long", stop=activeStop, limit=activeTp)
    else
        strategy.exit("Long Exit", from_entry="Long", stop=activeStop)
    if stTrend == -1 and emaFast < emaSlow
        strategy.close("Long")

if inShort and not forceSquareOffNow
    if beTriggerR > 0 and not na(entryPrice) and not na(initRisk) and low <= (entryPrice - initRisk * beTriggerR)
        shortBeStop = math.round((entryPrice - initRisk * beOffsetR) * 100.0) / 100.0
        if na(activeStop) or shortBeStop < activeStop
            activeStop   := shortBeStop
            ratchetStage := math.max(ratchetStage, 1)
    if lock2TrigR > 0 and not na(entryPrice) and not na(initRisk) and low <= (entryPrice - initRisk * lock2TrigR)
        shortL2Stop = math.round((entryPrice - initRisk * lock2OffR) * 100.0) / 100.0
        if na(activeStop) or shortL2Stop < activeStop
            activeStop   := shortL2Stop
            ratchetStage := math.max(ratchetStage, 2)
    if useStTrail and stTrend == -1 and not na(stLine) and (na(activeStop) or stLine < activeStop)
        activeStop := math.round(stLine * 100.0) / 100.0
    if tpR > 0 and not na(activeTp)
        strategy.exit("Short Exit", from_entry="Short", stop=activeStop, limit=activeTp)
    else
        strategy.exit("Short Exit", from_entry="Short", stop=activeStop)
    if stTrend == 1 and emaFast > emaSlow
        strategy.close("Short")

freshBullTrigger = use5mProf ? ((stTrend[1] == -1) or (emaFast[1] <= emaSlow[1]) or (rsiVal[1] <= rsiLong)) : ((stTrend[1] == -1) or (rsiVal[1] <= rsiLong))
freshBearTrigger = use5mProf ? ((stTrend[1] == 1)  or (emaFast[1] >= emaSlow[1]) or (rsiVal[1] >= rsiShort)) : ((stTrend[1] == 1)  or (rsiVal[1] >= rsiShort))
adxOk            = (adxMin <= 0.0) or (adxVal >= adxMin)

longCond  = bar_index >= 55 and inEntryWindow and (legTrades < maxLegTrades) and stTrend == 1  and emaFast > emaSlow and close > emaMac and close > intradayVwap and rsiVal > rsiLong  and adxOk and freshBullTrigger
shortCond = bar_index >= 55 and inEntryWindow and (legTrades < maxLegTrades) and stTrend == -1 and emaFast < emaSlow and close < emaMac and close < intradayVwap and rsiVal < rsiShort and adxOk and freshBearTrigger

flatNow = (strategy.position_size == 0) or (inLong and (forceSquareOffNow or (stTrend == -1 and emaFast < emaSlow))) or (inShort and (forceSquareOffNow or (stTrend == 1 and emaFast > emaSlow)))

bool enteredLongBar  = false
bool enteredShortBar = false

if flatNow and not forceSquareOffNow
    if longCond
        tradeNum       += 1
        entryPrice     := close
        initRisk       := curAtr * slAtrMult
        activeStop     := math.round((entryPrice - initRisk) * 100.0) / 100.0
        activeTp       := tpR > 0 ? (math.round((entryPrice + initRisk * tpR) * 100.0) / 100.0) : na
        ratchetStage   := 0
        legTrades      += 1
        enteredLongBar := true
        strategy.entry("Long", strategy.long)
        if tpR > 0 and not na(activeTp)
            strategy.exit("Long Exit", from_entry="Long", stop=activeStop, limit=activeTp)
        else
            strategy.exit("Long Exit", from_entry="Long", stop=activeStop)
    else if shortCond
        tradeNum        += 1
        entryPrice      := close
        initRisk        := curAtr * slAtrMult
        activeStop      := math.round((entryPrice + initRisk) * 100.0) / 100.0
        activeTp        := tpR > 0 ? (math.round((entryPrice - initRisk * tpR) * 100.0) / 100.0) : na
        ratchetStage    := 0
        legTrades       += 1
        enteredShortBar := true
        strategy.entry("Short", strategy.short)
        if tpR > 0 and not na(activeTp)
            strategy.exit("Short Exit", from_entry="Short", stop=activeStop, limit=activeTp)
        else
            strategy.exit("Short Exit", from_entry="Short", stop=activeStop)

// ============================================================================
// 5. VISUAL CALLOUT ENGINE (TRADE ID TAGGING & DOTTED CONNECTORS)
// ============================================================================
closedCount = strategy.closedtrades
prevClosed  = nz(closedCount[1], 0)

if showCallouts and closedCount > prevClosed
    for idx = prevClosed to closedCount - 1
        exPrice  = strategy.closedtrades.exit_price(idx)
        enPrice  = strategy.closedtrades.entry_price(idx)
        trSize   = strategy.closedtrades.size(idx)
        
        enBar    = strategy.closedtrades.entry_bar_index(idx)
        exBar    = strategy.closedtrades.exit_bar_index(idx)
        barsHeld = exBar - enBar
        
        ptsDiff  = trSize > 0 ? (exPrice - enPrice) : (enPrice - exPrice)
        isWin    = ptsDiff >= 0
        signStr  = isWin ? "+" : ""
        pillClr  = isWin ? #10b981 : #f43f5e
        
        // Un-Clustered Exit Pills matching the Entry ID
        exitTxt  = "EXIT #" + str.tostring(idx + 1) + "\\n" + signStr + str.tostring(ptsDiff, "0.0") + " pts\\n⏱ " + str.tostring(barsHeld) + " bars"
        wasLong  = trSize > 0
        
        yExitPos = wasLong ? (high + curAtr * 0.55) : (low - curAtr * 0.55)
        lblStyle = wasLong ? label.style_label_down : label.style_label_up
        
        label.new(bar_index, yExitPos, exitTxt, xloc=xloc.bar_index, yloc=yloc.price, color=pillClr, textcolor=color.white, style=lblStyle, size=size.small)
        
        // Subtle Dotted Trade Connector Line
        line.new(enBar, enPrice, exBar, exPrice, color=color.new(pillClr, 30), width=2, style=line.style_dotted)

// Un-Clustered Entry Callout Boxes (Tagged with matching Trade ID)
if showCallouts and enteredLongBar
    callClr = (entryStyle == "Solid Blue") ? #2563eb : #059669
    callTxt = "BUY CALL #" + str.tostring(tradeNum) + "\\nEntry: " + str.tostring(entryPrice, "0.00") + "\\nQty: " + str.tostring(displayLots)
    label.new(bar_index, low - curAtr * 0.65, callTxt, xloc=xloc.bar_index, yloc=yloc.price, color=callClr, textcolor=color.white, style=label.style_label_up, size=size.small)

if showCallouts and enteredShortBar
    putClr  = (entryStyle == "Solid Blue") ? #2563eb : #e11d48
    putTxt  = "BUY PUT #" + str.tostring(tradeNum) + "\\nEntry: " + str.tostring(entryPrice, "0.00") + "\\nQty: " + str.tostring(displayLots)
    label.new(bar_index, high + curAtr * 0.65, putTxt, xloc=xloc.bar_index, yloc=yloc.price, color=putClr, textcolor=color.white, style=label.style_label_down, size=size.small)

plotshape(enteredLongBar, title="Buy Call Marker", style=shape.triangleup, location=location.belowbar, color=#3b82f6, size=size.tiny)
plotshape(enteredShortBar, title="Buy Put Marker", style=shape.triangledown, location=location.abovebar, color=#f59e0b, size=size.tiny)

plot(showRibbons ? emaFast : na, "Fast EMA", color=color.new(#06b6d4, 55), linewidth=1)
plot(showRibbons ? emaSlow : na, "Slow EMA", color=color.new(#f59e0b, 55), linewidth=1)
plot(showRibbons ? emaMac  : na, "Macro EMA", color=color.new(#818cf8, 60), linewidth=2)
plot(showRibbons ? intradayVwap : na, "Intraday VWAP", color=color.new(#e879f9, 55), linewidth=1, style=plot.style_circles)

stColor = stTrend == 1 ? color.new(#10b981, 25) : color.new(#f43f5e, 25)
plot(showStLine ? stLine : na, "Supertrend Spine", color=stColor, linewidth=2)

inTradeNow = strategy.position_size != 0
plot(showTradeLvls and inTradeNow ? entryPrice : na, "Active Entry Price", color=color.new(#60a5fa, 20), linewidth=1, style=plot.style_linebr)
plot(showTradeLvls and inTradeNow ? activeStop : na, "Active Ratchet / Trail Stop", color=color.new(#fbbf24, 0), linewidth=2, style=plot.style_linebr)
plot(showTradeLvls and inTradeNow and tpR > 0 ? activeTp : na, "Active Profit Target", color=color.new(#10b981, 20), linewidth=1, style=plot.style_linebr)

// ============================================================================
// 6. QUANT STUDIO TELEMETRY HUD TABLE
// ============================================================================
var table hud = table.new(position.top_right, 2, 9, bgcolor=color.new(#0e121b, 8), border_color=color.new(#ffffff, 82), border_width=1)

if barstate.islast and showHud
    totTrades = strategy.closedtrades
    wins      = strategy.wintrades
    winRate   = totTrades > 0 ? (wins / totTrades) * 100.0 : 0.0
    pf        = strategy.grossloss != 0 ? math.abs(strategy.grossprofit / strategy.grossloss) : 0.0
    netInr    = strategy.netprofit
    netPts    = netInr / math.max(lotSize, 1)
    maxDdPts  = strategy.max_drawdown / math.max(lotSize, 1)
    profLabel = use5mProf ? "5M SCALPER [AUTO]" : use15mProf ? "15M SWING [AUTO]" : "MANUAL CUSTOM"
    ratchTxt  = ratchetStage == 2 ? " [LOCK +1.1R]" : ratchetStage == 1 ? " [BE LOCK]" : " [INIT SL]"

    table.cell(hud, 0, 0, "👑 APEX SYMPHONY v2", text_color=#60a5fa, text_size=size.small, bgcolor=color.new(#1e293b, 10), text_halign=text.align_left)
    table.cell(hud, 1, 0, profLabel, text_color=#34d399, text_size=size.tiny, bgcolor=color.new(#1e293b, 10), text_halign=text.align_right)

    table.cell(hud, 0, 1, "Active Parameters", text_color=#94a3b8, text_size=size.tiny, text_halign=text.align_left)
    table.cell(hud, 1, 1, "ST(" + str.tostring(stPeriod) + "," + str.tostring(stMult, "0.0") + ") · EMA(" + str.tostring(emaFastP) + "/" + str.tostring(emaSlowP) + "/" + str.tostring(emaMacP) + ")", text_color=#e2e8f0, text_size=size.tiny, text_halign=text.align_right)

    table.cell(hud, 0, 2, "Regime · RSI · ADX", text_color=#94a3b8, text_size=size.tiny, text_halign=text.align_left)
    table.cell(hud, 1, 2, (stTrend == 1 ? "BULL" : "BEAR") + " · RSI " + str.tostring(rsiVal, "0.0") + " · ADX " + str.tostring(adxVal, "0.0"), text_color=(stTrend == 1 ? #10b981 : #f43f5e), text_size=size.tiny, text_halign=text.align_right)

    table.cell(hud, 0, 3, "Active Stop / Ratchet", text_color=#94a3b8, text_size=size.tiny, text_halign=text.align_left)
    table.cell(hud, 1, 3, inTradeNow ? (str.tostring(activeStop, "0.00") + ratchTxt) : "FLAT", text_color=#fbbf24, text_size=size.tiny, text_halign=text.align_right)

    table.cell(hud, 0, 4, "Net Profit (Nifty Pts)", text_color=#94a3b8, text_size=size.tiny, text_halign=text.align_left)
    table.cell(hud, 1, 4, (netPts >= 0 ? "+" : "") + str.tostring(netPts, "0.00") + " pts", text_color=(netPts >= 0 ? #10b981 : #f43f5e), text_size=size.tiny, text_halign=text.align_right)

    table.cell(hud, 0, 5, "Net Profit (1 Lot INR)", text_color=#94a3b8, text_size=size.tiny, text_halign=text.align_left)
    table.cell(hud, 1, 5, (netInr >= 0 ? "+INR " : "-INR ") + str.tostring(math.abs(netInr), "0"), text_color=(netInr >= 0 ? #10b981 : #f43f5e), text_size=size.tiny, text_halign=text.align_right)

    table.cell(hud, 0, 6, "Win Rate (Trades)", text_color=#94a3b8, text_size=size.tiny, text_halign=text.align_left)
    table.cell(hud, 1, 6, str.tostring(winRate, "0.0") + "% (" + str.tostring(totTrades) + ")", text_color=#f8fafc, text_size=size.tiny, text_halign=text.align_right)

    table.cell(hud, 0, 7, "Profit Factor", text_color=#94a3b8, text_size=size.tiny, text_halign=text.align_left)
    table.cell(hud, 1, 7, str.tostring(pf, "0.00"), text_color=(pf >= 1.5 ? #10b981 : #f8fafc), text_size=size.tiny, text_halign=text.align_right)

    table.cell(hud, 0, 8, "Max Drawdown", text_color=#94a3b8, text_size=size.tiny, text_halign=text.align_left)
    table.cell(hud, 1, 8, "-" + str.tostring(maxDdPts, "0.00") + " pts", text_color=#f43f5e, text_size=size.tiny, text_halign=text.align_right)`
},
{
  name: "Claude A - Swing Fib Pullback (ZigZag-ATR)",
  code: `//@version=5
strategy("Swing Fib Pullback (ZigZag-ATR)", overlay=true, initial_capital=500000, default_qty_value=75)

// ZigZag swing legs confirmed by ATR reversal; trade Fib 0.382-0.618 pullbacks inside HH/HL (or LH/LL) structure.
atrLen  = input.int(14, "ATR length")
revMult = input.float(0.8, "ZigZag reversal (xATR)", step=0.1)
minLeg  = input.float(1.5, "Min impulse leg (xATR)", step=0.1)
fibLo   = input.float(0.382, "Fib zone start", step=0.01)
fibHi   = input.float(0.618, "Fib zone end", step=0.01)
tgtX    = input.float(0.8, "Target = x leg from pullback extreme", step=0.1)
stopBuf = input.float(0.25, "Stop buffer beyond swing (xATR)", step=0.05)
startH  = input.int(9, "No entries before hour")
endH    = input.int(14, "No entries from hour")
adxMin  = input.float(25, "ADX min", step=1)
adxLen  = input.int(14, "ADX length")
useSpr  = input.int(1, "Spring/upthrust entries (1=on)")

atr = ta.atr(atrLen)
[dip, dim, adx] = ta.dmi(adxLen, adxLen)
thr = revMult * atr
newDay = ta.change(dayofmonth) != 0

var int dir = 0
var float ext = na
var float shP = na
var float slP = na
var float shPrev = na
var float slPrev = na
var bool used = false

if na(ext)
    ext := high
    dir := 1
if dir == 1
    if high > ext
        ext := high
    else if not na(thr) and low < ext - thr
        shPrev := shP
        shP := ext
        dir := -1
        ext := low
        used := false
else
    if low < ext
        ext := low
    else if not na(thr) and high > ext + thr
        slPrev := slP
        slP := ext
        dir := 1
        ext := high
        used := false

inWin = hour >= startH and hour < endH
flat = strategy.position_size == 0
upStruct = not na(shPrev) and not na(slPrev) and shP > shPrev and slP > slPrev
dnStruct = not na(shPrev) and not na(slPrev) and shP < shPrev and slP < slPrev
leg = shP - slP

// long: down-leg correction after HH/HL structure, price in fib zone, bullish reversal bar
zHi = shP - fibLo * leg
zLo = shP - fibHi * leg
longSig = adx >= adxMin and dip > dim and dir == -1 and upStruct and leg >= minLeg * atr and low <= zHi and close > zLo and low > slP and close > open and close > close[1]
// short: up-leg correction after LH/LL structure
zHiS = slP + fibHi * leg
zLoS = slP + fibLo * leg
shortSig = adx >= adxMin and dim > dip and dir == 1 and dnStruct and leg >= minLeg * atr and high >= zLoS and close < zHiS and high < shP and close < open and close < close[1]

sprL = useSpr == 1 and adx >= adxMin and dip > dim and dir == -1 and shP > shPrev and low < slP and close > slP and close > open and close > close[1] and leg >= minLeg * atr
sprS = useSpr == 1 and adx >= adxMin and dim > dip and dir == 1 and shP < shPrev and high > shP and close < shP and close < open and close < close[1] and leg >= minLeg * atr
if flat and inWin and not used and sprL
    strategy.entry("Long", strategy.long)
    strategy.exit("LX", "Long", stop=low - stopBuf * atr, limit=close + tgtX * leg)
    used := true
if flat and inWin and not used and sprS
    strategy.entry("Short", strategy.short)
    strategy.exit("SX", "Short", stop=high + stopBuf * atr, limit=close - tgtX * leg)
    used := true
if flat and inWin and not used and longSig
    strategy.entry("Long", strategy.long)
    strategy.exit("LX", "Long", stop=slP - stopBuf * atr, limit=low + tgtX * leg)
    used := true
if flat and inWin and not used and shortSig
    strategy.entry("Short", strategy.short)
    strategy.exit("SX", "Short", stop=shP + stopBuf * atr, limit=high - tgtX * leg)
    used := true

if hour == 15 and minute >= 15
    strategy.close_all(comment="Day end")
`
},
{
  name: "Claude B - Scorecard",
  code: `//@version=5
// Multi-factor scorecard (NIFTY 15m). Six normalised factors in [-1,1]: linreg slope/ATR, signed efficiency ratio,
// distance from session mean, range position, 3-bar swing-structure bias (HH/HL vs LH/LL), day return. Equal weights
// (per-factor bucket analysis showed all six are momentum-sign with similar spread). Trade only at score extremes
// (|score|>=thr), only when ATR is >= volMin of its 200-bar average. Exit: score fades through 0, ATR stop, or day end.
strategy("Scorecard", overlay=true, initial_capital=500000, default_qty_value=75)
L = input.int(24, "Factor lookback")
thr = input.float(0.6, "Entry score threshold", step=0.05)
exitThr = input.float(0, "Exit when score fades to", step=0.05)
stopM = input.float(3, "Stop (ATR mult)", step=0.1)
tgtM = input.float(0, "Target (ATR mult, 0=off)", step=0.1)
trailM = input.float(0, "Trail (ATR mult, 0=off)", step=0.1)
volMin = input.float(0.75, "Min ATR vs 200-bar avg", step=0.05)
w1 = input.float(1, "w slope")
w2 = input.float(1, "w efficiency")
w3 = input.float(1, "w dist session mean")
w4 = input.float(1, "w range pos")
w5 = input.float(1, "w swing")
w6 = input.float(1, "w day return")
a = ta.atr(14)
f(x) => math.max(-1.0, math.min(1.0, x))
// 1 trend slope z (linreg slope scaled by ATR)
slope = (ta.linreg(close, L, 0) - ta.linreg(close, L, 1)) * L / a
f1v = f(slope / 1.5)
// 2 efficiency ratio signed
path = math.sum(math.abs(ta.change(close)), L)
er = path > 0 ? (close - close[L]) / path : 0.0
f2 = f(er * 2.0)
// 3 distance from session mean
newDay = ta.change(dayofmonth) != 0
var float sm = 0.0
var float cn = 0.0
var float dOpen = 0.0
if newDay
    sm := 0.0
    cn := 0.0
    dOpen := open
sm += (high + low + close) / 3
cn += 1
f3 = f((close - sm / cn) / a / 2.0)
// 4 range position
hh = ta.highest(high, L + 10)
ll = ta.lowest(low, L + 10)
f4 = f(((close - ll) / math.max(hh - ll, 0.0001) - 0.5) * 2.0)
// 5 swing structure bias (confirmed 3-bar pivots)
ph = ta.pivothigh(high, 3, 3)
pl = ta.pivotlow(low, 3, 3)
var float ph1 = na
var float ph2 = na
var float pl1 = na
var float pl2 = na
if not na(ph)
    ph2 := ph1
    ph1 := ph
if not na(pl)
    pl2 := pl1
    pl1 := pl
f5 = (na(ph2) or na(pl2)) ? 0.0 : (math.sign(ph1 - ph2) + math.sign(pl1 - pl2)) / 2.0
// 6 day return so far
f6 = f((close - dOpen) / a / 3.0)
wsum = w1 + w2 + w3 + w4 + w5 + w6
score = (w1 * f1v + w2 * f2 + w3 * f3 + w4 * f4 + w5 * f5 + w6 * f6) / wsum
// volatility percentile gate
atrPct = a / ta.sma(a, 200)
volOk = volMin <= 0 or atrPct >= volMin
inWin = (hour > 10 or (hour == 10 and minute >= 30)) and (hour < 14 or (hour == 14 and minute < 45))
dayEnd = hour == 15 and minute >= 10
flat = strategy.position_size == 0
if flat and inWin and volOk and score >= thr 
    strategy.entry("Long", strategy.long)
if flat and inWin and volOk and score <= -thr 
    strategy.entry("Short", strategy.short)
if strategy.position_size > 0
    if score < exitThr
        strategy.close("Long", comment="fade")
if strategy.position_size < 0
    if score > -exitThr
        strategy.close("Short", comment="fade")
ep = strategy.opentrades.entry_price(0)
if strategy.position_size > 0
    strategy.exit("xL", "Long", stop=ep - stopM * a)
if strategy.position_size < 0
    strategy.exit("xS", "Short", stop=ep + stopM * a)
if dayEnd
    strategy.close_all(comment="Day end")
`
},
{
  name: "Claude C - VolRegime Expansion Breakout 15m",
  code: `//@version=5
// VolRegime Squeeze-Expansion Breakout (15m NIFTY)
// Idea: structural trigger = close-strong expansion bar that breaks the prior swN-bar swing high/low,
// taken only in the direction of a slow EMA trend. Exits are volatility-scaled (ATR): initial stop,
// early break-even + small profit lock (lifts win rate), then a Chandelier-style ATR trail from the
// bar extreme, a time stop and a hard EOD square-off. ATR percentile rank is computed and can gate regime.
strategy("VolRegime Expansion Breakout 15m", overlay=true, initial_capital=500000, default_qty_value=75)
swN   = input.int(18, "Swing lookback (bars)", minval=3)
trendL= input.int(80, "Trend EMA length", minval=2)
slA   = input.float(1.5, "Initial stop (ATR x)", step=0.1)
tpA   = input.float(3.0, "Target (ATR x)", step=0.1)
beA   = input.float(0.6, "Break-even trigger (ATR x)", step=0.1)
lkA   = input.float(0.2, "Profit lock after trigger (ATR x)", step=0.05)
trA   = input.float(2.0, "Chandelier trail (ATR x)", step=0.1)
maxB  = input.int(30, "Max bars in trade")
pctL  = input.int(100, "ATR percentile window")
pLo   = input.float(0.0, "Min ATR rank (regime gate)", step=0.05)
pHi   = input.float(1.0, "Max ATR rank (regime gate)", step=0.05)
a = ta.atr(14)
cnt = 0.0
for i = 1 to pctL
    cnt := cnt + (a[i] < a ? 1.0 : 0.0)
rank = cnt / pctL
inReg = rank >= pLo and rank <= pHi
tmin = hour*60 + minute
canTrade = tmin >= 600 and tmin <= 870
hiS = ta.highest(high[1], swN)
loS = ta.lowest(low[1], swN)
rng = math.max(high - low, syminfo.mintick)
cpos = (close - low) / rng
emaT = ta.ema(close, trendL)
longSig  = close > hiS and cpos > 0.7 and inReg and canTrade and close > emaT
shortSig = close < loS and cpos < 0.3 and inReg and canTrade and close < emaT
var float stp = na
var float tgt = na
var int eb = 0
var float ea = 0.0
if strategy.position_size == 0
    if longSig
        strategy.entry("L", strategy.long)
        ea := a
        eb := bar_index
        stp := close - slA*a
        tgt := close + tpA*a
    else if shortSig
        strategy.entry("S", strategy.short)
        ea := a
        eb := bar_index
        stp := close + slA*a
        tgt := close - tpA*a
if strategy.position_size > 0
    ep = strategy.opentrades.entry_price(0)
    if high >= ep + beA*ea
        stp := math.max(stp, ep + lkA*ea)
        stp := math.max(stp, high - trA*ea)
    strategy.exit("xL", "L", stop=stp, limit=tgt)
    if bar_index - eb >= maxB
        strategy.close("L", comment="time")
if strategy.position_size < 0
    ep = strategy.opentrades.entry_price(0)
    if low <= ep - beA*ea
        stp := math.min(stp, ep - lkA*ea)
        stp := math.min(stp, low + trA*ea)
    strategy.exit("xS", "S", stop=stp, limit=tgt)
    if bar_index - eb >= maxB
        strategy.close("S", comment="time")
if hour == 15 and minute >= 15
    strategy.close_all(comment="EOD")
`
},
{
  name: "Claude D - C2 Drift 5m tuned",
  code: `//@version=5
strategy("C2 Drift 5m tuned", overlay=true, initial_capital=500000, default_qty_value=75, default_qty_type=strategy.fixed, pyramiding=0)
// ===== Inputs =====
biasMin   = input.float(0.5, "Min open bias (ATRd)")
pbAtr     = input.float(1.5, "Pullback depth (ATR5)")
erMin     = input.float(0.15, "Min efficiency ratio")
slAtr     = input.float(3.0, "Stop ATR5 mult")
tpAtr     = input.float(10.0, "Target ATR5 mult")
lateDir   = input.float(0.0, "Late drift min day move (ATRd)")
useLate   = input.bool(true, "Late drift on")
lateStart = input.int(720, "Late window start (min)")
lateEnd   = input.int(870, "Late window end (min)")
exitT     = input.int(910, "Time exit (min)")
skipDow   = input.int(4, "Skip weekday (1=Sun..7)")
mornEnd   = input.int(720, "Morning window end (min)")
adxMin    = input.float(18.0, "ADX min")
useADX    = input.bool(false, "Confirm: ADX/DMI")
useST     = input.bool(true, "Confirm: Supertrend")
useMACD   = input.bool(false, "Confirm: MACD hist")
useLR     = input.bool(false, "Confirm: linreg slope")
useKC     = input.bool(false, "Confirm: Keltner side")
useRSI    = input.bool(false, "Confirm: RSI side")
useER     = input.bool(true, "Confirm: efficiency ratio (morning)")
mornExit  = input.int(765, "Morning trade time stop (min)")
useMorn   = input.bool(true, "Morning pullback on")
skipMorn  = input.bool(true, "Wed skip also morning")
skipDow2  = input.int(0, "Second skip weekday (0=none)")
beAtr     = input.float(2.25, "Break-even trigger ATR5 (0=off)")
beLock    = input.float(0.5, "Break-even lock ATR5")
slLate    = input.float(0.0, "Late stop ATR5 (0=same)")
tpLate    = input.float(0.0, "Late target ATR5 (0=same)")
volMin    = input.float(0.0, "Min ATRd / ATRd-slow ratio (0=off)")
volMax    = input.float(0.0, "Max ATRd / ATRd-slow ratio (0=off)")
stK       = input.float(3.0, "Supertrend factor")
maxBiasA  = input.float(0.0, "Max |bias| (0=off)")

// ===== LAYER 1: CONTEXT / REGIME =====
// in-script daily bars: previous close, day range ATR (EMA 14 of daily range), day open/high/low
var float prevC = na
var float dOpen = na
var float dHigh = na
var float dLow  = na
var float atrD  = na
var float atrS  = na
var float cumM  = 0.0
var int   nB    = 0
var float dayBias = 0.0
newDay = dayofmonth != dayofmonth[1] or month != month[1]
if newDay
    if not na(dHigh)
        r = dHigh - dLow
        atrD := na(atrD) ? r : atrD + (r - atrD) / 14.0
        atrS := na(atrS) ? r : atrS + (r - atrS) / 60.0
        prevC := close[1]
    dOpen := open
    dHigh := high
    dLow := low
    cumM := 0.0
    nB := 0
dHigh := math.max(dHigh, high)
dLow  := math.min(dLow, low)
nB += 1
cumM += hlc3
sessMean = cumM / nB
tod = hour * 60 + minute
if tod == 9 * 60 + 40
    dayBias := (not na(prevC) and not na(atrD)) ? (close - prevC) / atrD : 0.0
atr5 = ta.atr(14)
// higher-timeframe slope emulation: 36-bar (3h) EMA slope and 78-bar (day) efficiency ratio
ema36 = ta.ema(close, 36)
slope = ema36 - ema36[12]
er = math.abs(close - close[24]) / math.max(ta.cum(math.abs(ta.change(close))) - nz(ta.cum(math.abs(ta.change(close)))[24]), 0.0001)
bias = dayBias
volR = na(atrS) ? 1.0 : atrD / atrS
volOk = (volMin == 0 or volR >= volMin) and (volMax == 0 or volR <= volMax) and (maxBiasA == 0 or math.abs(bias) <= maxBiasA)
biasDir = not volOk ? 0 : bias > biasMin ? 1 : bias < -biasMin ? -1 : 0

// ===== LAYER 2: LOCATION / STRUCTURE =====
// morning: price has pulled back toward session mean / by pbAtr from the trend extreme
var float exHi = na
var float exLo = na
if newDay
    exHi := high
    exLo := low
exHi := math.max(exHi, high)
exLo := math.min(exLo, low)
pbLong  = (exHi - low) >= pbAtr * atr5 or low <= sessMean
pbShort = (high - exLo) >= pbAtr * atr5 or high >= sessMean
var bool pbL = false
var bool pbS = false
if newDay
    pbL := false
    pbS := false
if pbLong and biasDir == 1
    pbL := true
if pbShort and biasDir == -1
    pbS := true
// late: day position (close in outer part of the day range)
rngD = math.max(dHigh - dLow, 0.0001)
posD = (close - dLow) / rngD
dayMove = (close - nz(prevC, dOpen)) / nz(atrD, 1)

// ===== LAYER 3: TRIGGER =====
// morning: pullback-and-resume (close takes out prior bar high/low after pullback flagged)
mornWin = tod >= 9 * 60 + 50 and tod <= mornEnd and not (skipMorn and dayofweek == skipDow) and dayofweek != skipDow2
resumeL = pbL and close > high[1] and close > open
resumeS = pbS and close < low[1] and close < open
// late: first qualifying bar in 13:30-14:00 in direction of the day
lateWin = tod >= lateStart and tod <= lateEnd and dayofweek != skipDow and dayofweek != skipDow2 and volOk
lateL = dayMove > lateDir and posD > 0.6
lateS = dayMove < -lateDir and posD < 0.4

// ===== LAYER 4: CONFIRMATION / FILTER =====
[dip, dim, adxv] = ta.dmi(14, 14)
[stl, stdir] = ta.supertrend(stK, 10)
[mc, ms, mh] = ta.macd(close, 12, 26, 9)
lrs = ta.linreg(close, 30, 0) - ta.linreg(close, 30, 1)
[kcm, kcu, kcl] = ta.kc(close, 20, 1.5)
rsi14 = ta.rsi(close, 14)
bullInd = (not useADX or (adxv > adxMin and dip > dim)) and (not useST or stdir < 0) and (not useMACD or mh > 0) and (not useLR or lrs > 0) and (not useKC or close > kcm) and (not useRSI or rsi14 > 50)
bearInd = (not useADX or (adxv > adxMin and dim > dip)) and (not useST or stdir > 0) and (not useMACD or mh < 0) and (not useLR or lrs < 0) and (not useKC or close < kcm) and (not useRSI or rsi14 < 50)
confL = slope > 0 and (not useER or er > erMin) and close > sessMean and bullInd
confS = slope < 0 and (not useER or er > erMin) and close < sessMean and bearInd
lateConfL = slope > 0 and close > sessMean and bullInd
lateConfS = slope < 0 and close < sessMean and bearInd
var int tradedM = 0
var int tradedL = 0
if newDay
    tradedM := 0
    tradedL := 0
flat = strategy.position_size == 0
entL = false
entS = false
if useMorn and flat and tradedM < 1 and mornWin and resumeL and confL and biasDir == 1
    entL := true
    tradedM += 1
if useMorn and flat and tradedM < 1 and mornWin and resumeS and confS and biasDir == -1
    entS := true
    tradedM += 1
if useLate and flat and tradedL < 1 and lateWin and lateL and lateConfL
    entL := true
    tradedL += 1
if useLate and flat and tradedL < 1 and lateWin and lateS and lateConfS
    entS := true
    tradedL += 1
if entL
    strategy.entry("L", strategy.long)
if entS
    strategy.entry("S", strategy.short)

// ===== LAYER 5: EXIT =====
// ATR stop + ATR target, time stop at 15:10 (late) / 13:30 (morning trades), day end 15:15
var float stopD = na
var bool lateTr = false
if entL or entS
    stopD := atr5
    lateTr := lateWin
sM = (lateTr and slLate > 0) ? slLate : slAtr
tM = (lateTr and tpLate > 0) ? tpLate : tpAtr
var float stopL = na
var float stopS = na
if entL or entS
    stopL := na
    stopS := na
if strategy.position_size > 0
    if na(stopL)
        stopL := strategy.position_avg_price - sM * stopD
    if beAtr > 0 and high >= strategy.position_avg_price + beAtr * stopD
        stopL := math.max(stopL, strategy.position_avg_price + beLock * stopD)
    strategy.exit("xL", "L", stop=stopL, limit=strategy.position_avg_price + tM * stopD)
if strategy.position_size < 0
    if na(stopS)
        stopS := strategy.position_avg_price + sM * stopD
    if beAtr > 0 and low <= strategy.position_avg_price - beAtr * stopD
        stopS := math.min(stopS, strategy.position_avg_price - beLock * stopD)
    strategy.exit("xS", "S", stop=stopS, limit=strategy.position_avg_price - tM * stopD)
var bool mornPos = false
if entL or entS
    mornPos := mornWin and not lateWin
if strategy.position_size == 0
    mornPos := false
if mornPos and tod >= mornExit
    strategy.close_all("MT")
if tod >= exitT
    strategy.close_all("EOD")
`
},
{
  name: "Gemini A - TX 15m S1: Dual-Pullback Trend & ATR Regime",
  code: `//@version=5
// =============================================================================
// TradeX Strategy 1: NIFTY 50 (15-Minute Timeframe)
// Dual-Pullback Trend & ATR Volatility Regime ("TX 15m S1")
// Backtest: 562 Trades | 71.35% Win Rate | 2.17 Profit Factor | +15,483.25 Points
// =============================================================================
strategy("TX 15m S1: Dual-Pullback Trend & ATR Regime", overlay=true, initial_capital=500000, default_qty_value=75)

// --- Inputs ---
stFactor   = input.float(3.1, "Supertrend Factor", step=0.1)
stLen      = input.int(11, "Supertrend ATR Length", minval=1)
emaFastLen = input.int(14, "Fast Pullback EMA", minval=1)
emaMidLen  = input.int(25, "Mid Value EMA", minval=1)
emaSlowLen = input.int(55, "Macro Trend EMA", minval=1)
adxTrigger = input.int(22, "Pullback ADX Threshold", minval=1)
atrMult    = input.float(1.05, "Mid-Day ATR Expansion Mult", step=0.05)
t1Pts      = input.float(32.0, "Ratchet Tier 1 Trigger (pts)")
o1Pts      = input.float(6.0, "Ratchet Tier 1 Lock (pts)")
t2Pts      = input.float(75.0, "Ratchet Tier 2 Trigger (pts)")
o2Pts      = input.float(32.0, "Ratchet Tier 2 Lock (pts)")

// --- Indicators ---
[st, dir]  = ta.supertrend(stFactor, stLen)
emaFast    = ta.ema(close, emaFastLen)
emaMid     = ta.ema(close, emaMidLen)
emaSlow    = ta.ema(close, emaSlowLen)
vwapVal    = ta.vwap(hlc3)
rsi14      = ta.rsi(close, 14)
[dp, dm, adx] = ta.dmi(14, 14)
atr        = ta.atr(14)
atrAvg     = ta.sma(atr, 20)

plot(st, "Supertrend", color = dir < 0 ? color.teal : color.red, linewidth=2)
plot(emaFast, "Fast EMA", color=color.orange)
plot(emaSlow, "Macro EMA", color=color.blue)
plot(vwapVal, "VWAP", color=color.purple)

// --- Session & Volatility Regime ---
mins       = hour * 60 + minute
dayEnd     = hour == 15 and minute >= 15
midDay     = mins >= 690 and mins <= 765
volOk      = not midDay or atr > atrAvg * atrMult

newDay     = ta.change(dayofmonth) != 0
var int pbCount = 0
if newDay
    pbCount := 0

entryWindow = mins < 900 and volOk
pbWindow    = mins >= 570 and mins <= 840 and volOk

// --- Layer 1: Primary Trend Regime Flips ---
flipL = ta.change(dir) < 0 and entryWindow
flipS = ta.change(dir) > 0 and entryWindow and rsi14 < 47

// --- Layer 2: Dual Mean-Reversion Pullback in Trend ---
pbL1 = dir < 0 and close > emaSlow and low <= emaFast and close > emaFast and close > open and close > high[1] and adx > adxTrigger
pbL2 = dir < 0 and close > emaSlow and close > vwapVal and low <= emaMid and close > emaMid and close > open and adx > 20
pbS1 = dir > 0 and close < emaSlow and high >= emaFast and close < emaFast and close < open and close < low[1] and adx > adxTrigger
pbS2 = dir > 0 and close < emaSlow and close < vwapVal and high >= emaMid and close < emaMid and close < open and adx > 20

pbL = strategy.position_size == 0 and not flipL and pbWindow and pbCount < 1 and (pbL1 or pbL2)
pbS = strategy.position_size == 0 and not flipS and pbWindow and pbCount < 1 and (pbS1 or pbS2)

if flipL
    strategy.entry("Long", strategy.long, comment="Trend Long")
else if pbL
    strategy.entry("Long", strategy.long, comment="PB Long")
    pbCount += 1

if flipS
    strategy.entry("Short", strategy.short, comment="Trend Short")
else if pbS
    strategy.entry("Short", strategy.short, comment="PB Short")
    pbCount += 1

// --- Layer 3: Multi-Stage Profit Floor Ratchet & Asymmetric EOD ---
var float maxFav = 0.0
var int prevPos  = 0
if strategy.position_size == 0 or strategy.position_size != prevPos
    maxFav := 0.0
prevPos := strategy.position_size

if strategy.position_size > 0
    ep = strategy.position_avg_price
    maxFav := math.max(maxFav, high - ep)
    float stopPx = maxFav >= t2Pts ? ep + o2Pts : maxFav >= t1Pts ? ep + o1Pts : na
    if not na(stopPx)
        strategy.exit("XL", "Long", stop=stopPx)

if strategy.position_size < 0
    ep = strategy.position_avg_price
    maxFav := math.max(maxFav, ep - low)
    float stopPx = maxFav >= t2Pts ? ep - o2Pts : maxFav >= t1Pts ? ep - o1Pts : na
    if not na(stopPx)
        strategy.exit("XS", "Short", stop=stopPx)

if dayEnd
    if strategy.position_size < 0 and strategy.openprofit < -3000
        strategy.close_all(comment="EOD S Cut", immediately=true)
    else
        strategy.close_all(comment="Day end")`
},
{
  name: "Gemini B - TX 15m S2: DMI-Confirmed Trend & EMA Reclaim",
  code: `//@version=5
// =============================================================================
// TradeX Strategy 2: NIFTY 50 (15-Minute Timeframe)
// DMI-Confirmed Trend & EMA Reclaim ("TX 15m S2")
// Backtest: 460 Trades | 73.04% Win Rate | 2.39 Profit Factor | +14,323.10 Points
// =============================================================================
strategy("TX 15m S2: DMI-Confirmed Trend & EMA Reclaim", overlay=true, initial_capital=500000, default_qty_value=75)

// --- Inputs ---
stFactor   = input.float(3.1, "Supertrend Factor", step=0.1)
stLen      = input.int(11, "Supertrend ATR Length", minval=1)
emaFastLen = input.int(14, "Pullback EMA Length", minval=1)
emaSlowLen = input.int(55, "Macro Trend EMA Length", minval=1)
adxMin     = input.int(22, "Pullback ADX Minimum", minval=1)
rsiShortMx = input.int(47, "Short RSI Ceiling", minval=1)
t1Pts      = input.float(32.0, "Ratchet Tier 1 Trigger (pts)")
o1Pts      = input.float(6.0, "Ratchet Tier 1 Lock (pts)")
t2Pts      = input.float(75.0, "Ratchet Tier 2 Trigger (pts)")
o2Pts      = input.float(32.0, "Ratchet Tier 2 Lock (pts)")

// --- Indicators ---
[st, dir]  = ta.supertrend(stFactor, stLen)
emaFast    = ta.ema(close, emaFastLen)
emaSlow    = ta.ema(close, emaSlowLen)
rsi14      = ta.rsi(close, 14)
[dp, dm, adx] = ta.dmi(14, 14)

plot(st, "Supertrend", color = dir < 0 ? color.teal : color.red, linewidth=2)
plot(emaFast, "Pullback EMA", color=color.orange)
plot(emaSlow, "Macro EMA", color=color.blue)

// --- Session & Chop Lull Filter ---
mins       = hour * 60 + minute
dayEnd     = hour == 15 and minute >= 15
midDay     = mins >= 690 and mins <= 765

newDay     = ta.change(dayofmonth) != 0
var int pbCount = 0
if newDay
    pbCount := 0

entryWindow = mins < 900 and not midDay
pbWindow    = mins >= 570 and mins <= 840 and not midDay

// --- Layer 1: DMI & RSI Confirmed Trend Flips ---
flipL = ta.change(dir) < 0 and entryWindow and (dp > dm or close > emaSlow)
flipS = ta.change(dir) > 0 and entryWindow and dm > dp and rsi14 < rsiShortMx

// --- Layer 2: Mean-Reversion Pullback & Breakout-Reclaim ---
pbL = strategy.position_size == 0 and not flipL and pbWindow and pbCount < 1 and dir < 0 and close > emaSlow and low <= emaFast and close > emaFast and close > open and close > high[1] and adx > adxMin
pbS = strategy.position_size == 0 and not flipS and pbWindow and pbCount < 1 and dir > 0 and close < emaSlow and high >= emaFast and close < emaFast and close < open and close < low[1] and adx > adxMin

if flipL
    strategy.entry("Long", strategy.long, comment="Trend Long")
else if pbL
    strategy.entry("Long", strategy.long, comment="PB Long")
    pbCount += 1

if flipS
    strategy.entry("Short", strategy.short, comment="Trend Short")
else if pbS
    strategy.entry("Short", strategy.short, comment="PB Short")
    pbCount += 1

// --- Layer 3: Multi-Stage Profit Floor Ratchet & Asymmetric EOD ---
var float maxFav = 0.0
var int prevPos  = 0
if strategy.position_size == 0 or strategy.position_size != prevPos
    maxFav := 0.0
prevPos := strategy.position_size

if strategy.position_size > 0
    ep = strategy.position_avg_price
    maxFav := math.max(maxFav, high - ep)
    float stopPx = maxFav >= t2Pts ? ep + o2Pts : maxFav >= t1Pts ? ep + o1Pts : na
    if not na(stopPx)
        strategy.exit("XL", "Long", stop=stopPx)

if strategy.position_size < 0
    ep = strategy.position_avg_price
    maxFav := math.max(maxFav, ep - low)
    float stopPx = maxFav >= t2Pts ? ep - o2Pts : maxFav >= t1Pts ? ep - o1Pts : na
    if not na(stopPx)
        strategy.exit("XS", "Short", stop=stopPx)

if dayEnd
    if strategy.position_size < 0 and strategy.openprofit < -3000
        strategy.close_all(comment="EOD S Cut", immediately=true)
    else
        strategy.close_all(comment="Day end")`
},
{
  name: "Gemini C - TX 5m S3: Hybrid Regime-Adaptive Alpha",
  code: `//@version=5
// =============================================================================
// TradeX Strategy 3: NIFTY 50 (5-Minute Timeframe)
// Hybrid Regime-Adaptive Alpha ("TX 5m S3")
// Backtest: 637 Trades | 76.30% Win Rate | 2.25 Profit Factor | +8,077.52 Points
// =============================================================================
strategy("TX 5m S3: Hybrid Regime-Adaptive Alpha", overlay=true, initial_capital=500000, default_qty_value=75)

// --- Inputs ---
enableBTST = input.bool(true, "Enable Institutional Overnight Carry (BTST)")
tightBull  = input.bool(false, "Use Tight BBW Filter on Bull OR")
tpMult     = input.float(1.2, "Profit Target (ATR Multiple)", step=0.1)
slMult     = input.float(2.0, "Stop Loss (ATR Multiple)", step=0.1)
maxBars    = input.int(8, "Max Intraday Hold (Bars)", minval=2)
snapRsi    = input.int(36, "Snap-Back Exit RSI2 Threshold", minval=15, maxval=45)
snapAtr    = input.float(0.20, "Minimum Snap-Back Profit (ATR)", step=0.05)

// --- Session & Intraday Structural State ---
newDay = ta.change(dayofmonth) != 0
var float prevClose = na
var float dayOpen   = na
var float gapPct    = 0.0
var float orH15     = na
var float orL15     = na
var float orH30     = na
var float orL30     = na
var float dayH      = na
var float dayL      = na
var int   entryBar  = -1

if newDay
    prevClose := close[1]
    dayOpen   := open
    gapPct    := na(prevClose) ? 0.0 : (open - prevClose) / prevClose * 100.0
    orH15     := high
    orL15     := low
    orH30     := high
    orL30     := low
    dayH      := high
    dayL      := low
else
    dayH := math.max(dayH, high)
    dayL := math.min(dayL, low)

// 1. Exit Overnight Institutional Carry at Morning Open
if newDay and strategy.position_size != 0
    strategy.close_all(comment="BTST Open Exit")

mins = (hour - 9) * 60 + minute - 15
if mins < 15
    orH15 := math.max(orH15, high)
    orL15 := math.min(orL15, low)
if mins < 30
    orH30 := math.max(orH30, high)
    orL30 := math.min(orL30, low)

// --- Indicators ---
rsi2            = ta.rsi(close, 2)
hma20           = ta.hma(close, 20)
hma50           = ta.hma(close, 50)
ema50           = ta.ema(close, 50)
ema200          = ta.ema(close, 200)
vwapVal         = ta.vwap(hlc3)
atr14           = ta.atr(14)
bbw             = ta.bbw(close, 20, 2.0)
[dip, dim, adx] = ta.dmi(14, 14)
dayPos          = (close - dayL) / math.max(dayH - dayL, 1.0)

plot(vwapVal, "VWAP", color=color.orange, linewidth=2)
plot(hma20, "HMA 20", color=color.teal)
plot(hma50, "HMA 50", color=color.blue)
plot(mins >= 30 ? orH30 : na, "OR30 High", color=color.green, style=plot.style_linebr)
plot(mins >= 30 ? orL30 : na, "OR30 Low", color=color.red, style=plot.style_linebr)

inWin = mins >= 5 and mins <= 330
flat  = strategy.position_size == 0

// --- Short Regimes ---
s_gap  = mins <= 135 and gapPct > 0.12 and gapPct < 0.55 and close < vwapVal and rsi2 > 85
s_mid  = mins >= 60 and mins <= 270 and close < vwapVal and close < dayOpen and hma50 < hma50[1] and rsi2 > 92
s_bear = close < vwapVal and close < dayOpen and close < ema50 and hma50 < hma50[1] and adx > 22 and dim > dip and rsi2 > 90
s_tue  = dayofweek == 3 and mins >= 30 and close < orL30 and close < vwapVal and close < dayOpen and hma20 < hma20[1] and rsi2 > 86

// --- Long Regimes ---
notTue = dayofweek != 3
l_gap  = mins >= 15 and mins <= 120 and gapPct < -0.38 and close > orL15 and close > vwapVal and hma20 > hma20[1] and rsi2 < 14
l_pm   = notTue and mins >= 240 and mins <= 330 and close > dayOpen + atr14 and close > vwapVal and dayPos > 0.68 and hma20 > hma20[1] and rsi2 < 18
l_bull = notTue and mins >= 30 and mins <= 210 and close > orH30 and close > ema200 and close > vwapVal and hma50 > hma50[1] and (tightBull ? bbw < 0.45 : low <= hma20) and rsi2 < 10

if inWin and flat
    if s_gap
        strategy.entry("S_GapFade", strategy.short)
        entryBar := bar_index
    else if s_mid
        strategy.entry("S_MidMR", strategy.short)
        entryBar := bar_index
    else if s_bear
        strategy.entry("S_BearTrend", strategy.short)
        entryBar := bar_index
    else if s_tue
        strategy.entry("S_TueBear", strategy.short)
        entryBar := bar_index
    else if l_gap
        strategy.entry("L_GapRev", strategy.long)
        entryBar := bar_index
    else if l_pm
        strategy.entry("L_PMCont", strategy.long)
        entryBar := bar_index
    else if l_bull
        strategy.entry("L_BullOR", strategy.long)
        entryBar := bar_index

// --- Dynamic Snap-Back & Time-Stop Exit ---
barsHeld = bar_index - entryBar
avgPx    = strategy.position_avg_price

if mins >= 5 and mins < 360
    if strategy.position_size < 0 and ((rsi2 < snapRsi and close < avgPx - atr14 * snapAtr) or barsHeld >= maxBars)
        strategy.close_all(comment="Snap/Time")
    if strategy.position_size > 0 and ((rsi2 > (100 - snapRsi) and close > avgPx + atr14 * snapAtr) or barsHeld >= maxBars)
        strategy.close_all(comment="Snap/Time")

strategy.exit("X_All", profit = atr14 * tpMult / syminfo.mintick, loss = atr14 * slMult / syminfo.mintick)

// --- Intraday Square-Off at 15:15 ---
if hour == 15 and minute == 15
    strategy.close_all(comment="EOD")

// --- Institutional Overnight Carry (BTST 15:20 -> 09:20) ---
if enableBTST and hour == 15 and minute == 20 and strategy.position_size == 0
    if close > dayOpen and dayPos > 0.68 and dayofweek != 6 and dayofweek != 4
        strategy.entry("BTST_Carry", strategy.long)
        entryBar := bar_index`
}
];
if (typeof module !== 'undefined' && module.exports) module.exports = SAMPLES; else root.TX_SAMPLES = SAMPLES;
})(typeof self !== 'undefined' ? self : this);
