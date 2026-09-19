import jsQR from "jsqr";
import QRCode from "qrcode";
import { useEffect, useRef, useState, type ReactNode } from "react";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal card" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="row">
          <h3 style={{ margin: 0 }}>{title}</h3>
          <div className="spacer" />
          <button className="btn ghost sm" onClick={onClose} aria-label="Kapat">
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function QrImage({ text, size = 280 }: { text: string; size?: number }) {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    QRCode.toDataURL(text, { width: size, margin: 1, errorCorrectionLevel: "M" }).then(setUrl);
  }, [text, size]);
  return url ? (
    <img src={url} width={size} height={size} alt="Ödeme dilimi QR kodu" style={{ display: "block", margin: "0 auto", borderRadius: 12 }} />
  ) : (
    <div style={{ width: size, height: size }} />
  );
}

/** Kamerayla QR okur (jsQR). Kamera yoksa üst bileşen metin girişine düşer. */
export function QrScanner({ onResult }: { onResult: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;

    (async () => {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" } });
        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        const tick = () => {
          if (done) return;
          const c = canvas.current!;
          if (v.readyState === v.HAVE_ENOUGH_DATA) {
            c.width = v.videoWidth;
            c.height = v.videoHeight;
            const ctx = c.getContext("2d", { willReadFrequently: true })!;
            ctx.drawImage(v, 0, 0, c.width, c.height);
            const img = ctx.getImageData(0, 0, c.width, c.height);
            const found = jsQR(img.data, img.width, img.height);
            if (found?.data) {
              done = true;
              onResult(found.data);
              return;
            }
          }
          raf = requestAnimationFrame(tick);
        };
        tick();
      } catch {
        setError("Kameraya erişilemedi. Kodu aşağıya yapıştırabilirsin.");
      }
    })();

    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [onResult]);

  return error ? (
    <div className="callout warn">{error}</div>
  ) : (
    <div style={{ position: "relative" }}>
      <video ref={video} muted playsInline style={{ width: "100%", borderRadius: 12, background: "#000" }} />
      <canvas ref={canvas} style={{ display: "none" }} />
    </div>
  );
}
