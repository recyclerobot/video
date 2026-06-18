// WebGL2 multi-pass compositor.
//
// Pipeline per frame (driven by engine/render.ts):
//   clearAccum()
//   for each visual layer bottom→top:
//     tex = uploadSource(...)               // video frame / image / text canvas
//     layer = prepareLayer(slot, tex, ...)  // transform + crop + per-clip filters
//     compositeLayer(layer, opacity)        // alpha-blend onto accumulation
//   applyAdjustment(filters)                // adjustment-layer filters over accum
//   present()                               // accumulation → screen
//
// Transitions render two prepared layers (slot 0 + 1) and blend them onto accum.
//
// Orientation: the draw-source pass flips Y (sources are top-origin); every
// FBO→FBO pass samples straight, so the on-screen image is upright.
import { FILTERS } from "./filters";
import { sampleParam } from "./keyframes";
import { hexToRgb } from "./color";
import { modelMatrix, cropVec } from "./transform";
import type { FilterInstance, LutAsset, Transform, TransitionType } from "../types";

interface FBO {
  fbo: WebGLFramebuffer;
  tex: WebGLTexture;
}

const VERT_QUAD = `#version 300 es
layout(location = 0) in vec2 a_pos;
out vec2 v_uv;
void main(){ v_uv = a_pos * 0.5 + 0.5; gl_Position = vec4(a_pos, 0.0, 1.0); }`;

const VERT_MODEL = `#version 300 es
layout(location = 0) in vec2 a_pos;
uniform mat3 u_model;
uniform vec4 u_crop;
out vec2 v_uv;
void main(){
  vec3 p = u_model * vec3(a_pos, 1.0);
  gl_Position = vec4(p.xy, 0.0, 1.0);
  vec2 base = a_pos * 0.5 + 0.5;
  v_uv = vec2(mix(u_crop.x, 1.0 - u_crop.z, base.x), mix(u_crop.y, 1.0 - u_crop.w, base.y));
}`;

const FRAG_DRAW = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 outColor;
uniform sampler2D u_tex; uniform float u_opacity;
void main(){
  vec4 c = texture(u_tex, vec2(v_uv.x, 1.0 - v_uv.y));
  outColor = vec4(c.rgb, c.a * u_opacity);
}`;

const FRAG_BLIT = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 outColor;
uniform sampler2D u_tex; uniform float u_opacity;
void main(){ vec4 c = texture(u_tex, v_uv); outColor = vec4(c.rgb, c.a * u_opacity); }`;

const FRAG_TRANSITION = `#version 300 es
precision highp float;
in vec2 v_uv; out vec4 outColor;
uniform sampler2D u_texA, u_texB;
uniform float u_progress; uniform int u_type;
void main(){
  vec4 a = texture(u_texA, v_uv);
  vec4 b = texture(u_texB, v_uv);
  float p = u_progress;
  if (u_type == 0) { outColor = mix(a, b, p); }
  else if (u_type == 1) { vec4 m = vec4(0.0); outColor = p < 0.5 ? mix(a, m, p*2.0) : mix(m, b, (p-0.5)*2.0); }
  else if (u_type == 2) { vec4 m = vec4(1.0); outColor = p < 0.5 ? mix(a, m, p*2.0) : mix(m, b, (p-0.5)*2.0); }
  else if (u_type == 3) { outColor = v_uv.x < p ? b : a; }
  else { outColor = v_uv.x > (1.0 - p) ? b : a; }
}`;

const TRANSITION_INDEX: Record<TransitionType, number> = {
  crossfade: 0,
  "dip-black": 1,
  "dip-white": 2,
  wipe: 3,
  slide: 4,
};

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS))
    throw new Error(gl.getShaderInfoLog(sh) || "shader compile error");
  return sh;
}
function link(gl: WebGL2RenderingContext, vsSrc: string, fsSrc: string): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, compile(gl, gl.VERTEX_SHADER, vsSrc));
  gl.attachShader(p, compile(gl, gl.FRAGMENT_SHADER, fsSrc));
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS))
    throw new Error(gl.getProgramInfoLog(p) || "link error");
  return p;
}

