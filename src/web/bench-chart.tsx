import { useEffect, useRef, useState } from "react";
import { type ChartResult, chartPage } from "../../bench/chart";
import bench from "./bench-results.json";
import { FullScreenIcon } from "./icons";

// Written by `bun bench chart` from the kept bench runs, so the chart ships with the app and needs no network.
const page = chartPage(bench.results as ChartResult[], bench.rounds, { titles: bench.titles, scores: bench.scores });
// The pickers, key and chart title above a full-screen chart, so it is sized to show whole beneath them.
const ABOVE_CHART = "220px";

/**
 * The bench's chart page in a frame: its selectors pick the version, the score and the story. The frame takes the app's theme
 * and shows the paper through it. Inline it grows to its page's height; `full` fills its box instead, without the page's heading
 * and explanation, the page as wide as the box and each chart no taller than fits on screen.
 */
function Frame({ full = false }: { full?: boolean }) {
  const frame = useRef<HTMLIFrameElement>(null);
  const fit = () => {
    const doc = frame.current?.contentDocument;
    if (!doc?.body) return;
    const theme = document.documentElement.dataset.theme;
    if (theme) doc.documentElement.dataset.theme = theme;
    doc.body.style.background = "transparent";
    if (full) {
      const style = doc.createElement("style");
      // The Guide already says what the chart is, so full screen shows only the pickers and the chart.
      style.textContent = `body { max-width: none; } h1, body > p { display: none; } svg { max-height: calc(100vh - ${ABOVE_CHART}); }`;
      doc.head.append(style);
      return;
    }
    const grow = () => {
      if (frame.current) frame.current.style.height = `${doc.body.scrollHeight + 48}px`;
    };
    grow();
    new ResizeObserver(grow).observe(doc.body);
  };
  // A frame from srcDoc can finish loading before React attaches onLoad.
  useEffect(() => {
    if (frame.current?.contentDocument?.readyState === "complete") fit();
  });
  return <iframe ref={frame} className="bench-chart" title="How the AIs compare" srcDoc={page} onLoad={fit} />;
}

/** How the AIs scored on NovelForge's own bench, with a button in its corner to see it full screen. */
export function BenchChart() {
  const [full, setFull] = useState(false);
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    if (full) dialog.current!.showModal();
  }, [full]);
  return (
    <div className="bench-chart-box">
      <Frame />
      <button type="button" className="icon" title="Full screen" aria-label="Full screen" aria-haspopup="dialog" onClick={() => setFull(true)}>
        {FullScreenIcon}
      </button>
      {full && (
        <dialog ref={dialog} className="bench-chart-full" onClose={() => setFull(false)} aria-label="How the AIs compare">
          <Frame full />
          <button type="button" className="quiet" onClick={() => dialog.current!.close()}>
            Close
          </button>
        </dialog>
      )}
    </div>
  );
}
