import { defineConfig } from "vite";

// Build into docs/ for GitHub Pages. Configure base via VITE_BASE env (default "/").
export default defineConfig({
  base: process.env.VITE_BASE ?? "/",
  build: {
    outDir: "docs",
    emptyOutDir: false, // we preserve CNAME via the build:docs script
    sourcemap: false,
    target: "es2022",
  },
});
