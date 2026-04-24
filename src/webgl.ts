// WebGL2 compositor.
// - Each video clip frame is uploaded to a texture.
// - Effect clips active at the playhead build a per-frame uniform stack
//   that is applied to all layers below them.
// - Title clips are rendered in 2D after compositing (we use a separate
//   2D overlay canvas for crisp text — kept simple).
import type { EffectClip, TitleClip } from "./types";

const VERT = `#version 300 es
in vec2 a_pos;
in vec2 a_uv;
out vec2 v_uv;
void main(){
  v_uv = a_uv;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

// Layer shader applies brightness/contrast/saturation/hue/tint.
const FRAG = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform float u_brightness;
uniform float u_contrast;
uniform float u_saturation;
uniform float u_hue; // radians
uniform vec4  u_tint; // rgb + amount
uniform float u_opacity;

vec3 hueRotate(vec3 c, float a){
  // rotate around luma axis using YIQ-like matrix
  float cosA = cos(a), sinA = sin(a);
  mat3 m = mat3(
    0.299 + 0.701*cosA + 0.168*sinA, 0.587 - 0.587*cosA + 0.330*sinA, 0.114 - 0.114*cosA - 0.497*sinA,
    0.299 - 0.299*cosA - 0.328*sinA, 0.587 + 0.413*cosA + 0.035*sinA, 0.114 - 0.114*cosA + 0.292*sinA,
    0.299 - 0.300*cosA + 1.250*sinA, 0.587 - 0.588*cosA - 1.050*sinA, 0.114 + 0.886*cosA - 0.203*sinA
  );
  return clamp(m * c, 0.0, 1.0);
}

void main(){
  vec4 c = texture(u_tex, vec2(v_uv.x, 1.0 - v_uv.y));
  vec3 rgb = c.rgb;
  rgb = hueRotate(rgb, u_hue);
  rgb = (rgb - 0.5) * u_contrast + 0.5;
  rgb *= u_brightness;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, u_saturation);
  rgb = mix(rgb, u_tint.rgb, u_tint.a);
  outColor = vec4(clamp(rgb, 0.0, 1.0), c.a * u_opacity);
}`;

function compile(gl: WebGL2RenderingContext, type: number, src: string): WebGLShader {
  const sh = gl.createShader(type)!;
  gl.shaderSource(sh, src);
  gl.compileShader(sh);
  if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) {
    throw new Error(gl.getShaderInfoLog(sh) || "shader compile error");
  }
  return sh;
}

function link(gl: WebGL2RenderingContext, vs: WebGLShader, fs: WebGLShader): WebGLProgram {
  const p = gl.createProgram()!;
  gl.attachShader(p, vs);
  gl.attachShader(p, fs);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    throw new Error(gl.getProgramInfoLog(p) || "link error");
  }
  return p;
}

export interface ColorParams {
  brightness: number;
  contrast: number;
  saturation: number;
  hue: number; // degrees
  tint: [number, number, number];
  tintAmount: number;
  opacity: number;
}

export const NEUTRAL_COLOR: ColorParams = {
  brightness: 1, contrast: 1, saturation: 1, hue: 0,
  tint: [0, 0, 0], tintAmount: 0, opacity: 1,
};

export function combineEffects(effects: EffectClip[]): ColorParams {
  // Compose multiple effect clips: multiply brightness/contrast/saturation,
  // sum hue, blend tint.
  const out: ColorParams = { ...NEUTRAL_COLOR, tint: [0, 0, 0] };
  for (const e of effects) {
    out.brightness *= e.brightness;
    out.contrast *= e.contrast;
    out.saturation *= e.saturation;
    out.hue += e.hue;
    const t = hexToRgb(e.tint);
    // alpha-style blend of tints, weighted by amount
    const a = Math.min(1, out.tintAmount + e.tintAmount);
    if (a > 0) {
      const w = e.tintAmount / a;
      out.tint = [
        out.tint[0] * (1 - w) + t[0] * w,
        out.tint[1] * (1 - w) + t[1] * w,
        out.tint[2] * (1 - w) + t[2] * w,
      ];
      out.tintAmount = a;
    }
  }
  return out;
}

export function hexToRgb(hex: string): [number, number, number] {
  const m = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(hex);
  if (!m) return [0, 0, 0];
  return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
}

export class Compositor {
  gl: WebGL2RenderingContext;
  program: WebGLProgram;
  vao: WebGLVertexArrayObject;
  texByKey = new Map<string, WebGLTexture>();
  uLoc: Record<string, WebGLUniformLocation | null> = {};