export class Compositor {
  gl: WebGL2RenderingContext;
  private quad: WebGLVertexArrayObject;
  private progDraw: WebGLProgram;
  private progBlit: WebGLProgram;
  private progTransition: WebGLProgram;
  private filterProgs = new Map<string, WebGLProgram>();
  private uniforms = new WeakMap<WebGLProgram, Map<string, WebGLUniformLocation | null>>();
  private sources = new Map<string, WebGLTexture>();
  private lutTex = new Map<string, { tex: WebGLTexture; size: number }>();

  private W = 0;
  private H = 0;
  private accum!: FBO;
  private tmp!: FBO;
  private slots: FBO[][] = [];

  constructor(public canvas: HTMLCanvasElement | OffscreenCanvas) {
    const gl = (canvas as HTMLCanvasElement).getContext("webgl2", {
      premultipliedAlpha: false,
      alpha: false,
      preserveDrawingBuffer: true,
    }) as WebGL2RenderingContext | null;
    if (!gl) throw new Error("WebGL2 not supported");
    this.gl = gl;

    this.progDraw = link(gl, VERT_MODEL, FRAG_DRAW);
    this.progBlit = link(gl, VERT_QUAD, FRAG_BLIT);
    this.progTransition = link(gl, VERT_QUAD, FRAG_TRANSITION);

    this.quad = gl.createVertexArray()!;
    gl.bindVertexArray(this.quad);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(
      gl.ARRAY_BUFFER,
      new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]),
      gl.STATIC_DRAW,
    );
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    // bind a_pos to location 0 on all programs
    for (const p of [this.progDraw, this.progBlit, this.progTransition]) {
      gl.bindAttribLocation(p, 0, "a_pos");
    }
    gl.bindVertexArray(null);
    gl.disable(gl.DEPTH_TEST);
  }

  private uloc(p: WebGLProgram, name: string): WebGLUniformLocation | null {
    let m = this.uniforms.get(p);
    if (!m) {
      m = new Map();
      this.uniforms.set(p, m);
    }
    if (!m.has(name)) m.set(name, this.gl.getUniformLocation(p, name));
    return m.get(name)!;
  }

  private createFBO(): FBO {
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, this.W, this.H, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const fbo = gl.createFramebuffer()!;
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    return { fbo, tex };
  }

  setSize(w: number, h: number): void {
    if (w === this.W && h === this.H && this.accum) return;
    const gl = this.gl;
    this.W = w;
    this.H = h;
    if (this.canvas.width !== w) this.canvas.width = w;
    if (this.canvas.height !== h) this.canvas.height = h;
    // recreate buffers
    const dispose = (f?: FBO) => {
      if (!f) return;
      gl.deleteFramebuffer(f.fbo);
      gl.deleteTexture(f.tex);
    };
    dispose(this.accum);
    dispose(this.tmp);
    for (const slot of this.slots) for (const f of slot) dispose(f);
    this.accum = this.createFBO();
    this.tmp = this.createFBO();
    this.slots = [
      [this.createFBO(), this.createFBO()],
      [this.createFBO(), this.createFBO()],
    ];
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
  }

  uploadSource(key: string, source: TexImageSource): WebGLTexture {
    const gl = this.gl;
    let tex = this.sources.get(key);
    if (!tex) {
      tex = gl.createTexture()!;
      this.sources.set(key, tex);
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
      gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    } else {
      gl.bindTexture(gl.TEXTURE_2D, tex);
    }
    gl.pixelStorei(gl.UNPACK_FLIP_Y_WEBGL, false);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
    return tex;
  }
  disposeSource(key: string): void {
    const t = this.sources.get(key);
    if (t) {
      this.gl.deleteTexture(t);
      this.sources.delete(key);
    }
  }

  clearAccum(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.fbo);
    gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  /** Render a source through transform + crop + filter stack into a slot; returns its texture. */
  prepareLayer(
    slot: number,
    srcTex: WebGLTexture,
    srcW: number,
    srcH: number,
    transform: Transform,
    opacity: number,
    filters: FilterInstance[],
    localTime: number,
  ): WebGLTexture {
    const gl = this.gl;
    const bufs = this.slots[slot];
    // draw-source into bufs[0]
    gl.bindFramebuffer(gl.FRAMEBUFFER, bufs[0].fbo);
    gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progDraw);
    gl.bindVertexArray(this.quad);
    const m = modelMatrix(transform, srcW, srcH, this.W, this.H, localTime);
    gl.uniformMatrix3fv(this.uloc(this.progDraw, "u_model"), false, m);
    const cv = cropVec(transform);
    gl.uniform4f(this.uloc(this.progDraw, "u_crop"), cv[0], cv[1], cv[2], cv[3]);
    gl.uniform1f(this.uloc(this.progDraw, "u_opacity"), opacity);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, srcTex);
    gl.uniform1i(this.uloc(this.progDraw, "u_tex"), 0);
    gl.drawArrays(gl.TRIANGLES, 0, 6);

    // run filters, ping-pong bufs[0] <-> bufs[1]
    let curTex = bufs[0].tex;
    let other = 1;
    for (const flt of filters) {
      if (!flt.enabled) continue;
      const def = FILTERS[flt.type];
      const prog = this.filterProgram(flt.type);
      for (let pass = 0; pass < def.passes; pass++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, bufs[other].fbo);
        gl.viewport(0, 0, this.W, this.H);
        gl.disable(gl.BLEND);
        gl.useProgram(prog);
        gl.bindVertexArray(this.quad);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, curTex);
        gl.uniform1i(this.uloc(prog, "u_tex"), 0);
        this.setFilterUniforms(prog, flt, localTime, pass);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        curTex = bufs[other].tex;
        other = other === 0 ? 1 : 0;
      }
    }
    return curTex;
  }

  /** Alpha-blend a prepared layer texture onto the accumulation buffer. */
  compositeLayer(layerTex: WebGLTexture, opacity = 1): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.fbo);
    gl.viewport(0, 0, this.W, this.H);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.progBlit);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, layerTex);
    gl.uniform1i(this.uloc(this.progBlit, "u_tex"), 0);
    gl.uniform1f(this.uloc(this.progBlit, "u_opacity"), opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Blend two prepared layers via a transition and composite onto accum. */
  compositeTransition(
    texA: WebGLTexture,
    texB: WebGLTexture,
    progress: number,
    type: TransitionType,
  ): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.fbo);
    gl.viewport(0, 0, this.W, this.H);
    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
    gl.useProgram(this.progTransition);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, texA);
    gl.uniform1i(this.uloc(this.progTransition, "u_texA"), 0);
    gl.activeTexture(gl.TEXTURE1);
    gl.bindTexture(gl.TEXTURE_2D, texB);
    gl.uniform1i(this.uloc(this.progTransition, "u_texB"), 1);
    gl.uniform1f(this.uloc(this.progTransition, "u_progress"), progress);
    gl.uniform1i(this.uloc(this.progTransition, "u_type"), TRANSITION_INDEX[type]);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  /** Apply adjustment-layer filters in place over the accumulation buffer. */
  applyAdjustment(filters: FilterInstance[], localTime: number): void {
    const gl = this.gl;
    let srcFbo = this.accum;
    let dstFbo = this.tmp;
    let ran = false;
    for (const flt of filters) {
      if (!flt.enabled) continue;
      const def = FILTERS[flt.type];
      const prog = this.filterProgram(flt.type);
      for (let pass = 0; pass < def.passes; pass++) {
        gl.bindFramebuffer(gl.FRAMEBUFFER, dstFbo.fbo);
        gl.viewport(0, 0, this.W, this.H);
        gl.disable(gl.BLEND);
        gl.useProgram(prog);
        gl.bindVertexArray(this.quad);
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, srcFbo.tex);
        gl.uniform1i(this.uloc(prog, "u_tex"), 0);
        this.setFilterUniforms(prog, flt, localTime, pass);
        gl.drawArrays(gl.TRIANGLES, 0, 6);
        const t = srcFbo;
        srcFbo = dstFbo;
        dstFbo = t;
        ran = true;
      }
    }
    // if the latest result is not in accum, blit it back
    if (ran && srcFbo !== this.accum) {
      gl.bindFramebuffer(gl.FRAMEBUFFER, this.accum.fbo);
      gl.viewport(0, 0, this.W, this.H);
      gl.disable(gl.BLEND);
      gl.useProgram(this.progBlit);
      gl.bindVertexArray(this.quad);
      gl.activeTexture(gl.TEXTURE0);
      gl.bindTexture(gl.TEXTURE_2D, srcFbo.tex);
      gl.uniform1i(this.uloc(this.progBlit, "u_tex"), 0);
      gl.uniform1f(this.uloc(this.progBlit, "u_opacity"), 1);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }
  }

  /** Draw the accumulation buffer to the visible canvas / default framebuffer. */
  present(): void {
    const gl = this.gl;
    gl.bindFramebuffer(gl.FRAMEBUFFER, null);
    gl.viewport(0, 0, this.W, this.H);
    gl.disable(gl.BLEND);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.progBlit);
    gl.bindVertexArray(this.quad);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, this.accum.tex);
    gl.uniform1i(this.uloc(this.progBlit, "u_tex"), 0);
    gl.uniform1f(this.uloc(this.progBlit, "u_opacity"), 1);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  // ---- LUTs ----
  uploadLut(lut: LutAsset): void {
    if (this.lutTex.has(lut.id)) return;
    const gl = this.gl;
    const tex = gl.createTexture()!;
    gl.bindTexture(gl.TEXTURE_3D, tex);
    const n = lut.size;
    const data = new Uint8Array(n * n * n * 4);
    for (let i = 0; i < n * n * n; i++) {
      data[i * 4] = Math.round(Math.min(1, Math.max(0, lut.data[i * 3])) * 255);
      data[i * 4 + 1] = Math.round(Math.min(1, Math.max(0, lut.data[i * 3 + 1])) * 255);
      data[i * 4 + 2] = Math.round(Math.min(1, Math.max(0, lut.data[i * 3 + 2])) * 255);
      data[i * 4 + 3] = 255;
    }
    gl.texImage3D(gl.TEXTURE_3D, 0, gl.RGBA, n, n, n, 0, gl.RGBA, gl.UNSIGNED_BYTE, data);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_3D, gl.TEXTURE_WRAP_R, gl.CLAMP_TO_EDGE);
    this.lutTex.set(lut.id, { tex, size: n });
  }

  private filterProgram(type: string): WebGLProgram {
    let p = this.filterProgs.get(type);
    if (!p) {
      p = link(this.gl, VERT_QUAD, FILTERS[type as keyof typeof FILTERS].frag);
      this.gl.bindAttribLocation(p, 0, "a_pos");
      this.filterProgs.set(type, p);
    }
    return p;
  }

  private setFilterUniforms(
    prog: WebGLProgram,
    flt: FilterInstance,
    localTime: number,
    pass: number,
  ): void {
    const gl = this.gl;
    const def = FILTERS[flt.type];
    gl.uniform2f(this.uloc(prog, "u_resolution"), this.W, this.H);
    gl.uniform1f(this.uloc(prog, "u_seed"), (localTime * 60) % 100);
    // blur direction per pass
    if (flt.type === "blur") {
      gl.uniform2f(this.uloc(prog, "u_dir"), pass === 0 ? 1 : 0, pass === 0 ? 0 : 1);
    } else {
      gl.uniform2f(this.uloc(prog, "u_dir"), 1, 0);
    }
    for (const n of def.numeric) {
      gl.uniform1f(this.uloc(prog, `u_${n.key}`), sampleParam(flt.params[n.key], localTime, n.default));
    }
    for (const c of def.colors) {
      const hex = (flt.params[c.key] as string) ?? c.default;
      const [r, g, b] = hexToRgb(hex);
      gl.uniform3f(this.uloc(prog, `u_${c.key}`), r, g, b);
    }
    if (flt.type === "lut") {
      const lutId = flt.params.lutId as string;
      const lut = lutId ? this.lutTex.get(lutId) : undefined;
      gl.uniform1i(this.uloc(prog, "u_hasLut"), lut ? 1 : 0);
      if (lut) {
        gl.activeTexture(gl.TEXTURE1);
        gl.bindTexture(gl.TEXTURE_3D, lut.tex);
        gl.uniform1i(this.uloc(prog, "u_lut"), 1);
      }
    }
  }
}
