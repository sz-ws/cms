"use client";

import { useEffect, useRef, useState } from "react";

// The video itself is never shown — every frame is sampled, Bayer-dithered,
// and re-rendered as a colored glyph field on a light ground. Dense glyphs
// follow darkness and saturation, so the bloom reads as a living drawing.
const RAMP = " `.,:;i1tfLCG08@";
const BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];
const PLAYBACK_RATE = 0.9;
const CHAR_ASPECT = 0.6; // mono glyph width/height ratio
const PAPER = "#fbfaf9";

function clamp01(v: number): number {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

export function LoginAsciiField({
  onPhase,
}: {
  onPhase?: (phase: "playing" | "held") => void;
}) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const sampleRef = useRef<HTMLCanvasElement | null>(null);
  const rafRef = useRef<number | null>(null);
  const rvfcRef = useRef<number | null>(null);
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const video = videoRef.current;
    const canvas = canvasRef.current;
    if (!video || !canvas) return;
    const player: HTMLVideoElement = video;
    const display: HTMLCanvasElement = canvas;

    const reducedMotion = window.matchMedia(
      "(prefers-reduced-motion: reduce)",
    ).matches;

    // requestVideoFrameCallback 只在影片真的推進到下一張畫面時觸發,不像 rAF
    // 跟著螢幕刷新率(60~120Hz)空轉——影片來源沒那麼多幀,rAF 版等於同一張畫面
    // 重算好幾次逐格的亮度/dither/邊緣運算。舊瀏覽器(如較舊版 Firefox)沒有這個
    // API 則退回 rAF,行為與改動前一致。
    const supportsRVFC = typeof player.requestVideoFrameCallback === "function";

    function stopLoop() {
      if (rafRef.current !== null) {
        cancelAnimationFrame(rafRef.current);
        rafRef.current = null;
      }
      if (rvfcRef.current !== null) {
        player.cancelVideoFrameCallback(rvfcRef.current);
        rvfcRef.current = null;
      }
    }

    function scheduleStep() {
      if (supportsRVFC) {
        rvfcRef.current = player.requestVideoFrameCallback(step);
      } else {
        rafRef.current = requestAnimationFrame(step);
      }
    }

    function render() {
      if (player.readyState < 2 || !player.videoWidth) return;

      const width = window.innerWidth;
      const height = window.innerHeight;
      const dpr = Math.min(window.devicePixelRatio || 1, 1.5);

      if (display.width !== Math.floor(width * dpr)) {
        display.width = Math.floor(width * dpr);
        display.height = Math.floor(height * dpr);
        display.style.width = `${width}px`;
        display.style.height = `${height}px`;
      }

      const ctx = display.getContext("2d");
      if (!ctx) return;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      // glyph grid sized to viewport
      const cellW = width < 640 ? 7.5 : width < 1280 ? 7 : 6.5;
      const cols = Math.floor(width / cellW);
      const cellH = cellW / CHAR_ASPECT;
      const rows = Math.ceil(height / cellH);
      // 視窗尚未 layout(寬/高為 0)時 cols/rows 會是 0,getImageData(…,0,…) 會丟
      // IndexSizeError。先跳過,下次 rAF/resize 拿到實際尺寸再畫。
      if (cols < 1 || rows < 1) return;

      const sample = sampleRef.current ?? document.createElement("canvas");
      sampleRef.current = sample;
      sample.width = cols;
      sample.height = rows;
      const sctx = sample.getContext("2d", { willReadFrequently: true });
      if (!sctx) return;

      // cover-crop the video into the grid so the bloom fills any viewport
      const gridAspect = (cols * CHAR_ASPECT) / rows;
      const videoAspect = player.videoWidth / player.videoHeight;
      let sx = 0;
      let sy = 0;
      let sw = player.videoWidth;
      let sh = player.videoHeight;
      if (videoAspect > gridAspect) {
        sw = player.videoHeight * gridAspect;
        sx = (player.videoWidth - sw) / 2;
      } else {
        sh = player.videoWidth / gridAspect;
        sy = (player.videoHeight - sh) / 2;
      }
      sctx.drawImage(player, sx, sy, sw, sh, 0, 0, cols, rows);
      const { data } = sctx.getImageData(0, 0, cols, rows);

      ctx.fillStyle = PAPER;
      ctx.fillRect(0, 0, width, height);
      ctx.font = `${cellH}px ui-monospace, SFMono-Regular, Menlo, monospace`;
      ctx.textBaseline = "top";

      // concentric rings radiate from the bloom core: in quiet sky cells the
      // dither dots only survive near ring crests, so the background texture
      // itself becomes a set of circles around the flower
      const ringCx = width * 0.64;
      const ringCy = height * 0.78;
      const ringPeriod = Math.max(56, Math.min(width, height) * 0.085);

      // luminance grid first, so a cheap edge pass can trace petal contours
      const lums = new Float32Array(cols * rows);
      for (let c = 0; c < cols * rows; c++) {
        lums[c] =
          (0.2126 * data[c * 4] +
            0.7152 * data[c * 4 + 1] +
            0.0722 * data[c * 4 + 2]) /
          255;
      }

      for (let y = 0; y < rows; y++) {
        for (let x = 0; x < cols; x++) {
          const i = (y * cols + x) * 4;
          const r = data[i];
          const g = data[i + 1];
          const b = data[i + 2];
          const lum = lums[y * cols + x];
          const max = Math.max(r, g, b);
          const sat = max === 0 ? 0 : (max - Math.min(r, g, b)) / max;

          // local contrast traces the drawing: petal edges and veins pop
          // even where petal and sky luminance are nearly identical
          const lumL = lums[y * cols + Math.max(0, x - 1)];
          const lumR = lums[y * cols + Math.min(cols - 1, x + 1)];
          const lumU = lums[Math.max(0, y - 1) * cols + x];
          const lumD = lums[Math.min(rows - 1, y + 1) * cols + x];
          const edge = Math.abs(lumR - lumL) + Math.abs(lumD - lumU);

          // ink follows darkness + saturation + edges: the flat sky drops
          // out, contours and the violet core carry the image
          const ink = clamp01((1 - lum) * 0.8 + sat * 0.7 + edge * 1.8);
          const dither = (BAYER_8[y % 8][x % 8] / 64 - 0.5) * 0.2;

          const px = x * cellW + cellW / 2;
          const py = y * cellH + cellH / 2;
          const dist = Math.hypot(px - ringCx, py - ringCy);
          const ring = Math.sin((dist / ringPeriod) * Math.PI * 2);
          const ringBoost = ring > 0 ? ring * ring * 0.07 : 0;

          const shaped = Math.pow(
            clamp01((ink + dither * 0.5 + ringBoost - 0.24) / 0.6),
            1.3,
          );
          const level = clamp01(shaped + dither * 0.08);
          const char = RAMP[Math.floor(level * (RAMP.length - 1))];
          if (char === " ") continue;

          // boost saturation, darken to hold on the light ground, and pull
          // quiet cells toward blue so the dither field reads cool
          const lumC = 0.2126 * r + 0.7152 * g + 0.0722 * b;
          const tone = 0.86 - level * 0.34;
          const blue = (1 - level) * 0.72;
          let cr = clamp01((lumC + (r - lumC) * 1.7) / 255) * 255 * tone;
          let cg = clamp01((lumC + (g - lumC) * 1.7) / 255) * 255 * tone;
          let cb = clamp01((lumC + (b - lumC) * 1.7) / 255) * 255 * tone;
          cr = Math.round(cr + (86 - cr) * blue);
          cg = Math.round(cg + (114 - cg) * blue);
          cb = Math.round(cb + (228 - cb) * blue);
          ctx.fillStyle = `rgb(${cr},${cg},${cb})`;
          ctx.fillText(char, x * cellW, y * cellH);
        }
      }
    }

    function step() {
      render();
      if (!player.paused && !player.ended) {
        scheduleStep();
      }
    }

    function handleLoadedData() {
      render();
      setVisible(true);
      if (reducedMotion) {
        player.currentTime = Math.max(0, player.duration - 0.05);
        onPhase?.("held");
        return;
      }
      player.playbackRate = PLAYBACK_RATE;
      onPhase?.("playing");
      player.play().catch(() => {
        // autoplay blocked: hold the first decoded frame
        render();
        onPhase?.("held");
      });
    }

    function handlePlay() {
      stopLoop();
      scheduleStep();
    }

    function handleEnded() {
      stopLoop();
      render();
      onPhase?.("held");
    }

    function handleSeeked() {
      render();
    }

    function handleResize() {
      render();
    }

    if (player.readyState >= 2) handleLoadedData();
    player.addEventListener("loadeddata", handleLoadedData);
    player.addEventListener("play", handlePlay);
    player.addEventListener("ended", handleEnded);
    player.addEventListener("seeked", handleSeeked);
    window.addEventListener("resize", handleResize);

    return () => {
      stopLoop();
      player.removeEventListener("loadeddata", handleLoadedData);
      player.removeEventListener("play", handlePlay);
      player.removeEventListener("ended", handleEnded);
      player.removeEventListener("seeked", handleSeeked);
      window.removeEventListener("resize", handleResize);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div
      className="absolute inset-0 overflow-hidden bg-[#fbfaf9]"
      aria-hidden
    >
      <video
        ref={videoRef}
        className="pointer-events-none absolute h-px w-px opacity-0"
        autoPlay
        muted
        playsInline
        preload="auto"
        poster="/login-media/flower-bloom-poster.jpg"
        crossOrigin="anonymous"
      >
        <source src="/login-media/flower-bloom.webm" type="video/webm" />
        <source src="/login-media/flower-bloom.mp4" type="video/mp4" />
      </video>

      <canvas
        ref={canvasRef}
        className="absolute inset-0 transition-opacity duration-[1400ms] ease-out"
        style={{ opacity: visible ? 1 : 0 }}
      />

      {/* soften the field behind the form column so glyphs never fight the fields */}
      <div className="absolute inset-0 bg-[radial-gradient(ellipse_56%_64%_at_50%_50%,rgba(251,250,249,0.72),transparent_74%)]" />
      <div className="absolute inset-0 bg-[linear-gradient(180deg,rgba(251,250,249,0.85),transparent_16%,transparent_84%,rgba(251,250,249,0.85))]" />
    </div>
  );
}
