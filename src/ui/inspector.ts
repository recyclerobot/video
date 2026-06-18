// Inspector: per-clip property editing with keyframe toggles, transform,
// filter stacks, audio, and rich-text controls. Rebuilds only when the
// selection/revision changes, so live slider/text edits don't break mid-drag.
import type { EditorStore } from "../state/store";
import type { PlaybackEngine } from "../engine/playback";
import { decoupleAudio } from "../state/commands";
import {
  addKeyframe,
  hasKeyframeAt,
  isAnimated,
  removeKeyframe,
  sampleAt,
} from "../engine/keyframes";
import { FILTERS, FILTER_ORDER, makeFilter } from "../engine/filters";
import { resolveProp, setProp } from "./timeline";
import { clamp, escapeHtml } from "../util";
import {
  type Animatable,
  type AudioClip,
  type Clip,
  type EffectClip,
  type FilterInstance,
  type ImageClip,
  type SequenceClip,
  type TitleClip,
  type VideoClip,
  type VisualClip,
} from "../types";

export class Inspector {
  private body: HTMLElement;
  private sig = "";

  constructor(
    root: HTMLElement,
    private store: EditorStore,
    private engine: PlaybackEngine,
  ) {
    this.body = root.querySelector("#inspectorBody")!;
    this.store.subscribe(() => this.maybeRender());
  }

  private maybeRender(): void {
    const u = this.store.ui;
    const sig = `${u.selectedClipIds.join(",")}|${u.selectedTransitionId}|${u.activeKeyframeProp}|${u.revision}`;
    if (sig !== this.sig) {
      this.sig = sig;
      this.render();
    }
  }

  private localTime(c: Clip): number {
    return clamp(this.engine.time - c.start, 0, c.duration);
  }

  render(): void {
    this.body.textContent = "";
    if (this.store.ui.selectedTransitionId) {
      this.renderTransition();
      return;
    }
    const c = this.store.primarySelection();
    if (!c) {
      this.body.innerHTML = `<div class="muted-note">Select a clip to edit.</div>`;
      return;
    }
    this.body.append(this.common(c));
    if (c.kind === "video") this.videoSection(c);
    if (c.kind === "audio") this.audioSection(c);
    if (c.kind === "image") this.imageSection(c);
    if (c.kind === "sequence") this.sequenceSection(c);
    if (c.kind === "title") this.titleSection(c);
    if (c.kind === "effect") this.effectSection(c);
    if (c.kind === "video" || c.kind === "image" || c.kind === "sequence" || c.kind === "title") {
      this.transformSection(c as VisualClip);
      this.filterSection(c as VisualClip);
    }
  }

  // ---- generic controls ----
  private sectionTitle(t: string): HTMLElement {
    const d = document.createElement("div");
    d.className = "section-title";
    d.textContent = t;
    return d;
  }

  private row(labelText: string, control: HTMLElement, extra?: HTMLElement): HTMLElement {
    const r = document.createElement("div");
    r.className = "row";
    const l = document.createElement("label");
    l.textContent = labelText;
    r.append(l, control);
    if (extra) r.append(extra);
    return r;
  }

  /** A numeric field with begin/commit transaction (one undo step per edit). */
  private numField(
    labelText: string,
    get: () => number,
    set: (v: number) => void,
    opts: { min?: number; max?: number; step?: number; range?: boolean } = {},
  ): HTMLElement {
    const input = document.createElement("input");
    input.type = opts.range ? "range" : "number";
    if (opts.min != null) input.min = String(opts.min);
    if (opts.max != null) input.max = String(opts.max);
    input.step = String(opts.step ?? 0.01);
    input.value = String(get());
    let active = false;
    const begin = () => {
      if (!active) {
        active = true;
        this.store.beginTransaction(labelText);
      }
    };
    const commit = () => {
      if (active) {
        active = false;
        this.store.commitTransaction();
      }
    };
    input.addEventListener("input", () => {
      begin();
      this.store.mutateLive(() => set(parseFloat(input.value)));
      this.engine.renderFrame();
    });
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    return this.row(labelText, input);
  }

