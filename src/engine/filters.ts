// Filter registry: GLSL fragment sources + parameter metadata.
// The compositor compiles one program per filter type and sets uniforms from
// the (animatable) params; the inspector renders controls from this metadata.
import { newId, type FilterInstance, type FilterType } from "../types";

export interface NumericParam {
  key: string;
  label: string;
  min: number;
  max: number;
  step: number;
  default: number;
}
export interface ColorParamDef {
  key: string;
  label: string;
  default: string;
}

export interface FilterDef {
  type: FilterType;
  label: string;
  /** Fragment shader body (full GLSL 300 es). */
  frag: string;
  numeric: NumericParam[];
  colors: ColorParamDef[];
  /** Number of ping-pong passes (blur = 2 for separable gaussian). */
  passes: number;
}

const HEADER = `#version 300 es
precision highp float;
in vec2 v_uv;
out vec4 outColor;
uniform sampler2D u_tex;
uniform vec2 u_resolution;
uniform vec2 u_dir;
uniform float u_seed;
`;

const HUE = `
vec3 hueRotate(vec3 c, float a){
  float cosA = cos(a), sinA = sin(a);
  mat3 m = mat3(
    0.299 + 0.701*cosA + 0.168*sinA, 0.587 - 0.587*cosA + 0.330*sinA, 0.114 - 0.114*cosA - 0.497*sinA,
    0.299 - 0.299*cosA - 0.328*sinA, 0.587 + 0.413*cosA + 0.035*sinA, 0.114 - 0.114*cosA + 0.292*sinA,
    0.299 - 0.300*cosA + 1.250*sinA, 0.587 - 0.588*cosA - 1.050*sinA, 0.114 + 0.886*cosA - 0.203*sinA
  );
  return clamp(m * c, 0.0, 1.0);
}
`;

