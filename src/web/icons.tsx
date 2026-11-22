import { useId } from "react";

const icon = (path: string) => (
  <svg viewBox="0 0 24 24" aria-hidden="true">
    <path d={path} />
  </svg>
);

export const ChartIcon = icon("M4 4v16h16M8 15h.01M12 10h.01M16 13h.01M18 7h.01");
export const ChapterIcon = icon("M6 3h12v18l-6-4-6 4z");
export const ContinueIcon = icon("M4 12h16M13 5l7 7-7 7");
export const ChoicesIcon = icon("M9 6h11M9 12h11M9 18h11M4.5 6h.01M4.5 12h.01M4.5 18h.01");
export const DieIcon = icon("M5 3h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2zM8 8h.01M16 8h.01M12 12h.01M8 16h.01M16 16h.01");
export const DeleteIcon = icon("M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13M10 11v6M14 11v6");
export const DecideIcon = icon("M12 3l1.8 5.2L19 10l-5.2 1.8L12 17l-1.8-5.2L5 10l5.2-1.8zM19 16l.8 2.2L22 19l-2.2.8L19 22l-.8-2.2L16 19l2.2-.8z");
export const DrawIcon = icon("M3 5h18v14H3zM3 16l5-5 5 5 3-3 5 5M15.5 9.5h.01");
export const AskIcon = icon("M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20zM9.1 9a3 3 0 0 1 5.8 1c0 2-3 3-3 3M12 17h.01");
export const DownIcon = icon("M12 4v16M5 13l7 7 7-7");
export const FullScreenIcon = icon("M4 9V4h5M15 4h5v5M20 15v5h-5M9 20H4v-5");
export const UpIcon = icon("M12 20V4M5 11l7-7 7 7");
export const DuplicateIcon = icon("M8 3h9l3 3v12H8zM4 7v14h11");
/** An arrow coming round to begin again. */
export const StartOverIcon = icon("M4 12a8 8 0 1 0 2.4-5.7M4 3v4h4");
export const ExportIcon = icon("M12 4v11M7 10l5 5 5-5M4 15v5h16v-5");
/** A name tag. */
export const RenameIcon = icon("M3 12V4h8l10 10-8 8zM7.5 7.5h.01");
export const EditIcon = icon("M4 20l1-5L16 4l4 4L9 19zM14 6l4 4");
/** A quill, for rewriting a passage or nudging a picture. */
export const RewriteIcon = icon("M20 3c-7 1-12 6-14 14M20 3c0 6-3 10-9 11M4 21l2-4");
export const RegenerateIcon = icon("M20 12a8 8 0 1 1-2.4-5.7M20 3v5h-5");
export const UploadIcon = icon("M12 15V4M7 9l5-5 5 5M4 15v5h16v-5");
export const StopIcon = icon("M7 7h10v10H7z");
export const SendIcon = icon("M12 20V4M5 11l7-7 7 7");
/** Brand marks (Simple Icons), filled rather than stroked. */
export const DiscordIcon = icon(
  "M20.317 4.3698a19.7913 19.7913 0 00-4.8851-1.5152.0741.0741 0 00-.0785.0371c-.211.3753-.4447.8648-.6083 1.2495-1.8447-.2762-3.68-.2762-5.4868 0-.1636-.3933-.4058-.8742-.6177-1.2495a.077.077 0 00-.0785-.037 19.7363 19.7363 0 00-4.8852 1.515.0699.0699 0 00-.0321.0277C.5334 9.0458-.319 13.5799.0992 18.0578a.0824.0824 0 00.0312.0561c2.0528 1.5076 4.0413 2.4228 5.9929 3.0294a.0777.0777 0 00.0842-.0276c.4616-.6304.8731-1.2952 1.226-1.9942a.076.076 0 00-.0416-.1057c-.6528-.2476-1.2743-.5495-1.8722-.8923a.077.077 0 01-.0076-.1277c.1258-.0943.2517-.1923.3718-.2914a.0743.0743 0 01.0776-.0105c3.9278 1.7933 8.18 1.7933 12.0614 0a.0739.0739 0 01.0785.0095c.1202.099.246.1981.3728.2924a.077.077 0 01-.0066.1276 12.2986 12.2986 0 01-1.873.8914.0766.0766 0 00-.0407.1067c.3604.698.7719 1.3628 1.225 1.9932a.076.076 0 00.0842.0286c1.961-.6067 3.9495-1.5219 6.0023-3.0294a.077.077 0 00.0313-.0552c.5004-5.177-.8382-9.6739-3.5485-13.6604a.061.061 0 00-.0312-.0286zM8.02 15.3312c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9555-2.4189 2.157-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.9555 2.4189-2.1569 2.4189zm7.9748 0c-1.1825 0-2.1569-1.0857-2.1569-2.419 0-1.3332.9554-2.4189 2.1569-2.4189 1.2108 0 2.1757 1.0952 2.1568 2.419 0 1.3332-.946 2.4189-2.1568 2.4189Z",
);
export const GitHubIcon = icon(
  "M12 .297c-6.63 0-12 5.373-12 12 0 5.303 3.438 9.8 8.205 11.385.6.113.82-.258.82-.577 0-.285-.01-1.04-.015-2.04-3.338.724-4.042-1.61-4.042-1.61C4.422 18.07 3.633 17.7 3.633 17.7c-1.087-.744.084-.729.084-.729 1.205.084 1.838 1.236 1.838 1.236 1.07 1.835 2.809 1.305 3.495.998.108-.776.417-1.305.76-1.605-2.665-.3-5.466-1.332-5.466-5.93 0-1.31.465-2.38 1.235-3.22-.135-.303-.54-1.523.105-3.176 0 0 1.005-.322 3.3 1.23.96-.267 1.98-.399 3-.405 1.02.006 2.04.138 3 .405 2.28-1.552 3.285-1.23 3.285-1.23.645 1.653.24 2.873.12 3.176.765.84 1.23 1.91 1.23 3.22 0 4.61-2.805 5.625-5.475 5.92.42.36.81 1.096.81 2.22 0 1.606-.015 2.896-.015 3.286 0 .315.21.69.825.57C20.565 22.092 24 17.592 24 12.297c0-6.627-5.373-12-12-12",
);
export const RevertIcon = icon("M4 12a8 8 0 1 0 2.4-5.7M4 3v5h5");

