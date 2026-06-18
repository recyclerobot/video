# RR Video — Roadmap

> A browser-based, WebGL-powered, fully client-side video editor.
> No uploads, no server: media lives in IndexedDB, compositing runs on the GPU,
> export runs through WebCodecs.

This document describes where the project is today, where it's going, and the
concrete work required to get there. The **North Star** is a capable,
no-install browser editor that handles **image sequences, filters, animated
text, and professional-grade audio editing** end-to-end.

---

## 0. Implementation status (v0.2)

The roadmap below was written against v0.1. The codebase has since been
re-architected to implement essentially all of it. Quick status map:

| Phase | Status | Notes |
|---|---|---|
| 0 — Foundations | ✅ Done | Central `EditorStore`, transaction-based undo/redo, command layer, schema-v2 migrations, Vitest (25 tests) + GitHub Actions CI |
| 1 — Image & image-sequence import | ✅ Done | Stills + numeric-run sequence detection, lazy `ImageBitmap` LRU cache + prefetch |
| 2 — Transform & keyframes | ✅ Done | Per-clip transform (model matrix), generic animatable props + easing, preview drag/scale, keyframe toggles + markers |
| 3 — Filters & effects | ✅ Done | Multi-pass FBO pipeline; color grade, blur, sharpen, vignette, grain, pixelate, chroma key, `.cube` LUT; adjustment layers; crossfade/dip/wipe/slide transitions. *Shape masks still TODO.* |
| 4 — Text & titles 2.0 | ✅ Done | Fonts, weight, align, outline, shadow, bg box; fade/slide/typewriter/pop presets; direct manipulation; composited inside the GL pipeline |
| 5 — Pro audio | ✅ Done | Cut/copy/paste/duplicate, waveforms, fades, volume/pan automation, per-track gain/pan/solo/mute, master gain via one Web Audio graph (preview == export) |
| 6 — Timeline UX | ✅ Mostly | Snapping, ripple/lift delete, clipboard, multi-select, nudge, markers, range. *Full timeline virtualization still TODO (currently full rebuild).* |
| 7 — Render & export | ✅ Mostly | **Converged render path** (`engine/render.ts` used by preview + export); resolution/fps/bitrate/range options; PNG frame export. *Frame-accurate WebCodecs `VideoDecoder` decode and the audio-clock playback are partial — preview is audio-locked, export still uses element seeking.* |
| 8 — Polish & platform | ✅ Mostly | IndexedDB projects + multi-project browser, `.rrvproj` import/export, PWA (manifest + service worker). *CRDT collaboration and File System Access API not implemented (were stretch goals).* |

**Known deferrals (intentionally not built yet):** shape masks (3.3),
WebM/VP9/AV1 export, timeline virtualization, WebCodecs `VideoDecoder` export
path, CRDT collaboration. These remain as described in the phases below.

> The sections that follow are the original plan, kept verbatim as the reference
> spec and for the deferred items above.

---

## 1. Current State (v0.1)

### What works today
- **Multi-track timeline** — video, audio, title, and effect tracks ([`src/types.ts`](src/types.ts), [`src/main.ts`](src/main.ts)).
- **Import** — video & audio files via file picker / drag-drop; probed for duration, dimensions, thumbnail ([`src/media.ts`](src/media.ts)).
- **Clip editing** — trim (in/out handles), move, split at playhead, delete, per-clip speed.
- **Audio basics** — per-clip volume, mute, decouple/extract audio from a video clip into its own audio clip.
- **Titles** — text overlays with font size, color, background, normalized x/y position (2D canvas overlay).
- **Effects** — one color-grade stack (brightness, contrast, saturation, hue, tint) applied to all video layers below the effect track ([`src/webgl.ts`](src/webgl.ts)).
- **Compositing** — WebGL2, layered video tracks, alpha blending.
- **Persistence** — project JSON autosaved to `localStorage`; media blobs in IndexedDB ([`src/storage.ts`](src/storage.ts)).
- **Export** — MP4 (H.264 + AAC) via WebCodecs + `mp4-muxer`, with progress UI ([`src/export.ts`](src/export.ts)).

### Architecture snapshot
| Concern | Module | Notes |
|---|---|---|
| Data model | `types.ts` | `Project`, `Track`, `Clip` union, `MediaAsset` |
| App / UI | `main.ts` | ~950 lines, hand-rolled DOM, global mutable `project` |
| Preview | `playback.ts` | rAF loop, wall-clock `dt`, drives native media elements |
| GPU | `webgl.ts` | Single shader program, fullscreen quad, color grade only |
| Export | `export.ts` | Frame-by-frame `<video>` seek → `VideoEncoder` |
| Media pool | `media.ts` | `<video>`/`<audio>` element cache, object URLs |
| Storage | `storage.ts` | `localStorage` (project) + IndexedDB (blobs) |

