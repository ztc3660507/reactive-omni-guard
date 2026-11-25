import React, { useEffect, useMemo, useState } from "react";
import { ethers } from "ethers";
import {
  Activity,
  ArrowRight,
  CheckCircle2,
  ExternalLink,
  Flame,
  Gauge,
  Layers,
  Lock,
  RefreshCw,
  Shield,
  TrendingDown,
  TrendingUp,
  Wallet,
  Zap,
} from "lucide-react";
import deployments from "./deployments.json";
import liveProof from "./live-proof.json";
import { POOL_ABI, REACTIVE_ABI, TOKEN_ABI, VAULT_ABI } from "./abis";

const REASON_LABELS = {
  0: "None",
  1: "Trailing Stop-Loss",
  2: "Take-Profit",
  3: "Flash-Crash Breaker",
};

const STATUS_LABELS = {
  0: "None",
  1: "Armed",
  2: "Executed",
  3: "Disarmed",
};

function shortAddr(addr) {
  if (!addr) return "Pending Deploy";
  return `${addr.slice(0, 6)}...${addr.slice(-4)}`;
}

function fmtUsd(n) {
  if (n == null || Number.isNaN(Number(n))) return "$0.00";
  return `$${Number(n).toLocaleString("en-US", {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function PriceChart({ history, hwm, trailingStop, takeProfit, triggerPoint }) {
  const width = 760;
  const height = 250;
  const pad = { top: 22, right: 64, bottom: 26, left: 56 };

  const allVals = [
    ...history.map((h) => h.price),
    ...(hwm ? [hwm] : []),
    ...(trailingStop ? [trailingStop] : []),
    ...(takeProfit ? [takeProfit] : []),
  ];
  const minV = Math.min(...allVals) * 0.96;
  const maxV = Math.max(...allVals) * 1.04;
  const span = Math.max(maxV - minV, 50);

  const xOf = (i) =>
    pad.left + (i / Math.max(history.length - 1, 1)) * (width - pad.left - pad.right);
  const yOf = (v) => pad.top + ((maxV - v) / span) * (height - pad.top - pad.bottom);

  const pricePath = history
    .map((pt, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(1)} ${yOf(pt.price).toFixed(1)}`)
    .join(" ");

  const hwmPath = history
    .map((pt, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(1)} ${yOf(pt.hwm).toFixed(1)}`)
    .join(" ");

  const stopPath = history
    .map((pt, i) => `${i === 0 ? "M" : "L"} ${xOf(i).toFixed(1)} ${yOf(pt.stop).toFixed(1)}`)
    .join(" ");

  const yTicks = [0, 0.25, 0.5, 0.75, 1].map((t) => minV + t * span);

  return (
    <svg viewBox={`0 0 ${width} ${height}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <defs>
        <linearGradient id="priceFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#38bdf8" stopOpacity="0.28" />
          <stop offset="100%" stopColor="#38bdf8" stopOpacity="0.0" />
        </linearGradient>
      </defs>

      {yTicks.map((v, idx) => (
        <g key={idx}>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={yOf(v)}
            y2={yOf(v)}
            stroke="rgba(148,163,184,0.12)"
            strokeDasharray="3 4"
          />
          <text
            x={pad.left - 8}
            y={yOf(v) + 4}
            textAnchor="end"
            fill="#64748b"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            ${Math.round(v)}
          </text>
        </g>
      ))}

      {takeProfit > 0 && takeProfit <= maxV && (
        <g>
          <line
            x1={pad.left}
            x2={width - pad.right}
            y1={yOf(takeProfit)}
            y2={yOf(takeProfit)}
            stroke="#34d399"
            strokeWidth="1.5"
            strokeDasharray="5 5"
          />
          <text
            x={width - pad.right + 6}
            y={yOf(takeProfit) + 4}
            fill="#34d399"
            fontSize="10"
            fontFamily="JetBrains Mono, monospace"
          >
            TP ${takeProfit}
          </text>
        </g>
      )}

      {history.length > 1 && (
        <path
          d={`${pricePath} L ${xOf(history.length - 1).toFixed(1)} ${height - pad.bottom} L ${pad.left} ${
            height - pad.bottom
          } Z`}
          fill="url(#priceFill)"
        />
      )}

      <path d={hwmPath} fill="none" stroke="#a78bfa" strokeWidth="1.6" strokeDasharray="4 3" />
      <path d={stopPath} fill="none" stroke="#fbbf24" strokeWidth="2" strokeDasharray="6 4" />
      <path d={pricePath} fill="none" stroke="#38bdf8" strokeWidth="2.8" strokeLinejoin="round" />

      {history.map((pt, i) => (
        <circle
          key={i}
          cx={xOf(i)}
          cy={yOf(pt.price)}
          r={triggerPoint === i ? 6 : 3.2}
          fill={triggerPoint === i ? "#fb7185" : "#38bdf8"}
          stroke="#060913"
          strokeWidth="1.5"
        />
      ))}

      {history.length > 0 && (
        <text
          x={width - pad.right + 6}
          y={yOf(history[history.length - 1].stop) + 4}
          fill="#fbbf24"
          fontSize="10"
          fontFamily="JetBrains Mono, monospace"
        >
          STOP ${Math.round(history[history.length - 1].stop)}
        </text>
      )}
    </svg>
  );
}