  /** An animatable numeric property with a keyframe (◆) toggle. */
  private animRow(
    c: Clip,
    path: string,
    labelText: string,
    min: number,
    max: number,
    step: number,
  ): HTMLElement {
    const lt = this.localTime(c);
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const cur = resolveProp(c, path);
    input.value = String(cur != null ? sampleAt(cur, lt) : 0);

    const diamond = document.createElement("button");
    const animated = cur != null && isAnimated(cur);
    const hasKf = cur != null && hasKeyframeAt(cur, lt);
    diamond.className = "kf-toggle" + (hasKf ? " on" : animated ? " animated" : "");
    diamond.textContent = hasKf ? "◆" : "◇";
    diamond.title = "keyframe at playhead";
    diamond.addEventListener("click", () => {
      const v = resolveProp(c, path);
      if (v == null) return;
      this.store.update("Keyframe " + labelText, (p) => {
        const cc = p.clips.find((x) => x.id === c.id);
        if (!cc) return;
        const value = resolveProp(cc, path)!;
        if (hasKeyframeAt(value, lt)) setProp(cc, path, removeKeyframe(value, lt));
        else setProp(cc, path, addKeyframe(value, lt, sampleAt(value, lt)));
      });
      this.store.ui.activeKeyframeProp = path;
      this.engine.renderFrame();
      this.render();
    });

    let active = false;
    input.addEventListener("input", () => {
      if (!active) {
        active = true;
        this.store.beginTransaction(labelText);
      }
      const val = parseFloat(input.value);
      this.store.mutateLive((p) => {
        const cc = p.clips.find((x) => x.id === c.id);
        if (!cc) return;
        const value = resolveProp(cc, path);
        if (value == null) return;
        if (isAnimated(value)) setProp(cc, path, addKeyframe(value, lt, val));
        else setProp(cc, path, val);
      });
      this.engine.renderFrame();
    });
    const commit = () => {
      if (active) {
        active = false;
        this.store.commitTransaction();
      }
    };
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    return this.row(labelText, input, diamond);
  }

  private colorField(labelText: string, get: () => string, set: (v: string) => void): HTMLElement {
    const input = document.createElement("input");
    input.type = "color";
    input.value = get();
    input.addEventListener("input", () => {
      this.store.update("Color", () => set(input.value));
      this.engine.renderFrame();
    });
    return this.row(labelText, input);
  }
  private checkField(labelText: string, get: () => boolean, set: (v: boolean) => void): HTMLElement {
    const input = document.createElement("input");
    input.type = "checkbox";
    input.checked = get();
    input.addEventListener("change", () => {
      this.store.update(labelText, () => set(input.checked));
      this.engine.renderFrame();
    });
    return this.row(labelText, input);
  }
  private selectField(
    labelText: string,
    options: [string, string][],
    get: () => string,
    set: (v: string) => void,
  ): HTMLElement {
    const sel = document.createElement("select");
    for (const [val, lab] of options) {
      const o = document.createElement("option");
      o.value = val;
      o.textContent = lab;
      sel.append(o);
    }
    sel.value = get();
    sel.addEventListener("change", () => {
      this.store.update(labelText, () => set(sel.value));
      this.engine.renderFrame();
    });
    return this.row(labelText, sel);
  }
  private textField(labelText: string, get: () => string, set: (v: string) => void): HTMLElement {
    const wrap = document.createElement("div");
    wrap.style.width = "100%";
    const ta = document.createElement("textarea");
    ta.rows = 2;
    ta.className = "ta";
    ta.value = get();
    let active = false;
    ta.addEventListener("input", () => {
      if (!active) {
        active = true;
        this.store.beginTransaction("Text");
      }
      this.store.mutateLive(() => set(ta.value));
      this.engine.renderFrame();
    });
    const commit = () => {
      if (active) {
        active = false;
        this.store.commitTransaction();
      }
    };
    ta.addEventListener("change", commit);
    ta.addEventListener("blur", commit);
    const t = document.createElement("div");
    t.className = "section-title";
    t.textContent = labelText;
    wrap.append(t, ta);
    return wrap;
  }

  private edit(c: Clip, fn: (clip: Clip) => void, label = "Edit"): void {
    this.store.update(label, (p) => {
      const cc = p.clips.find((x) => x.id === c.id);
      if (cc) fn(cc);
    });
    this.engine.renderFrame();
  }

  // ---- sections ----
  private common(c: Clip): HTMLElement {
    const wrap = document.createElement("div");
    wrap.append(this.sectionTitle(`Clip · ${c.kind}`));
    wrap.append(
      this.numField("Start", () => c.start, (v) => this.edit(c, (cc) => (cc.start = Math.max(0, v))), { min: 0 }),
    );
    wrap.append(
      this.numField("Duration", () => c.duration, (v) => this.edit(c, (cc) => (cc.duration = Math.max(0.05, v))), { min: 0.05 }),
    );
    return wrap;
  }