  constructor(public canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl2", { premultipliedAlpha: false, alpha: false });
    if (!gl) throw new Error("WebGL2 not supported");
    this.gl = gl;
    const vs = compile(gl, gl.VERTEX_SHADER, VERT);
    const fs = compile(gl, gl.FRAGMENT_SHADER, FRAG);
    this.program = link(gl, vs, fs);

    const aPos = gl.getAttribLocation(this.program, "a_pos");
    const aUv = gl.getAttribLocation(this.program, "a_uv");
    this.uLoc = {
      u_tex: gl.getUniformLocation(this.program, "u_tex"),
      u_brightness: gl.getUniformLocation(this.program, "u_brightness"),
      u_contrast: gl.getUniformLocation(this.program, "u_contrast"),
      u_saturation: gl.getUniformLocation(this.program, "u_saturation"),
      u_hue: gl.getUniformLocation(this.program, "u_hue"),
      u_tint: gl.getUniformLocation(this.program, "u_tint"),
      u_opacity: gl.getUniformLocation(this.program, "u_opacity"),
    };

    this.vao = gl.createVertexArray()!;
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer()!;
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    // x,y, u,v — fullscreen quad
    const data = new Float32Array([
      -1, -1, 0, 0,
       1, -1, 1, 0,
      -1,  1, 0, 1,
      -1,  1, 0, 1,
       1, -1, 1, 0,
       1,  1, 1, 1,
    ]);
    gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(aPos);
    gl.vertexAttribPointer(aPos, 2, gl.FLOAT, false, 16, 0);
    gl.enableVertexAttribArray(aUv);
    gl.vertexAttribPointer(aUv, 2, gl.FLOAT, false, 16, 8);
    gl.bindVertexArray(null);

    gl.enable(gl.BLEND);
    gl.blendFuncSeparate(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA, gl.ONE, gl.ONE_MINUS_SRC_ALPHA);
  }

  resize(w: number, h: number): void {
    if (this.canvas.width !== w || this.canvas.height !== h) {
      this.canvas.width = w;
      this.canvas.height = h;
    }
    this.gl.viewport(0, 0, w, h);
  }

  clear(): void {
    const gl = this.gl;
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);
  }

  uploadFrame(key: string, source: TexImageSource): WebGLTexture {
    const gl = this.gl;
    let tex = this.texByKey.get(key);
    if (!tex) {
      tex = gl.createTexture()!;
      this.texByKey.set(key, tex);
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

  drawTexture(tex: WebGLTexture, color: ColorParams): void {
    const gl = this.gl;
    gl.useProgram(this.program);
    gl.bindVertexArray(this.vao);
    gl.activeTexture(gl.TEXTURE0);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    gl.uniform1i(this.uLoc.u_tex, 0);
    gl.uniform1f(this.uLoc.u_brightness, color.brightness);
    gl.uniform1f(this.uLoc.u_contrast, color.contrast);
    gl.uniform1f(this.uLoc.u_saturation, color.saturation);
    gl.uniform1f(this.uLoc.u_hue, (color.hue * Math.PI) / 180);
    gl.uniform4f(this.uLoc.u_tint, color.tint[0], color.tint[1], color.tint[2], color.tintAmount);
    gl.uniform1f(this.uLoc.u_opacity, color.opacity);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  disposeTex(key: string): void {
    const t = this.texByKey.get(key);
    if (t) {
      this.gl.deleteTexture(t);
      this.texByKey.delete(key);
    }
  }
}

/** Render title clips onto a 2D context. */
export function renderTitles(ctx: CanvasRenderingContext2D, w: number, h: number, titles: TitleClip[]): void {
  ctx.save();
  for (const t of titles) {
    if (t.bgColor && t.bgColor !== "transparent") {
      ctx.fillStyle = t.bgColor;
      const metrics = measure(ctx, t);
      const px = t.x * w - metrics.width / 2 - 12;
      const py = t.y * h - metrics.height / 2 - 6;
      ctx.fillRect(px, py, metrics.width + 24, metrics.height + 12);
    }
    ctx.fillStyle = t.color;
    ctx.font = `${t.fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    const lines = t.text.split("\n");
    const lineH = t.fontSize * 1.2;
    const totalH = lines.length * lineH;
    lines.forEach((ln, i) => {
      ctx.fillText(ln, t.x * w, t.y * h - totalH / 2 + lineH * (i + 0.5));
    });
  }
  ctx.restore();
}

function measure(ctx: CanvasRenderingContext2D, t: TitleClip) {
  ctx.font = `${t.fontSize}px ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif`;
  const lines = t.text.split("\n");
  const widths = lines.map((l) => ctx.measureText(l).width);
  const width = Math.max(0, ...widths);
  const height = lines.length * t.fontSize * 1.2;
  return { width, height };
}
