// Mobile shell. On narrow screens the three-column desktop grid collapses to
// preview-on-top plus a single swappable pane (timeline / media / inspector)
// driven by the bottom tab bar. Desktop keeps the classic layout and never
// sees the tab bar.
export type Pane = "timeline" | "media" | "inspector";

const PANES: Pane[] = ["timeline", "media", "inspector"];
/** Must stay in sync with the single-pane breakpoint in style.css. */
const MOBILE_QUERY = "(max-width: 860px), (max-height: 520px) and (orientation: landscape)";
const STORE_KEY = "rrv.pane";

function readPane(): Pane {
  try {
    const v = localStorage.getItem(STORE_KEY) as Pane | null;
    if (v && PANES.includes(v)) return v;
  } catch {
    /* storage disabled (private mode) */
  }
  return "timeline";
}

function writePane(p: Pane): void {
  try {
    localStorage.setItem(STORE_KEY, p);
  } catch {
    /* ignore */
  }
}

export class MobileShell {
  private mq = window.matchMedia(MOBILE_QUERY);
  private tabbar: HTMLElement;

  /**
   * @param onLayoutChange run whenever the visible area changes (pane switch,
   *   breakpoint crossing, rotation) so the caller can resize the preview and
   *   re-render the timeline.
   */
  constructor(
    private app: HTMLElement,
    private onLayoutChange: () => void,
  ) {
    this.tabbar = app.querySelector("#tabbar")!;
    for (const b of this.tabbar.querySelectorAll<HTMLButtonElement>("[data-pane]")) {
      b.addEventListener("click", () => this.setPane(b.dataset.pane as Pane));
    }
    this.apply(readPane());
    this.mq.addEventListener("change", () => this.onLayoutChange());
    window.addEventListener("orientationchange", () => this.onLayoutChange());
    window.visualViewport?.addEventListener("resize", () => this.onLayoutChange());
  }

  /** True while the narrow single-pane layout is in effect. */
  get isMobile(): boolean {
    return this.mq.matches;
  }

  get pane(): Pane {
    return (this.app.dataset.pane as Pane) ?? "timeline";
  }

  setPane(p: Pane): void {
    if (this.pane === p) return;
    this.apply(p);
    writePane(p);
  }

  /** Bring a pane forward, but only when the tab bar is what's hiding it. */
  revealPane(p: Pane): void {
    if (this.isMobile) this.setPane(p);
  }

  private apply(p: Pane): void {
    this.app.dataset.pane = p;
    for (const b of this.tabbar.querySelectorAll<HTMLButtonElement>("[data-pane]")) {
      const on = b.dataset.pane === p;
      b.classList.toggle("active", on);
      b.setAttribute("aria-selected", String(on));
    }
    this.onLayoutChange();
  }
}

let toastEl: HTMLDivElement | null = null;
let toastTimer = 0;

/** Transient message for touch layouts, where the topbar status can scroll off. */
export function showToast(msg: string): void {
  if (!msg) return;
  if (!toastEl) {
    toastEl = document.createElement("div");
    toastEl.className = "toast";
    document.body.append(toastEl);
  }
  toastEl.textContent = msg;
  toastEl.classList.remove("hidden");
  clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toastEl?.classList.add("hidden"), 1800);
}
