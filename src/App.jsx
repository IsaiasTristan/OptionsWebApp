import { useState, useCallback } from "react";
import OptionsModel from "./OptionsModel.jsx";
import ScreenerDashboard from "./ScreenerDashboard.jsx";

export default function App() {
  const [view, setView]               = useState("model");
  const [loadedTicker, setLoadedTicker] = useState(null);

  const handleLoadTicker = useCallback((tickerData) => {
    setLoadedTicker(tickerData);
    setView("model");
  }, []);

  if (view === "screener") {
    return (
      <ScreenerDashboard
        onBack={() => setView("model")}
        onLoadTicker={handleLoadTicker}
      />
    );
  }

  return (
    <div>
      <div style={{
        background: "#1a2332",
        borderBottom: "2px solid #0055a5",
        padding: "8px 20px",
        display: "flex",
        alignItems: "center",
        gap: 12,
      }}>
        <div style={{ fontWeight: 700, fontSize: 12, color: "#4a9eff", letterSpacing: "0.1em" }}>
          OPTIX
        </div>
        <div style={{ width: 1, height: 20, background: "#2a3548" }} />
        {[
          { id: "model",    label: "Options Model" },
          { id: "screener", label: "Vol Screener" },
        ].map((item) => (
          <button key={item.id} onClick={() => setView(item.id)} style={{
            padding: "4px 12px",
            fontSize: 11,
            fontWeight: 600,
            cursor: "pointer",
            border: "none",
            borderRadius: 4,
            background: view === item.id ? "#0055a5" : "none",
            color: view === item.id ? "#ffffff" : "#a8b8cc",
            letterSpacing: "0.03em",
          }}>
            {item.label}
          </button>
        ))}
        {loadedTicker && (
          <div style={{ marginLeft: 8, fontSize: 10, color: "#4a9eff", background: "#0055a522", padding: "2px 8px", borderRadius: 4 }}>
            Loaded: {loadedTicker.symbol}
          </div>
        )}
      </div>
      <OptionsModel loadedTicker={loadedTicker} />
    </div>
  );
}