### Known limitations (these drive the roadmap)
1. **No image or image-sequence support** — `MediaAsset.type` is only `"video" | "audio"`.
2. **No undo/redo** — destructive, mutable global state; a blocker for a real editor.
3. **No clip transform** — every video fills the frame (fullscreen quad); no scale/position/rotation/crop, so no picture-in-picture, no pan & zoom.
4. **No keyframes/animation** — every property is static for a clip's lifetime.
5. **Filters are limited** — one global color-grade stack; no per-clip filters, blur, sharpen, LUTs, vignette, masks, or transitions.
6. **Titles are basic** — single font, center align, no stroke/shadow, no animation, position by number entry only.
7. **Audio is thin** — no copy/paste/duplicate, no waveforms, no fades/crossfades, no automation/envelopes, no real-time effects (preview uses raw element volume, not a Web Audio graph).
8. **Timeline is naive** — clips can overlap on a track (only the first match renders), no snapping, no ripple, full DOM rebuild on every change.
9. **Playback drift** — preview advances by wall-clock `dt`, not locked to media or audio clock; sync is approximate.
10. **Persistence ceiling** — `localStorage` caps at ~5 MB; large projects silently fail to save.
11. **No tests / CI**, **Chromium-only** (WebCodecs), no project file import/export.

---

## 2. Guiding Principles

- **Client-side only.** Privacy and zero-infra are the product. No server round-trips for media.
- **GPU-first.** All visual compositing, filters, and transitions run as shaders so preview and export share one render path.
- **One render path.** Preview and export must call the *same* compositing code to guarantee WYSIWYG. Today they're forked (`playback.ts` vs `export.ts`) — converge them.
- **Non-destructive.** Edits describe transformations; source media is never mutated.
- **Incremental & shippable.** Every phase ends with something usable.

---

## 3. Roadmap Overview

| Phase | Theme | Headline outcome |
|---|---|---|
| **0** | Foundations | Central store, undo/redo, command system, tests |
| **1** | Image & image-sequence import | Stills and frame sequences as first-class media |
| **2** | Transform & keyframes | Move/scale/rotate clips; animate any property |
| **3** | Filters & effects | Per-clip filter stack, transitions, LUTs, masks |
| **4** | Text & titles 2.0 | Rich, animated, draggable text overlays |
| **5** | Pro audio | Waveforms, fades, copy/paste, automation, Web Audio mixer |
| **6** | Timeline UX | Snapping, ripple, clipboard, virtualized rendering |
| **7** | Render & export | Frame-accurate decode, formats, presets, quality |
| **8** | Polish & platform | Persistence, project files, collaboration, PWA |

Phases 1–5 deliver the four explicitly requested feature areas. Phase 0 and
Phase 2 are **prerequisites** that those features lean on (undo/redo, the
keyframe/transform system). The recommended build order is **0 → 1 → 2 → (3, 4, 5
in parallel) → 6 → 7 → 8**.

---

## Phase 0 — Foundations *(prerequisite)*

**Goal:** Replace the mutable global with an architecture that can support
undo/redo, large projects, and feature growth — before piling features on.

### 0.1 Central state store
- Introduce a single `EditorStore` holding `Project` + UI state (selection, playhead, zoom).
- All mutations go through typed actions/commands; subscribers re-render reactively.
- Decouple `main.ts` into modules: `ui/` (timeline, inspector, library, transport), `state/`, `engine/`.

### 0.2 Command pattern + Undo/Redo
- Model every edit (add/move/trim/split/delete/property-change) as a reversible **Command** with `do()`/`undo()`.
- Maintain undo & redo stacks; coalesce rapid changes (e.g. dragging a slider) into one undo step.
- Keyboard: `Cmd/Ctrl+Z`, `Cmd/Ctrl+Shift+Z`.
- **Acceptance:** any edit can be undone and redone; drag operations collapse to a single step.

### 0.3 Selection model
- Support multi-select (shift/cmd-click, marquee). Today `selection` is a single clip.
- Selection is store state, not a local variable.

### 0.4 Project schema versioning + migrations
- Bump `Project.version`; add a migration runner so old saved projects load forward.
- Centralize defaults so new fields (transform, keyframes) get sane values on load.

### 0.5 Testing & CI
- Add **Vitest** for unit tests (data model, commands, time math, audio mix math).
- Add **Playwright** for smoke tests (import → edit → export produces a valid MP4).
- GitHub Actions: typecheck + test on PR. Wire alongside the existing `build:docs` hook.

