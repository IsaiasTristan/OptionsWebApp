import React, { useState, useMemo, useCallback, useEffect } from "react";
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
  ScatterChart,
  Scatter,
  AreaChart,
  Area,
  ReferenceLine,
} from "recharts";
import {
  fetchStrategies,
  saveStrategy,
  deleteStrategy,
  isCloudEnabled,
} from "./lib/supabase.js";

// ─── BLACK-SCHOLES ENGINE ───────────────────────────────────────────────────
function erf(x) {
  const a1=0.254829592,a2=-0.284496736,a3=1.421413741,a4=-1.453152027,a5=1.061405429,p=0.3275911;
  const sign = x<0?-1:1; x=Math.abs(x);
  const t=1/(1+p*x);
  const y=1-(((((a5*t+a4)*t)+a3)*t+a2)*t+a1)*t*Math.exp(-x*x);
  return sign*y;
}
function normCDF(x){ return 0.5*(1+erf(x/Math.sqrt(2))); }
function normPDF(x){ return Math.exp(-0.5*x*x)/Math.sqrt(2*Math.PI); }

function bs(S, K, T, r, sigma, type="call") {
  if(T<=0) {
    const intrinsic = type==="call" ? Math.max(S-K,0) : Math.max(K-S,0);
    return { price: intrinsic, delta: type==="call"?(S>K?1:0):(S<K?-1:0), gamma:0, vega:0, theta:0, charm:0, vomma:0, rho:0 };
  }
  const d1 = (Math.log(S/K)+(r+0.5*sigma*sigma)*T)/(sigma*Math.sqrt(T));
  const d2 = d1 - sigma*Math.sqrt(T);
  const Nd1 = normCDF(d1), Nd2 = normCDF(d2);
  const nd1 = normPDF(d1);
  
  let price, delta;
  if(type==="call"){
    price = S*Nd1 - K*Math.exp(-r*T)*Nd2;
    delta = Nd1;
  } else {
    price = K*Math.exp(-r*T)*normCDF(-d2) - S*normCDF(-d1);
    delta = Nd1-1;
  }
  const gamma = nd1/(S*sigma*Math.sqrt(T));
  const vega = S*nd1*Math.sqrt(T)/100; // per 1 vol point
  const theta = (-(S*nd1*sigma)/(2*Math.sqrt(T)) - r*K*Math.exp(-r*T)*(type==="call"?Nd2:1-Nd2))/365;
  const rho = type==="call"
    ? (K*T*Math.exp(-r*T)*Nd2)/100
    : (-K*T*Math.exp(-r*T)*normCDF(-d2))/100;
  const charm = type==="call"
    ? -nd1*(2*r*T - d2*sigma*Math.sqrt(T))/(2*T*sigma*Math.sqrt(T))
    : nd1*(2*r*T - d2*sigma*Math.sqrt(T))/(2*T*sigma*Math.sqrt(T));
  const vomma = vega*(d1*d2/sigma);
  
  return { price, delta, gamma, vega, theta, rho, charm, vomma, d1, d2, Nd1, Nd2 };
}

function computeIV(price, S, K, T, r, type, tol=0.0001, maxIter=200) {
  let lo=0.001, hi=5, mid=0.25;
  for(let i=0;i<maxIter;i++){
    const p=bs(S,K,T,r,mid,type).price;
    if(Math.abs(p-price)<tol) return mid;
    if(p<price) lo=mid; else hi=mid;
    mid=(lo+hi)/2;
  }
  return mid;
}

// ─── SKEW / TERM STRUCTURE (simplified parametric) ──────────────────────────

// ─── VOL SURFACE ENGINE ──────────────────────────────────────────────────────

// Fit a quadratic in log-moneyness for a single tenor slice
// returns {a, b, c} such that IV(K) = a + b*m + c*m^2, m = ln(K/S)
function fitSlice(points, S) {
  // points = [{strike, iv}], minimum 2 needed (3 for full quadratic)
  if (!points || points.length === 0) return null;
  if (points.length === 1) return { a: points[0].iv, b: 0, c: 0 };
  
  const ms = points.map(p => Math.log(p.strike / S));
  const ivs = points.map(p => p.iv);
  
  if (points.length === 2) {
    // Linear fit
    const dm = ms[1] - ms[0];
    const b = dm !== 0 ? (ivs[1] - ivs[0]) / dm : 0;
    const a = ivs[0] - b * ms[0];
    return { a, b, c: 0 };
  }
  
  // Quadratic least squares (Vandermonde normal equations)
  let s0=0, s1=0, s2=0, s3=0, s4=0, t0=0, t1=0, t2=0;
  for (let i=0; i<ms.length; i++) {
    const m=ms[i], v=ivs[i];
    s0+=1; s1+=m; s2+=m*m; s3+=m*m*m; s4+=m*m*m*m;
    t0+=v; t1+=m*v; t2+=m*m*v;
  }
  // Solve 3x3 system [s0,s1,s2; s1,s2,s3; s2,s3,s4] * [a,b,c] = [t0,t1,t2]
    // Use simple matrix inverse for 3x3
  const M = [[s0,s1,s2],[s1,s2,s3],[s2,s3,s4]];
  const T = [t0,t1,t2];
  // Gaussian elimination
  for (let col=0; col<3; col++) {
    let maxRow=col;
    for (let row=col+1; row<3; row++) if (Math.abs(M[row][col])>Math.abs(M[maxRow][col])) maxRow=row;
    [M[col],M[maxRow]]=[M[maxRow],M[col]]; [T[col],T[maxRow]]=[T[maxRow],T[col]];
    for (let row=col+1; row<3; row++) {
      const f = M[col][col]!==0 ? M[row][col]/M[col][col] : 0;
      for (let k=col; k<3; k++) M[row][k]-=f*M[col][k];
      T[row]-=f*T[col];
    }
  }
  const c3 = M[2][2]!==0 ? T[2]/M[2][2] : 0;
  const c2 = M[1][1]!==0 ? (T[1]-M[1][2]*c3)/M[1][1] : 0;
  const c1 = M[0][0]!==0 ? (T[0]-M[0][1]*c2-M[0][2]*c3)/M[0][0] : 0;
  return { a: c1, b: c2, c: c3 };
}

// Interpolate IV from fitted surface at given strike and DTE
function surfaceIV(surfacePoints, S, strike, targetDte) {
  if (!surfacePoints || surfacePoints.length === 0) return null;
  
  // Group points by tenor
  const tenorMap = {};
  surfacePoints.forEach(p => {
    const k = p.dte;
    if (!tenorMap[k]) tenorMap[k] = [];
    tenorMap[k].push(p);
  });
  const tenors = Object.keys(tenorMap).map(Number).sort((a,b)=>a-b);
  if (tenors.length === 0) return null;
  
  // Fit each slice
  const fits = tenors.map(t => ({ dte: t, fit: fitSlice(tenorMap[t], S) }));
  
  // Evaluate IV at this strike for each fitted tenor
  const m = Math.log(strike / S);
  const evalAt = (fit) => fit ? Math.max(0.5, fit.a + fit.b*m + fit.c*m*m) : null;
  
  // If only one tenor, just use it
  if (fits.length === 1) return evalAt(fits[0].fit);
  
  // Find bracketing tenors and interpolate linearly in sqrt(T) space
  if (targetDte <= tenors[0]) return evalAt(fits[0].fit);
  if (targetDte >= tenors[tenors.length-1]) return evalAt(fits[fits.length-1].fit);
  
  let lo = fits[0], hi = fits[1];
  for (let i=0; i<fits.length-1; i++) {
    if (fits[i].dte <= targetDte && fits[i+1].dte >= targetDte) { lo=fits[i]; hi=fits[i+1]; break; }
  }
  
  // Interpolate in sqrt(T) (variance time) space
  const sqLo = Math.sqrt(lo.dte), sqHi = Math.sqrt(hi.dte), sqT = Math.sqrt(targetDte);
  const wHi = sqHi > sqLo ? (sqT - sqLo) / (sqHi - sqLo) : 0;
  const wLo = 1 - wHi;
  const ivLo = evalAt(lo.fit), ivHi = evalAt(hi.fit);
  if (ivLo == null || ivHi == null) return ivLo ?? ivHi;
  return wLo * ivLo + wHi * ivHi;
}


// Convert expiry date string → DTE (days from today)
function expiryToDte(expiryStr) {
  const today = new Date(); today.setHours(0,0,0,0);
  const exp   = new Date(expiryStr); exp.setHours(0,0,0,0);
  return Math.max(1, Math.round((exp - today) / 86400000));
}

// ─── DYNAMIC RISK-FREE RATE ──────────────────────────────────────────────────
// Interpolated from a US Treasury yield curve approximation.
// Update the curve array as market rates change.
function getRiskFreeRate(dte) {
  const curve = [
    [7,   4.30], [30,  4.25], [60,  4.20], [90,  4.15],
    [180, 4.10], [365, 4.05], [730, 4.00],
  ];
  if (dte <= curve[0][0]) return curve[0][1];
  if (dte >= curve[curve.length - 1][0]) return curve[curve.length - 1][1];
  for (let i = 0; i < curve.length - 1; i++) {
    if (dte >= curve[i][0] && dte <= curve[i + 1][0]) {
      const t = (dte - curve[i][0]) / (curve[i + 1][0] - curve[i][0]);
      return +(curve[i][1] + t * (curve[i + 1][1] - curve[i][1])).toFixed(3);
    }
  }
  return 4.15;
}

// ─── STRATEGY BUILDER ───────────────────────────────────────────────────────
function computeLeg(leg, S, T, r) {
  // Use mid of bid/ask IV from Fidelity chain
  const midIV = (leg.bidIV != null && leg.askIV != null)
    ? (leg.bidIV + leg.askIV) / 2 / 100
    : (leg.iv || 25) / 100;
  const g = bs(S, leg.strike, T, r, midIV, leg.type);
  return { ...g, iv: midIV, cost: g.price*leg.qty*(leg.dir==="long"?1:-1)*100 };
}

// ─── MAIN COMPONENT ─────────────────────────────────────────────────────────
const STRATEGIES = ["Custom","Long Call","Long Put","Bull Call Spread","Bear Put Spread","Long Straddle","Long Strangle","Iron Condor","Butterfly","Risk Reversal","Calendar Spread"];

const PRESETS = {
  "Long Call":     [{ type:"call", dir:"long",  qty:1, strikePct:100, iv:25 }],
  "Long Put":      [{ type:"put",  dir:"long",  qty:1, strikePct:100, iv:25 }],
  "Bull Call Spread": [{ type:"call", dir:"long", qty:1, strikePct:98, iv:25 },{ type:"call", dir:"short", qty:1, strikePct:105, iv:23 }],
  "Bear Put Spread": [{ type:"put", dir:"long", qty:1, strikePct:102, iv:25 },{ type:"put", dir:"short", qty:1, strikePct:95, iv:23 }],
  "Long Straddle": [{ type:"call", dir:"long", qty:1, strikePct:100, iv:25 },{ type:"put", dir:"long", qty:1, strikePct:100, iv:25 }],
  "Long Strangle": [{ type:"call", dir:"long", qty:1, strikePct:105, iv:26 },{ type:"put", dir:"long", qty:1, strikePct:95, iv:26 }],
  "Iron Condor":   [{ type:"put", dir:"short", qty:1, strikePct:95, iv:27 },{ type:"put", dir:"long", qty:1, strikePct:90, iv:29 },{ type:"call", dir:"short", qty:1, strikePct:105, iv:27 },{ type:"call", dir:"long", qty:1, strikePct:110, iv:29 }],
  "Butterfly":     [{ type:"call", dir:"long", qty:1, strikePct:95, iv:26 },{ type:"call", dir:"short", qty:2, strikePct:100, iv:25 },{ type:"call", dir:"long", qty:1, strikePct:105, iv:26 }],
  "Risk Reversal": [{ type:"call", dir:"long", qty:1, strikePct:105, iv:22 },{ type:"put", dir:"short", qty:1, strikePct:95, iv:28 }],
};

// ─── P&L CURVE GENERATOR (pure function, no hooks) ──────────────────────────
function generatePnLCurve(lgs, S0, T0, rf0, daysForward=0, extraVolShift=0) {
  const Tf = Math.max(T0 - daysForward/365, 0.001);
  const range = Array.from({length:61},(_,i)=>S0*(0.7+i*0.01));
  return range.map(s => {
    let entry=0, current=0;
    lgs.forEach(l => {
      const strike    = S0*(l.strikePct/100);
      const baseIV    = (l.baseIV != null ? l.baseIV : l.iv) / 100;   // what you paid — clean
      const currentIV = Math.max(0.001, baseIV + extraVolShift/100);   // shifted IV for current mark
      const entryPrice = bs(S0, strike, T0, rf0, baseIV,     l.type).price;
      const currPrice  = bs(s,  strike, Tf, rf0, currentIV,  l.type).price;
      const sign = l.dir==="long"?1:-1;
      entry   += entryPrice * l.qty * sign * 100;
      current += currPrice  * l.qty * sign * 100;
    });
    return { spot: +s.toFixed(2), pnl: +(current - entry).toFixed(2) };
  });
}


// ─── 3D VOL SURFACE RENDERER ─────────────────────────────────────────────────
// ─── 3D VOL SURFACE RENDERER ─────────────────────────────────────────────────
// ─── 3D VOL SURFACE RENDERER ─────────────────────────────────────────────────
function VolSurface3D({ surfacePoints, spot, surfaceTenors, expiryToDteFn }) {
  const canvasRef = React.useRef(null);
  const [rotX, setRotX] = React.useState(0.45);
  const [rotY, setRotY] = React.useState(0.55);
  const [dragging, setDragging] = React.useState(false);
  const dragStart = React.useRef(null);
  const rotStart  = React.useRef(null);
  
  // Build grid data
  const gridData = React.useMemo(() => {
    if (surfacePoints.length < 2 || surfaceTenors.length < 1) return null;
    const ptsWithDte = surfacePoints.map(p => ({ ...p, dte: expiryToDteFn(p.expiry || "") }));
    const STRIKE_STEPS = 30;
    const TENOR_STEPS  = Math.min(surfaceTenors.length * 6, 30);
    const minStrike = spot * 0.75, maxStrike = spot * 1.25;
    const minDte    = Math.min(...ptsWithDte.map(p => p.dte));
    const maxDte    = Math.max(...ptsWithDte.map(p => p.dte));
    const dteRange  = Math.max(maxDte - minDte, 10);

    const grid = [];
    let minIV = Infinity, maxIV = -Infinity;

    for (let ti = 0; ti <= TENOR_STEPS; ti++) {
      const row = [];
      const t = minDte + (ti / TENOR_STEPS) * dteRange;
      for (let si = 0; si <= STRIKE_STEPS; si++) {
        const k = minStrike + (si / STRIKE_STEPS) * (maxStrike - minStrike);
        const iv = surfaceIV(ptsWithDte, spot, k, t) || 0;
        if (iv > 0) { minIV = Math.min(minIV, iv); maxIV = Math.max(maxIV, iv); }
        row.push({ k, t, iv });
      }
      grid.push(row);
    }
    return { grid, minIV, maxIV, minStrike, maxStrike, minDte, maxDte, STRIKE_STEPS, TENOR_STEPS };
  }, [surfacePoints, spot, surfaceTenors, expiryToDteFn]);

  // Draw
  React.useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !gridData) return;
    const ctx = canvas.getContext("2d");
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);

    // Dark background
    ctx.fillStyle = "#0d1117";
    ctx.fillRect(0, 0, W, H);

    const { grid, minIV, maxIV, minStrike, maxStrike, minDte, maxDte, STRIKE_STEPS, TENOR_STEPS } = gridData;
    const ivRange = Math.max(maxIV - minIV, 0.5);

    // 3D → screen projection
    const cx = W * 0.5, cy = H * 0.5;
    const scale = Math.min(W, H) * 0.36;
    const cosX = Math.cos(rotX), sinX = Math.sin(rotX);
    const cosY = Math.cos(rotY), sinY = Math.sin(rotY);

    function project(nx, ny, nz) {
      // nx ∈ [-1,1]: tenor axis  ny ∈ [0,1]: IV (up)  nz ∈ [-1,1]: strike axis
      // Rotate around Y then X
      let x = nx * cosY - nz * sinY;
      let z = nx * sinY + nz * cosY;
      let y2 = ny * cosX - z * sinX;
      let z2 = ny * sinX + z * cosX;
      // Simple perspective
      const fov = 3.5;
      const pz = z2 + fov;
      return {
        sx: cx + (x / pz) * scale,
        sy: cy - (y2 / pz) * scale,
        z: pz,
      };
    }

    function ivColor(iv) {
      const norm = (iv - minIV) / ivRange;
      // Blue (low IV) → cyan → green → yellow → red (high IV)
      let r, g, b;
      if (norm < 0.25) {
        const s = norm / 0.25;
        r = Math.round(20 + s * 0);
        g = Math.round(80 + s * 140);
        b = Math.round(200 + s * 55);
      } else if (norm < 0.5) {
        const s = (norm - 0.25) / 0.25;
        r = Math.round(20 + s * 20);
        g = Math.round(220 + s * 35);
        b = Math.round(255 * (1 - s));
      } else if (norm < 0.75) {
        const s = (norm - 0.5) / 0.25;
        r = Math.round(40 + s * 215);
        g = Math.round(255 - s * 55);
        b = Math.round(30 * (1 - s));
      } else {
        const s = (norm - 0.75) / 0.25;
        r = Math.round(255);
        g = Math.round(200 - s * 200);
        b = Math.round(0);
      }
      return `rgb(${r},${g},${b})`;
    }

    // Precompute projected vertices
    const verts = grid.map(row => row.map(p => {
      const nx = ((p.t - minDte) / Math.max(maxDte - minDte, 1)) * 2 - 1;
      const nz = ((p.k - minStrike) / (maxStrike - minStrike)) * 2 - 1;
      const ny = (p.iv - minIV) / ivRange * 0.7; // scale IV height
      return { ...project(nx, ny, nz), iv: p.iv };
    }));

    // Determine draw order (back to front) based on average Z
    const quads = [];
    for (let ti = 0; ti < TENOR_STEPS; ti++) {
      for (let si = 0; si < STRIKE_STEPS; si++) {
        const v00 = verts[ti][si], v10 = verts[ti+1][si];
        const v01 = verts[ti][si+1], v11 = verts[ti+1][si+1];
        const avgZ = (v00.z + v10.z + v01.z + v11.z) / 4;
        const avgIV = (grid[ti][si].iv + grid[ti+1][si].iv + grid[ti][si+1].iv + grid[ti+1][si+1].iv) / 4;
        quads.push({ ti, si, avgZ, avgIV, v00, v10, v01, v11 });
      }
    }
    quads.sort((a, b) => b.avgZ - a.avgZ); // painter's algorithm

    // Draw quads
    quads.forEach(({ v00, v10, v01, v11, avgIV }) => {
      const col = ivColor(avgIV);
      ctx.beginPath();
      ctx.moveTo(v00.sx, v00.sy);
      ctx.lineTo(v10.sx, v10.sy);
      ctx.lineTo(v11.sx, v11.sy);
      ctx.lineTo(v01.sx, v01.sy);
      ctx.closePath();
      ctx.fillStyle = col;
      ctx.fill();
      ctx.strokeStyle = "rgba(13,17,23,0.35)";
      ctx.lineWidth = 0.4;
      ctx.stroke();
    });

    // Draw ATM plane (vertical line at spot)
        for (let ti = 0; ti < TENOR_STEPS; ti++) {
      const si = Math.round(STRIKE_STEPS / 2);
      const v0 = verts[ti][si], v1 = verts[ti+1][si];
      ctx.beginPath();
      ctx.moveTo(v0.sx, v0.sy);
      ctx.lineTo(v1.sx, v1.sy);
      ctx.strokeStyle = "rgba(0,215,155,0.6)";
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }

    // Axes labels
    ctx.font = "bold 10px 'JetBrains Mono', monospace";
    ctx.fillStyle = "#4a9eff";
        const axTenor  = project(1, 0, -1);
    const axStrike = project(-1, 0, 1);
    const axIV     = project(-1, 0.75, -1);

    ctx.fillStyle = "rgba(100,180,255,0.7)";
    ctx.fillText("DTE →", axTenor.sx - 28, axTenor.sy - 4);
    ctx.fillStyle = "rgba(100,220,150,0.7)";
    ctx.fillText("STRIKE →", axStrike.sx - 4, axStrike.sy + 14);
    ctx.fillStyle = "rgba(255,200,80,0.9)";
    ctx.fillText("IV %", axIV.sx - 22, axIV.sy);

    // IV color legend
    const lgX = W - 28, lgY = H * 0.15, lgH = H * 0.55;
    for (let i = 0; i <= 40; i++) {
      const norm = i / 40;
      const iv = minIV + norm * ivRange;
      ctx.fillStyle = ivColor(iv);
      ctx.fillRect(lgX, lgY + lgH * (1 - norm) - 3, 12, lgH / 38);
    }
    ctx.font = "9px 'JetBrains Mono', monospace";
    ctx.fillStyle = "rgba(200,220,255,0.7)";
    ctx.fillText(maxIV.toFixed(1)+"%", lgX - 16, lgY + 4);
    ctx.fillText(minIV.toFixed(1)+"%", lgX - 16, lgY + lgH + 4);
    ctx.fillStyle = "rgba(150,180,255,0.5)";
    ctx.fillText("IV", lgX - 2, lgY - 6);

  }, [gridData, rotX, rotY]);

  // Mouse drag handlers
  const onMouseDown = (e) => {
    setDragging(true);
    dragStart.current = { x: e.clientX, y: e.clientY };
    rotStart.current  = { x: rotX, y: rotY };
  };
  const onMouseMove = (e) => {
    if (!dragging || !dragStart.current) return;
    const dx = e.clientX - dragStart.current.x;
    const dy = e.clientY - dragStart.current.y;
    setRotY(rotStart.current.y + dx * 0.008);
    setRotX(Math.max(-0.1, Math.min(1.4, rotStart.current.x + dy * 0.006)));
  };
  const onMouseUp = () => setDragging(false);

  // Touch support
  const onTouchStart = (e) => {
    if (e.touches.length !== 1) return;
    dragStart.current = { x: e.touches[0].clientX, y: e.touches[0].clientY };
    rotStart.current  = { x: rotX, y: rotY };
  };
  const onTouchMove = (e) => {
    if (e.touches.length !== 1 || !dragStart.current) return;
    const dx = e.touches[0].clientX - dragStart.current.x;
    const dy = e.touches[0].clientY - dragStart.current.y;
    setRotY(rotStart.current.y + dx * 0.008);
    setRotX(Math.max(-0.1, Math.min(1.4, rotStart.current.x + dy * 0.006)));
  };

  if (!gridData || surfacePoints.length < 2) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "#a8b8cc", fontSize: 11 }}>
        Add at least 2 data points to render 3D surface
      </div>
    );
  }

  return (
    <div style={{ position: "relative" }}>
      <canvas
        ref={canvasRef}
        width={500}
        height={320}
        style={{
          width: "100%",
          height: 320,
          borderRadius: 6,
          cursor: dragging ? "grabbing" : "grab",
          display: "block",
          background: "#0d1117",
        }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onMouseUp}
      />
      <div style={{
        position: "absolute", bottom: 8, left: 8,
        fontSize: 9, color: "rgba(160,190,230,0.6)",
        fontFamily: "'JetBrains Mono', monospace",
        pointerEvents: "none",
      }}>
        drag to rotate
      </div>
    </div>
  );
}

