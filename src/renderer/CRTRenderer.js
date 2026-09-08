/**
 * @file CRTRenderer.js — WebGL post-processing pipeline
 *
 * Architecture:
 *   1. Game world is rendered into an offscreen Canvas2D (640×400)
 *   2. That canvas is uploaded as a WebGL texture each frame
 *   3. A fullscreen quad fragment shader applies the CRT effects:
 *        • Nearest-neighbour upscale    — pixel-sharp, no bilinear blur
 *        • Mild barrel distortion       — readable curve without edge warp
 *        • Subtle chromatic aberration  — colour character, not smear
 *        • Tight-threshold bloom        — only brightest whites/cyans glow
 *        • Source-pixel scanlines       — lines tied to game pixels not screen pixels
 *        • Light phosphor flicker       — alive without fatiguing
 *        • Gentle vignette              — depth without eating the playfield
 *   4. The processed texture is composited onto the display canvas
 *
 * Tuning philosophy: a real C64 monitor (Commodore 1702, 1084) had tight
 * dot pitch and a sharp phosphor. The softness of retro games came from
 * low resolution, not from smearing. Every effect here is dialled to read
 * as "CRT character" rather than "image degradation".
 */

// ── GLSL shaders ─────────────────────────────────────────────────────────────

const VERT_SRC = `#version 300 es
precision mediump float;
in vec2 a_pos;
out vec2 v_uv;
void main() {
  v_uv = a_pos * 0.5 + 0.5;
  v_uv.y = 1.0 - v_uv.y;
  gl_Position = vec4(a_pos, 0.0, 1.0);
}`;

const FRAG_SRC = `#version 300 es
precision mediump float;

uniform sampler2D u_tex;
uniform float u_time;
uniform float u_barrel;     // barrel distortion strength  (default 0.04)
uniform float u_chroma;     // chromatic aberration offset (default 0.002)
uniform float u_scanline;   // scanline darkness factor    (default 0.55)
uniform float u_bloom;      // bloom intensity             (default 0.20)
uniform float u_flicker;    // phosphor flicker            (default 0.35)
uniform float u_vignette;   // vignette strength           (default 0.55)
uniform vec2  u_resolution; // display canvas size in px
uniform vec2  u_srcSize;    // source texture size (640×400)

in  vec2 v_uv;
out vec4 fragColor;

// ── Barrel distortion ─────────────────────────────────────────────────────────
vec2 barrel(vec2 uv) {
  vec2 cc = uv - 0.5;
  float r2 = dot(cc, cc);
  return uv + cc * r2 * u_barrel;
}

// ── Nearest-neighbour pixel-locked sample ─────────────────────────────────────
// Snaps UV to the centre of the nearest source texel so the WebGL sampler
// (even when set to NEAREST) doesn't bleed across texel boundaries under
// barrel distortion.
vec2 pixelLock(vec2 uv) {
  vec2 texel = 1.0 / u_srcSize;
  return (floor(uv / texel) + 0.5) * texel;
}

// ── Tight-threshold bloom ──────────────────────────────────────────────────────
// Only samples at ±1 source texel (not 2×), threshold 0.72 so only the
// brightest whites and cyans glow — the rest of the palette stays crisp.
vec3 bloom(sampler2D tex, vec2 uv) {
  vec2 t = 1.0 / u_srcSize;
  vec3 s = vec3(0.0);
  for (int dx = -1; dx <= 1; dx++) {
    for (int dy = -1; dy <= 1; dy++) {
      s += texture(tex, uv + vec2(float(dx), float(dy)) * t).rgb;
    }
  }
  s /= 9.0;
  float lum = dot(s, vec3(0.299, 0.587, 0.114));
  // Only pixels above luminance 0.72 contribute bloom
  return s * max(0.0, (lum - 0.72) * 3.5) * u_bloom;
}

void main() {
  vec2 texel = 1.0 / u_srcSize;

  // 1. Barrel distortion
  vec2 uv = barrel(v_uv);
  if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) {
    fragColor = vec4(0.0, 0.0, 0.0, 1.0);
    return;
  }

  // 2. Lock to source pixel grid before sampling — eliminates bilinear blur
  //    that occurs under barrel distortion even with NEAREST filtering
  vec2 uvLocked = pixelLock(uv);

  // 3. Chromatic aberration — fringe only at edges (magnitude grows with
  //    distance from centre), max 0.002 UV units
  vec2  dir = normalize(uv - 0.5) * length(uv - 0.5) * 2.0; // 0 at centre, 1 at corner
  float ca  = u_chroma;
  vec3 col;
  col.r = texture(u_tex, pixelLock(uvLocked + dir * ca * texel * 4.0)).r;
  col.g = texture(u_tex, uvLocked).g;
  col.b = texture(u_tex, pixelLock(uvLocked - dir * ca * texel * 4.0)).b;

  // 4. Bloom (tight threshold — only the very brightest pixels)
  col += bloom(u_tex, uvLocked);

  // 5. Scanlines — tied to SOURCE pixel rows (scale with the image, not the
  //    display). Every other row of the 400-line source is darkened.
  //    fract(uv.y * u_srcSize.y) gives position within each source texel row.
  float srcRow  = uv.y * u_srcSize.y;
  float scanPos = fract(srcRow);          // 0..1 within each source row
  // Dark band in the lower third of each source pixel row
  float scanMask = scanPos < 0.38
    ? (1.0 - u_scanline * 0.50)          // dark half of the line
    : 1.0;                                // bright half
  col *= scanMask;

  // 6. Phosphor flicker
  float flicker = 1.0 - u_flicker * 0.025 * fract(sin(u_time * 73.1) * 4375.5);
  col *= flicker;

  // 7. Vignette — subtle, only reaches ~15% into the playfield
  vec2  vig  = uv * (1.0 - uv);
  float vigF = pow(vig.x * vig.y * 16.0, u_vignette * 0.3);
  col *= vigF;

  fragColor = vec4(clamp(col, 0.0, 1.0), 1.0);
}`;