export const FILTERS: Record<FilterType, FilterDef> = {
  colorgrade: {
    type: "colorgrade",
    label: "Color grade",
    passes: 1,
    numeric: [
      { key: "brightness", label: "Brightness", min: 0, max: 2, step: 0.01, default: 1 },
      { key: "contrast", label: "Contrast", min: 0, max: 2, step: 0.01, default: 1 },
      { key: "saturation", label: "Saturation", min: 0, max: 2, step: 0.01, default: 1 },
      { key: "hue", label: "Hue", min: -180, max: 180, step: 1, default: 0 },
      { key: "exposure", label: "Exposure", min: -2, max: 2, step: 0.01, default: 0 },
      { key: "temperature", label: "Temperature", min: -1, max: 1, step: 0.01, default: 0 },
      { key: "tintAmount", label: "Tint amt", min: 0, max: 1, step: 0.01, default: 0 },
    ],
    colors: [{ key: "tint", label: "Tint", default: "#000000" }],
    frag: `${HEADER}
uniform float u_brightness, u_contrast, u_saturation, u_hue, u_exposure, u_temperature, u_tintAmount;
uniform vec3 u_tint;
${HUE}
void main(){
  vec4 c = texture(u_tex, v_uv);
  vec3 rgb = c.rgb;
  rgb *= pow(2.0, u_exposure);
  rgb.r += u_temperature * 0.12; rgb.b -= u_temperature * 0.12;
  rgb = hueRotate(rgb, radians(u_hue));
  rgb = (rgb - 0.5) * u_contrast + 0.5;
  rgb *= u_brightness;
  float l = dot(rgb, vec3(0.2126, 0.7152, 0.0722));
  rgb = mix(vec3(l), rgb, u_saturation);
  rgb = mix(rgb, u_tint, u_tintAmount);
  outColor = vec4(clamp(rgb, 0.0, 1.0), c.a);
}`,
  },
  blur: {
    type: "blur",
    label: "Gaussian blur",
    passes: 2,
    numeric: [{ key: "radius", label: "Radius", min: 0, max: 20, step: 0.1, default: 2 }],
    colors: [],
    frag: `${HEADER}
uniform float u_radius;
void main(){
  vec2 px = u_dir / u_resolution;
  float w[5] = float[](0.227, 0.194, 0.121, 0.054, 0.016);
  vec4 sum = texture(u_tex, v_uv) * w[0];
  for (int i = 1; i < 5; i++){
    sum += texture(u_tex, v_uv + px * float(i) * u_radius) * w[i];
    sum += texture(u_tex, v_uv - px * float(i) * u_radius) * w[i];
  }
  outColor = sum;
}`,
  },
  sharpen: {
    type: "sharpen",
    label: "Sharpen",
    passes: 1,
    numeric: [{ key: "amount", label: "Amount", min: 0, max: 3, step: 0.01, default: 0.5 }],
    colors: [],
    frag: `${HEADER}
uniform float u_amount;
void main(){
  vec2 px = 1.0 / u_resolution;
  vec4 c = texture(u_tex, v_uv);
  vec3 n = texture(u_tex, v_uv + vec2(px.x,0)).rgb + texture(u_tex, v_uv - vec2(px.x,0)).rgb
         + texture(u_tex, v_uv + vec2(0,px.y)).rgb + texture(u_tex, v_uv - vec2(0,px.y)).rgb;
  vec3 sharp = c.rgb + (c.rgb * 4.0 - n) * u_amount;
  outColor = vec4(clamp(sharp, 0.0, 1.0), c.a);
}`,
  },
  vignette: {
    type: "vignette",
    label: "Vignette",
    passes: 1,
    numeric: [
      { key: "amount", label: "Amount", min: 0, max: 1, step: 0.01, default: 0.5 },
      { key: "radius", label: "Radius", min: 0.1, max: 1.2, step: 0.01, default: 0.75 },
    ],
    colors: [],
    frag: `${HEADER}
uniform float u_amount, u_radius;
void main(){
  vec4 c = texture(u_tex, v_uv);
  vec2 d = v_uv - 0.5;
  float r = length(d * vec2(u_resolution.x / u_resolution.y, 1.0));
  float v = smoothstep(u_radius, u_radius - 0.35, r);
  c.rgb *= mix(1.0, v, u_amount);
  outColor = c;
}`,
  },
  grain: {
    type: "grain",
    label: "Film grain",
    passes: 1,
    numeric: [{ key: "amount", label: "Amount", min: 0, max: 0.5, step: 0.005, default: 0.08 }],
    colors: [],
    frag: `${HEADER}
uniform float u_amount;
void main(){
  vec4 c = texture(u_tex, v_uv);
  float n = fract(sin(dot(v_uv * (u_seed + 1.0), vec2(12.9898, 78.233))) * 43758.5453);
  c.rgb += (n - 0.5) * u_amount;
  outColor = vec4(clamp(c.rgb, 0.0, 1.0), c.a);
}`,
  },
  pixelate: {
    type: "pixelate",
    label: "Pixelate",
    passes: 1,
    numeric: [{ key: "size", label: "Block px", min: 1, max: 64, step: 1, default: 8 }],
    colors: [],
    frag: `${HEADER}
uniform float u_size;
void main(){
  vec2 size = vec2(max(1.0, u_size));
  vec2 uv = (floor(v_uv * u_resolution / size) + 0.5) * size / u_resolution;
  outColor = texture(u_tex, uv);
}`,
  },
  chromakey: {
    type: "chromakey",
    label: "Chroma key",
    passes: 1,
    numeric: [
      { key: "threshold", label: "Threshold", min: 0, max: 1, step: 0.01, default: 0.3 },
      { key: "smoothness", label: "Smoothness", min: 0, max: 0.5, step: 0.01, default: 0.1 },
      { key: "spill", label: "Spill", min: 0, max: 1, step: 0.01, default: 0.3 },
    ],
    colors: [{ key: "key", label: "Key color", default: "#00ff00" }],
    frag: `${HEADER}
uniform float u_threshold, u_smoothness, u_spill;
uniform vec3 u_key;
void main(){
  vec4 c = texture(u_tex, v_uv);
  float d = distance(c.rgb, u_key);
  float a = smoothstep(u_threshold, u_threshold + u_smoothness + 0.001, d);
  // spill suppression: pull greenish residue toward luma
  float l = dot(c.rgb, vec3(0.2126, 0.7152, 0.0722));
  c.rgb = mix(c.rgb, vec3(l), (1.0 - a) * u_spill);
  outColor = vec4(c.rgb, c.a * a);
}`,
  },
  lut: {
    type: "lut",
    label: "LUT",
    passes: 1,
    numeric: [{ key: "amount", label: "Amount", min: 0, max: 1, step: 0.01, default: 1 }],
    colors: [],
    frag: `${HEADER}
uniform float u_amount;
uniform highp sampler3D u_lut;
uniform bool u_hasLut;
void main(){
  vec4 c = texture(u_tex, v_uv);
  if (u_hasLut) {
    vec3 graded = texture(u_lut, clamp(c.rgb, 0.0, 1.0)).rgb;
    c.rgb = mix(c.rgb, graded, u_amount);
  }
  outColor = c;
}`,
  },
};

/** Build a filter instance with default params for a given type. */
export function makeFilter(type: FilterType): FilterInstance {
  const def = FILTERS[type];
  const params: FilterInstance["params"] = {};
  for (const n of def.numeric) params[n.key] = n.default;
  for (const c of def.colors) params[c.key] = c.default;
  if (type === "lut") params.lutId = "";
  return { id: newId("flt"), type, enabled: true, params };
}

export const FILTER_ORDER: FilterType[] = [
  "colorgrade",
  "blur",
  "sharpen",
  "vignette",
  "grain",
  "pixelate",
  "chromakey",
  "lut",
];