const defaultLegs = [{ id:1, type:"call", dir:"long", qty:1, strikePct:100, iv:25, bidPrice:null, askPrice:null }];

export default function OptionsModel({ loadedTicker = null }) {
  const [spot, setSpot] = useState(100);
  // Default expiry = today + 75 days
  const todayStr = new Date().toISOString().split('T')[0];
  const [expiryDate, setExpiryDate] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 75);
    return d.toISOString().split('T')[0];
  });
  const dte = Math.max(1, Math.round((new Date(expiryDate) - new Date(todayStr)) / 86400000));
  const [legs, setLegs] = useState(defaultLegs);
  const [strategy, setStrategy] = useState("Custom");
  const [rv20, setRv20] = useState(18);
  const [rv60, setRv60] = useState(20);
  const [rv1y, setRv1y] = useState(22);
  const [iv1yPct, setIv1yPct] = useState(35); // current IV percentile
  const [activeTab, setActiveTab] = useState("overview");
  const [volShift, setVolShift] = useState(0);
  const [spotShift, setSpotShift] = useState(0);
  const [labSpotShift, setLabSpotShift] = useState(0);
  const [labVolShift, setLabVolShift] = useState(0);
  const [labDaysForward, setLabDaysForward] = useState(0);
  const [labRateShiftBps, setLabRateShiftBps] = useState(0);
  const [margin, setMargin] = useState(20); // % of notional
  const [nextId, setNextId] = useState(10);
  // Vol surface: array of {id, strike, dte, iv, type} data points from Fidelity chain
  // Pre-seeded with placeholder data — replace with your actual chain quotes
  const [surfacePoints, setSurfacePoints] = useState([
    // ~30d expiry
    {id:"s1",  strike:90,  expiry:"2026-04-01", iv:28.5}, {id:"s2",  strike:95,  expiry:"2026-04-01", iv:26.2},
    {id:"s3",  strike:100, expiry:"2026-04-01", iv:25.0}, {id:"s4",  strike:105, expiry:"2026-04-01", iv:24.1},
    {id:"s5",  strike:110, expiry:"2026-04-01", iv:23.8},
    // ~60d expiry
    {id:"s6",  strike:90,  expiry:"2026-05-01", iv:27.2}, {id:"s7",  strike:95,  expiry:"2026-05-01", iv:25.5},
    {id:"s8",  strike:100, expiry:"2026-05-01", iv:24.5}, {id:"s9",  strike:105, expiry:"2026-05-01", iv:23.8},
    {id:"s10", strike:110, expiry:"2026-05-01", iv:23.2},
    // ~90d expiry
    {id:"s11", strike:90,  expiry:"2026-05-31", iv:26.5}, {id:"s12", strike:95,  expiry:"2026-05-31", iv:25.0},
    {id:"s13", strike:100, expiry:"2026-05-31", iv:24.0}, {id:"s14", strike:105, expiry:"2026-05-31", iv:23.5},
    {id:"s15", strike:110, expiry:"2026-05-31", iv:23.0},
  ]);
  const [surfaceNextId, setSurfaceNextId] = useState(100);
  const [surfaceEnabled, setSurfaceEnabled] = useState(false);

  // ── Watchlist (cloud via Supabase when configured, else localStorage) ─────────
  const [ticker, setTicker] = useState("AAPL");
  const [watchlist, setWatchlist] = useState([]);
  const [watchlistOpen, setWatchlistOpen] = useState(false);
  const [saveNameDraft, setSaveNameDraft] = useState("");

  // Pre-populate from Screener when a ticker is loaded via "→ Model"
  useEffect(() => {
    if (!loadedTicker) return;
    setTicker(loadedTicker.symbol ?? "");
    if (loadedTicker.spot != null && loadedTicker.spot > 0) setSpot(loadedTicker.spot);
    if (loadedTicker.surfacePoints && loadedTicker.surfacePoints.length > 0) {
      setSurfacePoints(loadedTicker.surfacePoints);
      setSurfaceEnabled(true);
    }
    if (loadedTicker.rv20 != null) setRv20(+loadedTicker.rv20.toFixed(1));
  }, [loadedTicker]);

  // Load watchlist once on mount: from Supabase if configured and working, else localStorage
  useEffect(() => {
    const loadLocal = () => {
      try {
        setWatchlist(JSON.parse(localStorage.getItem("optix_watchlist") || "[]"));
      } catch {
        setWatchlist([]);
      }
    };
    if (isCloudEnabled()) {
      fetchStrategies().then(({ list, error }) => {
        if (error) loadLocal();
        else setWatchlist(list);
      });
    } else {
      loadLocal();
    }
  }, []);

  const persistWatchlist = (wl) => {
    setWatchlist(wl);
    if (!isCloudEnabled()) {
      try { localStorage.setItem("optix_watchlist", JSON.stringify(wl)); } catch { void 0; }
    }
  };

  const currentSnapshot = () => ({
    ticker,
    spot, expiryDate,
    legs, strategy,
    rv20, rv60, rv1y, iv1yPct,
    margin,
    surfacePoints, surfaceEnabled,
    savedAt: new Date().toISOString(),
  });

  const saveToWatchlist = async () => {
    const name = (saveNameDraft.trim() || ticker || "").trim();
    if (!name) return;
    const snap = { ...currentSnapshot(), ticker: name };
    const updated = [snap, ...watchlist.filter(w => w.ticker !== name)];
    if (isCloudEnabled()) {
      try {
        const ok = await saveStrategy(name, snap);
        if (ok) {
          const { list } = await fetchStrategies();
          setWatchlist(list);
        } else {
          setWatchlist(updated);
          try { localStorage.setItem("optix_watchlist", JSON.stringify(updated)); } catch { void 0; }
        }
      } catch (e) {
        console.warn("Cloud save failed, saving locally:", e);
        setWatchlist(updated);
        try { localStorage.setItem("optix_watchlist", JSON.stringify(updated)); } catch { void 0; }
      }
    } else {
      persistWatchlist(updated);
    }
    setSaveNameDraft("");
  };

  const loadFromWatchlist = (snap) => {
    setTicker(snap.ticker);
    setSpot(snap.spot);
        setExpiryDate(snap.expiryDate);
    setLegs(snap.legs);
    setStrategy(snap.strategy || "Custom");
    setRv20(snap.rv20); setRv60(snap.rv60); setRv1y(snap.rv1y);
    setIv1yPct(snap.iv1yPct);
    setMargin(snap.margin || 20);
    setSurfacePoints(snap.surfacePoints || []);
    setSurfaceEnabled(snap.surfaceEnabled || false);
    setSurfaceNextId(Math.max(100, ((snap.surfacePoints || []).length + 100)));
    setWatchlistOpen(false);
  };

  const deleteFromWatchlist = async (tickerName) => {
    const filtered = watchlist.filter(w => w.ticker !== tickerName);
    if (isCloudEnabled()) {
      try {
        const ok = await deleteStrategy(tickerName);
        if (ok) {
          const { list } = await fetchStrategies();
          setWatchlist(list);
        } else {
          setWatchlist(filtered);
          try { localStorage.setItem("optix_watchlist", JSON.stringify(filtered)); } catch { void 0; }
        }
      } catch (e) {
        console.warn("Cloud delete failed, updating locally:", e);
        setWatchlist(filtered);
        try { localStorage.setItem("optix_watchlist", JSON.stringify(filtered)); } catch { void 0; }
      }
    } else {
      persistWatchlist(filtered);
    }
  };

  const T = dte/365;
  const rf = getRiskFreeRate(dte) / 100;

  // Apply strategy preset
  const applyStrategy = useCallback((strat) => {
    setStrategy(strat);
    if(PRESETS[strat]) {
      setLegs(PRESETS[strat].map((l,i)=>({ ...l, id:i+1, strikePct:l.strikePct, strike:spot*(l.strikePct/100), bidPrice: null, askPrice: null })));
    }
  }, [spot]);

  // Compute all legs — back-solve IV from prices, or read from fitted surface
  const processedLegs = useMemo(() => legs.map(l => {
    const strike = spot*(l.strikePct/100);
    let midIV = l.iv || 25;
    let bidIV = null, askIV = null, midPrice = null;
    let fromSurface = false;

    if (l.bidPrice != null && l.askPrice != null && l.bidPrice > 0 && l.askPrice > 0) {
      // Prices entered manually — back-solve IV
      const Tl = Math.max(dte/365, 0.001);
      bidIV  = computeIV(l.bidPrice,  spot, strike, Tl, rf, l.type) * 100;
      askIV  = computeIV(l.askPrice,  spot, strike, Tl, rf, l.type) * 100;
      midPrice = (l.bidPrice + l.askPrice) / 2;
      midIV  = (bidIV + askIV) / 2;
    } else if (l.bidPrice != null && l.bidPrice > 0) {
      const Tl = Math.max(dte/365, 0.001);
      bidIV  = computeIV(l.bidPrice, spot, strike, Tl, rf, l.type) * 100;
      midIV  = bidIV;
    } else if (l.askPrice != null && l.askPrice > 0) {
      const Tl = Math.max(dte/365, 0.001);
      askIV  = computeIV(l.askPrice, spot, strike, Tl, rf, l.type) * 100;
      midIV  = askIV;
    } else if (surfaceEnabled && surfacePoints.length >= 2) {
      // No prices entered — read IV from fitted surface
      const ptsWithDte = surfacePoints.map(p=>({...p, dte: expiryToDte(p.expiry||"")}));
      const surfIV = surfaceIV(ptsWithDte, spot, strike, dte);
      if (surfIV != null) { midIV = surfIV; fromSurface = true; }
    }

    return {
      ...l,
      strike,
      bidIV:      bidIV != null ? +bidIV.toFixed(2) : null,
      askIV:      askIV != null ? +askIV.toFixed(2) : null,
      midPrice,
      fromSurface,
      baseIV:  midIV,
      iv:      midIV,   // volShift applied explicitly where needed, not baked in
    };
  }), [legs, spot, dte, rf, surfaceEnabled, surfacePoints]);

  // Current portfolio metrics
  const portfolio = useMemo(() => {
    const S = spot*(1+spotShift/100);
    return processedLegs.map(l => {
      // Apply volShift to IV for live greeks display
      const shifted = {...l, iv: Math.max(0.1, (l.baseIV ?? l.iv) + volShift)};
      return computeLeg(shifted, S, T, rf);
    });
  }, [processedLegs, spot, spotShift, T, rf, volShift]);

  const aggMetrics = useMemo(() => {
    const totalCost = portfolio.reduce((s,l) => s + l.cost, 0);
    const delta = portfolio.reduce((s,l,i) => s + l.delta * processedLegs[i].qty * (processedLegs[i].dir==="long"?1:-1) * 100, 0);
    const gamma = portfolio.reduce((s,l,i) => s + l.gamma * processedLegs[i].qty * (processedLegs[i].dir==="long"?1:-1) * 100, 0);
    const vega  = portfolio.reduce((s,l,i) => s + l.vega  * processedLegs[i].qty * (processedLegs[i].dir==="long"?1:-1) * 100, 0);
    const theta = portfolio.reduce((s,l,i) => s + l.theta * processedLegs[i].qty * (processedLegs[i].dir==="long"?1:-1) * 100, 0);
    const rho   = portfolio.reduce((s,l,i) => s + (l.rho||0) * processedLegs[i].qty * (processedLegs[i].dir==="long"?1:-1) * 100, 0);
    const charm = portfolio.reduce((s,l,i) => s + (l.charm||0) * processedLegs[i].qty * (processedLegs[i].dir==="long"?1:-1) * 100, 0);
    const vomma = portfolio.reduce((s,l,i) => s + (l.vomma||0) * processedLegs[i].qty * (processedLegs[i].dir==="long"?1:-1) * 100, 0);
    const avgIV = processedLegs.reduce((s,l)=>s+(l.iv||25),0)/processedLegs.length;
    const vrp = avgIV - rv20;
    const breakEvenRV = avgIV + (totalCost>0 ? -vrp : vrp); // simplified
    const maxLoss = Math.min(...generatePnLCurve(processedLegs, spot, T, rf, 0).map(p=>p.pnl));
    const maxGain = Math.max(...generatePnLCurve(processedLegs, spot, T, rf, 0).map(p=>p.pnl));
    const notional = spot * 100;
    const marginReq = notional * (margin/100);
    const retOnMargin = totalCost > 0 ? 0 : (-totalCost / marginReq) * 100;
    return { totalCost, delta, gamma, vega, theta, rho, charm, vomma, avgIV, vrp, breakEvenRV, maxLoss, maxGain, notional, marginReq, retOnMargin };
  }, [portfolio, processedLegs, spot, T, rf, rv20, margin]);

  // Dynamic time slices: Today + 3 equal quarters + At Expiry
  const PnLChartSlices = useMemo(() => {
    // Use exact integer days, ensure each slice is at least 1 day apart
    const q1 = Math.max(1,          Math.round(dte / 4));
    const q2 = Math.max(q1 + 1,     Math.round(dte / 2));
    const q3 = Math.max(q2 + 1,     Math.round(dte * 3 / 4));
    return [
      { key:"Today",      days:0,        color:"#00875a" },
      { key:`+${q1}d`,    days:q1,       color:"#0055a5" },
      { key:`+${q2}d`,    days:q2,       color:"#c05a00" },
      { key:`+${q3}d`,    days:q3,       color:"#8b44c2" },
      { key:"At Expiry",  days:dte-0.01, color:"#c0182e" },
    ];
  }, [dte]);

  const pnlCurves = useMemo(() => {
    const curves = {};
    PnLChartSlices.forEach(sl => {
      curves[sl.key] = generatePnLCurve(processedLegs, spot, T, rf, sl.days, volShift);
    });
    return curves;
  }, [processedLegs, spot, T, rf, PnLChartSlices, volShift]);

  const combinedPnL = useMemo(() => {
    const base = pnlCurves["Today"] || [];
    return base.map((d,i) => {
      const row = { spot: d.spot };
      PnLChartSlices.forEach(sl => {
        row[sl.key] = pnlCurves[sl.key]?.[i]?.pnl;
      });
      return row;
    });
  }, [pnlCurves, PnLChartSlices]);

  // Vol shift sensitivity
  const volSensitivity = useMemo(() => {
    return Array.from({length:21},(_,i)=>i-10).map(vs => {
      let pnl=0;
      processedLegs.forEach(l => {
        const strike = spot*(l.strikePct/100);
        const entryIV = (l.baseIV != null ? l.baseIV : l.iv) / 100; // clean entry — no global volShift
        const shiftIV  = Math.max(0.01, entryIV + vs/100);           // apply THIS chart's shift on top
        const entryP  = bs(spot, strike, T, rf, entryIV,  l.type).price;
        const shiftP  = bs(spot, strike, T, rf, shiftIV,  l.type).price;
        pnl += (shiftP - entryP)*l.qty*(l.dir==="long"?1:-1)*100;
      });
      return { volShift: vs, pnl: +pnl.toFixed(2) };
    });
  }, [processedLegs, spot, T, rf]);

  // Theta decay
  const thetaDecay = useMemo(() => {
    return Array.from({length:dte+1},(_,i)=>i).map(d => {
      const Td = Math.max((dte-d)/365, 0.001);
      let val=0;
      processedLegs.forEach(l => {
        const strike = spot*(l.strikePct/100);
        const entryIV = (l.baseIV != null ? l.baseIV : l.iv) / 100;
        const p0 = bs(spot, strike, T,  rf, entryIV, l.type).price;
        const pd = bs(spot, strike, Td, rf, entryIV, l.type).price;
        val += (pd-p0)*l.qty*(l.dir==="long"?1:-1)*100;
      });
      return { day: d, pnl: +val.toFixed(2) };
    });
  }, [processedLegs, spot, T, rf, dte]);

  // Scenario engine
  const scenarios = useMemo(() => {
    const shocks = [
      { label:"-15%", spot:-15, vol: 0 }, { label:"-10%", spot:-10, vol: 0 },
      { label:"-5%",  spot:-5,  vol: 0 }, { label:"Flat", spot:0,   vol: 0 },
      { label:"+5%",  spot:+5,  vol: 0 }, { label:"+10%", spot:+10, vol: 0 },
      { label:"+15%", spot:+15, vol: 0 },
      { label:"Vol -10", spot:0, vol:-10 }, { label:"Vol +10", spot:0, vol:+10 },
      { label:"-10% + Vol+10", spot:-10, vol:+10 }, { label:"+10% + Vol-5", spot:+10, vol:-5 },
    ];
    return shocks.map(s => {
      const newS = spot*(1+s.spot/100);
      let pnl=0;
      processedLegs.forEach(l => {
        const strike = spot*(l.strikePct/100);
        const entryIV = (l.baseIV != null ? l.baseIV : l.iv) / 100; // what you paid — no global shift
        const newIV   = Math.max(0.01, entryIV + s.vol/100);         // scenario shock on top of entry
        const entry   = bs(spot,  strike, T, rf, entryIV, l.type).price;
        const shock   = bs(newS,  strike, T, rf, newIV,   l.type).price;
        pnl += (shock-entry)*l.qty*(l.dir==="long"?1:-1)*100;
      });
      const absCost = Math.abs(aggMetrics.totalCost);
      const pct  = absCost > 0.01 ? (pnl / absCost)*100 : 0;
      // MOIC = current value / initial investment
      // initial investment = absCost (what you paid net), current = absCost + pnl
      const moic = absCost > 0.01 ? ((absCost + pnl) / absCost) : null;
      return { ...s, pnl: +pnl.toFixed(2), pct: +pct.toFixed(1), moic: moic != null ? +moic.toFixed(2) : null };
    });
  }, [processedLegs, spot, T, rf, aggMetrics.totalCost]);

  // Vol smile: plot each leg's actual mid IV vs strike as discrete points
  const skewCurve = useMemo(() => {
    return processedLegs.map(l => ({
      strike: +(spot*(l.strikePct/100)).toFixed(2),
      iv: +l.iv.toFixed(2),
      bid: l.bidIV != null ? +l.bidIV : null,
      ask: l.askIV != null ? +l.askIV : null,
      label: `${l.dir} ${l.type}`,
    })).sort((a,b) => a.strike - b.strike);
  }, [processedLegs, spot]);

  // Greeks per leg
  const greeksByLeg = useMemo(() => processedLegs.map((l,i) => {
    const g = portfolio[i];
    const sign = l.dir==="long"?1:-1;
    return {
      leg: `Leg ${i+1} (${l.dir} ${l.type} @${(l.strikePct).toFixed(0)}%)`,
      delta: +(g.delta*l.qty*sign*100).toFixed(3),
      gamma: +(g.gamma*l.qty*sign*100).toFixed(4),
      vega:  +(g.vega *l.qty*sign*100).toFixed(2),
      theta: +(g.theta*l.qty*sign*100).toFixed(2),
      rho:   +((g.rho||0)*l.qty*sign*100).toFixed(3),
      charm: +((g.charm||0)*l.qty*sign*100).toFixed(4),
      vomma: +((g.vomma||0)*l.qty*sign*100).toFixed(4),
    };
  }), [processedLegs, portfolio]);


  // ── Surface tab computed values ─────────────────────────────────────────────
  // surfaceTenors: unique sorted expiry dates
  const surfaceTenors = useMemo(() =>
    [...new Set(surfacePoints.map(p=>p.expiry||""))].filter(Boolean).sort()
  , [surfacePoints]);

  // Helper: convert a surface expiry date to DTE for the fitting engine
    const surfaceHeatmapDtes = useMemo(() => surfaceTenors.length > 0 ? surfaceTenors : [30,60,90], [surfaceTenors]);

  const surfaceHeatmapData = useMemo(() => {
    const hStrikes = Array.from({length:21},(_,i)=>+(spot*0.8+i*spot*0.02).toFixed(1));
    // Build a version of surfacePoints with dte computed from expiry for the fitting engine
    const ptsWithDte = surfacePoints.map(p=>({...p, dte: expiryToDte(p.expiry||"")}));
    return hStrikes.map(k=>{
      const row = {strike:k};
      surfaceHeatmapDtes.forEach(expiry=>{
        const t = expiryToDte(expiry);
        const iv = ptsWithDte.length>=2 ? surfaceIV(ptsWithDte,spot,k,t) : null;
        row[expiry] = iv!=null ? +iv.toFixed(1) : null;
      });
      return row;
    });
  }, [surfacePoints, spot, surfaceHeatmapDtes]);

  const surfaceIvColorRange = useMemo(() => {
    const all = surfaceHeatmapData.flatMap(r=>surfaceHeatmapDtes.map(t=>r[t+"d"])).filter(Boolean);
    return { min: Math.min(...all)||0, max: Math.max(...all)||100 };
  }, [surfaceHeatmapData, surfaceHeatmapDtes]);

  const surfaceSmileData = useMemo(() => {
    if (surfacePoints.length < 2) return [];
    const ptsWithDte = surfacePoints.map(p=>({...p, dte: expiryToDte(p.expiry||"")}));
    return Array.from({length:41},(_,i)=>+(spot*0.75+i*spot*0.0125).toFixed(2)).map(k=>({
      strike: k,
      fitted: +(surfaceIV(ptsWithDte,spot,k,dte)||0).toFixed(2),
    }));
  }, [surfacePoints, spot, dte]);

  const surfaceNearestTenorPoints = useMemo(() => {
    if (surfaceTenors.length === 0) return [];
    // Find the expiry date closest to current DTE
    const nearest = surfaceTenors.reduce((a,b)=>
      Math.abs(expiryToDte(b)-dte) < Math.abs(expiryToDte(a)-dte) ? b : a
    , surfaceTenors[0]);
    return surfacePoints.filter(p=>p.expiry===nearest);
  }, [surfacePoints, surfaceTenors, dte]);

  const surfaceLegPreviews = useMemo(() => {
    const ptsWithDte = surfacePoints.map(p=>({...p, dte: expiryToDte(p.expiry||"")}));
    return legs.map(l=>{
      const strike = spot*(l.strikePct/100);
      const iv = ptsWithDte.length>=2 ? surfaceIV(ptsWithDte,spot,strike,dte) : null;
      return {...l, strike, surfIV: iv!=null?+iv.toFixed(2):null};
    });
  }, [legs, surfacePoints, spot, dte]);

  const addSurfacePoint = (expiry) => {
    const exp = expiry || "2026-04-01";
    setSurfacePoints(prev=>[...prev,{id:"s"+surfaceNextId, strike:spot, expiry:exp, iv:25}]);
    setSurfaceNextId(n=>n+1);
  };
  const addSurfaceTenor = () => {
    // Add a new tenor with 2 placeholder points (minimum required)
    const exp = "2026-04-01";
    const id1 = surfaceNextId, id2 = surfaceNextId+1;
    setSurfacePoints(prev=>[...prev,
      {id:"s"+id1, strike:+(spot*0.95).toFixed(1), expiry:exp, iv:25},
      {id:"s"+id2, strike:+(spot*1.05).toFixed(1), expiry:exp, iv:25},
    ]);
    setSurfaceNextId(n=>n+2);
  };
  const updateSurfacePoint = (id,field,val) =>
    setSurfacePoints(prev=>prev.map(p=>p.id===id?{...p,[field]:val}:p));
  const removeSurfacePoint = id =>
    setSurfacePoints(prev=>prev.filter(p=>p.id!==id));

  const surfaceIvColor = useCallback((iv) => {
    if(iv==null) return "#f0f2f5";
    const {min,max} = surfaceIvColorRange;
    const t = Math.max(0, Math.min(1, (iv-min)/(max-min||1)));
    // blue (low) → white (mid) → red (high)
    let r, g, b;
    if (t < 0.5) {
      const s = t * 2; // 0→1
      r = Math.round(40  + s * (255 - 40));
      g = Math.round(100 + s * (255 - 100));
      b = Math.round(200 + s * (255 - 200));
    } else {
      const s = (t - 0.5) * 2; // 0→1
      r = 255;
      g = Math.round(255 - s * (255 - 40));
      b = Math.round(255 - s * (255 - 40));
    }
    return `rgb(${r},${g},${b})`;
  }, [surfaceIvColorRange]);


  // ── P&L chart tooltip helpers ───────────────────────────────────────────────
  const pnlChartCostBasis = useMemo(() => {
    let cost = 0;
    processedLegs.forEach(l => {
      const entryIV = (l.baseIV != null ? l.baseIV : l.iv) / 100;
      cost += bs(spot, spot*(l.strikePct/100), T, rf, entryIV, l.type).price
        * l.qty * (l.dir==="long"?1:-1) * 100;
    });
    return Math.abs(cost);
  }, [processedLegs, spot, T, rf]);




  // ── Instant P&L check values (P&L tab sliders) ──────────────────────────────
  const instantPnL = useMemo(() => {
    const shiftedS = spot*(1+spotShift/100);
    let entryVal=0, currentVal=0;
    processedLegs.forEach(l=>{
      const strike = spot*(l.strikePct/100);
      const entryIV   = (l.baseIV != null ? l.baseIV : l.iv) / 100;
      const currentIV = Math.max(0.001, entryIV + volShift/100);
      entryVal   += bs(spot,     strike, T, rf, entryIV,   l.type).price * l.qty*(l.dir==="long"?1:-1)*100;
      currentVal += bs(shiftedS, strike, T, rf, currentIV, l.type).price * l.qty*(l.dir==="long"?1:-1)*100;
    });
    const pnl = currentVal - entryVal;
    const absCost = Math.abs(entryVal);
    const moic = absCost > 0.01 ? (currentVal / absCost) : null;
    return {
      shiftedS,
      pnl,
      absCost,
      moic,
      moicStr:  moic != null ? moic.toFixed(2)+"x" : "—",
      moicColor: moic == null ? "#5a6e85" : moic >= 1 ? "#00875a" : "#c0182e",
    };
  }, [processedLegs, spot, spotShift, T, rf, volShift]);

  // ── Custom shock live P&L (scenarios slider) ─────────────────────────────────
  const customShockPnL = useMemo(() => {
    let pnl=0;
    processedLegs.forEach(l => {
      const strike = spot*(l.strikePct/100);
      const entryIV = (l.baseIV != null ? l.baseIV : l.iv) / 100;
      const newIV = Math.max(0.01, entryIV + volShift/100);
      const newS  = spot*(1+spotShift/100);
      const entry = bs(spot,  strike, T, rf, entryIV, l.type).price;
      const shock = bs(newS,  strike, T, rf, newIV,   l.type).price;
      pnl += (shock-entry)*l.qty*(l.dir==="long"?1:-1)*100;
    });
    return pnl;
  }, [processedLegs, spot, spotShift, volShift, T, rf]);

  // ——— Position Lab analytics ———————————————————————————————————————————————————
  const evalPositionScenario = useCallback((spotPct = 0, volPts = 0, daysForward = 0, rateShiftBps = 0) => {
    const scenarioSpot = spot * (1 + spotPct / 100);
    const scenarioT = Math.max(T - daysForward / 365, 0.001);
    const scenarioRf = Math.max(-0.05, rf + rateShiftBps / 10000);
    let entryValue = 0;
    let currentValue = 0;
    let intrinsicValue = 0;
    let extrinsicValue = 0;
    let delta = 0, gamma = 0, theta = 0, vega = 0, rho = 0;

    processedLegs.forEach((l) => {
      const strike = spot * (l.strikePct / 100);
      const entryIV = (l.baseIV != null ? l.baseIV : l.iv) / 100;
      const scenarioIV = Math.max(0.001, entryIV + volPts / 100);
      const sign = l.dir === "long" ? 1 : -1;
      const mult = l.qty * sign * 100;

      const entry = bs(spot, strike, T, rf, entryIV, l.type);
      const current = bs(scenarioSpot, strike, scenarioT, scenarioRf, scenarioIV, l.type);
      const intrinsicPx = l.type === "call" ? Math.max(scenarioSpot - strike, 0) : Math.max(strike - scenarioSpot, 0);

      entryValue += entry.price * mult;
      currentValue += current.price * mult;
      intrinsicValue += intrinsicPx * mult;
      extrinsicValue += (current.price - intrinsicPx) * mult;
      delta += current.delta * mult;
      gamma += current.gamma * mult;
      theta += current.theta * mult;
      vega += current.vega * mult;
      rho += (current.rho || 0) * mult;
    });

    const pnl = currentValue - entryValue;
    return {
      scenarioSpot,
      scenarioT,
      scenarioRf,
      scenarioRfPct: scenarioRf * 100,
      entryValue,
      currentValue,
      pnl,
      intrinsicValue,
      extrinsicValue,
      delta,
      gamma,
      theta,
      vega,
      rho,
    };
  }, [processedLegs, spot, T, rf]);

  const payoffAtExpiry = useMemo(() => generatePnLCurve(processedLegs, spot, T, rf, dte, 0), [processedLegs, spot, T, rf, dte]);

  const labBreakEven = useMemo(() => {
    if (!payoffAtExpiry || payoffAtExpiry.length < 2) return null;
    for (let i = 1; i < payoffAtExpiry.length; i++) {
      const p0 = payoffAtExpiry[i - 1];
      const p1 = payoffAtExpiry[i];
      if (p0.pnl === 0) return p0.spot;
      if ((p0.pnl < 0 && p1.pnl > 0) || (p0.pnl > 0 && p1.pnl < 0)) {
        const w = Math.abs(p0.pnl) / (Math.abs(p0.pnl) + Math.abs(p1.pnl));
        return +(p0.spot + (p1.spot - p0.spot) * w).toFixed(2);
      }
    }
    return null;
  }, [payoffAtExpiry]);

  const positionNow = useMemo(() => evalPositionScenario(0, 0, 0, 0), [evalPositionScenario]);

  const priceSensitivityRows = useMemo(() => {
    return [-30, -20, -10, -5, 0, 5, 10, 20, 30].map((pct) => {
      const s = evalPositionScenario(pct, 0, 0, 0);
      return {
        priceChange: pct,
        underlying: +s.scenarioSpot.toFixed(2),
        optionPrice: +(s.currentValue / 100).toFixed(2),
        positionValue: +s.currentValue.toFixed(2),
        pnl: +s.pnl.toFixed(2),
      };
    });
  }, [evalPositionScenario]);

  const timeDecayRows = useMemo(() => {
    const days = [...new Set([0, 7, 14, 30, 60, dte].filter((x) => x <= dte))].sort((a, b) => a - b);
    return days.map((day) => {
      const s = evalPositionScenario(0, 0, day, 0);
      return {
        daysForward: day,
        optionPrice: +(s.currentValue / 100).toFixed(2),
        positionValue: +s.currentValue.toFixed(2),
        pnl: +s.pnl.toFixed(2),
      };
    });
  }, [evalPositionScenario, dte]);

  const ivSensitivityRows = useMemo(() => {
    return [-20, -10, -5, 0, 5, 10, 20].map((ivShift) => {
      const s = evalPositionScenario(0, ivShift, 0, 0);
      return {
        ivChange: ivShift,
        ivLevel: +(Math.max(0.1, aggMetrics.avgIV + ivShift)).toFixed(2),
        optionPrice: +(s.currentValue / 100).toFixed(2),
        positionValue: +s.currentValue.toFixed(2),
        pnl: +s.pnl.toFixed(2),
      };
    });
  }, [evalPositionScenario, aggMetrics.avgIV]);

  const heatmapPriceShifts = useMemo(() => [-20, -10, 0, 10, 20], []);
  const heatmapDays = useMemo(() => [...new Set([0, 7, 14, 30, 60].filter((x) => x <= dte))].sort((a, b) => a - b), [dte]);
  const priceTimeHeatmapRows = useMemo(() => {
    return heatmapPriceShifts.map((pct) => {
      const row = { priceChange: pct };
      heatmapDays.forEach((day) => {
        row[`d${day}`] = +evalPositionScenario(pct, 0, day, 0).pnl.toFixed(2);
      });
      return row;
    });
  }, [evalPositionScenario, heatmapDays, heatmapPriceShifts]);

  const heatmapRange = useMemo(() => {
    const vals = priceTimeHeatmapRows.flatMap((r) => heatmapDays.map((d) => r[`d${d}`]));
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    return { min: Number.isFinite(min) ? min : 0, max: Number.isFinite(max) ? max : 0 };
  }, [priceTimeHeatmapRows, heatmapDays]);

  const greekExposureRows = useMemo(() => {
    return [-10, 0, 10].map((pct) => {
      const s = evalPositionScenario(pct, 0, 0, 0);
      return {
        priceMove: pct,
        delta: +s.delta.toFixed(3),
        gamma: +s.gamma.toFixed(4),
        theta: +s.theta.toFixed(2),
        vega: +s.vega.toFixed(2),
        rho: +s.rho.toFixed(3),
      };
    });
  }, [evalPositionScenario]);

  const labScenario = useMemo(() => {
    return evalPositionScenario(labSpotShift, labVolShift, labDaysForward, labRateShiftBps);
  }, [evalPositionScenario, labSpotShift, labVolShift, labDaysForward, labRateShiftBps]);

  const strategyAggregationRows = useMemo(() => {
    return processedLegs.map((l) => {
      const strike = spot * (l.strikePct / 100);
      const sigma = (l.baseIV != null ? l.baseIV : l.iv) / 100;
      const px = bs(spot, strike, T, rf, sigma, l.type).price;
      return {
        id: l.id,
        leg: `${l.dir === "long" ? "L" : "S"}${l.qty}`,
        type: l.type.toUpperCase(),
        strike: +strike.toFixed(2),
        exp: expiryDate,
        qty: l.qty,
        price: +px.toFixed(2),
      };
    });
  }, [processedLegs, spot, T, rf, expiryDate]);

  const probabilityRows = useMemo(() => {
    const shifts = [-20, -10, 0, 10, 20];
    const sigma = Math.max(0.01, aggMetrics.avgIV / 100);
    if (T <= 0) {
      return shifts.map((shift) => {
        const snap = evalPositionScenario(shift, 0, 0, 0);
        return { shift, probability: shift === 0 ? 1 : 0, pnl: +snap.pnl.toFixed(2) };
      });
    }
    const mu = Math.log(spot) + (rf - 0.5 * sigma * sigma) * T;
    const sd = sigma * Math.sqrt(T);
    const levels = shifts.map((s) => spot * (1 + s / 100));
    const boundaries = [0];
    for (let i = 0; i < levels.length - 1; i++) boundaries.push((levels[i] + levels[i + 1]) / 2);
    boundaries.push(Infinity);

    const rows = shifts.map((shift, i) => {
      const lo = boundaries[i];
      const hi = boundaries[i + 1];
      const zLo = lo <= 0 ? -Infinity : (Math.log(lo) - mu) / sd;
      const zHi = hi === Infinity ? Infinity : (Math.log(hi) - mu) / sd;
      const probability = Math.max(0, normCDF(zHi) - normCDF(zLo));
      const snap = evalPositionScenario(shift, 0, 0, 0);
      return { shift, probability, pnl: +snap.pnl.toFixed(2) };
    });
    return rows;
  }, [aggMetrics.avgIV, T, spot, rf, evalPositionScenario]);

  const probabilityExpectedPnl = useMemo(() => {
    return probabilityRows.reduce((s, r) => s + r.probability * r.pnl, 0);
  }, [probabilityRows]);

  // ─── UI HELPERS ─────────────────────────────────────────────────────────
  const fmtPnl = v => (v>=0?"+":"")+v.toFixed(2);
  const fmtPct = v => (v>=0?"+":"")+v.toFixed(1)+"%";
  const clr = v => v>=0?"#00875a":"#c0182e";

  const TABS = ["overview","positionlab","pnl","vol","greeks","scenarios","capital","surface"];
  const TAB_LABELS = {
    overview: "overview",
    positionlab: "position lab",
    pnl: "p&l",
    vol: "vol",
    greeks: "greeks",
    scenarios: "scenarios",
    capital: "capital",
    surface: "surface",
  };
  
  const addLeg = () => {
    setLegs(prev=>[...prev, { id:nextId, type:"call", dir:"long", qty:1, strikePct:100, iv:25, bidPrice: null, askPrice: null }]);
    setNextId(n=>n+1);
    setStrategy("Custom");
  };
  const removeLeg = id => setLegs(prev=>prev.filter(l=>l.id!==id));
  const updateLeg = (id, field, val) => {
    setLegs(prev=>prev.map(l=>l.id===id?{...l,[field]:val}:l));
    setStrategy("Custom");
  };

  // ─── RENDER ─────────────────────────────────────────────────────────────
  return (
    <div style={{
      fontFamily:"'JetBrains Mono', 'Fira Code', 'Consolas', monospace",
      background:"#f0f2f5",
      minHeight:"100vh",
      color:"#1a2332",
      fontSize:12,
    }}>
      {/* Global styles */}
      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@300;400;500;700&family=Syne:wght@400;700;800&display=swap');
        html, body, #root { height:auto !important; min-height:100vh; overflow:visible !important; display:block !important; }
        * { box-sizing:border-box; margin:0; padding:0; }
        ::-webkit-scrollbar { width:4px; height:4px; background:#f8fafc; }
        ::-webkit-scrollbar-thumb { background:#a8b8cc; border-radius:2px; }
        input[type=range] { -webkit-appearance:none; height:3px; border-radius:2px; background:#c5cdd8; outline:none; }
        input[type=range]::-webkit-slider-thumb { -webkit-appearance:none; width:12px; height:12px; border-radius:50%; background:#00d9a0; cursor:pointer; }
        input[type=number], select { background:#f8fafc; border:1px solid #c5cdd8; color:#1a2332; padding:4px 8px; border-radius:4px; font-family:inherit; font-size:11px; outline:none; }
        input[type=number]:focus, select:focus { border-color:#006b44; }
        .tab-btn { background:none; border:none; cursor:pointer; font-family:inherit; font-size:11px; padding:8px 16px; color:#5a6e85; transition:all 0.2s; letter-spacing:0.05em; text-transform:uppercase; }
        .tab-btn.active { color:#0055a5; border-bottom:2px solid #0055a5; }
        .tab-btn:hover { color:#1a2332; }
        .metric-card { background:#f8fafc; border:1px solid #c5cdd8; border-radius:6px; padding:12px 16px; }
        .metric-card:hover { border-color:#a8b8cc; }
        .grid-2 { display:grid; grid-template-columns:1fr 1fr; gap:8px; }
        .grid-3 { display:grid; grid-template-columns:1fr 1fr 1fr; gap:8px; }
        .grid-4 { display:grid; grid-template-columns:1fr 1fr 1fr 1fr; gap:8px; }
        .badge { display:inline-block; padding:2px 8px; border-radius:3px; font-size:10px; font-weight:700; letter-spacing:0.1em; }
        .badge-long { background:#d4f5e9; color:#006b44; border:1px solid #a3e4c7; }
        .badge-short { background:#fde8ec; color:#c0182e; border:1px solid #f5b8c2; }
        .scenario-row:hover { background:#f8fafc; }
        .leg-row { background:#ffffff; border:1px solid #dde3eb; border-radius:6px; padding:6px 8px; margin-bottom:6px; display:grid; grid-template-columns:28px 80px 80px 52px 110px 80px 70px 70px 70px 28px; gap:6px; align-items:center; }
        .btn { background:#f8fafc; border:1px solid #c5cdd8; color:#1a2332; padding:5px 12px; border-radius:4px; cursor:pointer; font-family:inherit; font-size:11px; transition:all 0.15s; }
        .btn:hover { border-color:#006b44; color:#006b44; }
        .btn-primary { background:#d4f5e9; border-color:#a3e4c7; color:#006b44; }
        .btn-danger { border-color:#f5b8c2; color:#c0182e; }
        .btn-danger:hover { background:#fde8ec; border-color:#c0182e; }
        .section-title { font-family:'Syne',sans-serif; font-size:10px; font-weight:700; letter-spacing:0.15em; text-transform:uppercase; color:#5a6e85; margin-bottom:8px; }
        .tooltip-custom { background:#f8fafc!important; border:1px solid #a8b8cc!important; border-radius:4px!important; font-family:inherit!important; font-size:11px!important; }
      `}</style>

      {/* Header */}
      <div style={{background:"#ffffff", borderBottom:"1px solid #dde3eb", padding:"12px 24px", display:"flex", alignItems:"center", gap:24}}>
        <div>
          <div style={{fontFamily:"'Syne',sans-serif", fontSize:16, fontWeight:800, color:"#1a2332", letterSpacing:"-0.02em"}}>
            OPTIX <span style={{color:"#00875a"}}>PRO</span>
          </div>
          <div style={{fontSize:10, color:"#5a6e85", letterSpacing:"0.1em"}}>OPTIONS ANALYTICS ENGINE</div>
        </div>
        <div style={{width:1, height:32, background:"#c5cdd8"}}/>
        {/* Ticker + Save/Load */}
        <div style={{display:"flex", alignItems:"center", gap:6, position:"relative"}}>
          <span style={{fontSize:9, color:"#5a6e85", letterSpacing:"0.1em"}}>TICKER</span>
          <input value={ticker} onChange={e=>setTicker(e.target.value.toUpperCase())}
            style={{width:70, fontWeight:700, textTransform:"uppercase", letterSpacing:"0.05em"}}
            placeholder="AAPL"/>
          {/* Save input + button */}
          <input value={saveNameDraft} onChange={e=>setSaveNameDraft(e.target.value)}
            placeholder={ticker||"name"}
            style={{width:70, fontSize:10}}
            onKeyDown={e=>e.key==="Enter"&&saveToWatchlist()}/>
          <button className="btn btn-primary" onClick={saveToWatchlist}
            style={{padding:"4px 10px", fontSize:10, whiteSpace:"nowrap"}}>
            💾 Save
          </button>
          {/* Watchlist toggle */}
          <div style={{position:"relative"}}>
            <button className="btn" onClick={()=>setWatchlistOpen(v=>!v)}
              style={{padding:"4px 10px", fontSize:10, background: watchlistOpen?"#e8f3fc":"#f0f2f5",
                border:"1px solid "+(watchlistOpen?"#a3cef0":"#dde3eb"), whiteSpace:"nowrap"}}>
              📋 Watchlist {watchlist.length>0&&<span style={{background:"#0055a5",color:"#fff",
                borderRadius:8,padding:"0 5px",fontSize:9,marginLeft:3}}>{watchlist.length}</span>}
              {isCloudEnabled()&&<span style={{marginLeft:4,fontSize:8,color:"#006b44",fontWeight:700}}>☁</span>}
            </button>
            {watchlistOpen && (
              <div style={{position:"absolute", top:"calc(100% + 6px)", left:0, zIndex:1000,
                background:"#ffffff", border:"1px solid #dde3eb", borderRadius:8,
                boxShadow:"0 8px 24px rgba(0,0,0,0.12)", minWidth:300, maxHeight:420, overflowY:"auto"}}>
                <div style={{padding:"10px 14px", borderBottom:"1px solid #f0f2f5",
                  fontSize:10, fontWeight:700, color:"#1a2332", letterSpacing:"0.1em"}}>
                  SAVED TICKERS
                </div>
                {watchlist.length===0 ? (
                  <div style={{padding:20, textAlign:"center", color:"#a8b8cc", fontSize:11}}>
                    No saved tickers yet. Enter a name and click Save.
                  </div>
                ) : watchlist.map(w=>(
                  <div key={w.ticker} style={{display:"flex", alignItems:"center", gap:8,
                    padding:"10px 14px", borderBottom:"1px solid #f8fafc",
                    cursor:"pointer", transition:"background 0.15s"}}
                    onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"}
                    onMouseLeave={e=>e.currentTarget.style.background="transparent"}>
                    <div style={{flex:1}} onClick={()=>loadFromWatchlist(w)}>
                      <div style={{fontWeight:700, color:"#1a2332", fontSize:12}}>{w.ticker}</div>
                      <div style={{fontSize:9, color:"#a8b8cc", marginTop:1}}>
                        Spot {w.spot} · {w.legs?.length||0} leg{w.legs?.length!==1?"s":""} · {w.surfacePoints?.length||0} surface pts
                        · saved {new Date(w.savedAt).toLocaleDateString()}
                      </div>
                    </div>
                    <button onClick={e=>{e.stopPropagation();loadFromWatchlist(w);}}
                      style={{fontSize:10, background:"#e8f3fc", color:"#0055a5",
                        border:"1px solid #a3cef0", borderRadius:4, padding:"3px 8px", cursor:"pointer", whiteSpace:"nowrap"}}>
                      Load
                    </button>
                    <button onClick={e=>{e.stopPropagation();deleteFromWatchlist(w.ticker);}}
                      style={{fontSize:12, background:"#fde8ec", color:"#c0182e",
                        border:"1px solid #f5b8c2", borderRadius:4, padding:"3px 8px", cursor:"pointer"}}>
                      ×
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
        <div style={{width:1, height:32, background:"#c5cdd8"}}/>
        {/* Quick inputs */}
        <div style={{display:"flex", gap:16, alignItems:"center", flexWrap:"wrap"}}>
          {/* SPOT */}
          <div style={{display:"flex", alignItems:"center", gap:6}}>
            <span style={{fontSize:9, color:"#5a6e85", letterSpacing:"0.1em"}}>SPOT</span>
            <input type="number" value={spot} min={1} max={10000} step={0.5}
              onChange={e=>setSpot(+e.target.value)} style={{width:70}}/>
          </div>
          {/* EXPIRY DATE → DTE */}
          <div style={{display:"flex", alignItems:"center", gap:6}}>
            <span style={{fontSize:9, color:"#5a6e85", letterSpacing:"0.1em"}}>EXPIRY</span>
            <input type="date" value={expiryDate} min={todayStr}
              onChange={e=>setExpiryDate(e.target.value)}
              style={{padding:"4px 6px", border:"1px solid #c5cdd8", borderRadius:4,
                background:"#ffffff", color:"#1a2332", fontSize:11, fontFamily:"inherit"}}/>
            <div style={{background:"#e8f3fc", border:"1px solid #a3cef0", borderRadius:4,
              padding:"3px 8px", fontSize:11, fontWeight:700, color:"#0055a5", whiteSpace:"nowrap"}}>
              {dte}d
            </div>
          </div>
          {/* RATE — dynamic, shown read-only */}
          <div style={{display:"flex", alignItems:"center", gap:6}}>
            <span style={{fontSize:9, color:"#5a6e85", letterSpacing:"0.1em"}}>RATE</span>
            <div style={{background:"#f0f2f5", border:"1px solid #c5cdd8", borderRadius:4,
              padding:"4px 8px", fontSize:11, color:"#5a6e85", fontWeight:600, whiteSpace:"nowrap"}}>
              {getRiskFreeRate(dte).toFixed(2)}%
            </div>
          </div>
          {/* STRATEGY */}
          <div style={{display:"flex", alignItems:"center", gap:6}}>
            <span style={{fontSize:9, color:"#5a6e85", letterSpacing:"0.1em"}}>STRATEGY</span>
            <select value={strategy} onChange={e=>applyStrategy(e.target.value)} style={{width:150}}>
              {STRATEGIES.map(s=><option key={s}>{s}</option>)}
            </select>
          </div>
        </div>
        <div style={{marginLeft:"auto", display:"flex", gap:16, alignItems:"center"}}>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:9, color:"#5a6e85"}}>POSITION VALUE</div>
            <div style={{fontSize:16, fontWeight:700, color:clr(-aggMetrics.totalCost)}}>
              {aggMetrics.totalCost>0 ? "+" : ""}{aggMetrics.totalCost.toFixed(2)}
            </div>
          </div>
          <div style={{width:1, height:32, background:"#dde3eb"}}/>
          <div style={{textAlign:"right"}}>
            <div style={{fontSize:9, color:"#5a6e85"}}>OPTION VALUE</div>
            <div style={{fontSize:14, fontWeight:700, color:"#0055a5"}}>
              {(()=>{
                let val=0;
                processedLegs.forEach(l=>{
                  const iv = Math.max(0.001, (l.baseIV??l.iv)/100 + volShift/100);
                  val += bs(spot*(1+spotShift/100), spot*(l.strikePct/100), T, rf, iv, l.type).price
                    * l.qty * (l.dir==="long"?1:-1);
                });
                return (val>=0?"+":"")+val.toFixed(2);
              })()}
            </div>
          </div>

        </div>
      </div>

      {/* ── STRUCTURE BUILDER (always visible, above tabs) ── */}
      <div style={{background:"#ffffff", borderBottom:"1px solid #dde3eb", padding:"10px 24px 14px"}}>
        <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:6}}>
          <div>
            <div className="section-title" style={{marginBottom:0}}>Structure Builder</div>
            <div style={{display:"flex", alignItems:"center", gap:8, marginTop:2}}>
              <span style={{fontSize:9, color:"#7a8ea5"}}>Enter Bid $ / Ask $ from Fidelity chain → model back-solves IV</span>
              {surfaceEnabled && (
                <span style={{fontSize:9, background:"#d4f5e9", color:"#006b44", padding:"2px 7px",
                  borderRadius:3, fontWeight:700, border:"1px solid #a3e4c7"}}>
                  ↗ SURFACE ACTIVE — legs auto-fill IV from fitted surface
                </span>
              )}
            </div>
          </div>
          <button className="btn btn-primary" onClick={addLeg}>+ Add Leg</button>
        </div>
        {/* Header row */}
        <div style={{display:"grid", gridTemplateColumns:"28px 70px 72px 46px 120px 76px 130px 76px 28px", gap:6, padding:"4px 8px", fontSize:9, color:"#5a6e85", letterSpacing:"0.1em", marginBottom:4}}>
          {["","TYPE","DIR","QTY","STRIKE %","STRIKE ($)","BID $ / ASK $ (Fidelity)","MID IV (solved)",""].map((h,i)=>(
            <div key={i} style={{textAlign: i===0||i===8 ? "center" : "left"}}>{h}</div>
          ))}
        </div>
        {legs.map((l, idx)=>{
          return (
            <div key={l.id} style={{
              background:"#f8fafc", border:"1px solid #dde3eb", borderRadius:6,
              padding:"6px 8px", marginBottom:6,
              display:"grid",
              gridTemplateColumns:"28px 70px 72px 46px 120px 76px 130px 76px 28px",
              gap:6, alignItems:"center"
            }}>
              <div style={{width:20, height:20, borderRadius:3, background:"#e2e6ec", display:"flex", alignItems:"center", justifyContent:"center", fontSize:9, color:"#5a6e85", fontWeight:700}}>{idx+1}</div>
              <select value={l.type} onChange={e=>updateLeg(l.id,"type",e.target.value)} style={{width:"100%"}}>
                <option value="call">Call</option>
                <option value="put">Put</option>
              </select>
              <select value={l.dir} onChange={e=>updateLeg(l.id,"dir",e.target.value)}
                style={{width:"100%", color:l.dir==="long"?"#006b44":"#c0182e", fontWeight:600}}>
                <option value="long">Long</option>
                <option value="short">Short</option>
              </select>
              <input type="number" value={l.qty} min={1} max={100} step={1}
                onChange={e=>updateLeg(l.id,"qty",+e.target.value)} style={{width:"100%"}}/>
              <div style={{display:"flex", flexDirection:"column", gap:2}}>
                <input type="number" value={l.strikePct} min={50} max={150} step={0.5}
                  onChange={e=>updateLeg(l.id,"strikePct",+e.target.value)} style={{width:"100%"}}/>
                <input type="range" min={50} max={150} step={0.5} value={l.strikePct}
                  onChange={e=>updateLeg(l.id,"strikePct",+e.target.value)} style={{width:"100%"}}/>
              </div>
              <input type="number" value={(spot*l.strikePct/100).toFixed(2)} readOnly
                style={{width:"100%", color:"#0055a5", background:"#f0f4f8", cursor:"default", fontWeight:600}}/>
              <div style={{display:"flex", gap:3, alignItems:"center"}}>
                <div style={{flex:1}}>
                  <div style={{fontSize:8, color:"#c0182e", letterSpacing:"0.05em", marginBottom:1}}>BID $</div>
                  <input type="number" value={l.bidPrice ?? ""} min={0.01} max={9999} step={0.01}
                    placeholder="e.g. 10.05"
                    onChange={e=>updateLeg(l.id,"bidPrice", e.target.value===""?null:+e.target.value)}
                    style={{width:"100%", borderColor:"#f5b8c2"}}/>
                </div>
                <div style={{fontSize:10, color:"#a8b8cc", paddingTop:12}}>/</div>
                <div style={{flex:1}}>
                  <div style={{fontSize:8, color:"#006b44", letterSpacing:"0.05em", marginBottom:1}}>ASK $</div>
                  <input type="number" value={l.askPrice ?? ""} min={0.01} max={9999} step={0.01}
                    placeholder="e.g. 12.50"
                    onChange={e=>updateLeg(l.id,"askPrice", e.target.value===""?null:+e.target.value)}
                    style={{width:"100%", borderColor:"#a3e4c7"}}/>
                </div>
              </div>
              {(() => {
                const pl = processedLegs.find(p=>p.id===l.id) || {};
                const hasPrices = l.bidPrice != null || l.askPrice != null;
                const biv = pl.bidIV, aiv = pl.askIV;
                const mid = pl.baseIV != null ? pl.baseIV.toFixed(1) : (l.iv||25).toFixed(1);
                const spd = (biv != null && aiv != null) ? (aiv - biv).toFixed(1) : null;
                const src = hasPrices ? "price" : pl.fromSurface ? "surface" : "manual";
                const srcColors = {
                  price:   { bg:"#e8f3fc", text:"#0055a5", label:"solved ↑" },
                  surface: { bg:"#d4f5e9", text:"#006b44", label:"↗ surface" },
                  manual:  { bg:"#f0f2f5", text:"#a8b8cc", label:"manual" },
                };
                const sc = srcColors[src];
                return (
                  <div style={{textAlign:"center", padding:"2px 0"}}>
                    <div style={{fontSize:14, fontWeight:700, color: src==="manual"?"#a8b8cc":"#0055a5"}}>{mid}%</div>
                    {spd && (
                      <div style={{fontSize:8, color:"#5a6e85", marginTop:1}}>
                        {biv!=null?biv.toFixed(1):"—"} / {aiv!=null?aiv.toFixed(1):"—"}
                      </div>
                    )}
                    {spd && <div style={{fontSize:8, color:"#a8b8cc"}}>spd {spd}v</div>}
                    <div style={{fontSize:8, background:sc.bg, color:sc.text,
                      borderRadius:3, padding:"1px 4px", marginTop:2, display:"inline-block", fontWeight:700}}>
                      {sc.label}
                    </div>
                    {src==="manual" && !surfaceEnabled && (
                      <div style={{fontSize:7, color:"#c5cdd8", marginTop:1}}>enter prices or enable surface</div>
                    )}
                  </div>
                );
              })()}
              <button className="btn btn-danger" onClick={()=>removeLeg(l.id)}
                style={{width:26,height:26,display:"flex",alignItems:"center",justifyContent:"center",padding:0,fontSize:14}}>×</button>
            </div>
          );
        })}
      </div>

      {/* Tabs */}
      <div style={{background:"#ffffff", borderBottom:"1px solid #dde3eb", padding:"0 24px", display:"flex"}}>
        {TABS.map(t=>(
          <button key={t} className={`tab-btn ${activeTab===t?"active":""}`} onClick={()=>setActiveTab(t)}>{TAB_LABELS[t] || t}</button>
        ))}
      </div>

      <div style={{padding:16}}>

        {/* ── OVERVIEW TAB ── */}
        {activeTab==="overview" && (
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
            {/* Left: trade translation */}
            <div>
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">Trade Translation</div>
                <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8}}>
                  {[
                    { label:"DIRECTION", val: aggMetrics.delta>0.1?"BULLISH":aggMetrics.delta<-0.1?"BEARISH":"NEUTRAL" },
                    { label:"HORIZON", val: `${dte}D (${(dte/7).toFixed(0)}W)` },
                    { label:"VOL VIEW", val: aggMetrics.vrp>0?"SHORT VOL (IV>RV)":"LONG VOL (IV<RV)" },
                    { label:"STRUCTURE", val: Math.abs(aggMetrics.gamma)>0.1&&Math.abs(aggMetrics.vega)>5?"CONVEXITY":Math.abs(aggMetrics.delta)>0.3?"DIRECTIONAL":"VOL PLAY" },
                  ].map(x=>(
                    <div key={x.label} style={{padding:8, background:"#f0f2f5", borderRadius:4, border:"1px solid #dde3eb"}}>
                      <div style={{fontSize:9, color:"#5a6e85", letterSpacing:"0.1em"}}>{x.label}</div>
                      <div style={{fontSize:13, fontWeight:700, color:"#1a2332", marginTop:2}}>{x.val}</div>
                    </div>
                  ))}
                </div>
              </div>

              {/* IV vs Realized */}
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">Implied vs Realized Volatility</div>
                {[
                  { label:"Avg Mid IV (your legs)", val:aggMetrics.avgIV.toFixed(1)+"%", color:"#0055a5" },
                  { label:"20d Realized Vol", val:rv20+"%", color:"#0055a5" },
                  { label:"60d Realized Vol", val:rv60+"%", color:"#0055a5" },
                  { label:"1Y Realized Vol",  val:rv1y+"%", color:"#0055a5" },
                  { label:"Vol Risk Premium",  val:(aggMetrics.avgIV-rv20).toFixed(1)+" vols", color:aggMetrics.vrp>0?"#c05a00":"#00875a" },
                  { label:"IV 1Y Percentile",  val:iv1yPct+"%", color:"#1a2332" },
                  { label:"BE Realized Vol",   val:aggMetrics.breakEvenRV.toFixed(1)+"%", color:"#c05a00" },
                ].map(x=>(
                  <div key={x.label} style={{display:"flex", justifyContent:"space-between", alignItems:"center", padding:"5px 0", borderBottom:"1px solid #f8fafc"}}>
                    <span style={{color:"#5a6e85"}}>{x.label}</span>
                    <span style={{color:x.color, fontWeight:700}}>{x.val}</span>
                  </div>
                ))}
                {/* IV Percentile bar */}
                <div style={{marginTop:8}}>
                  <div style={{fontSize:9, color:"#5a6e85", marginBottom:4}}>IV 1Y PERCENTILE RANK</div>
                  <div style={{height:6, background:"#dde3eb", borderRadius:3, position:"relative"}}>
                    <div style={{position:"absolute", left:0, width:`${iv1yPct}%`, height:"100%", background:`hsl(${120-iv1yPct*1.2},65%,38%)`, borderRadius:3, transition:"width 0.3s"}}/>
                    <div style={{position:"absolute", left:`${iv1yPct}%`, top:-3, width:2, height:12, background:"#1a2332", borderRadius:1, transform:"translateX(-50%)"}}/>
                  </div>
                  <div style={{display:"flex", justifyContent:"space-between", fontSize:9, color:"#8a9eb5", marginTop:2}}>
                    <span>LOW</span><span>MED</span><span>HIGH</span>
                  </div>
                </div>
                {/* RV inputs */}
                <div style={{marginTop:8, display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:4}}>
                  {[{l:"RV20",v:rv20,s:setRv20},{l:"RV60",v:rv60,s:setRv60},{l:"RV1Y",v:rv1y,s:setRv1y},{l:"IV%ile",v:iv1yPct,s:setIv1yPct}].map(x=>(
                    <div key={x.l}>
                      <div style={{fontSize:9, color:"#5a6e85"}}>{x.l}</div>
                      <input type="number" value={x.v} min={0} max={100} step={0.5} onChange={e=>x.s(+e.target.value)} style={{width:"100%"}}/>
                    </div>
                  ))}
                </div>
              </div>
            </div>

            {/* Right: Aggregate Greeks */}
            <div>
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">Aggregate Greeks</div>
                <div className="grid-2" style={{marginBottom:8}}>
                  {[
                    {l:"DELTA (net)",v:aggMetrics.delta.toFixed(3),sub:`${(aggMetrics.delta*spot/100*1).toFixed(2)} / 1% move`},
                    {l:"GAMMA",v:aggMetrics.gamma.toFixed(4),sub:`convexity onset`},
                    {l:"VEGA",v:aggMetrics.vega.toFixed(2),sub:`per 1 vol pt`},
                    {l:"THETA",v:aggMetrics.theta.toFixed(2),sub:`per day`},
                    {l:"CHARM",v:aggMetrics.charm.toFixed(4),sub:`Δ decay / day`},
                    {l:"VOMMA",v:aggMetrics.vomma.toFixed(4),sub:`vol convexity`},
                  ].map(x=>(
                    <div key={x.l} style={{padding:10, background:"#f0f2f5", borderRadius:4, border:"1px solid #dde3eb"}}>
                      <div style={{fontSize:9, color:"#5a6e85", letterSpacing:"0.1em"}}>{x.l}</div>
                      <div style={{fontSize:16, fontWeight:700, color:"#1a2332", margin:"2px 0"}}>{x.v}</div>
                      <div style={{fontSize:9, color:"#8a9eb5"}}>{x.sub}</div>
                    </div>
                  ))}
                </div>
              </div>
              {/* Per-leg IV smile */}
              <div className="metric-card">
                <div className="section-title">Your Leg IVs — Mid from Fidelity</div>
                <ResponsiveContainer width="100%" height={150}>
                  <ScatterChart margin={{top:4,right:8,bottom:16,left:0}}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="strike" type="number" name="Strike" tick={{fontSize:9,fill:"#5a6e85"}} domain={["auto","auto"]} label={{value:"Strike",position:"insideBottom",fill:"#5a6e85",fontSize:9}}/>
                    <YAxis dataKey="iv" type="number" name="IV %" tick={{fontSize:9,fill:"#5a6e85"}} domain={["auto","auto"]}/>
                    <Tooltip contentStyle={{background:"#fff",border:"1px solid #dde3eb",fontSize:10}}
                      content={({payload})=>{
                        if(!payload||!payload[0]) return null;
                        const d=payload[0].payload;
                        return <div style={{background:"#fff",border:"1px solid #dde3eb",padding:"5px 8px",borderRadius:4,fontSize:10}}>
                          <b>{d.label}</b><br/>Mid: {d.iv}% | Bid: {d.bid}% | Ask: {d.ask}%
                        </div>;
                      }}
                    />
                    <ReferenceLine x={spot} stroke="#00875a" strokeDasharray="3 3" opacity={0.7}/>
                    <Scatter data={skewCurve} fill="#0055a5" r={6} name="Mid IV"/>
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}

        {/* ── P&L TAB ── */}
        
        {/* POSITION LAB TAB */}
        {activeTab==="positionlab" && (
          <div style={{display:"grid", gridTemplateColumns:"1fr", gap:16}}>
            <div className="metric-card">
              <div className="section-title">Position Summary</div>
              <div className="grid-4">
                {[
                  { l: "Underlying (S)", v: positionNow.scenarioSpot.toFixed(2), c: "#0055a5" },
                  { l: "Days to Expiry", v: `${dte}d`, c: "#1a2332" },
                  { l: "Current Option Price (net)", v: (positionNow.currentValue/100).toFixed(2), c: "#0055a5" },
                  { l: "Position Market Value", v: positionNow.currentValue.toFixed(2), c: "#0055a5" },
                  { l: "Unrealized P&L", v: fmtPnl(positionNow.pnl), c: clr(positionNow.pnl) },
                  { l: "Break-even (approx)", v: labBreakEven != null ? labBreakEven.toFixed(2) : "�", c: "#c05a00" },
                  { l: "Intrinsic Value", v: positionNow.intrinsicValue.toFixed(2), c: "#00875a" },
                  { l: "Extrinsic Value", v: positionNow.extrinsicValue.toFixed(2), c: "#c05a00" },
                ].map((m) => (
                  <div key={m.l} style={{padding:10, background:"#f0f2f5", borderRadius:4, border:"1px solid #dde3eb"}}>
                    <div style={{fontSize:9, color:"#5a6e85"}}>{m.l}</div>
                    <div style={{fontSize:14, fontWeight:700, color:m.c, marginTop:2}}>{m.v}</div>
                  </div>
                ))}
              </div>
            </div>

            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
              <div className="metric-card">
                <div className="section-title">Price Sensitivity Table</div>
                <table style={{width:"100%", borderCollapse:"collapse", fontSize:10}}>
                  <thead>
                    <tr style={{borderBottom:"1px solid #dde3eb"}}>
                      {["Price Change","Underlying","Option Price","Position Value","P&L"].map((h)=><th key={h} style={{padding:"4px 6px", textAlign:"right", color:"#5a6e85"}}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {priceSensitivityRows.map((r) => (
                      <tr key={r.priceChange} style={{background:`${r.pnl>=0?"#edf9f4":"#fdeff1"}`}}>
                        <td style={{padding:"4px 6px",textAlign:"right"}}>{r.priceChange>0?`+${r.priceChange}%`:`${r.priceChange}%`}</td>
                        <td style={{padding:"4px 6px",textAlign:"right"}}>{r.underlying.toFixed(2)}</td>
                        <td style={{padding:"4px 6px",textAlign:"right"}}>{r.optionPrice.toFixed(2)}</td>
                        <td style={{padding:"4px 6px",textAlign:"right"}}>{r.positionValue.toFixed(2)}</td>
                        <td style={{padding:"4px 6px",textAlign:"right",fontWeight:700,color:clr(r.pnl)}}>{fmtPnl(r.pnl)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="metric-card">
                <div className="section-title">P&L vs Price (Today)</div>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={priceSensitivityRows}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="underlying" tick={{fontSize:9, fill:"#5a6e85"}}/>
                    <YAxis tick={{fontSize:9, fill:"#5a6e85"}}/>
                    <Tooltip/>
                    <ReferenceLine y={0} stroke="#8a9eb5"/>
                    <Line type="monotone" dataKey="pnl" stroke="#0055a5" strokeWidth={2} dot={false}/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
              <div className="metric-card">
                <div className="section-title">Time Decay</div>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={timeDecayRows}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="daysForward" tick={{fontSize:9, fill:"#5a6e85"}}/>
                    <YAxis tick={{fontSize:9, fill:"#5a6e85"}}/>
                    <Tooltip/>
                    <ReferenceLine y={0} stroke="#8a9eb5"/>
                    <Area type="monotone" dataKey="pnl" stroke="#c05a00" fill="#fff4e5" strokeWidth={2}/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              <div className="metric-card">
                <div className="section-title">IV Sensitivity</div>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={ivSensitivityRows}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="ivChange" tick={{fontSize:9, fill:"#5a6e85"}}/>
                    <YAxis tick={{fontSize:9, fill:"#5a6e85"}}/>
                    <Tooltip/>
                    <ReferenceLine y={0} stroke="#8a9eb5"/>
                    <Line type="monotone" dataKey="pnl" stroke="#006b44" strokeWidth={2} dot={false}/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
              <div className="metric-card">
                <div className="section-title">Price vs Time Heatmap</div>
                <table style={{width:"100%", borderCollapse:"separate", borderSpacing:4, fontSize:10}}>
                  <thead>
                    <tr>
                      <th style={{textAlign:"right", color:"#5a6e85"}}>Price \\ Days</th>
                      {heatmapDays.map((d)=><th key={d} style={{textAlign:"center", color:"#5a6e85"}}>{d}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {priceTimeHeatmapRows.map((r) => (
                      <tr key={r.priceChange}>
                        <td style={{textAlign:"right", color:"#1a2332", fontWeight:700, paddingRight:6}}>{r.priceChange>0?`+${r.priceChange}%`:`${r.priceChange}%`}</td>
                        {heatmapDays.map((d) => {
                          const v = r[`d${d}`];
                          const min = heatmapRange.min;
                          const max = heatmapRange.max;
                          const t = (v - min) / ((max - min) || 1);
                          const bg = v >= 0 ? `rgba(0,135,90,${0.15 + 0.65*t})` : `rgba(192,24,46,${0.15 + 0.65*(1-t)})`;
                          return <td key={d} style={{textAlign:"center", padding:"6px 4px", borderRadius:4, background:bg, color:"#1a2332", fontWeight:700}}>{fmtPnl(v)}</td>;
                        })}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <div className="metric-card">
                <div className="section-title">Payoff Diagram (Expiry)</div>
                <ResponsiveContainer width="100%" height={220}>
                  <LineChart data={payoffAtExpiry}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="spot" tick={{fontSize:9, fill:"#5a6e85"}}/>
                    <YAxis tick={{fontSize:9, fill:"#5a6e85"}}/>
                    <Tooltip/>
                    <ReferenceLine y={0} stroke="#8a9eb5"/>
                    <ReferenceLine x={spot} stroke="#c5cdd8" strokeDasharray="3 3"/>
                    {labBreakEven != null && <ReferenceLine x={labBreakEven} stroke="#c05a00" strokeDasharray="3 3"/>}
                    <Line type="monotone" dataKey="pnl" stroke="#0055a5" dot={false} strokeWidth={2}/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
              <div className="metric-card">
                <div className="section-title">Greek Exposure Panel</div>
                <table style={{width:"100%", borderCollapse:"collapse", fontSize:10}}>
                  <thead>
                    <tr style={{borderBottom:"1px solid #dde3eb"}}>{["Price Move","Delta","Gamma","Theta","Vega","Rho"].map((h)=><th key={h} style={{padding:"4px 6px",textAlign:"right",color:"#5a6e85"}}>{h}</th>)}</tr>
                  </thead>
                  <tbody>
                    {greekExposureRows.map((r)=><tr key={r.priceMove}><td style={{padding:"4px 6px",textAlign:"right"}}>{r.priceMove>0?`+${r.priceMove}%`:`${r.priceMove}%`}</td><td style={{padding:"4px 6px",textAlign:"right"}}>{r.delta.toFixed(3)}</td><td style={{padding:"4px 6px",textAlign:"right"}}>{r.gamma.toFixed(4)}</td><td style={{padding:"4px 6px",textAlign:"right"}}>{r.theta.toFixed(2)}</td><td style={{padding:"4px 6px",textAlign:"right"}}>{r.vega.toFixed(2)}</td><td style={{padding:"4px 6px",textAlign:"right"}}>{r.rho.toFixed(3)}</td></tr>)}
                  </tbody>
                </table>
              </div>
              <div className="metric-card">
                <div className="section-title">Scenario Builder</div>
                <div className="grid-2">
                  <div><div style={{fontSize:9,color:"#5a6e85"}}>Underlying Shift %</div><input type="range" min={-30} max={30} value={labSpotShift} onChange={(e)=>setLabSpotShift(+e.target.value)} style={{width:"100%"}}/></div>
                  <div><div style={{fontSize:9,color:"#5a6e85"}}>IV Shift pts</div><input type="range" min={-20} max={20} value={labVolShift} onChange={(e)=>setLabVolShift(+e.target.value)} style={{width:"100%"}}/></div>
                  <div><div style={{fontSize:9,color:"#5a6e85"}}>Days Forward</div><input type="range" min={0} max={Math.max(1,dte)} value={labDaysForward} onChange={(e)=>setLabDaysForward(+e.target.value)} style={{width:"100%"}}/></div>
                  <div><div style={{fontSize:9,color:"#5a6e85"}}>Rate Shift (bps)</div><input type="range" min={-200} max={200} step={5} value={labRateShiftBps} onChange={(e)=>setLabRateShiftBps(+e.target.value)} style={{width:"100%"}}/></div>
                </div>
                <div style={{marginTop:8,fontSize:11,color:"#1a2332"}}>Value: <b>{labScenario.currentValue.toFixed(2)}</b> | P&L: <b style={{color:clr(labScenario.pnl)}}>{fmtPnl(labScenario.pnl)}</b></div>
              </div>
            </div>

            <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
              <div className="metric-card">
                <div className="section-title">Strategy Aggregation</div>
                <table style={{width:"100%", borderCollapse:"collapse", fontSize:10}}>
                  <thead><tr style={{borderBottom:"1px solid #dde3eb"}}>{["Leg","Type","Strike","Exp","Qty","Price"].map((h)=><th key={h} style={{padding:"4px 6px",textAlign:"right",color:"#5a6e85"}}>{h}</th>)}</tr></thead>
                  <tbody>{strategyAggregationRows.map((r)=><tr key={r.id}><td style={{padding:"4px 6px",textAlign:"right"}}>{r.leg}</td><td style={{padding:"4px 6px",textAlign:"right"}}>{r.type}</td><td style={{padding:"4px 6px",textAlign:"right"}}>{r.strike.toFixed(2)}</td><td style={{padding:"4px 6px",textAlign:"right"}}>{r.exp.slice(5)}</td><td style={{padding:"4px 6px",textAlign:"right"}}>{r.qty}</td><td style={{padding:"4px 6px",textAlign:"right"}}>{r.price.toFixed(2)}</td></tr>)}</tbody>
                </table>
              </div>
              <div className="metric-card">
                <div className="section-title">Probability-weighted P&L</div>
                <table style={{width:"100%", borderCollapse:"collapse", fontSize:10}}>
                  <thead><tr style={{borderBottom:"1px solid #dde3eb"}}>{["Price Level","Probability","P&L"].map((h)=><th key={h} style={{padding:"4px 6px",textAlign:"right",color:"#5a6e85"}}>{h}</th>)}</tr></thead>
                  <tbody>{probabilityRows.map((r)=><tr key={r.shift}><td style={{padding:"4px 6px",textAlign:"right"}}>{r.shift>0?`+${r.shift}%`:`${r.shift}%`}</td><td style={{padding:"4px 6px",textAlign:"right"}}>{(r.probability*100).toFixed(1)}%</td><td style={{padding:"4px 6px",textAlign:"right",fontWeight:700,color:clr(r.pnl)}}>{fmtPnl(r.pnl)}</td></tr>)}</tbody>
                </table>
                <div style={{marginTop:10,padding:10,background:"#eef4fb",border:"1px solid #cfe0f5",borderRadius:4}}>
                  <div style={{fontSize:9,color:"#5a6e85"}}>Expected Value</div>
                  <div style={{fontSize:16,fontWeight:700,color:clr(probabilityExpectedPnl)}}>{fmtPnl(probabilityExpectedPnl)}</div>
                </div>
              </div>
            </div>
          </div>
        )}
        {activeTab==="pnl" && (
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
            <div>
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">P&L vs Spot (Multiple Time Slices)</div>
                <div style={{display:"flex", gap:8, marginBottom:8, alignItems:"center"}}>
                  <span style={{fontSize:9, color:"#5a6e85"}}>VOL SHIFT</span>
                  <input type="range" min={-15} max={15} value={volShift} onChange={e=>setVolShift(+e.target.value)} style={{width:100}}/>
                  <span style={{color:volShift>=0?"#00875a":"#c0182e", fontSize:10, fontWeight:700}}>{volShift>=0?"+":""}{volShift} vols</span>
                </div>
                <ResponsiveContainer width="100%" height={260}>
                  <LineChart data={combinedPnL}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="spot" tick={{fontSize:9, fill:"#5a6e85"}} tickCount={7}/>
                    <YAxis tick={{fontSize:9, fill:"#5a6e85"}}/>
                    <Tooltip content={(props)=>{
                      const {active,payload,label}=props;
                      if(!active||!payload||!payload.length) return null;
                      return (
                        <div style={{background:"#ffffff",border:"1px solid #dde3eb",borderRadius:6,
                          padding:"10px 14px",fontSize:11,boxShadow:"0 2px 8px rgba(0,0,0,0.10)",minWidth:180}}>
                          <div style={{fontWeight:700,color:"#1a2332",marginBottom:8,
                            borderBottom:"1px solid #f0f2f5",paddingBottom:6}}>
                            Spot: <span style={{color:"#0055a5"}}>{(+label).toFixed(2)}</span>
                          </div>
                          {PnLChartSlices.map(sl=>{
                            const entry=payload.find(p=>p.dataKey===sl.key);
                            if(!entry||entry.value==null) return null;
                            const pnl=entry.value;
                            const moic=pnlChartCostBasis>0.01?((pnlChartCostBasis+pnl)/pnlChartCostBasis):null;
                            const pnlColor=pnl>=0?"#00875a":"#c0182e";
                            const moicColor=moic==null?"#a8b8cc":moic>=1?"#0055a5":"#c0182e";
                            return (
                              <div key={sl.key} style={{display:"flex",justifyContent:"space-between",
                                alignItems:"center",marginBottom:5,gap:16}}>
                                <span style={{color:sl.color,fontWeight:600,minWidth:70}}>{sl.key}</span>
                                <span style={{color:pnlColor,fontWeight:700,minWidth:60,textAlign:"right"}}>
                                  {pnl>=0?"+":""}{pnl.toFixed(2)}
                                </span>
                                <span style={{color:moicColor,fontWeight:700,fontSize:10,
                                  background:moic==null?"#f0f2f5":moic>=1?"#e8f3fc":"#fde8ec",
                                  padding:"1px 6px",borderRadius:3,minWidth:48,textAlign:"center"}}>
                                  {moic!=null?moic.toFixed(2)+"x":"—"}
                                </span>
                              </div>
                            );
                          })}
                          {pnlChartCostBasis>0.01&&(
                            <div style={{marginTop:6,paddingTop:6,borderTop:"1px solid #f0f2f5",
                              fontSize:9,color:"#a8b8cc"}}>
                              cost basis: ${pnlChartCostBasis.toFixed(2)}
                            </div>
                          )}
                        </div>
                      );
                    }}/>
                    <Legend wrapperStyle={{fontSize:9}}/>
                    <ReferenceLine y={0} stroke="#8a9eb5"/>
                    <ReferenceLine x={spot} stroke="#c5cdd8" strokeDasharray="3 3" label={{value:"entry",fill:"#a8b8cc",fontSize:8}}/>
                    <ReferenceLine x={+(spot*(1+spotShift/100)).toFixed(2)} stroke="#0055a5" strokeDasharray="3 3" label={{value:"now",fill:"#0055a5",fontSize:8}}/>
                    {PnLChartSlices.map((sl,i)=>(
                      <Line key={sl.key} type="monotone" dataKey={sl.key} stroke={sl.color} dot={false}
                        strokeWidth={i===0||i===PnLChartSlices.length-1?2:1.5}
                        strokeDasharray={i===0||i===PnLChartSlices.length-1?undefined:"4 2"}/>
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {/* Theta decay */}
              <div className="metric-card">
                <div className="section-title">Theta Decay — P&L Trajectory (at spot)</div>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={thetaDecay}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="day" tick={{fontSize:9, fill:"#5a6e85"}} label={{value:"Days elapsed",position:"insideBottom",fill:"#5a6e85",fontSize:9}}/>
                    <YAxis tick={{fontSize:9, fill:"#5a6e85"}}/>
                    <Tooltip content={(props)=>{
                      const {active,payload,label}=props;
                      if(!active||!payload?.length) return null;
                      const pnl=payload[0].value;
                      let absCost=0;
                      processedLegs.forEach(l=>{const entryIV=(l.baseIV??l.iv)/100;absCost+=Math.abs(bs(spot,spot*(l.strikePct/100),T,rf,entryIV,l.type).price*l.qty*100);});
                      const moic=absCost>0.01?((absCost+pnl)/absCost):null;
                      const pc=pnl>=0?"#00875a":"#c0182e";
                      const mc=moic==null?"#a8b8cc":moic>=1?"#0055a5":"#c0182e";
                      return <div style={{background:"#ffffff",border:"1px solid #dde3eb",borderRadius:6,padding:"10px 14px",fontSize:11,boxShadow:"0 2px 8px rgba(0,0,0,0.10)"}}>
                        <div style={{fontWeight:700,color:"#1a2332",marginBottom:6,borderBottom:"1px solid #f0f2f5",paddingBottom:5}}>Day {label}</div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3}}>
                          <span style={{color:"#5a6e85"}}>P&L</span>
                          <span style={{color:pc,fontWeight:700}}>{pnl>=0?"+":""}{pnl.toFixed(2)}</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16}}>
                          <span style={{color:"#5a6e85"}}>MOIC</span>
                          <span style={{background:moic==null?"#f0f2f5":moic>=1?"#e8f3fc":"#fde8ec",color:mc,padding:"1px 6px",borderRadius:3,fontWeight:700,fontSize:10}}>
                            {moic!=null?moic.toFixed(2)+"x":"—"}
                          </span>
                        </div>
                      </div>;
                    }}/>
                    <ReferenceLine y={0} stroke="#8a9eb5"/>
                    <Area type="monotone" dataKey="pnl" stroke="#c05a00" fill="#fff4e5" strokeWidth={2} name="Cumul P&L"/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
            {/* Vol sensitivity */}
            <div>
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">P&L vs Volatility Shift (Parallel)</div>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={volSensitivity}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="volShift" tick={{fontSize:9, fill:"#5a6e85"}} label={{value:"Vol shift (pts)",position:"insideBottom",fill:"#5a6e85",fontSize:9}}/>
                    <YAxis tick={{fontSize:9, fill:"#5a6e85"}}/>
                    <Tooltip content={(props)=>{
                      const {active,payload,label}=props;
                      if(!active||!payload?.length) return null;
                      const pnl=payload[0].value;
                      let absCost=0;
                      processedLegs.forEach(l=>{const entryIV=(l.baseIV??l.iv)/100;absCost+=Math.abs(bs(spot,spot*(l.strikePct/100),T,rf,entryIV,l.type).price*l.qty*100);});
                      const moic=absCost>0.01?((absCost+pnl)/absCost):null;
                      const pc=pnl>=0?"#00875a":"#c0182e";
                      const mc=moic==null?"#a8b8cc":moic>=1?"#0055a5":"#c0182e";
                      return <div style={{background:"#ffffff",border:"1px solid #dde3eb",borderRadius:6,padding:"10px 14px",fontSize:11,boxShadow:"0 2px 8px rgba(0,0,0,0.10)"}}>
                        <div style={{fontWeight:700,color:"#1a2332",marginBottom:6,borderBottom:"1px solid #f0f2f5",paddingBottom:5}}>
                          Vol shift: <span style={{color:"#0055a5"}}>{label>=0?"+":""}{label} pts</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3}}>
                          <span style={{color:"#5a6e85"}}>P&L</span>
                          <span style={{color:pc,fontWeight:700}}>{pnl>=0?"+":""}{pnl.toFixed(2)}</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16}}>
                          <span style={{color:"#5a6e85"}}>MOIC</span>
                          <span style={{background:moic==null?"#f0f2f5":moic>=1?"#e8f3fc":"#fde8ec",color:mc,padding:"1px 6px",borderRadius:3,fontWeight:700,fontSize:10}}>
                            {moic!=null?moic.toFixed(2)+"x":"—"}
                          </span>
                        </div>
                      </div>;
                    }}/>
                    <ReferenceLine y={0} stroke="#8a9eb5"/>
                    <ReferenceLine x={0} stroke="#5a6e85" strokeDasharray="3 3"/>
                    <Area type="monotone" dataKey="pnl" stroke="#0055a5" fill="#e8f3fc" strokeWidth={2} name="P&L"/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              {/* P&L by spot shift slider */}
              <div className="metric-card">
                <div className="section-title">Instant P&L Check</div>
                <div style={{display:"flex", flexDirection:"column", gap:8}}>
                  <div style={{display:"flex", alignItems:"center", gap:8}}>
                    <span style={{fontSize:9, color:"#5a6e85", width:70}}>SPOT SHIFT</span>
                    <input type="range" min={-30} max={30} value={spotShift} onChange={e=>setSpotShift(+e.target.value)} style={{flex:1}}/>
                    <span style={{color:spotShift>=0?"#00875a":"#c0182e", fontWeight:700, width:40}}>{spotShift>=0?"+":""}{spotShift}%</span>
                  </div>
                  <div style={{display:"flex", alignItems:"center", gap:8}}>
                    <span style={{fontSize:9, color:"#5a6e85", width:70}}>VOL SHIFT</span>
                    <input type="range" min={-20} max={20} value={volShift} onChange={e=>setVolShift(+e.target.value)} style={{flex:1}}/>
                    <span style={{color:volShift>=0?"#00875a":"#c0182e", fontWeight:700, width:40}}>{volShift>=0?"+":""}{volShift}</span>
                  </div>
                </div>
                <div style={{marginTop:16, display:"grid", gridTemplateColumns:"1fr 1fr 1fr 1fr", gap:8}}>
                  {[
                    {l:"New Spot",  v:instantPnL.shiftedS.toFixed(2),       c:"#1a2332"},
                    {l:"P&L",       v:fmtPnl(instantPnL.pnl),               c:clr(instantPnL.pnl)},
                    {l:"MOIC",      v:instantPnL.moicStr,                   c:instantPnL.moicColor},
                    {l:"Net Delta", v:aggMetrics.delta.toFixed(3),          c:"#1a2332"},
                  ].map(x=>(
                    <div key={x.l} style={{padding:10, background:"#f0f2f5", borderRadius:4, border:"1px solid #dde3eb", textAlign:"center"}}>
                      <div style={{fontSize:9, color:"#5a6e85"}}>{x.l}</div>
                      <div style={{fontSize:14, fontWeight:700, color:x.c}}>{x.v}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── VOL TAB ── */}
        {activeTab==="vol" && (
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
            <div>
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">Volatility Surface Summary</div>
                <table style={{width:"100%", borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{borderBottom:"1px solid #dde3eb"}}>
                      {["Metric","Value","Signal"].map(h=><th key={h} style={{textAlign:"left",padding:"6px 8px",fontSize:9,color:"#5a6e85",letterSpacing:"0.1em"}}>{h}</th>)}
                    </tr>
                  </thead>
                  <tbody>
                    {[
                      {m:"ATM IV",v:`${aggMetrics.avgIV.toFixed(1)}%`,s:iv1yPct>70?"ELEVATED":iv1yPct<30?"COMPRESSED":"NORMAL",sc:iv1yPct>70?"#c05a00":iv1yPct<30?"#00875a":"#1a2332"},
                      {m:"20d RV",v:`${rv20}%`,s:aggMetrics.avgIV>rv20?"IV>RV (VRP +ve)":"IV<RV (VRP -ve)",sc:aggMetrics.avgIV>rv20?"#c05a00":"#00875a"},
                      {m:"VRP (IV-RV20)",v:`${(aggMetrics.avgIV-rv20).toFixed(1)} vols`,s:aggMetrics.vrp>3?"Sell vol candidate":aggMetrics.vrp<-2?"Buy vol candidate":"Fair",sc:aggMetrics.vrp>3?"#c0182e":aggMetrics.vrp<-2?"#00875a":"#1a2332"},
                      {m:"BE RV (long)",v:`${aggMetrics.breakEvenRV.toFixed(1)}%`,s:rv20>aggMetrics.breakEvenRV?"Trade +EV":"Trade -EV",sc:rv20>aggMetrics.breakEvenRV?"#00875a":"#c0182e"},
                      {m:"IV 1Y %ile",v:`${iv1yPct}%ile`,s:iv1yPct>80?"RICH":iv1yPct<20?"CHEAP":"FAIR",sc:iv1yPct>80?"#c0182e":iv1yPct<20?"#00875a":"#1a2332"},
                      {m:"Expected Move",v:`±${(aggMetrics.avgIV/100*Math.sqrt(dte/365)*spot*0.6827).toFixed(2)}`,s:"1σ over DTE",sc:"#0055a5"},
                    ].map(x=>(
                      <tr key={x.m} style={{borderBottom:"1px solid #f8fafc"}}>
                        <td style={{padding:"7px 8px",color:"#1a2332"}}>{x.m}</td>
                        <td style={{padding:"7px 8px",fontWeight:700,color:x.sc}}>{x.v}</td>
                        <td style={{padding:"7px 8px"}}><span style={{fontSize:9,background:"#ffffff",color:x.sc,padding:"2px 6px",borderRadius:3}}>{x.s}</span></td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              {/* Term structure (synthetic) */}
              <div className="metric-card">
                <div className="section-title">Term Structure (Synthetic)</div>
                <ResponsiveContainer width="100%" height={180}>
                  <LineChart data={[7,14,21,30,45,60,90,120,180,360].map(d=>{
                    const baseIV = aggMetrics.avgIV;
                    const ts = baseIV + (rv20-baseIV)*(1-Math.exp(-d/90));
                    return {dte:d, iv:+ts.toFixed(1)};
                  })}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="dte" tick={{fontSize:9,fill:"#5a6e85"}} label={{value:"DTE",position:"insideBottom",fill:"#5a6e85",fontSize:9}}/>
                    <YAxis tick={{fontSize:9,fill:"#5a6e85"}}/>
                    <Tooltip content={(props)=>{
                      const {active,payload,label}=props;
                      if(!active||!payload?.length) return null;
                      const iv=payload[0].value;
                      const atmIV=aggMetrics.avgIV;
                      const diff=(iv-atmIV).toFixed(1);
                      return <div style={{background:"#ffffff",border:"1px solid #dde3eb",borderRadius:6,padding:"10px 14px",fontSize:11,boxShadow:"0 2px 8px rgba(0,0,0,0.10)"}}>
                        <div style={{fontWeight:700,color:"#1a2332",marginBottom:6,borderBottom:"1px solid #f0f2f5",paddingBottom:5}}>
                          DTE: <span style={{color:"#0055a5"}}>{label}d</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3}}>
                          <span style={{color:"#5a6e85"}}>IV</span><span style={{color:"#00875a",fontWeight:700}}>{iv}%</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3}}>
                          <span style={{color:"#5a6e85"}}>vs your DTE</span>
                          <span style={{color:diff>=0?"#c0182e":"#00875a",fontWeight:700}}>{diff>=0?"+":""}{diff} vols</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16}}>
                          <span style={{color:"#5a6e85"}}>Structure</span>
                          <span style={{background:"#f0f2f5",color:"#5a6e85",padding:"1px 6px",borderRadius:3,fontSize:10}}>
                            {label<dte?"front":"back"}
                          </span>
                        </div>
                      </div>;
                    }}/>
                    <ReferenceLine x={dte} stroke="#00875a" strokeDasharray="3 3" label={{value:"now",fill:"#00875a",fontSize:9}}/>
                    <Line type="monotone" dataKey="iv" stroke="#00875a" dot={false} strokeWidth={2} name="IV"/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>
            {/* Per-leg IV from Fidelity chain */}
            <div>
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">Vol Smile — Your Leg IVs vs Strike</div>
                <div style={{fontSize:9, color:"#7a8ea5", marginBottom:8}}>
                  Dots = mid IV per leg. Bid/ask bars show the spread you pay/receive.
                </div>
                <ResponsiveContainer width="100%" height={200}>
                  <ScatterChart margin={{top:4,right:8,bottom:4,left:0}}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="strike" type="number" name="Strike" tick={{fontSize:9,fill:"#5a6e85"}} domain={["auto","auto"]} label={{value:"Strike",position:"insideBottom",fill:"#5a6e85",fontSize:9}}/>
                    <YAxis dataKey="iv" type="number" name="IV %" tick={{fontSize:9,fill:"#5a6e85"}} domain={["auto","auto"]} label={{value:"IV %",angle:-90,position:"insideLeft",fill:"#5a6e85",fontSize:9}}/>
                    <Tooltip cursor={{strokeDasharray:"3 3"}} contentStyle={{background:"#ffffff",border:"1px solid #dde3eb",fontSize:10}}
                      content={({payload})=>{
                        if(!payload||!payload[0]) return null;
                        const d=payload[0].payload;
                        return <div style={{background:"#fff",border:"1px solid #dde3eb",padding:"6px 10px",borderRadius:4,fontSize:10}}>
                          <div style={{fontWeight:700,marginBottom:3}}>{d.label}</div>
                          <div>Strike: <b>{d.strike}</b></div>
                          <div style={{color:"#c0182e"}}>Bid IV: <b>{d.bid}%</b></div>
                          <div style={{color:"#006b44"}}>Ask IV: <b>{d.ask}%</b></div>
                          <div style={{color:"#0055a5"}}>Mid IV: <b>{d.iv}%</b></div>
                          <div style={{color:"#7a8ea5"}}>Spread: <b>{d.ask && d.bid ? (d.ask-d.bid).toFixed(1) : "—"} vols</b></div>
                        </div>;
                      }}
                    />
                    <ReferenceLine x={spot} stroke="#00875a" strokeDasharray="3 3" label={{value:"spot",fill:"#00875a",fontSize:9}}/>
                    <Scatter data={skewCurve} fill="#0055a5" shape={(props)=>{
                      const {cx,cy,payload} = props;
                      if(!payload) return null;
                      return <g>
                        <circle cx={cx} cy={cy} r={6} fill="#0055a5" opacity={0.9}/>
                        <text x={cx} y={cy-10} textAnchor="middle" fontSize={8} fill="#5a6e85">{payload.label}</text>
                      </g>;
                    }} name="Mid IV"/>
                  </ScatterChart>
                </ResponsiveContainer>
              </div>

              {/* Per-leg IV detail table */}
              <div className="metric-card">
                <div className="section-title">Per-Leg IV Detail — from Fidelity Chain</div>
                <table style={{width:"100%", borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{borderBottom:"1px solid #dde3eb"}}>
                      {["Leg","Strike","Bid $","Ask $","Bid IV","Ask IV","Mid IV","Spd (vols)"].map(h=>(
                        <th key={h} style={{padding:"5px 8px",fontSize:9,color:"#5a6e85",letterSpacing:"0.08em",textAlign:h==="Leg"?"left":"right"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {processedLegs.map((l)=>{
                                            const bidIVd = l.bidIV != null ? l.bidIV.toFixed(1)+"%" : "—";
                      const askIVd = l.askIV != null ? l.askIV.toFixed(1)+"%" : "—";
                      const midIVd = (l.iv - volShift).toFixed(2)+"%";
                      const spd = (l.bidIV != null && l.askIV != null) ? (l.askIV - l.bidIV).toFixed(1) : "—";
                      return (
                        <tr key={l.id} style={{borderBottom:"1px solid #f0f2f5"}}>
                          <td style={{padding:"6px 8px",fontSize:10,color:"#1a2332"}}>
                            <span style={{fontWeight:600}}>{l.dir==="long"?"▲":"▼"}</span> {l.type} @{(l.strike||0).toFixed(2)}
                          </td>
                          <td style={{padding:"6px 8px",textAlign:"right",color:"#0055a5",fontWeight:600}}>{(l.strike||0).toFixed(2)}</td>
                          <td style={{padding:"6px 8px",textAlign:"right",color:"#c0182e",fontWeight:600}}>
                            {l.bidPrice != null ? "$"+l.bidPrice.toFixed(2) : <span style={{color:"#c5cdd8"}}>—</span>}
                          </td>
                          <td style={{padding:"6px 8px",textAlign:"right",color:"#006b44",fontWeight:600}}>
                            {l.askPrice != null ? "$"+l.askPrice.toFixed(2) : <span style={{color:"#c5cdd8"}}>—</span>}
                          </td>
                          <td style={{padding:"6px 8px",textAlign:"right",color:"#c0182e"}}>{bidIVd}</td>
                          <td style={{padding:"6px 8px",textAlign:"right",color:"#006b44"}}>{askIVd}</td>
                          <td style={{padding:"6px 8px",textAlign:"right",color:"#0055a5",fontWeight:700}}>{midIVd}</td>
                          <td style={{padding:"6px 8px",textAlign:"right",color:"#c05a00"}}>{spd}</td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
                <div style={{marginTop:8, padding:"6px 8px", background:"#f8fafc", borderRadius:4, fontSize:9, color:"#7a8ea5", border:"1px solid #dde3eb"}}>
                  💡 <b>Fidelity workflow:</b> Options chain → find your strike row → copy the <b>Bid</b> and <b>Ask</b> prices → paste into the BID$/ASK$ fields in the Structure Builder below. The model back-solves IV from those prices automatically and uses the mid for all calculations.
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── GREEKS TAB ── */}
        {activeTab==="greeks" && (
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
            <div>
              {/* Greeks table per leg */}
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">Greeks by Leg</div>
                <div style={{overflowX:"auto"}}>
                  <table style={{width:"100%", borderCollapse:"collapse", minWidth:600}}>
                    <thead>
                      <tr style={{borderBottom:"1px solid #dde3eb"}}>
                        {["Leg","Delta","Gamma","Vega","Theta","Charm","Vomma"].map(h=>(
                          <th key={h} style={{textAlign:"right",padding:"6px 8px",fontSize:9,color:"#5a6e85",letterSpacing:"0.1em",":first-child":{textAlign:"left"}}}>{h}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {greeksByLeg.map((g,i)=>(
                        <tr key={i} style={{borderBottom:"1px solid #f8fafc"}}>
                          <td style={{padding:"7px 8px",color:"#1a2332",fontSize:10}}>{g.leg}</td>
                          {["delta","gamma","vega","theta","charm","vomma"].map(k=>(
                            <td key={k} style={{padding:"7px 8px",textAlign:"right",fontWeight:600,color:g[k]>=0?"#00875a":"#c0182e"}}>{g[k]}</td>
                          ))}
                        </tr>
                      ))}
                      <tr style={{borderTop:"2px solid #a8b8cc",background:"#f0f2f5"}}>
                        <td style={{padding:"7px 8px",color:"#1a2332",fontSize:10,fontWeight:700}}>TOTAL</td>
                        {["delta","gamma","vega","theta","charm","vomma"].map(k=>{
                          const t=greeksByLeg.reduce((s,g)=>s+g[k],0);
                          return <td key={k} style={{padding:"7px 8px",textAlign:"right",fontWeight:700,color:t>=0?"#00875a":"#c0182e"}}>{t.toFixed(4)}</td>;
                        })}
                      </tr>
                    </tbody>
                  </table>
                </div>
              </div>
              {/* Delta per 1% move */}
              <div className="metric-card">
                <div className="section-title">Dollar Greeks (per $100 notional block)</div>
                <div className="grid-2">
                  {[
                    {l:"$ Delta / 1% move",v:(aggMetrics.delta*spot*0.01).toFixed(2),c:"#00875a"},
                    {l:"$ Gamma / 1% move²",v:(aggMetrics.gamma*spot*spot*0.0001*0.5).toFixed(2),c:"#0055a5"},
                    {l:"$ Vega / vol pt",v:(aggMetrics.vega).toFixed(2),c:"#c05a00"},
                    {l:"$ Theta / day",v:(aggMetrics.theta).toFixed(2),c:"#c0182e"},
                  ].map(x=>(
                    <div key={x.l} style={{padding:10, background:"#f0f2f5", borderRadius:4, border:"1px solid #dde3eb"}}>
                      <div style={{fontSize:9, color:"#5a6e85"}}>{x.l}</div>
                      <div style={{fontSize:16, fontWeight:700, color:x.c, marginTop:4}}>{x.v}</div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div>
              {/* Delta profile across spot */}
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">Delta Profile vs Spot</div>
                <ResponsiveContainer width="100%" height={200}>
                  <LineChart data={Array.from({length:41},(_,i)=>spot*(0.8+i*0.01)).map(s=>{
                    let d=0;
                    processedLegs.forEach(l=>{
                      const g = bs(s, spot*(l.strikePct/100), T, rf, l.iv/100, l.type);
                      d += g.delta*l.qty*(l.dir==="long"?1:-1)*100;
                    });
                    return {spot:+s.toFixed(1), delta:+d.toFixed(3)};
                  })}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="spot" tick={{fontSize:9,fill:"#5a6e85"}} tickCount={6}/>
                    <YAxis tick={{fontSize:9,fill:"#5a6e85"}}/>
                    <Tooltip content={(props)=>{
                      const {active,payload,label}=props;
                      if(!active||!payload?.length) return null;
                      const delta=payload[0].value;
                      const dollarDelta=(delta*(+label)*0.01).toFixed(2);
                      const dc=delta>=0?"#00875a":"#c0182e";
                      return <div style={{background:"#ffffff",border:"1px solid #dde3eb",borderRadius:6,padding:"10px 14px",fontSize:11,boxShadow:"0 2px 8px rgba(0,0,0,0.10)"}}>
                        <div style={{fontWeight:700,color:"#1a2332",marginBottom:6,borderBottom:"1px solid #f0f2f5",paddingBottom:5}}>
                          Spot: <span style={{color:"#0055a5"}}>{(+label).toFixed(2)}</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3}}>
                          <span style={{color:"#5a6e85"}}>Delta</span><span style={{color:dc,fontWeight:700}}>{delta.toFixed(3)}</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16}}>
                          <span style={{color:"#5a6e85"}}>$ / 1% move</span><span style={{color:dc,fontWeight:700}}>{dollarDelta>=0?"+":""}{dollarDelta}</span>
                        </div>
                      </div>;
                    }}/>
                    <ReferenceLine x={spot} stroke="#5a6e85" strokeDasharray="3 3"/>
                    <ReferenceLine y={0} stroke="#8a9eb5"/>
                    <Line type="monotone" dataKey="delta" stroke="#00875a" dot={false} strokeWidth={2} name="Delta"/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {/* Gamma profile */}
              <div className="metric-card">
                <div className="section-title">Gamma Profile vs Spot</div>
                <ResponsiveContainer width="100%" height={180}>
                  <AreaChart data={Array.from({length:41},(_,i)=>spot*(0.8+i*0.01)).map(s=>{
                    let g=0;
                    processedLegs.forEach(l=>{
                      const gr = bs(s, spot*(l.strikePct/100), T, rf, l.iv/100, l.type);
                      g += gr.gamma*l.qty*(l.dir==="long"?1:-1)*100;
                    });
                    return {spot:+s.toFixed(1), gamma:+g.toFixed(5)};
                  })}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="spot" tick={{fontSize:9,fill:"#5a6e85"}} tickCount={6}/>
                    <YAxis tick={{fontSize:9,fill:"#5a6e85"}}/>
                    <Tooltip content={(props)=>{
                      const {active,payload,label}=props;
                      if(!active||!payload?.length) return null;
                      const gamma=payload[0].value;
                      const dollarGamma=(0.5*gamma*(+label)*(+label)*0.0001).toFixed(4);
                      return <div style={{background:"#ffffff",border:"1px solid #dde3eb",borderRadius:6,padding:"10px 14px",fontSize:11,boxShadow:"0 2px 8px rgba(0,0,0,0.10)"}}>
                        <div style={{fontWeight:700,color:"#1a2332",marginBottom:6,borderBottom:"1px solid #f0f2f5",paddingBottom:5}}>
                          Spot: <span style={{color:"#0055a5"}}>{(+label).toFixed(2)}</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3}}>
                          <span style={{color:"#5a6e85"}}>Gamma</span><span style={{color:"#0055a5",fontWeight:700}}>{gamma.toFixed(5)}</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16}}>
                          <span style={{color:"#5a6e85"}}>$ Gamma (½Γs²)</span><span style={{color:"#0055a5",fontWeight:700}}>{dollarGamma}</span>
                        </div>
                      </div>;
                    }}/>
                    <ReferenceLine x={spot} stroke="#5a6e85" strokeDasharray="3 3"/>
                    <ReferenceLine y={0} stroke="#8a9eb5"/>
                    <Area type="monotone" dataKey="gamma" stroke="#0055a5" fill="#e8f3fc" strokeWidth={2} name="Gamma"/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
            </div>
          </div>
        )}

        {/* ── SCENARIOS TAB ── */}
        {activeTab==="scenarios" && (
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
            <div>
              <div className="metric-card">
                <div className="section-title">Scenario Engine — Instant Shocks</div>
                <table style={{width:"100%", borderCollapse:"collapse"}}>
                  <thead>
                    <tr style={{borderBottom:"1px solid #dde3eb"}}>
                      {["Scenario","Spot Δ","Vol Δ","P&L ($)","Return %","MOIC"].map((h,i)=>(
                        <th key={h} style={{textAlign:i===0?"left":"right",padding:"7px 8px",fontSize:9,color:"#5a6e85",letterSpacing:"0.1em"}}>{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {scenarios.map((s,i)=>(
                      <tr key={i} className="scenario-row" style={{borderBottom:"1px solid #f8fafc",cursor:"pointer",transition:"background 0.15s"}}>
                        <td style={{padding:"8px 8px",color:"#1a2332",fontWeight:500}}>{s.label}</td>
                        <td style={{padding:"8px 8px",textAlign:"right",color:s.spot>=0?"#00875a":"#c0182e"}}>{s.spot>=0?"+":""}{s.spot}%</td>
                        <td style={{padding:"8px 8px",textAlign:"right",color:s.vol>=0?"#00875a":"#c0182e"}}>{s.vol>=0?"+":""}{s.vol}</td>
                        <td style={{padding:"8px 8px",textAlign:"right",fontWeight:700,color:s.pnl>=0?"#00875a":"#c0182e"}}>{fmtPnl(s.pnl)}</td>
                        <td style={{padding:"8px 8px",textAlign:"right",color:s.pct>=0?"#00875a":"#c0182e"}}>{fmtPct(s.pct)}</td>
                        <td style={{padding:"8px 8px",textAlign:"right",fontWeight:700,
                          color:s.moic==null?"#a8b8cc":s.moic>=1?"#0055a5":"#c0182e"}}>
                          {s.moic != null ? s.moic.toFixed(2)+"x" : "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
            <div>
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">P&L Scenario Chart</div>
                <ResponsiveContainer width="100%" height={240}>
                  <LineChart data={scenarios.slice(0,7)} margin={{bottom:20}}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="label" tick={{fontSize:9,fill:"#5a6e85"}} angle={-30} textAnchor="end" height={40}/>
                    <YAxis tick={{fontSize:9,fill:"#5a6e85"}}/>
                    <Tooltip content={(props)=>{
                      const {active,payload,label}=props;
                      if(!active||!payload?.length) return null;
                      const s=scenarios.find(x=>x.label===label)||{};
                      const pnl=payload[0].value;
                      const moic=s.moic;
                      const pc=pnl>=0?"#00875a":"#c0182e";
                      const mc=moic==null?"#a8b8cc":moic>=1?"#0055a5":"#c0182e";
                      return <div style={{background:"#ffffff",border:"1px solid #dde3eb",borderRadius:6,padding:"10px 14px",fontSize:11,boxShadow:"0 2px 8px rgba(0,0,0,0.10)"}}>
                        <div style={{fontWeight:700,color:"#1a2332",marginBottom:6,borderBottom:"1px solid #f0f2f5",paddingBottom:5}}>{label}</div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3}}>
                          <span style={{color:"#5a6e85"}}>Spot Δ</span><span style={{color:s.spot>=0?"#00875a":"#c0182e",fontWeight:600}}>{s.spot>=0?"+":""}{s.spot}%</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3}}>
                          <span style={{color:"#5a6e85"}}>Vol Δ</span><span style={{color:s.vol>=0?"#00875a":"#c0182e",fontWeight:600}}>{s.vol>=0?"+":""}{s.vol} pts</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3}}>
                          <span style={{color:"#5a6e85"}}>P&L</span><span style={{color:pc,fontWeight:700}}>{pnl>=0?"+":""}{pnl.toFixed(2)}</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16}}>
                          <span style={{color:"#5a6e85"}}>MOIC</span>
                          <span style={{background:moic==null?"#f0f2f5":moic>=1?"#e8f3fc":"#fde8ec",color:mc,padding:"1px 6px",borderRadius:3,fontWeight:700,fontSize:10}}>
                            {moic!=null?moic.toFixed(2)+"x":"—"}
                          </span>
                        </div>
                      </div>;
                    }}/>
                    <ReferenceLine y={0} stroke="#8a9eb5"/>
                    <Line type="monotone" dataKey="pnl" stroke="#00875a" dot={{fill:"#00875a",r:3}} strokeWidth={2} name="P&L"/>
                  </LineChart>
                </ResponsiveContainer>
              </div>
              {/* Custom shock builder */}
              <div className="metric-card">
                <div className="section-title">Custom Shock</div>
                <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:8, marginBottom:8}}>
                  <div>
                    <div style={{fontSize:9, color:"#5a6e85", marginBottom:4}}>SPOT SHIFT %</div>
                    <input type="range" min={-30} max={30} value={spotShift} onChange={e=>setSpotShift(+e.target.value)} style={{width:"100%"}}/>
                    <div style={{textAlign:"center", fontSize:11, color:"#1a2332"}}>{spotShift>=0?"+":""}{spotShift}%</div>
                  </div>
                  <div>
                    <div style={{fontSize:9, color:"#5a6e85", marginBottom:4}}>VOL SHIFT (pts)</div>
                    <input type="range" min={-20} max={20} value={volShift} onChange={e=>setVolShift(+e.target.value)} style={{width:"100%"}}/>
                    <div style={{textAlign:"center", fontSize:11, color:"#1a2332"}}>{volShift>=0?"+":""}{volShift}</div>
                  </div>
                </div>
                <div style={{padding:12, background:"#f0f2f5", borderRadius:6, border:"1px solid #dde3eb", textAlign:"center"}}>
                  <div style={{fontSize:9, color:"#5a6e85", marginBottom:4}}>LIVE P&L</div>
                  <div style={{fontSize:24, fontWeight:700, color:clr(customShockPnL)}}>
                    {fmtPnl(customShockPnL)}
                  </div>
                </div>
              </div>
            </div>
          </div>
        )}

        {/* ── CAPITAL TAB ── */}
        {activeTab==="capital" && (
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
            <div>
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">Capital Efficiency & Risk Budget</div>
                <div style={{display:"flex", gap:8, marginBottom:12, alignItems:"center"}}>
                  <span style={{fontSize:9, color:"#5a6e85"}}>MARGIN %</span>
                  <input type="range" min={5} max={100} value={margin} onChange={e=>setMargin(+e.target.value)} style={{flex:1}}/>
                  <input type="number" value={margin} min={5} max={100} step={1} onChange={e=>setMargin(+e.target.value)} style={{width:55}}/>
                  <span style={{fontSize:9, color:"#5a6e85"}}>% notional</span>
                </div>
                <div className="grid-2" style={{marginBottom:8}}>
                  {[
                    {l:"Notional",v:`$${aggMetrics.notional.toFixed(0)}`,c:"#1a2332"},
                    {l:"Margin Req",v:`$${aggMetrics.marginReq.toFixed(0)}`,c:"#c05a00"},
                    {l:"Net Premium",v:`$${aggMetrics.totalCost.toFixed(2)}`,c:clr(-aggMetrics.totalCost)},
                    {l:"Max Loss",v:`$${aggMetrics.maxLoss.toFixed(2)}`,c:"#c0182e"},
                    {l:"Max Gain",v:`$${aggMetrics.maxGain.toFixed(2)}`,c:"#00875a"},
                    {l:"Ret on Margin",v:`${aggMetrics.retOnMargin.toFixed(1)}%`,c:"#0055a5"},
                  ].map(x=>(
                    <div key={x.l} style={{padding:10, background:"#f0f2f5", borderRadius:4, border:"1px solid #dde3eb"}}>
                      <div style={{fontSize:9, color:"#5a6e85"}}>{x.l}</div>
                      <div style={{fontSize:14, fontWeight:700, color:x.c, marginTop:2}}>{x.v}</div>
                    </div>
                  ))}
                </div>
                {/* Risk ratios */}
                <div style={{padding:10, background:"#f0f2f5", borderRadius:4, border:"1px solid #dde3eb"}}>
                  <div className="section-title" style={{marginBottom:6}}>Risk Ratios</div>
                  {[
                    {l:"Reward/Risk",v:(aggMetrics.maxGain/Math.abs(aggMetrics.maxLoss)).toFixed(2)+"x"},
                    {l:"Max Loss / Margin",v:((Math.abs(aggMetrics.maxLoss)/aggMetrics.marginReq)*100).toFixed(1)+"%"},
                    {l:"Theta / Day vs Max Loss",v:((Math.abs(aggMetrics.theta)/Math.abs(aggMetrics.maxLoss))*100).toFixed(2)+"%"},
                    {l:"Kelly Fraction (est)",v:(() => {
                      const p=0.5+(aggMetrics.vrp>0?-0.05:0.05); // simplified
                      const b=Math.abs(aggMetrics.maxGain)/Math.max(0.01,Math.abs(aggMetrics.maxLoss));
                      const k=Math.max(0,(p*(b+1)-1)/b);
                      return (k*100).toFixed(1)+"%";
                    })()},
                  ].map(x=>(
                    <div key={x.l} style={{display:"flex", justifyContent:"space-between", padding:"5px 0", borderBottom:"1px solid #f8fafc"}}>
                      <span style={{color:"#5a6e85"}}>{x.l}</span>
                      <span style={{color:"#1a2332", fontWeight:600}}>{x.v}</span>
                    </div>
                  ))}
                </div>
              </div>
            </div>
            <div>
              {/* Expected shortfall (simplified) */}
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">Risk Distribution (Spot Scenarios)</div>
                <ResponsiveContainer width="100%" height={200}>
                  <AreaChart data={pnlCurves["Today"]}>
                    <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                    <XAxis dataKey="spot" tick={{fontSize:9,fill:"#5a6e85"}} tickCount={6}/>
                    <YAxis tick={{fontSize:9,fill:"#5a6e85"}}/>
                    <Tooltip content={(props)=>{
                      const {active,payload,label}=props;
                      if(!active||!payload?.length) return null;
                      const pnl=payload[0].value;
                      let absCost=0;
                      processedLegs.forEach(l=>{const entryIV=(l.baseIV??l.iv)/100;absCost+=Math.abs(bs(spot,spot*(l.strikePct/100),T,rf,entryIV,l.type).price*l.qty*100);});
                      const moic=absCost>0.01?((absCost+pnl)/absCost):null;
                      const pc=pnl>=0?"#00875a":"#c0182e";
                      const mc=moic==null?"#a8b8cc":moic>=1?"#0055a5":"#c0182e";
                      return <div style={{background:"#ffffff",border:"1px solid #dde3eb",borderRadius:6,padding:"10px 14px",fontSize:11,boxShadow:"0 2px 8px rgba(0,0,0,0.10)"}}>
                        <div style={{fontWeight:700,color:"#1a2332",marginBottom:6,borderBottom:"1px solid #f0f2f5",paddingBottom:5}}>
                          Spot: <span style={{color:"#0055a5"}}>{(+label).toFixed(2)}</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16,marginBottom:3}}>
                          <span style={{color:"#5a6e85"}}>P&L (today)</span><span style={{color:pc,fontWeight:700}}>{pnl>=0?"+":""}{pnl.toFixed(2)}</span>
                        </div>
                        <div style={{display:"flex",justifyContent:"space-between",gap:16}}>
                          <span style={{color:"#5a6e85"}}>MOIC</span>
                          <span style={{background:moic==null?"#f0f2f5":moic>=1?"#e8f3fc":"#fde8ec",color:mc,padding:"1px 6px",borderRadius:3,fontWeight:700,fontSize:10}}>
                            {moic!=null?moic.toFixed(2)+"x":"—"}
                          </span>
                        </div>
                      </div>;
                    }}/>
                    <ReferenceLine y={0} stroke="#8a9eb5"/>
                    <ReferenceLine x={spot} stroke="#c5cdd8" strokeDasharray="3 3" label={{value:"entry",fill:"#a8b8cc",fontSize:8}}/>
                    <ReferenceLine x={+(spot*(1+spotShift/100)).toFixed(2)} stroke="#0055a5" strokeDasharray="3 3" label={{value:"now",fill:"#0055a5",fontSize:8}}/>
                    <defs>
                      <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#00875a" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#c0182e" stopOpacity={0.3}/>
                      </linearGradient>
                    </defs>
                    <Area type="monotone" dataKey="pnl" stroke="#0055a5" fill="url(#pnlGrad)" strokeWidth={2} name="P&L Today"/>
                  </AreaChart>
                </ResponsiveContainer>
              </div>
              {/* ES */}
              <div className="metric-card">
                <div className="section-title">Expected Shortfall</div>
                {(() => {
                  const pnls = pnlCurves["Today"].map(p=>p.pnl).sort((a,b)=>a-b);
                  const n=pnls.length;
                  const es95 = pnls.slice(0,Math.floor(n*0.05)).reduce((s,v)=>s+v,0)/Math.max(1,Math.floor(n*0.05));
                  const es99 = pnls.slice(0,Math.floor(n*0.01)||1).reduce((s,v)=>s+v,0)/Math.max(1,Math.floor(n*0.01)||1);
                  const var95 = pnls[Math.floor(n*0.05)]||pnls[0];
                  return (
                    <div className="grid-3">
                      {[
                        {l:"VaR (95%)",v:var95.toFixed(2),c:"#c05a00"},
                        {l:"ES (95%)",v:es95.toFixed(2),c:"#c05a00"},
                        {l:"ES (99%)",v:es99.toFixed(2),c:"#c0182e"},
                      ].map(x=>(
                        <div key={x.l} style={{padding:10, background:"#f0f2f5", borderRadius:4, border:"1px solid #dde3eb", textAlign:"center"}}>
                          <div style={{fontSize:9, color:"#5a6e85"}}>{x.l}</div>
                          <div style={{fontSize:14, fontWeight:700, color:x.c, marginTop:4}}>{x.v}</div>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          </div>
        )}

        {/* ── SURFACE TAB ── */}
        {activeTab==="surface" && (
          <div style={{display:"grid", gridTemplateColumns:"1fr 1fr", gap:16}}>
            {/* Left: data entry + surface toggle */}
            <div>
              <div className="metric-card" style={{marginBottom:8}}>
                <div style={{display:"flex", justifyContent:"space-between", alignItems:"center", marginBottom:10}}>
                  <div>
                    <div className="section-title" style={{marginBottom:2}}>Vol Surface — Fidelity Chain Data</div>
                    <div style={{fontSize:9,color:"#7a8ea5"}}>Group by expiry date. Min 2 strike/IV points per tenor. Edit dates on blur.</div>
                  </div>
                  <div style={{display:"flex", gap:8, alignItems:"center"}}>
                    <div style={{display:"flex", alignItems:"center", gap:6,
                      background: surfaceEnabled?"#d4f5e9":"#f0f2f5",
                      border:"1px solid "+(surfaceEnabled?"#a3e4c7":"#dde3eb"),
                      borderRadius:6, padding:"5px 10px", cursor:"pointer"}}
                      onClick={()=>setSurfaceEnabled(v=>!v)}>
                      <div style={{width:12,height:12,borderRadius:2,
                        background:surfaceEnabled?"#006b44":"#c5cdd8",transition:"background 0.2s"}}/>
                      <span style={{fontSize:10,fontWeight:700,color:surfaceEnabled?"#006b44":"#5a6e85"}}>
                        {surfaceEnabled?"SURFACE ON":"SURFACE OFF"}
                      </span>
                    </div>
                    <button className="btn btn-primary" onClick={addSurfaceTenor}>+ Add Tenor</button>
                  </div>
                </div>

                {/* Tenor groups — each group is one expiry date with min 2 strike/IV pairs */}
                {surfaceTenors.length>0 ? surfaceTenors.map(expiry=>{
                  const tenorPts = surfacePoints.filter(p=>p.expiry===expiry).sort((a,b)=>a.strike-b.strike);
                  const dte_t    = expiryToDte(expiry);
                  const canDelete = tenorPts.length > 2;
                  return (
                    <div key={expiry} style={{marginBottom:12,border:"1px solid #e0e8f0",borderRadius:6,overflow:"hidden"}}>
                      {/* Tenor header */}
                      <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                        padding:"5px 8px",background:"#eef4fb",borderBottom:"1px solid #dde8f4"}}>
                        <div style={{display:"flex",alignItems:"center",gap:8}}>
                          <input type="date" key={expiry+"_date"} defaultValue={expiry}
                            onBlur={e=>{
                              const newExp = e.target.value;
                              if(!newExp) return;
                              setSurfacePoints(prev=>prev.map(p=>p.expiry===expiry?{...p,expiry:newExp}:p));
                            }}
                            style={{fontSize:10,padding:"2px 4px",border:"1px solid #a3cef0",borderRadius:3,
                              background:"#fff",color:"#0055a5",fontWeight:700,fontFamily:"inherit"}}/>
                          <span style={{fontSize:9,background:"#0055a5",color:"#fff",
                            borderRadius:3,padding:"1px 6px",fontWeight:700}}>{dte_t}d</span>
                          <span style={{fontSize:9,color:"#7a8ea5"}}>({tenorPts.length} pt{tenorPts.length!==1?"s":""})</span>
                          {tenorPts.length < 2 && (
                            <span style={{fontSize:9,color:"#c0182e",fontWeight:700}}>⚠ min 2 required</span>
                          )}
                        </div>
                        <div style={{display:"flex",gap:4}}>
                          <button className="btn btn-primary" onClick={()=>addSurfacePoint(expiry)}
                            style={{fontSize:9,padding:"2px 8px"}}>+ Point</button>
                          <button className="btn btn-danger" onClick={()=>{
                            if(window.confirm("Remove this entire tenor?"))
                              setSurfacePoints(prev=>prev.filter(p=>p.expiry!==expiry));
                          }} style={{fontSize:9,padding:"2px 8px"}}>✕ Tenor</button>
                        </div>
                      </div>
                      {/* Column headers */}
                      <div style={{display:"grid",gridTemplateColumns:"1fr 90px 28px",gap:4,
                        padding:"3px 8px",fontSize:9,color:"#5a6e85",letterSpacing:"0.08em",
                        background:"#f8fafc",borderBottom:"1px solid #f0f2f5"}}>
                        <div>STRIKE</div><div>IV %</div><div/>
                      </div>
                      {/* Points */}
                      {tenorPts.map(p=>(
                        <div key={p.id} style={{display:"grid",gridTemplateColumns:"1fr 90px 28px",
                          gap:4,padding:"4px 8px",alignItems:"center",
                          borderBottom:"1px solid #f8fafc",background:"#ffffff"}}>
                          <input type="number" key={p.id+"_s_"+p.strike} defaultValue={p.strike} step={0.5} min={0.01}
                            onBlur={e=>{ const v=+e.target.value; if(!isNaN(v)&&v>0) updateSurfacePoint(p.id,"strike",v); }}
                            style={{width:"100%"}}/>
                          <input type="number" key={p.id+"_iv_"+p.iv} defaultValue={p.iv} step={0.1} min={0.1} max={300}
                            onBlur={e=>{ const v=+e.target.value; if(!isNaN(v)&&v>0) updateSurfacePoint(p.id,"iv",v); }}
                            style={{width:"100%"}}/>
                          <button className="btn btn-danger" onClick={()=>{ if(canDelete) removeSurfacePoint(p.id); }}
                            title={canDelete?"Remove point":"Need at least 2 points per tenor"}
                            style={{width:24,height:24,display:"flex",alignItems:"center",justifyContent:"center",
                              padding:0,fontSize:13,opacity:canDelete?1:0.3,cursor:canDelete?"pointer":"not-allowed"}}>×</button>
                        </div>
                      ))}
                    </div>
                  );
                }) : (
                  <div style={{padding:16,textAlign:"center",color:"#a8b8cc",fontSize:11}}>
                    No tenors yet — click "+ Add Tenor" below to start.
                  </div>
                )}

                {/* Add Tenor + Load example */}
                <div style={{display:"flex",gap:6,marginTop:8}}>
                  <button className="btn btn-primary" onClick={addSurfaceTenor}
                    style={{flex:1,fontSize:10}}>+ Add Tenor</button>
                  {surfacePoints.length===0 && (
                    <button className="btn" style={{flex:1,fontSize:10,color:"#0055a5"}}
                      onClick={()=>{setSurfacePoints([
                        {id:"e1",strike:90, expiry:"2026-04-01",iv:28.5},{id:"e2",strike:95, expiry:"2026-04-01",iv:26.2},
                        {id:"e3",strike:100,expiry:"2026-04-01",iv:25.0},{id:"e4",strike:105,expiry:"2026-04-01",iv:24.1},{id:"e5",strike:110,expiry:"2026-04-01",iv:23.8},
                        {id:"e6",strike:90, expiry:"2026-05-01",iv:27.2},{id:"e7",strike:95, expiry:"2026-05-01",iv:25.5},
                        {id:"e8",strike:100,expiry:"2026-05-01",iv:24.5},{id:"e9",strike:105,expiry:"2026-05-01",iv:23.8},{id:"e10",strike:110,expiry:"2026-05-01",iv:23.2},
                        {id:"e11",strike:90, expiry:"2026-05-31",iv:26.5},{id:"e12",strike:95, expiry:"2026-05-31",iv:25.0},
                        {id:"e13",strike:100,expiry:"2026-05-31",iv:24.0},{id:"e14",strike:105,expiry:"2026-05-31",iv:23.5},{id:"e15",strike:110,expiry:"2026-05-31",iv:23.0},
                      ]); setSurfaceNextId(200);}}>Load example</button>
                  )}
                </div>
              </div>

              {/* Leg preview */}
              <div className="metric-card">
                <div className="section-title">Surface IV for Your Current Legs</div>
                <div style={{fontSize:9,color:"#7a8ea5",marginBottom:8}}>
                  With surface ON, these IVs auto-populate legs that have no bid/ask entered.
                </div>
                {surfaceLegPreviews.length===0 ? (
                  <div style={{color:"#a8b8cc",fontSize:11,textAlign:"center",padding:12}}>No legs defined</div>
                ) : surfaceLegPreviews.map(l=>(
                  <div key={l.id} style={{display:"flex",justifyContent:"space-between",alignItems:"center",
                    padding:"7px 0",borderBottom:"1px solid #f0f2f5"}}>
                    <span style={{color:"#1a2332",fontSize:10}}>
                      <b>{l.dir==="long"?"▲":"▼"}</b> {l.type} @ {l.strike.toFixed(2)} ({dte}d)
                    </span>
                    <div style={{display:"flex",gap:8,alignItems:"center"}}>
                      {(l.bidPrice||l.askPrice) ? (
                        <span style={{fontSize:9,background:"#fff4e5",color:"#c05a00",padding:"2px 6px",borderRadius:3}}>
                          using price input
                        </span>
                      ) : l.surfIV!=null ? (
                        <span style={{fontSize:9,
                          background: surfaceEnabled?"#d4f5e9":"#f0f2f5",
                          color:surfaceEnabled?"#006b44":"#7a8ea5",
                          padding:"2px 6px",borderRadius:3,fontWeight:700}}>
                          {surfaceEnabled?"↗ surface: ":"preview: "}{l.surfIV}%
                        </span>
                      ) : (
                        <span style={{fontSize:9,color:"#a8b8cc"}}>surface N/A</span>
                      )}
                      <span style={{fontWeight:700,color:"#0055a5",fontSize:11}}>
                        {((l.iv||25)).toFixed(1)}%
                      </span>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Right: heatmap + smile */}
            <div>
              <div className="metric-card" style={{marginBottom:8}}>
                <div className="section-title">Fitted Vol Surface — Heatmap</div>
                <div style={{fontSize:9,color:"#7a8ea5",marginBottom:8}}>
                  Strike (rows) × Tenor (columns). Color = IV level. Blue=low, Red=high.
                </div>
                {surfaceHeatmapDtes.length>0 && surfacePoints.length>=2 ? (
                  <div style={{overflowX:"auto"}}>
                    <table style={{width:"100%",borderCollapse:"collapse",fontSize:10}}>
                      <thead>
                        <tr>
                          <th style={{padding:"4px 8px",textAlign:"right",fontSize:9,color:"#5a6e85",fontWeight:600}}>Strike</th>
                          {surfaceHeatmapDtes.map(expiry=>(
                            <th key={expiry} style={{padding:"4px 8px",textAlign:"center",fontSize:9,color:"#0055a5",fontWeight:700}}>
                              {expiry.slice(5)}<br/><span style={{fontWeight:400,color:"#7a8ea5"}}>{expiryToDte(expiry)}d</span>
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {surfaceHeatmapData.map(row=>(
                          <tr key={row.strike} style={{borderBottom:"1px solid #f8fafc"}}>
                            <td style={{padding:"3px 8px",textAlign:"right",fontWeight:600,fontSize:10,
                              color:Math.abs(row.strike-spot)<spot*0.01?"#0055a5":row.strike<spot?"#c0182e":"#006b44"}}>
                              {row.strike.toFixed(1)}
                              {Math.abs(row.strike-spot)<spot*0.005 && (
                                <span style={{fontSize:8,marginLeft:3,color:"#0055a5"}}>ATM</span>
                              )}
                            </td>
                            {surfaceHeatmapDtes.map(expiry=>{
                              const iv=row[expiry];
                              const {min,max} = surfaceIvColorRange;
                              const t = iv!=null ? Math.max(0,Math.min(1,(iv-min)/(max-min||1))) : 0.5;
                              const textCol = (t>0.25&&t<0.75) ? "#1a2332" : "#ffffff";
                              return (
                                <td key={expiry} style={{padding:"3px 6px",textAlign:"center",borderRadius:2,
                                  background:surfaceIvColor(iv),fontWeight:600,color:textCol,fontSize:10,
                                  textShadow: textCol==="#ffffff"?"0 1px 2px rgba(0,0,0,0.25)":"none"}}>
                                  {iv!=null?iv.toFixed(1):"—"}
                                </td>
                              );
                            })}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : (
                  <div style={{padding:24,textAlign:"center",color:"#a8b8cc",fontSize:11}}>
                    Add at least 2 data points to see the fitted surface
                  </div>
                )}
              </div>

              {/* Smile chart */}
              <div className="metric-card">
                <div className="section-title">Fitted Smile at {dte}d (your expiry)</div>
                <div style={{fontSize:9,color:"#7a8ea5",marginBottom:8}}>
                  Solid line = fitted curve. Orange dashes = nearest tenor input points.
                </div>
                {surfaceSmileData.length>=2 ? (
                  <ResponsiveContainer width="100%" height={200}>
                    <LineChart data={surfaceSmileData}>
                      <CartesianGrid strokeDasharray="2 2" stroke="#dde3eb"/>
                      <XAxis dataKey="strike" tick={{fontSize:9,fill:"#5a6e85"}} tickCount={6}/>
                      <YAxis tick={{fontSize:9,fill:"#5a6e85"}} domain={["auto","auto"]} unit="%"/>
                      <Tooltip content={(props)=>{
                        const {active,payload,label}=props;
                        if(!active||!payload||!payload.length) return null;
                        const iv=payload[0] && payload[0].value;
                        const mono=Math.log((+label)/spot);
                        return (
                          <div style={{background:"#fff",border:"1px solid #dde3eb",borderRadius:6,
                            padding:"8px 12px",fontSize:11,boxShadow:"0 2px 8px rgba(0,0,0,0.10)"}}>
                            <div style={{fontWeight:700,color:"#1a2332",marginBottom:4}}>Strike: {(+label).toFixed(2)}</div>
                            <div style={{display:"flex",justifyContent:"space-between",gap:12,marginBottom:2}}>
                              <span style={{color:"#5a6e85"}}>Fitted IV</span>
                              <span style={{color:"#0055a5",fontWeight:700}}>{iv}%</span>
                            </div>
                            <div style={{display:"flex",justifyContent:"space-between",gap:12}}>
                              <span style={{color:"#5a6e85"}}>Log-moneyness</span>
                              <span style={{color:"#5a6e85"}}>{mono.toFixed(3)}</span>
                            </div>
                          </div>
                        );
                      }}/>
                      <ReferenceLine x={spot} stroke="#00875a" strokeDasharray="3 3" label={{value:"spot",fill:"#00875a",fontSize:8}}/>
                      <Line type="monotone" dataKey="fitted" stroke="#0055a5" dot={false} strokeWidth={2} name="Fitted IV"/>
                      {surfaceNearestTenorPoints.map(p=>(
                        <ReferenceLine key={p.id} x={p.strike} stroke="#c05a00" strokeDasharray="2 2" opacity={0.5}
                          label={{value:p.iv+"%",position:"top",fill:"#c05a00",fontSize:8}}/>
                      ))}
                    </LineChart>
                  </ResponsiveContainer>
                ) : (
                  <div style={{padding:24,textAlign:"center",color:"#a8b8cc",fontSize:11}}>
                    Add at least 2 data points to see the smile
                  </div>
                )}
              </div>

              {/* 3D Surface */}
              <div className="metric-card" style={{marginTop:8, padding:0, overflow:"hidden", background:"#0d1117", border:"1px solid #1e2a3a"}}>
                <div style={{padding:"10px 14px 6px", display:"flex", justifyContent:"space-between", alignItems:"center", borderBottom:"1px solid #1e2a3a"}}>
                  <div>
                    <div style={{fontFamily:"'Syne',sans-serif", fontSize:10, fontWeight:700, letterSpacing:"0.15em", textTransform:"uppercase", color:"#4a9eff", marginBottom:2}}>3D VOL SURFACE</div>
                    <div style={{fontSize:9, color:"rgba(160,190,230,0.5)"}}>strike × DTE × implied volatility</div>
                  </div>
                  <div style={{fontSize:9, color:"rgba(100,220,155,0.7)", letterSpacing:"0.1em"}}>
                    ● ATM
                  </div>
                </div>
                <VolSurface3D
                  surfacePoints={surfacePoints}
                  spot={spot}
                  surfaceTenors={surfaceTenors}
                  expiryToDteFn={expiryToDte}
                />
              </div>
            </div>
          </div>
        )}

      </div>
    </div>
  );
}