**Exit criteria:** undo/redo works across all edits; state is centralized; CI is green; no behavior regressions vs v0.1.

---

## Phase 1 — Image & Image-Sequence Import

**Goal:** Make still images and image sequences first-class citizens.

### 1.1 Still image support
- Extend `MediaAsset.type` to `"video" | "audio" | "image" | "sequence"`.
- Add an `ImageClip` (or generalize `VideoClip`) with a configurable on-timeline duration (default e.g. 5 s), since stills have no intrinsic duration.
- Probe images for dimensions + thumbnail in `probeMedia` (`<img>`/`createImageBitmap`).
- Accept `image/*` in the importer; render via `comp.uploadFrame` using an `ImageBitmap`.
- Inspector: duration, fit mode (contain/cover/stretch). Trimming = changing on-timeline duration.

### 1.2 Image-sequence import (`img_0001.png … img_0480.png`)
- Multi-file select / folder drop → detect numeric runs and group into **one sequence asset**.
- Parse the frame-number pattern; warn on gaps/missing frames.
- Store the sequence as an ordered list of blob ids in IndexedDB; metadata holds frame count + assumed fps.
- A `SequenceClip` maps timeline time → frame index given its fps; trim/speed work like video.
- **Performance:** decode frames to `ImageBitmap` lazily with an LRU cache + small read-ahead prefetch window; never hold the whole sequence in memory.
- Inspector: source fps, interpret-as (e.g. 24/30/60), loop/hold-last-frame.

### 1.3 Export integration
- Sequence/image clips flow through the same compositor path in `export.ts` (provide the right `ImageBitmap` per frame instead of seeking a `<video>`).

**Acceptance:** drop a folder of `frame_###.png`, get one clip; scrub and it shows the right frame; export matches preview. A single PNG/JPG/WebP imports as a still with adjustable duration.

---

## Phase 2 — Transform & Keyframe System *(prerequisite for 3, 4, 5)*

**Goal:** Position/scale/rotate clips and animate *any* numeric property over
time. This unlocks picture-in-picture, pan & zoom, animated titles, and
animated filter parameters.

### 2.1 Per-clip transform
- Add `transform` to visual clips: `{ x, y, scale, rotation, anchor, opacity, cropRect }` (normalized coords).
- Compositor: replace the hardcoded fullscreen quad with a per-clip model matrix; pass it as a uniform so each layer can be positioned/scaled/rotated.
- Preview interactions: draggable bounding box + resize/rotate handles on the overlay canvas (replaces numeric-only positioning).

### 2.2 Keyframe model
- Generic `Keyframe<T> = { time, value, easing }`; an `AnimatedProperty` is either a constant or a sorted keyframe list.
- Interpolation: linear + easing curves (ease-in/out, hold/step) with a small bezier evaluator.
- Make transform, opacity, volume, effect params, and title props animatable.
- Both the live engine and the export loop sample animated properties at frame time `t` (single shared `sampleAt(prop, t)` helper).

### 2.3 Keyframe UI
- Inspector: a "diamond" toggle per property to add/remove keyframes at the playhead.
- A keyframe lane under the selected clip on the timeline (drag to retime, right-click for easing).

**Acceptance:** animate a clip's position/scale/opacity across its duration; the curve plays back smoothly in preview and renders identically on export.

---

## Phase 3 — Filters & Effects

**Goal:** Move beyond a single global color grade to a flexible, per-clip
filter stack plus transitions.

### 3.1 Per-clip filter stack
- Each visual clip gets an ordered list of filters with their own (animatable) params.
- Refactor `webgl.ts` into a multi-pass pipeline using framebuffers (FBO ping-pong) so filters chain.
- Initial filter set:
  - Color: brightness/contrast/saturation/hue/tint (port existing), exposure, temperature/tint, levels/curves.
  - Blur (gaussian, separable), sharpen, vignette, grain/noise, pixelate.
  - **LUT** (.cube) import for cinematic color grading.
  - Chroma key (green-screen) with spill suppression.
- Keep the existing **effect track** as an "adjustment layer" that applies a filter stack to everything below (already the current model — generalize it to the new stack).

### 3.2 Transitions
- Transition objects living at clip boundaries: crossfade/dissolve, dip-to-black/white, wipe, slide, zoom.
- Implemented as a shader blending the outgoing and incoming layers over the overlap region.
- Timeline UI: drag a transition onto a cut; drag its width to set duration.