  private mediaName(mediaId: string): string {
    return this.store.getProject().media.find((m) => m.id === mediaId)?.name ?? "(missing)";
  }

  private videoSection(c: VideoClip): void {
    this.body.append(this.sectionTitle("Source · " + this.mediaName(c.mediaId)));
    this.body.append(this.numField("In point", () => c.inPoint, (v) => this.edit(c, (cc) => ((cc as VideoClip).inPoint = Math.max(0, v))), { min: 0 }));
    this.body.append(this.numField("Speed", () => c.speed, (v) => this.edit(c, (cc) => ((cc as VideoClip).speed = clamp(v, 0.1, 8))), { min: 0.1, max: 8, step: 0.1 }));
    this.audioSubsection(c);
  }

  private imageSection(c: ImageClip): void {
    this.body.append(this.sectionTitle("Image · " + this.mediaName(c.mediaId)));
  }

  private sequenceSection(c: SequenceClip): void {
    this.body.append(this.sectionTitle("Sequence · " + this.mediaName(c.mediaId)));
    this.body.append(this.numField("Source fps", () => c.sourceFps, (v) => this.edit(c, (cc) => ((cc as SequenceClip).sourceFps = clamp(v, 1, 120))), { min: 1, max: 120, step: 1 }));
    this.body.append(this.numField("In frame", () => c.inFrame, (v) => this.edit(c, (cc) => ((cc as SequenceClip).inFrame = Math.max(0, Math.round(v)))), { min: 0, step: 1 }));
    this.body.append(this.numField("Speed", () => c.speed, (v) => this.edit(c, (cc) => ((cc as SequenceClip).speed = clamp(v, 0.1, 8))), { min: 0.1, max: 8, step: 0.1 }));
    this.body.append(this.checkField("Hold last", () => c.holdLast, (v) => this.edit(c, (cc) => ((cc as SequenceClip).holdLast = v))));
  }

  private audioSection(c: AudioClip): void {
    this.body.append(this.sectionTitle("Audio · " + this.mediaName(c.mediaId)));
    this.body.append(this.numField("In point", () => c.inPoint, (v) => this.edit(c, (cc) => ((cc as AudioClip).inPoint = Math.max(0, v))), { min: 0 }));
    this.body.append(this.numField("Speed", () => c.speed, (v) => this.edit(c, (cc) => ((cc as AudioClip).speed = clamp(v, 0.1, 8))), { min: 0.1, max: 8, step: 0.1 }));
    this.audioSubsection(c);
  }

  private audioSubsection(c: AudioClip | VideoClip): void {
    this.body.append(this.sectionTitle("Audio mix"));
    if (c.kind === "video")
      this.body.append(this.checkField("Use own audio", () => (c as VideoClip).useOwnAudio, (v) => this.edit(c, (cc) => ((cc as VideoClip).useOwnAudio = v))));
    this.body.append(this.animRow(c, "audio.volume", "Volume", 0, 2, 0.01));
    this.body.append(this.animRow(c, "audio.pan", "Pan", -1, 1, 0.01));
    this.body.append(this.numField("Fade in", () => c.audio.fadeIn, (v) => this.edit(c, (cc) => ((cc as VideoClip).audio.fadeIn = Math.max(0, v))), { min: 0, step: 0.05 }));
    this.body.append(this.numField("Fade out", () => c.audio.fadeOut, (v) => this.edit(c, (cc) => ((cc as VideoClip).audio.fadeOut = Math.max(0, v))), { min: 0, step: 0.05 }));
    if (c.kind === "video") {
      const btn = document.createElement("button");
      btn.textContent = "Extract audio to new clip";
      btn.style.width = "100%";
      btn.addEventListener("click", () => {
        const id = decoupleAudio(this.store, c.id);
        if (id) this.store.setSelection([id]);
        this.engine.renderFrame();
      });
      this.body.append(btn);
    }
  }

  private transformSection(c: VisualClip): void {
    this.body.append(this.sectionTitle("Transform"));
    this.body.append(this.animRow(c, "transform.x", "X", -1, 1, 0.005));
    this.body.append(this.animRow(c, "transform.y", "Y", -1, 1, 0.005));
    this.body.append(this.animRow(c, "transform.scale", "Scale", 0.05, 4, 0.01));
    this.body.append(this.animRow(c, "transform.rotation", "Rotation", -180, 180, 1));
    this.body.append(this.animRow(c, "transform.opacity", "Opacity", 0, 1, 0.01));
    this.body.append(
      this.selectField(
        "Fit",
        [["contain", "contain"], ["cover", "cover"], ["stretch", "stretch"]],
        () => c.transform.fit,
        (v) => this.edit(c, (cc) => ((cc as VisualClip).transform.fit = v as VisualClip["transform"]["fit"])),
      ),
    );
  }