// ── Helper: compile a shader ──────────────────────────────────────────────────

function compileShader(gl, type, src) {
  const s = gl.createShader(type);
  gl.shaderSource(s, src);
  gl.compileShader(s);
  if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) {
    console.error('[CRT] Shader compile error:', gl.getShaderInfoLog(s));
    gl.deleteShader(s);
    return null;
  }
  return s;
}

function linkProgram(gl, vert, frag) {
  const p = gl.createProgram();
  gl.attachShader(p, vert);
  gl.attachShader(p, frag);
  gl.linkProgram(p);
  if (!gl.getProgramParameter(p, gl.LINK_STATUS)) {
    console.error('[CRT] Program link error:', gl.getProgramInfoLog(p));
    return null;
  }
  return p;
}

// ── CRTRenderer class ─────────────────────────────────────────────────────────

export class CRTRenderer {
  /**
   * @param {HTMLCanvasElement} displayCanvas  the visible canvas in the DOM
   * @param {HTMLCanvasElement} gameCanvas     offscreen 640×400 game canvas
   */
  constructor(displayCanvas, gameCanvas) {
    this.display    = displayCanvas;
    this.gameCanvas = gameCanvas;
    this._gl        = null;
    this._prog      = null;
    this._tex       = null;
    this._vao       = null;
    this._uniforms  = {};
    this._fallback  = false;
    this._time      = 0;

    // CRT effect parameters — tuned for sharpness-first retro character.
    // Every value is the minimum needed to read as "CRT" without degrading
    // legibility. Adjustable at runtime via crtRenderer.set(key, value).
    this.settings = {
      barrel:   0.04,   // was 0.12 — mild curve, no edge warp
      chroma:   0.002,  // was 0.006 — colour fringe only visible at edges
      scanline: 0.55,   // was 0.85 — lighter lines, readable contrast
      bloom:    0.20,   // was 0.55 — only brightest whites/cyans glow
      flicker:  0.35,   // was 0.70 — alive but not fatiguing
      vignette: 0.55,   // was 0.80 — depth without eating the playfield
    };

    this._init();
  }

