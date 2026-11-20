import { useEffect, useRef, useState } from "react";
import { type ChartResult, chartPage } from "../../bench/chart";
import bench from "./bench-results.json";
import { ChartIcon, FullScreenIcon } from "./icons";

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

/** The chart filling the window, open from when it mounts until closed. */
function FullChart({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => dialog.current!.showModal(), []);
  return (
    <dialog ref={dialog} className="bench-chart-full" onClose={onClose} aria-label="How the AIs compare">
      <Frame full />
      <button type="button" className="quiet" onClick={() => dialog.current!.close()}>
        Close
      </button>
    </dialog>
  );
}

/** How the AIs scored on Ink & Thread's own bench, with a button in its corner to see it full screen. */
export function BenchChart() {
  const [full, setFull] = useState(false);
  return (
    <div className="bench-chart-box">
      <Frame />
      <button type="button" className="icon" title="Full screen" aria-label="Full screen" aria-haspopup="dialog" onClick={() => setFull(true)}>
        {FullScreenIcon}
      </button>
      {full && <FullChart onClose={() => setFull(false)} />}
    </div>
  );
}

/**
 * The same chart behind a button, for a screen with no room for it, such as Setup's model picker. In words as well as its icon,
 * as an icon alone there didn't say it could be opened.
 */
export function BenchChartButton() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" className="quiet bench-chart-open" aria-haspopup="dialog" onClick={() => setOpen(true)}>
        {ChartIcon}
        How the AIs compare
      </button>
      {open && <FullChart onClose={() => setOpen(false)} />}
    </>
  );
}