// Three waves, from where the trail starts fading to past the nib, as the page slides one wave left each round.
const WAVE = "c1.008 0 1.392 1.4 2.4 1.4c1.008 0 1.392-1.4 2.4-1.4";
const LINE = `M4.4 17.3${WAVE}${WAVE}${WAVE}`;
/**
 * A quill writing in place, for beside the words of a Narrator at work: its tip only goes up and down while the page
 * slides left under it, so a short squiggle trails behind and fades. Its moves are in styles.css. Its own mask id, as
 * several can be on screen at once.
 */
export function Quilling() {
  const fade = useId();
  return (
    <svg className="painting quilling" viewBox="0 0 32 24" aria-hidden="true">
      <defs>
        <linearGradient id={`${fade}g`}>
          <stop offset="0" stopColor="#fff" stopOpacity="0" />
          <stop offset=".7" stopColor="#fff" />
        </linearGradient>
        <mask id={fade} maskUnits="userSpaceOnUse" x="0" y="0" width="32" height="24">
          <rect x="5.5" y="0" width="8.5" height="24" fill={`url(#${fade}g)`} />
        </mask>
      </defs>
      <g mask={`url(#${fade})`}>
        <path className="ink" d={LINE} />
      </g>
      <g className="nib">
        <path className="pen" d="M20 3c-7 1-12 6-14 14M20 3c0 6-3 10-9 11M4 21l2-4" transform="translate(14 18) scale(.8) translate(-4 -21)" />
      </g>
    </svg>
  );
}

const HILLS = "M4 19l7-8 5 5 4-4 8 7";
/** A brush painting hills in a frame, then a sun, for beside the words of a picture being drawn. Its moves are in styles.css. */
export const Painting = (
  <svg className="painting" viewBox="0 0 32 24" aria-hidden="true">
    <rect className="frame" x="2" y="2" width="28" height="20" rx="1" />
    <path className="hills" d={HILLS} pathLength={1} />
    <circle className="sun" cx="22" cy="7.5" r="2" />
    <g className="brush" style={{ offsetPath: `path("${HILLS}")` }}>
      <path d="M0 0c.5-1.5 1.5-2.5 2.5-2.5l1 1c0 1-1 2-2.5 2.5zM3-2l6-6" />
    </g>
  </svg>
);
