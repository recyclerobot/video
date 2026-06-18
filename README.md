# RR Video

A browser-based, WebGL-powered video editor built with Vite + TypeScript.
Everything runs client-side: media lives in IndexedDB, compositing runs on the
GPU, and export goes through the WebCodecs API. No uploads, no server.

## Features

- **Multi-track timeline** — video, audio, image, sequence, title, and adjustment tracks
- **Image & image-sequence import** — drop a folder of `frame_###.png` and it becomes one clip
- **Per-clip transform** — position, scale, rotation, opacity, crop, fit (PiP, pan & zoom)
- **Keyframe animation** — animate transform, opacity, filter params, volume, and pan with easing
- **Filter stacks** — color grade, blur, sharpen, vignette, grain, pixelate, chroma key, and `.cube` LUTs (multi-pass GPU pipeline)
- **Transitions** — crossfade, dip to black/white, wipe, slide
- **Rich text** — fonts, weight, alignment, outline, shadow, background box, and entrance/exit animation presets
- **Pro audio** — cut/copy/paste/duplicate, waveforms, fades, volume/pan automation, per-track gain/pan/solo/mute, master gain — mixed through a real Web Audio graph (preview matches export)
- **Editing** — split, ripple/lift delete, snapping, multi-select, nudge, markers, in/out range
- **Undo / redo** for every edit
- **Shared render path** — preview and export composite through the same code (WYSIWYG)
- **Export** — MP4 (H.264 + AAC) at chosen resolution / fps / bitrate, full timeline or a range, plus single-frame PNG
- **Projects** — multiple projects in IndexedDB, autosave, and portable `.rrvproj` import/export
- **PWA** — installable, works offline after first load

See [ROADMAP.md](ROADMAP.md) for the phased plan this implements.

## Develop

```bash
npm install
npm run dev        # dev server
npm run typecheck  # tsc --noEmit
npm test           # vitest
npm run build      # typecheck + production build into docs/
```

## Architecture

```
src/
  types.ts            data model (schema v2)
  state/              store, undo/redo commands, migrations
  engine/             keyframes, transform, filters, compositor, text,
                      audio mixer, shared render path, playback engine
  media/              probing, element pool, image sequences, waveforms
  ui/                 timeline, inspector, library
  storage.ts          IndexedDB (blobs + projects)
  projectFile.ts      .rrvproj bundles
  export.ts           WebCodecs MP4 export (shared render path)
  main.ts             wiring
```

Preview (`engine/playback.ts`) and export (`export.ts`) both call
`renderProject()` in `engine/render.ts`, so what you see is what you render.

## Deploy to GitHub Pages

The site builds into `docs/`. A pre-commit hook runs `npm run build:docs` when
non-`docs/` files change, so the deployed bundle stays in sync. The `CNAME` file
in `docs/` is preserved across builds.

1. Set GitHub Pages source to **Deploy from a branch → `main` / `docs`**.
2. (Optional) place a `CNAME` in `docs/` for a custom domain.

## Browser support

Export uses WebCodecs (`VideoEncoder`), which requires a recent Chromium-based
browser (Chrome/Edge). LUTs use WebGL2 3D textures. Preview works wherever
WebGL2 + Web Audio are available.