export default function App() {
  const isLiveDeployed = Boolean(
    deployments?.contracts?.omniGuardVault && deployments?.contracts?.omniGuardReactive
  );

  const [mode, setMode] = useState(isLiveDeployed ? "live" : "sim");
  const [walletAddr, setWalletAddr] = useState(null);
  const [loading, setLoading] = useState(false);
  const [statusMsg, setStatusMsg] = useState("");

  // Live chain state
  const [liveData, setLiveData] = useState({
    spotPrice: 3000,
    ewmaPrice: 3000,
    epoch: 0,
    activeGuards: 0,
    ticksProcessed: 0,
    callbacksRequested: 0,
    callbacksConfirmed: 0,
    protectedUsdc: 0,
    vaultEth: "0",
    reactiveBal: "0",
    vaultDebt: "0",
    reactiveDebt: "0",
    positions: [],
  });

  // Interactive simulator state (works out-of-the-box even offline)
  const [simPrice, setSimPrice] = useState(3000);
  const [simHwm, setSimHwm] = useState(3000);
  const [simTrailingPct, setSimTrailingPct] = useState(5);
  const [simTpPrice, setSimTpPrice] = useState(4200);
  const [simCrashPct, setSimCrashPct] = useState(10);
  const [simCollateral, setSimCollateral] = useState(2);
  const [simStatus, setSimStatus] = useState("Armed");
  const [simReason, setSimReason] = useState(null);
  const [simTriggerIdx, setSimTriggerIdx] = useState(null);
  const [simHistory, setSimHistory] = useState([
    { tick: 0, price: 3000, hwm: 3000, stop: 2850, note: "Position #1 Armed ($3,000)" },
  ]);
  const [simLogs, setSimLogs] = useState([
    {
      chain: "Base Sepolia",
      event: "PositionArmed",
      detail: "2.00 oWETH armed | 5% Trailing Stop | $4,200 TP | 10% Flash-Crash Shield",
      latency: "Origin Block",
    },
    {
      chain: "Reactive Lasna",
      event: "GuardRegistered (react)",
      detail: "OmniGuardReactive auto-mirrored Position #1 (HWM = $3,000.00)",
      latency: "~1.1s",
    },
  ]);

  async function refreshLive() {
    if (!isLiveDeployed) return;
    setLoading(true);
    try {
      const baseProvider = new ethers.JsonRpcProvider(deployments.networks.baseSepolia.rpcUrl);
      const lasnaProvider = new ethers.JsonRpcProvider(deployments.networks.lasna.rpcUrl);

      const pool = new ethers.Contract(deployments.contracts.omniPricePool, POOL_ABI, baseProvider);
      const vault = new ethers.Contract(deployments.contracts.omniGuardVault, VAULT_ABI, baseProvider);
      const reactive = new ethers.Contract(
        deployments.contracts.omniGuardReactive,
        REACTIVE_ABI,
        lasnaProvider
      );

      const [spot, epoch, vStats, rStats, nextId] = await Promise.all([
        pool.getSpotPrice(),
        pool.epoch(),
        vault.getVaultStats(),
        reactive.getReactiveStats(),
        vault.nextPositionId(),
      ]);

      const count = Math.min(Number(nextId) - 1, 12);
      const positions = [];
      for (let id = count; id >= 1; id--) {
        const [p, g] = await Promise.all([vault.getPosition(id), reactive.getGuardState(id)]);
        positions.push({
          id,
          owner: p.owner,
          wethAmount: Number(ethers.formatEther(p.wethAmount)),
          entryPrice: Number(p.entryPrice) / 1e6,
          takeProfitPrice: Number(p.takeProfitPrice) / 1e6,
          trailingBps: Number(p.trailingBps),
          crashDropBps: Number(p.crashDropBps),
          status: Number(p.status),
          executedReason: Number(p.executedReason),
          triggerPrice: Number(p.triggerPrice) / 1e6,
          highWaterMark: Math.max(Number(p.highWaterMark), Number(g.highWaterMark)) / 1e6,
          executionPrice: Number(p.executionPrice) / 1e6,
          usdcOut: Number(p.usdcOut) / 1e6,
          lasnaActive: g.active,
          lasnaPending: g.pendingCallback,
        });
      }

      setLiveData({
        spotPrice: Number(spot) / 1e6,
        ewmaPrice: Number(rStats.ewma) / 1e6 || Number(spot) / 1e6,
        epoch: Number(epoch),
        activeGuards: Number(rStats.activeCount),
        ticksProcessed: Number(rStats.ticksProcessed),
        callbacksRequested: Number(rStats.requestedCount),
        callbacksConfirmed: Number(rStats.confirmedCount),
        protectedUsdc: Number(vStats.protectedUsdc) / 1e6,
        vaultEth: Number(ethers.formatEther(vStats.ethBalance)).toFixed(4),
        reactiveBal: Number(ethers.formatEther(rStats.reactBalance)).toFixed(4),
        vaultDebt: ethers.formatEther(vStats.proxyDebt),
        reactiveDebt: ethers.formatEther(rStats.systemDebt),
        positions,
      });
    } catch (e) {
      setStatusMsg(`RPC sync notice: ${e.message}`);
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (isLiveDeployed) {
      refreshLive();
    }
  }, [isLiveDeployed]);

  async function connectWallet() {
    if (!window.ethereum) {
      setStatusMsg("MetaMask not detected — read-only live telemetry & simulator work without a wallet.");
      return;
    }
    try {
      const provider = new ethers.BrowserProvider(window.ethereum);
      const accounts = await provider.send("eth_requestAccounts", []);
      setWalletAddr(accounts[0]);
      setStatusMsg(`Connected ${shortAddr(accounts[0])}`);
    } catch (e) {
      setStatusMsg(e.message);
    }
  }

  function applySimMove(pctChange, label) {
    if (simStatus !== "Armed") return;
    const prev = simPrice;
    const next = Math.max(500, Math.round(prev * (1 + pctChange)));
    const nextHwm = Math.max(simHwm, next);
    const nextStop = Math.round(nextHwm * (1 - simTrailingPct / 100));
    const singleDropPct = prev > next ? ((prev - next) / prev) * 100 : 0;

    let reason = null;
    if (simCrashPct > 0 && singleDropPct >= simCrashPct) {
      reason = "Flash-Crash Breaker";
    } else if (simTrailingPct > 0 && next <= nextStop) {
      reason = "Trailing Stop-Loss";
    } else if (simTpPrice > 0 && next >= simTpPrice) {
      reason = "Take-Profit";
    }

    const newIdx = simHistory.length;
    setSimPrice(next);
    setSimHwm(nextHwm);
    setSimHistory((prevArr) => [
      ...prevArr,
      { tick: newIdx, price: next, hwm: nextHwm, stop: nextStop, note: label },
    ]);

    const newEntries = [
      {
        chain: "Base Sepolia",
        event: `PriceSync (${label})`,
        detail: `Spot moved ${fmtUsd(prev)} -> ${fmtUsd(next)}`,
        latency: "200ms block",
      },
    ];

    if (next > simHwm) {
      newEntries.push({
        chain: "Reactive Lasna",
        event: "HighWaterMarkRatcheted",
        detail: `HWM ratcheted ${fmtUsd(simHwm)} -> ${fmtUsd(nextHwm)} | New Stop = ${fmtUsd(nextStop)}`,
        latency: "~1.0s",
      });
    }

    if (reason) {
      setSimStatus("Executed");
      setSimReason(reason);
      setSimTriggerIdx(newIdx);
      const usdcOut = (simCollateral * next * 0.997).toFixed(2);
      newEntries.push({
        chain: "Reactive Lasna",
        event: `GuardCallbackRequested (${reason})`,
        detail: `SYSTEM.requestCallbackV_1_0(BaseSepolia, Vault, executeGuardCallback)`,
        latency: "~1.2s",
      });
      newEntries.push({
        chain: "Base Sepolia",
        event: "GuardExecuted (Callback Proxy)",
        detail: `Atomically swapped ${simCollateral} oWETH -> $${Number(usdcOut).toLocaleString()} oUSDC to user wallet`,
        latency: "~3.8s E2E",
      });
    } else if (next <= simHwm) {
      newEntries.push({
        chain: "Reactive Lasna",
        event: "react() — Hold",
        detail: `Spot ${fmtUsd(next)} > Stop ${fmtUsd(nextStop)} — no callback needed`,
        latency: "~1.0s",
      });
    }

    setSimLogs((prevLogs) => [...newEntries.reverse(), ...prevLogs]);
  }

  function resetSim() {
    const start = 3000;
    const stop = Math.round(start * (1 - simTrailingPct / 100));
    setSimPrice(start);
    setSimHwm(start);
    setSimStatus("Armed");
    setSimReason(null);
    setSimTriggerIdx(null);
    setSimHistory([{ tick: 0, price: start, hwm: start, stop, note: "Armed ($3,000)" }]);
    setSimLogs([
      {
        chain: "Base Sepolia",
        event: "PositionArmed",
        detail: `${simCollateral} oWETH armed | ${simTrailingPct}% Trailing Stop | $${simTpPrice} TP | ${simCrashPct}% Crash Shield`,
        latency: "Origin Block",
      },
    ]);
  }

  // Build chart data for live mode from liveProof if available
  const liveChartHistory = useMemo(() => {
    if (liveProof?.metrics) {
      const entry = liveProof.metrics.entryPriceUsd || 3000;
      const peak = liveProof.metrics.peakHighWaterMarkUsd || 3400;
      const stop = liveProof.metrics.trailingStopPriceUsd || 3230;
      const trig = liveProof.metrics.triggerPriceUsd || 3200;
      return [
        { tick: 0, price: entry, hwm: entry, stop: Math.round(entry * 0.95) },
        { tick: 1, price: Math.round((entry + peak) / 2), hwm: Math.round((entry + peak) / 2), stop: Math.round(((entry + peak) / 2) * 0.95) },
        { tick: 2, price: peak, hwm: peak, stop },
        { tick: 3, price: trig, hwm: peak, stop },
      ];
    }
    return simHistory;
  }, [simHistory]);

  const activeChartHistory = mode === "live" && liveProof?.metrics ? liveChartHistory : simHistory;
  const activeTriggerIdx = mode === "live" && liveProof?.metrics ? 3 : simTriggerIdx;

  return (
    <div className="app-shell">
      {/* Top Navigation */}
      <header className="topbar">
        <div className="brand">
          <div className="brand-icon">
            <Shield size={22} color="#fff" />
          </div>
          <div>
            <h1>OmniGuard</h1>
            <p>Keeper-less Sub-Second Trailing Stop &amp; Flash-Crash Shield · Reactive Omni × Base Sepolia</p>
          </div>
        </div>

        <div className="pill-row">
          <span className="pill">
            <span className="dot cyan" />
            Base Sepolia (84532)
          </span>
          <span className="pill">
            <span className="dot green" />
            Reactive Lasna (5318007)
          </span>
          <button
            className={`btn ${mode === "live" ? "btn-primary" : ""}`}
            onClick={() => setMode("live")}
          >
            <Activity size={14} /> Live On-Chain
          </button>
          <button
            className={`btn ${mode === "sim" ? "btn-primary" : ""}`}
            onClick={() => setMode("sim")}
          >
            <Zap size={14} /> Simulator
          </button>
          <button className="btn" onClick={connectWallet}>
            <Wallet size={14} /> {walletAddr ? shortAddr(walletAddr) : "Connect Wallet"}
          </button>
        </div>
      </header>

      {statusMsg && (
        <div
          className="card"
          style={{
            marginBottom: 16,
            padding: "10px 16px",
            borderColor: "rgba(56, 189, 248, 0.35)",
            fontSize: 13,
            color: "#38bdf8",
          }}
        >
          {statusMsg}
        </div>
      )}

      {/* KPI Row */}
      <section className="kpi-grid">
        <div className="card">
          <div className="kpi-label">
            <span>oWETH / oUSDC Spot</span>
            <TrendingUp size={15} color="#38bdf8" />
          </div>
          <div className="kpi-value mono">
            {mode === "live" ? fmtUsd(liveData.spotPrice) : fmtUsd(simPrice)}
          </div>
          <div className="kpi-sub mono">
            EWMA: {mode === "live" ? fmtUsd(liveData.ewmaPrice) : fmtUsd((simPrice + simHwm) / 2)} · Epoch #
            {mode === "live" ? liveData.epoch : simHistory.length}
          </div>
        </div>

        <div className="card">
          <div className="kpi-label">
            <span>Reactive Engine (Lasna)</span>
            <Layers size={15} color="#a78bfa" />
          </div>
          <div className="kpi-value mono">
            {mode === "live"
              ? `${liveData.ticksProcessed} Ticks`
              : `${simLogs.filter((l) => l.chain === "Reactive Lasna").length} Reacts`}
          </div>
          <div className="kpi-sub mono">
            {mode === "live"
              ? `Callbacks: ${liveData.callbacksRequested} req / ${liveData.callbacksConfirmed} settled · Debt: ${liveData.reactiveDebt}`
              : `HWM: ${fmtUsd(simHwm)} · Stop: ${fmtUsd(Math.round(simHwm * (1 - simTrailingPct / 100)))}`}
          </div>
        </div>

        <div className="card">
          <div className="kpi-label">
            <span>Protected Capital (Base)</span>
            <Lock size={15} color="#34d399" />
          </div>
          <div className="kpi-value mono" style={{ color: "#34d399" }}>
            {mode === "live"
              ? fmtUsd(liveData.protectedUsdc)
              : simStatus === "Executed"
              ? fmtUsd(simCollateral * simPrice * 0.997)
              : fmtUsd(simCollateral * simPrice)}
          </div>
          <div className="kpi-sub">
            {mode === "live"
              ? `${liveData.positions.filter((p) => p.status === 2).length} autonomous settlements · Zero keepers`
              : simStatus === "Executed"
              ? `Settled via ${simReason} callback`
              : `Armed & monitored 24/7 on Lasna`}
          </div>
        </div>

        <div className="card">
          <div className="kpi-label">
            <span>Cross-Chain E2E Latency</span>
            <Gauge size={15} color="#fbbf24" />
          </div>
          <div className="kpi-value mono" style={{ color: "#fbbf24" }}>
            {liveProof?.metrics?.endToEndBlockSec != null
              ? `${liveProof.metrics.endToEndBlockSec}s`
              : "~3.8s"}
          </div>
          <div className="kpi-sub mono">
            {liveProof?.metrics?.baseSepoliaBlockDelta != null
              ? `${liveProof.metrics.baseSepoliaBlockDelta} Base blocks · Origin -> Lasna -> Callback`
              : "Base (200ms) -> Lasna (~1s) -> Callback"}
          </div>
        </div>
      </section>

      {/* Main Split Grid */}
      <section className="main-grid">
        {/* Left: Trajectory Chart + Interactive Controls */}
        <div className="card">
          <div className="section-title">
            <h2>
              <Activity size={16} color="#38bdf8" />
              Stateful High-Water Mark &amp; Trailing Stop Engine
            </h2>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span className="badge badge-violet">HWM Ratchet</span>
              <span className="badge badge-amber">Trailing Floor</span>
              {mode === "live" && (
                <button className="btn" style={{ padding: "5px 10px" }} onClick={refreshLive} disabled={loading}>
                  <RefreshCw size={13} /> Sync RPC
                </button>
              )}
            </div>
          </div>

          <div className="chart-box">
            <PriceChart
              history={activeChartHistory}
              hwm={mode === "live" && liveProof?.metrics ? liveProof.metrics.peakHighWaterMarkUsd : simHwm}
              trailingStop={
                mode === "live" && liveProof?.metrics
                  ? liveProof.metrics.trailingStopPriceUsd
                  : Math.round(simHwm * (1 - simTrailingPct / 100))
              }
              takeProfit={mode === "live" ? 4500 : simTpPrice}
              triggerPoint={activeTriggerIdx}
            />
          </div>

          {mode === "sim" ? (
            <>
              <div className="sim-controls">
                <button
                  className="btn btn-emerald"
                  onClick={() => applySimMove(0.08, "+8% Rally")}
                  disabled={simStatus !== "Armed"}
                >
                  <TrendingUp size={14} /> +8% Rally (Ratchet HWM)
                </button>
                <button
                  className="btn btn-emerald"
                  onClick={() => applySimMove(0.18, "+18% Breakout")}
                  disabled={simStatus !== "Armed"}
                >
                  <TrendingUp size={14} /> +18% Breakout (Hit TP)
                </button>
                <button
                  className="btn btn-amber"
                  onClick={() => applySimMove(-0.06, "-6% Pullback")}
                  disabled={simStatus !== "Armed"}
                >
                  <TrendingDown size={14} /> -6% Pullback (Trigger Stop)
                </button>
                <button
                  className="btn btn-rose"
                  onClick={() => applySimMove(-0.12, "-12% Flash Crash")}
                  disabled={simStatus !== "Armed"}
                >
                  <Flame size={14} /> -12% Flash Crash
                </button>
                <button className="btn" onClick={resetSim}>
                  <RefreshCw size={14} /> Reset
                </button>
              </div>
              <p style={{ fontSize: 12, color: "#64748b", marginTop: 10 }}>
                Watch how rallies ratchet the purple High-Water Mark upward (raising the amber trailing stop floor
                without firing premature callbacks), then trigger instant protection the second a pullback or flash
                crash breaches the threshold.
              </p>
            </>
          ) : (
            <div className="arch-flow">
              <div className="arch-node">
                <h4 style={{ color: "#38bdf8" }}>1. Base Sepolia Origin</h4>
                <p>OmniPricePool emits PriceSync; OmniGuardVault emits PositionArmed.</p>
              </div>
              <div className="arch-node">
                <h4 style={{ color: "#a78bfa" }}>2. Lasna react()</h4>
                <p>OmniGuardReactive tracks HWM, EWMA &amp; single-tick crash drawdowns.</p>
              </div>
              <div className="arch-node">
                <h4 style={{ color: "#fbbf24" }}>3. V_1_0 Callback</h4>
                <p>SYSTEM.requestCallbackV_1_0 dispatches with anti-duplicate lock.</p>
              </div>
              <div className="arch-node">
                <h4 style={{ color: "#34d399" }}>4. Atomic Settlement</h4>
                <p>Base Callback Proxy calls Vault → swaps WETH→USDC directly to user.</p>
              </div>
            </div>
          )}
        </div>

        {/* Right: Position Config / Live Vault Positions */}
        <div className="card">
          <div className="section-title">
            <h2>
              <Shield size={16} color="#34d399" />
              {mode === "live" ? "On-Chain Guarded Positions" : "Configure Guard Rules"}
            </h2>
            <span className={`badge ${mode === "live" ? "badge-emerald" : "badge-cyan"}`}>
              {mode === "live" ? `${liveData.positions.length} On-Chain` : simStatus}
            </span>
          </div>

          {mode === "sim" ? (
            <>
              <div className="form-grid">
                <div className="field">
                  <label>Collateral (oWETH)</label>
                  <input
                    type="number"
                    value={simCollateral}
                    onChange={(e) => setSimCollateral(Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label>Trailing Stop (%)</label>
                  <input
                    type="number"
                    value={simTrailingPct}
                    onChange={(e) => setSimTrailingPct(Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label>Take-Profit Target ($)</label>
                  <input
                    type="number"
                    value={simTpPrice}
                    onChange={(e) => setSimTpPrice(Number(e.target.value))}
                  />
                </div>
                <div className="field">
                  <label>Flash-Crash Breaker (%)</label>
                  <input
                    type="number"
                    value={simCrashPct}
                    onChange={(e) => setSimCrashPct(Number(e.target.value))}
                  />
                </div>
              </div>

              <div className="pos-list" style={{ marginTop: 10 }}>
                {simLogs.slice(0, 5).map((log, i) => (
                  <div className="pos-item" key={i}>
                    <div className="pos-row">
                      <span
                        className={`badge ${
                          log.chain === "Reactive Lasna" ? "badge-violet" : "badge-cyan"
                        }`}
                      >
                        {log.chain}
                      </span>
                      <span className="mono" style={{ fontSize: 11, color: "#94a3b8" }}>
                        {log.latency}
                      </span>
                    </div>
                    <div style={{ fontWeight: 700, fontSize: 13, marginTop: 6 }}>{log.event}</div>
                    <div style={{ fontSize: 12, color: "#94a3b8", marginTop: 2 }}>{log.detail}</div>
                  </div>
                ))}
              </div>
            </>
          ) : (
            <div className="pos-list">
              {liveData.positions.length === 0 ? (
                <div className="pos-item" style={{ color: "#94a3b8", fontSize: 13 }}>
                  No on-chain positions fetched yet. Run deployment &amp; live demo script or switch to Simulator.
                </div>
              ) : (
                liveData.positions.map((p) => (
                  <div className="pos-item" key={p.id}>
                    <div className="pos-row">
                      <strong className="mono">
                        Position #{p.id} · {p.wethAmount.toFixed(2)} oWETH
                      </strong>
                      <span
                        className={`badge ${
                          p.status === 2
                            ? "badge-emerald"
                            : p.status === 1
                            ? "badge-cyan"
                            : "badge-amber"
                        }`}
                      >
                        {p.status === 2 ? REASON_LABELS[p.executedReason] : STATUS_LABELS[p.status]}
                      </span>
                    </div>
                    <div className="pos-meta mono">
                      <div>
                        <span>ENTRY / HWM</span>
                        {fmtUsd(p.entryPrice)} / {fmtUsd(p.highWaterMark)}
                      </div>
                      <div>
                        <span>RULES</span>
                        {(p.trailingBps / 100).toFixed(1)}% TS · {(p.crashDropBps / 100).toFixed(0)}% FC
                      </div>
                      <div>
                        <span>SETTLED USDC</span>
                        {p.status === 2 ? fmtUsd(p.usdcOut) : "Armed"}
                      </div>
                    </div>
                  </div>
                ))
              )}
            </div>
          )}
        </div>
      </section>

      {/* Bottom Section: Verified Cross-Chain Execution Proof & Deployed Contracts */}
      <section className="card">
        <div className="section-title">
          <h2>
            <CheckCircle2 size={16} color="#34d399" />
            Verified Cross-Chain Execution Proof (Base Sepolia ↔ Reactive Lasna)
          </h2>
          <span className="badge badge-emerald">
            {liveProof?.steps?.length ? `${liveProof.steps.length} Verified Loops` : "Ready for Testnet Proof"}
          </span>
        </div>

        {liveProof?.steps?.length > 0 ? (
          <div style={{ overflowX: "auto" }}>
            <table className="trace-table">
              <thead>
                <tr>
                  <th>Stage</th>
                  <th>Origin Tx (Base Sepolia)</th>
                  <th>Reactive Tx (Lasna 5318007)</th>
                  <th>Callback Tx (Base Sepolia)</th>
                  <th>Latency</th>
                </tr>
              </thead>
              <tbody className="mono">
                {liveProof.steps.map((s) => (
                  <tr key={s.step}>
                    <td style={{ fontFamily: "Inter, sans-serif", fontWeight: 600 }}>{s.label}</td>
                    <td>
                      <a
                        className="tx-link"
                        href={`${deployments.networks.baseSepolia.explorer}/tx/${s.originTx}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {shortAddr(s.originTx)} <ExternalLink size={11} style={{ display: "inline" }} />
                      </a>
                    </td>
                    <td>
                      {s.reactiveTx && s.reactiveTx.startsWith("0x") ? (
                        <a
                          className="tx-link"
                          href={`${deployments.networks.lasna.explorer}/tx/${s.reactiveTx}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortAddr(s.reactiveTx)} <ExternalLink size={11} style={{ display: "inline" }} />
                        </a>
                      ) : (
                        <span style={{ color: "#a78bfa" }}>Verified On-Chain State</span>
                      )}
                    </td>
                    <td>
                      {s.callbackTx ? (
                        <a
                          className="tx-link"
                          style={{ color: "#34d399" }}
                          href={`${deployments.networks.baseSepolia.explorer}/tx/${s.callbackTx}`}
                          target="_blank"
                          rel="noreferrer"
                        >
                          {shortAddr(s.callbackTx)} <ExternalLink size={11} style={{ display: "inline" }} />
                        </a>
                      ) : (
                        <span style={{ color: "#64748b" }}>State Sync Only</span>
                      )}
                    </td>
                    <td style={{ color: "#fbbf24" }}>
                      {s.onChainLatencySec != null
                        ? `${s.onChainLatencySec}s (${(s.wallLatencyMs / 1000).toFixed(1)}s wall)`
                        : `${(s.wallLatencyMs / 1000).toFixed(1)}s`}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <p style={{ color: "#94a3b8", fontSize: 13 }}>
            Live transaction hashes populate automatically once deployed to Base Sepolia &amp; Reactive Lasna.
          </p>
        )}

        {/* Deployed Contract Addresses */}
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(220px, 1fr))",
            gap: 10,
            marginTop: 18,
            paddingTop: 16,
            borderTop: "1px solid rgba(148,163,184,0.12)",
          }}
        >
          {[
            {
              name: "OmniGuardReactive (Lasna)",
              addr: deployments.contracts.omniGuardReactive,
              explorer: deployments.networks.lasna.explorer,
            },
            {
              name: "OmniGuardVault (Base Sepolia)",
              addr: deployments.contracts.omniGuardVault,
              explorer: deployments.networks.baseSepolia.explorer,
            },
            {
              name: "OmniPricePool (Base Sepolia)",
              addr: deployments.contracts.omniPricePool,
              explorer: deployments.networks.baseSepolia.explorer,
            },
            {
              name: "Base Callback Proxy (Omni)",
              addr: deployments.networks.baseSepolia.callbackProxy,
              explorer: deployments.networks.baseSepolia.explorer,
            },
            {
              name: "Lasna System Contract (Omni)",
              addr: deployments.networks.lasna.systemContract,
              explorer: deployments.networks.lasna.explorer,
            },
          ].map((c, idx) => (
            <div key={idx} className="pos-item" style={{ padding: "10px 12px" }}>
              <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 4 }}>{c.name}</div>
              {c.addr ? (
                <a
                  className="tx-link mono"
                  style={{ fontSize: 12 }}
                  href={`${c.explorer}/address/${c.addr}`}
                  target="_blank"
                  rel="noreferrer"
                >
                  {shortAddr(c.addr)} <ArrowRight size={11} style={{ display: "inline" }} />
                </a>
              ) : (
                <span className="mono" style={{ fontSize: 12, color: "#64748b" }}>
                  Pending Testnet Deploy
                </span>
              )}
            </div>
          ))}
        </div>
      </section>
    </div>
  );
}