### 3.3 Masking (stretch)
- Shape masks (rect/ellipse) and feathering, animatable for reveals and selective filters.

**Acceptance:** stack blur + LUT + vignette on one clip with animated intensity; add a 1 s crossfade between two clips; both preview and export correctly.

---

## Phase 4 — Text & Titles 2.0

**Goal:** Rich, animated, directly-manipulable text.

### 4.1 Rich text styling
- Font family (bundled web fonts + user font upload via `FontFace`), weight/italic, line height, letter spacing.
- Alignment (left/center/right), multi-line with proper layout.
- Stroke/outline, drop shadow, background box with padding, corner radius, opacity.
- Per-clip safe-area guides.

### 4.2 Direct manipulation
- Drag to position, handles to scale/rotate (reuse the Phase 2 transform/handles).
- Snap to center / thirds / edges.

### 4.3 Animation presets
- Built on the Phase 2 keyframe system: fade in/out, slide in, typewriter, pop/scale, per-word/character reveal.
- A small library of title templates (lower-third, caption, title card).

### 4.4 Render quality
- Render text to a texture at device-pixel scale and composite **inside** the GL pipeline (so it can be transformed/filtered and z-ordered with video) rather than always on a flat top overlay.

**Acceptance:** a draggable lower-third title with custom font, outline, shadow, and a fade-in/slide animation that exports crisply.

---

## Phase 5 — Pro Audio *(explicit goal: cutting, duplicating, pasting, etc.)*

**Goal:** Make audio editing genuinely good. This is the heaviest single feature
area and should be its own focused track of work.

### 5.1 Editing operations
- **Cut / copy / paste / duplicate** clips (and clip ranges) via a clipboard, with paste-at-playhead. (Generalize to video too — see Phase 6.6.)
- **Razor/split** already exists — extend to split all clips under the playhead.
- Ripple delete (close the gap), and "lift" delete (leave the gap).
- Nudge by frame / by small time increments with arrow keys.

### 5.2 Waveform visualization
- Decode audio to a downsampled peaks array (in a Web Worker) and cache it.
- Draw waveforms inside audio (and video) clips on the timeline; redraw on zoom.

### 5.3 Fades & gain automation
- Per-clip fade-in / fade-out handles (corner drags) with curve choice.
- **Crossfades** between adjacent clips on the same track.
- Volume **automation** (gain envelope) via the Phase 2 keyframe system — draw points directly on the clip.

### 5.4 Real-time Web Audio mixer
- Replace raw `element.volume` preview with a **Web Audio graph**: each clip → gain (with envelope) → per-track gain/pan → master.
- Enables real-time fades, panning, and effects in preview that match export.
- Per-track controls: volume, pan, mute, **solo**; master bus with **level meters**.

### 5.5 Audio effects (stretch)
- EQ (filters), compressor/limiter, normalize, noise gate — all available via Web Audio nodes; render-matched in `OfflineAudioContext` on export.

### 5.6 Export parity
- `mixAudio` in `export.ts` must apply the same envelopes, fades, crossfades, pan, track gain, and effects as preview. Refactor so preview and offline mixing share one graph-builder.

**Acceptance:** cut a clip, paste two copies, add fades + a crossfade, draw a volume envelope, pan one track, solo another — and the exported MP4 audio matches the preview exactly.

---

## Phase 6 — Timeline & Editing UX

**Goal:** Make the timeline feel like a real NLE.

- **Snapping** to playhead, clip edges, markers, and other clips (toggleable, with magnetic threshold).
- **Overlap resolution** — clips on the same track can't silently overlap; either prevent, insert/ripple, or define top-most-wins explicitly (today only the first match renders, which is a latent bug).
- **Ripple / roll / slip / slide** trim modes.
- **Universal clipboard** — cut/copy/paste/duplicate for *all* clip kinds (built in Phase 5, generalized here).
- **Markers**, in/out range selection, and range-based export.
- **Virtualized timeline rendering** — stop rebuilding the entire DOM (`drawTimeline`) on every change; render only visible tracks/clips and diff updates. Critical for long timelines.
- **Zoom-to-fit**, scroll-follow playhead, frame-step (`,` / `.`).
- **Snapping playhead to frames** and a frame-accurate time display (current display is `mm:ss.cc`; add frames + timecode).

**Acceptance:** smooth interaction with a 10-minute, many-clip timeline; trims snap; no DOM jank.

---

## Phase 7 — Rendering & Export

**Goal:** Faster, more accurate, more flexible export — and a converged render path.

### 7.1 Converge preview & export
- Extract a single `renderFrame(project, t, target)` used by both `playback.ts` and `export.ts`. Today they duplicate compositing logic and can drift. This is the highest-leverage correctness fix.