  private titleSection(c: TitleClip): void {
    this.body.append(this.sectionTitle("Text"));
    this.body.append(this.textField("Text", () => c.text, (v) => this.editTitle(c, (cc) => (cc.text = v))));
    this.body.append(this.selectField("Font", FONT_OPTIONS, () => c.fontFamily, (v) => this.editTitle(c, (cc) => (cc.fontFamily = v))));
    this.body.append(this.numField("Size", () => c.fontSize, (v) => this.editTitle(c, (cc) => (cc.fontSize = Math.max(4, v))), { min: 4, max: 400, step: 1 }));
    this.body.append(this.numField("Weight", () => c.fontWeight, (v) => this.editTitle(c, (cc) => (cc.fontWeight = clamp(v, 100, 900))), { min: 100, max: 900, step: 100 }));
    this.body.append(this.checkField("Italic", () => c.italic, (v) => this.editTitle(c, (cc) => (cc.italic = v))));
    this.body.append(this.colorField("Color", () => c.color, (v) => this.editTitle(c, (cc) => (cc.color = v))));
    this.body.append(this.selectField("Align", [["left", "left"], ["center", "center"], ["right", "right"]], () => c.align, (v) => this.editTitle(c, (cc) => (cc.align = v as TitleClip["align"]))));
    this.body.append(this.numField("Line height", () => c.lineHeight, (v) => this.editTitle(c, (cc) => (cc.lineHeight = clamp(v, 0.5, 3))), { min: 0.5, max: 3, step: 0.05 }));
    this.body.append(this.numField("Letter spacing", () => c.letterSpacing, (v) => this.editTitle(c, (cc) => (cc.letterSpacing = v)), { step: 0.5 }));
    this.body.append(this.sectionTitle("Outline & shadow"));
    this.body.append(this.colorField("Stroke", () => c.strokeColor, (v) => this.editTitle(c, (cc) => (cc.strokeColor = v))));
    this.body.append(this.numField("Stroke w", () => c.strokeWidth, (v) => this.editTitle(c, (cc) => (cc.strokeWidth = Math.max(0, v))), { min: 0, max: 40, step: 0.5 }));
    this.body.append(this.checkField("Shadow", () => c.shadow.enabled, (v) => this.editTitle(c, (cc) => (cc.shadow.enabled = v))));
    this.body.append(this.colorField("Shadow color", () => c.shadow.color, (v) => this.editTitle(c, (cc) => (cc.shadow.color = v))));
    this.body.append(this.numField("Shadow blur", () => c.shadow.blur, (v) => this.editTitle(c, (cc) => (cc.shadow.blur = Math.max(0, v))), { min: 0, max: 60, step: 1 }));
    this.body.append(this.sectionTitle("Background box"));
    const bgBtn = document.createElement("button");
    bgBtn.textContent = c.bgColor === "transparent" ? "Enable bg" : "Make transparent";
    bgBtn.style.width = "100%";
    bgBtn.addEventListener("click", () => {
      this.editTitle(c, (cc) => (cc.bgColor = cc.bgColor === "transparent" ? "#000000" : "transparent"));
      this.render();
    });
    this.body.append(bgBtn);
    if (c.bgColor !== "transparent") {
      this.body.append(this.colorField("Bg color", () => c.bgColor, (v) => this.editTitle(c, (cc) => (cc.bgColor = v))));
      this.body.append(this.numField("Bg padding", () => c.bgPadding, (v) => this.editTitle(c, (cc) => (cc.bgPadding = Math.max(0, v))), { min: 0, max: 100, step: 1 }));
      this.body.append(this.numField("Bg radius", () => c.bgRadius, (v) => this.editTitle(c, (cc) => (cc.bgRadius = Math.max(0, v))), { min: 0, max: 100, step: 1 }));
    }
    this.body.append(this.sectionTitle("Animation"));
    this.body.append(
      this.selectField(
        "Preset",
        [["none", "none"], ["fade", "fade"], ["slide-up", "slide up"], ["slide-left", "slide left"], ["typewriter", "typewriter"], ["pop", "pop"]],
        () => c.animation.preset,
        (v) => this.editTitle(c, (cc) => (cc.animation.preset = v as TitleClip["animation"]["preset"])),
      ),
    );
    this.body.append(this.numField("In dur", () => c.animation.inDuration, (v) => this.editTitle(c, (cc) => (cc.animation.inDuration = Math.max(0, v))), { min: 0, step: 0.05 }));
    this.body.append(this.numField("Out dur", () => c.animation.outDuration, (v) => this.editTitle(c, (cc) => (cc.animation.outDuration = Math.max(0, v))), { min: 0, step: 0.05 }));
  }
  private editTitle(c: TitleClip, fn: (cc: TitleClip) => void): void {
    this.store.update("Title", (p) => {
      const cc = p.clips.find((x) => x.id === c.id) as TitleClip | undefined;
      if (cc) fn(cc);
    });
    this.engine.renderFrame();
  }