  _init() {
    const canvas = this.display;
    let gl = null;
    try {
      gl = canvas.getContext('webgl2', { antialias: false, alpha: false });
    } catch {}
    if (!gl) {
      console.warn('[CRT] WebGL2 unavailable — falling back to Canvas2D blit');
      this._fallback = true;
      this._fallbackCtx = canvas.getContext('2d');
      return;
    }
    this._gl = gl;

    // Compile program
    const vert = compileShader(gl, gl.VERTEX_SHADER,   VERT_SRC);
    const frag = compileShader(gl, gl.FRAGMENT_SHADER, FRAG_SRC);
    if (!vert || !frag) { this._fallback = true; return; }
    this._prog = linkProgram(gl, vert, frag);
    if (!this._prog) { this._fallback = true; return; }

    // Fullscreen quad: two triangles covering clip space [-1,1]²
    const verts = new Float32Array([-1,-1,  1,-1,  -1,1,  -1,1,  1,-1,  1,1]);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, verts, gl.STATIC_DRAW);
    this._vao = gl.createVertexArray();
    gl.bindVertexArray(this._vao);
    const loc = gl.getAttribLocation(this._prog, 'a_pos');
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);

    // Texture for the game canvas.
    // NEAREST for both min and mag — pixel-sharp upscale.
    // The shader's pixelLock() function handles sub-texel precision under
    // barrel distortion so we never blur across source pixel boundaries.
    this._tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S,     gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T,     gl.CLAMP_TO_EDGE);

    // Cache uniform locations
    const p = this._prog;
    this._uniforms = {
      tex:        gl.getUniformLocation(p, 'u_tex'),
      time:       gl.getUniformLocation(p, 'u_time'),
      barrel:     gl.getUniformLocation(p, 'u_barrel'),
      chroma:     gl.getUniformLocation(p, 'u_chroma'),
      scanline:   gl.getUniformLocation(p, 'u_scanline'),
      bloom:      gl.getUniformLocation(p, 'u_bloom'),
      flicker:    gl.getUniformLocation(p, 'u_flicker'),
      vignette:   gl.getUniformLocation(p, 'u_vignette'),
      resolution: gl.getUniformLocation(p, 'u_resolution'),
      srcSize:    gl.getUniformLocation(p, 'u_srcSize'),
    };
  }

  /**
   * Present the game canvas through the CRT pipeline onto the display canvas.
   * Call once per frame, AFTER the game world has been drawn onto gameCanvas.
   * @param {number} dt  delta-time in seconds
   */
  present(dt) {
    this._time += dt;

    if (this._fallback) {
      // Plain blit — no shader effects
      const ctx = this._fallbackCtx;
      ctx.drawImage(this.gameCanvas, 0, 0,
        this.display.width, this.display.height);
      return;
    }

    const gl = this._gl;
    const u  = this._uniforms;
    const s  = this.settings;

    // Resize display canvas to its CSS pixel dimensions (handles retina / resize)
    const W = this.display.clientWidth  || this.display.width;
    const H = this.display.clientHeight || this.display.height;
    if (this.display.width !== W || this.display.height !== H) {
      this.display.width  = W;
      this.display.height = H;
    }

    // Upload game canvas as texture
    gl.bindTexture(gl.TEXTURE_2D, this._tex);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, this.gameCanvas);

    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 1);
    gl.clear(gl.COLOR_BUFFER_BIT);

    gl.useProgram(this._prog);
    gl.bindVertexArray(this._vao);

    gl.uniform1i (u.tex,        0);
    gl.uniform1f (u.time,       this._time);
    gl.uniform1f (u.barrel,     s.barrel);
    gl.uniform1f (u.chroma,     s.chroma);
    gl.uniform1f (u.scanline,   s.scanline);
    gl.uniform1f (u.bloom,      s.bloom);
    gl.uniform1f (u.flicker,    s.flicker);
    gl.uniform1f (u.vignette,   s.vignette);
    gl.uniform2f (u.resolution, W, H);
    gl.uniform2f (u.srcSize,    this.gameCanvas.width, this.gameCanvas.height);

    gl.drawArrays(gl.TRIANGLES, 0, 6);
    gl.bindVertexArray(null);
  }

  /** Dynamically update a CRT setting by name */
  set(key, value) {
    if (key in this.settings) this.settings[key] = value;
  }

  /** True if running in WebGL mode */
  get isWebGL() { return !this._fallback; }
}