### 7.2 Frame-accurate decode
- Replace `<video>` `currentTime` seeking in export (`seekVideoExact`) with **WebCodecs `VideoDecoder`** for deterministic, frame-accurate, faster decode. Element seeking is slow and occasionally off-by-a-frame.

### 7.3 Playback clock
- Drive preview from a media/audio clock instead of wall-clock `dt` accumulation to eliminate drift; drop frames under load rather than slipping time.

### 7.4 Export options & quality
- Resolution presets (720p/1080p/4K), fps, bitrate/quality slider, codec choice (H.264 now; **VP9/AV1/WebM** where supported via WebCodecs).
- Export range (in/out), and **GIF / WebP / PNG-sequence / single-frame (PNG)** export.
- HDR-safe color handling; configurable background (transparent export where the container allows).

### 7.5 Robustness
- Surface unsupported-codec errors clearly; feature-detect and degrade gracefully on non-Chromium browsers.
- Cancelable export; estimated time remaining; memory pressure handling for long renders.

**Acceptance:** export is frame-accurate, configurable, cancelable, and visually identical to preview.

---

## Phase 8 — Polish & Platform

**Goal:** Durability, sharing, and reach.

- **Persistence beyond localStorage** — move project state into IndexedDB (today large projects silently fail to save); support **multiple projects** with a project browser.
- **Project file import/export** — a `.json` (or zipped bundle with media) for backup/sharing; "Save As", recent projects.
- **File System Access API** — open/save to disk where supported.
- **PWA / offline** — installable, works offline (it's fully client-side already).
- **Performance budget** — OffscreenCanvas + Web Workers for decode/peaks/export so the UI stays responsive.
- **Accessibility & responsive layout** — keyboard-navigable, ARIA, usable on smaller screens.
- **Onboarding** — sample project, tooltips, shortcut cheatsheet.
- **Collaboration (stretch)** — CRDT-based shared editing; cloud sync as an *opt-in*, not a default.

---

## 4. Cross-Cutting Technical Themes

These thread through multiple phases and deserve dedicated attention:

1. **One render path** — preview and export must share compositing code (Phase 7.1). Everything else (filters, transforms, titles) inherits correctness from this.
2. **Keyframe everything** — the Phase 2 animation system is reused by filters (3), titles (4), and audio automation (5). Build it once, generically.
3. **Workers** — peaks generation, frame decode, and export should move off the main thread to keep the UI smooth.
4. **Memory discipline** — LRU caches and prefetch windows for sequence frames and decoded audio; revoke object URLs; dispose GPU textures (some disposal exists in `playback.ts`/`webgl.ts` — audit for leaks).
5. **Determinism** — given a project + time `t`, the rendered frame and mixed audio must be identical every time, on preview and export.

---

## 5. Suggested Near-Term Sequence (next ~5 milestones)

1. **M1 — Foundations:** central store + undo/redo + Vitest/Playwright + CI (Phase 0).
2. **M2 — Images:** still image import, then image-sequence import (Phase 1).
3. **M3 — Motion:** transform handles + keyframe system; ship pan & zoom and PiP (Phase 2).
4. **M4 — Audio core:** copy/paste/duplicate, waveforms, fades/crossfades, Web Audio mixer with solo/meters (Phase 5.1–5.4).
5. **M5 — Filters + Text:** per-clip filter stack + transitions (Phase 3) and Text 2.0 (Phase 4), both built on M3's keyframes.

Each milestone is independently shippable and leaves the editor more capable
than before.

---

## 6. Risks & Constraints

- **Browser support:** WebCodecs export is Chromium-only today. Document it; feature-detect; consider a (slower) `MediaRecorder` fallback for preview-quality export elsewhere.
- **Performance:** GPU multi-pass filters + many tracks + 4K can exceed budget — lean on FBO reuse, resolution-aware preview (render preview at display size, export at full).
- **Memory:** image sequences and decoded audio are large — caches and workers are non-negotiable (Section 4.4).
- **Scope:** Phase 5 (audio) and Phase 3 (filters) are each large; resist bundling them into one milestone.
- **Schema churn:** new fields (transform, keyframes, filters) require migrations (Phase 0.4) so saved projects keep loading.

---

## 7. Definition of Done (per feature)

A feature is "done" when:
- It works in **preview** and **exports identically** (same render path).
- It is **undoable/redoable**.
- It **persists** and survives reload (with migration if schema changed).
- It has **unit/smoke test** coverage for its core logic.
- Its inspector/timeline UI is **keyboard-accessible** and discoverable.
