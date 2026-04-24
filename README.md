# WebGL Video Editor

A browser-based, WebGL-powered video editor built with Vite + TypeScript. State is persisted to `localStorage`. Exports to MP4 (H.264) using the WebCodecs API.

## Features

- Multi-track timeline (video + audio + title + effect tracks)
- Trim clips (in/out points)
- Speed control (slow / fast playback per clip)
- Decoupled audio: remove or replace a clip's audio
- Title track (text overlays with styling)
- Effect track (color adjustments applied to all layers below)
- WebGL compositing with shader-based effects
- Project autosave to `localStorage`
- Export to MP4 H.264 via WebCodecs + `mp4-muxer`

## Develop

```bash
npm install
npm run dev
```

## Deploy to GitHub Pages

The site is built into `docs/`. A pre-commit hook runs `npm run build:docs`
on every commit (when non-`docs/` files change), so the deployed bundle stays
in sync with source. The `CNAME` file in `docs/` is **never** overwritten.

1. In your repo, set GitHub Pages source to **Deploy from a branch → `main` / `docs`**.
2. (Optional) place a `CNAME` file in `docs/` for a custom domain — it's preserved across builds.
3. Commit & push; the `docs/` folder will always reflect the latest build.

## Browser support

WebCodecs (used for export) requires a recent Chromium-based browser (Chrome/Edge ≥ 94, or Safari Tech Preview).