  private effectSection(c: EffectClip): void {
    this.body.append(this.sectionTitle("Adjustment layer"));
    const note = document.createElement("div");
    note.className = "muted-note";
    note.textContent = "Filters apply to all visual layers below this track.";
    this.body.append(note);
    this.filterStackEditor(c.id, c.filters);
  }

  private filterSection(c: VisualClip): void {
    this.body.append(this.sectionTitle("Filters"));
    this.filterStackEditor(c.id, c.filters);
  }

  private filterStackEditor(clipId: string, filters: FilterInstance[]): void {
    for (let i = 0; i < filters.length; i++) {
      this.body.append(this.filterCard(clipId, filters[i], i, filters.length));
    }
    // add filter
    const add = document.createElement("select");
    const ph = document.createElement("option");
    ph.value = "";
    ph.textContent = "+ Add filter…";
    add.append(ph);
    for (const t of FILTER_ORDER) {
      const o = document.createElement("option");
      o.value = t;
      o.textContent = FILTERS[t].label;
      add.append(o);
    }
    add.addEventListener("change", () => {
      if (!add.value) return;
      const f = makeFilter(add.value as FilterInstance["type"]);
      this.store.update("Add filter", (p) => {
        const cc = p.clips.find((x) => x.id === clipId) as { filters?: FilterInstance[] } | undefined;
        cc?.filters?.push(f);
      });
      this.engine.renderFrame();
      this.render();
    });
    this.body.append(add);
  }

  private filterCard(clipId: string, f: FilterInstance, idx: number, count: number): HTMLElement {
    const def = FILTERS[f.type];
    const card = document.createElement("div");
    card.className = "filter-card";
    const head = document.createElement("div");
    head.className = "filter-head";
    head.innerHTML = `<span>${escapeHtml(def.label)}</span>`;
    const ctrls = document.createElement("div");
    const enable = document.createElement("input");
    enable.type = "checkbox";
    enable.checked = f.enabled;
    enable.title = "enabled";
    enable.addEventListener("change", () => {
      this.editFilter(clipId, f.id, (ff) => (ff.enabled = enable.checked));
    });
    const up = mkBtn("↑", idx === 0, () => this.moveFilter(clipId, idx, -1));
    const down = mkBtn("↓", idx === count - 1, () => this.moveFilter(clipId, idx, 1));
    const del = mkBtn("×", false, () => this.removeFilter(clipId, f.id));
    del.className = "danger";
    ctrls.append(enable, up, down, del);
    head.append(ctrls);
    card.append(head);

    const lt = this.localTimeForClip(clipId);
    for (const n of def.numeric) {
      card.append(this.filterAnimRow(clipId, f, n.key, n.label, n.min, n.max, n.step, lt));
    }
    for (const col of def.colors) {
      card.append(
        this.colorField(col.label, () => (f.params[col.key] as string) ?? col.default, (v) =>
          this.editFilter(clipId, f.id, (ff) => (ff.params[col.key] = v)),
        ),
      );
    }
    if (f.type === "lut") {
      const luts = this.store.getProject().luts;
      const opts: [string, string][] = [["", "(none)"], ...luts.map((l) => [l.id, l.name] as [string, string])];
      card.append(
        this.selectField("LUT", opts, () => (f.params.lutId as string) ?? "", (v) =>
          this.editFilter(clipId, f.id, (ff) => (ff.params.lutId = v)),
        ),
      );
    }
    return card;
  }

  private filterAnimRow(
    clipId: string,
    f: FilterInstance,
    key: string,
    label: string,
    min: number,
    max: number,
    step: number,
    lt: number,
  ): HTMLElement {
    const input = document.createElement("input");
    input.type = "range";
    input.min = String(min);
    input.max = String(max);
    input.step = String(step);
    const val = f.params[key];
    input.value = String(typeof val === "number" ? val : isAnimated(val as Animatable) ? sampleAt(val as Animatable, lt) : min);
    let active = false;
    input.addEventListener("input", () => {
      if (!active) {
        active = true;
        this.store.beginTransaction(label);
      }
      const v = parseFloat(input.value);
      this.store.mutateLive((p) => {
        const cc = p.clips.find((x) => x.id === clipId) as { filters?: FilterInstance[] } | undefined;
        const ff = cc?.filters?.find((x) => x.id === f.id);
        if (!ff) return;
        const cur = ff.params[key];
        if (cur && typeof cur === "object" && "keys" in cur) ff.params[key] = addKeyframe(cur as Animatable, lt, v);
        else ff.params[key] = v;
      });
      this.engine.renderFrame();
    });
    const commit = () => {
      if (active) {
        active = false;
        this.store.commitTransaction();
      }
    };
    input.addEventListener("change", commit);
    input.addEventListener("blur", commit);
    return this.row(label, input);
  }

  private localTimeForClip(clipId: string): number {
    const c = this.store.getProject().clips.find((x) => x.id === clipId);
    return c ? this.localTime(c) : 0;
  }
  private editFilter(clipId: string, filterId: string, fn: (f: FilterInstance) => void): void {
    this.store.update("Filter", (p) => {
      const cc = p.clips.find((x) => x.id === clipId) as { filters?: FilterInstance[] } | undefined;
      const ff = cc?.filters?.find((x) => x.id === filterId);
      if (ff) fn(ff);
    });
    this.engine.renderFrame();
  }
  private removeFilter(clipId: string, filterId: string): void {
    this.store.update("Remove filter", (p) => {
      const cc = p.clips.find((x) => x.id === clipId) as { filters?: FilterInstance[] } | undefined;
      if (cc?.filters) cc.filters = cc.filters.filter((x) => x.id !== filterId);
    });
    this.engine.renderFrame();
    this.render();
  }
  private moveFilter(clipId: string, idx: number, dir: number): void {
    this.store.update("Reorder filter", (p) => {
      const cc = p.clips.find((x) => x.id === clipId) as { filters?: FilterInstance[] } | undefined;
      if (!cc?.filters) return;
      const j = idx + dir;
      if (j < 0 || j >= cc.filters.length) return;
      [cc.filters[idx], cc.filters[j]] = [cc.filters[j], cc.filters[idx]];
    });
    this.engine.renderFrame();
    this.render();
  }

  private renderTransition(): void {
    const id = this.store.ui.selectedTransitionId!;
    const tr = this.store.getProject().transitions.find((t) => t.id === id);
    if (!tr) {
      this.body.innerHTML = `<div class="muted-note">Transition not found.</div>`;
      return;
    }
    this.body.append(this.sectionTitle("Transition"));
    this.body.append(
      this.selectField(
        "Type",
        [["crossfade", "crossfade"], ["dip-black", "dip to black"], ["dip-white", "dip to white"], ["wipe", "wipe"], ["slide", "slide"]],
        () => tr.type,
        (v) => this.store.update("Transition type", (p) => {
          const t = p.transitions.find((x) => x.id === id);
          if (t) t.type = v as typeof tr.type;
        }),
      ),
    );
    const dur = document.createElement("input");
    dur.type = "number";
    dur.min = "0.1";
    dur.step = "0.1";
    dur.value = String(tr.duration);
    dur.addEventListener("change", () => {
      this.store.update("Transition duration", (p) => {
        const t = p.transitions.find((x) => x.id === id);
        if (t) t.duration = Math.max(0.1, parseFloat(dur.value));
      });
      this.engine.renderFrame();
    });
    this.body.append(this.row("Duration", dur));
  }
}

function mkBtn(label: string, disabled: boolean, onClick: () => void): HTMLButtonElement {
  const b = document.createElement("button");
  b.textContent = label;
  b.disabled = disabled;
  b.addEventListener("click", onClick);
  return b;
}

const FONT_OPTIONS: [string, string][] = [
  ["system-ui", "System"],
  ["Georgia, serif", "Georgia"],
  ["'Times New Roman', serif", "Times"],
  ["'Courier New', monospace", "Courier"],
  ["Impact, sans-serif", "Impact"],
  ["'Comic Sans MS', cursive", "Comic Sans"],
  ["Arial, sans-serif", "Arial"],
];
