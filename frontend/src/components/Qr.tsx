import jsQR from "jsqr";
import QRCode from "qrcode";
import { useEffect, useRef, useState, type ReactNode } from "react";
import {
  cameraMessage,
  cameraPermission,
  cameraProblem,
  listCameras,
  openCamera,
  stopStream,
  type CameraDevice,
  type CameraProblem,
} from "../lib/camera.ts";

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

/** Telefonun tam çözünürlüğünde tarama yapmak gereksiz pahalı; kareyi bu boya küçültüyoruz. */
const SCAN_EDGE = 640;

/**
 * Kamerayla QR okur (jsQR). Kamera açılmazsa nedeni söylenir ve QR metnini elle yapıştırma
 * yolu açık kalır: gün sonu QR'ı parayı aktaran tek adım olduğu için çalışan burada takılıp
 * kalmamalı.
 */
export function QrScanner({ onResult }: { onResult: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // onResult her render'da yeniden üretiliyor (liste 15 sn'de bir yenileniyor). Bağımlılığa
  // koyarsak kamera sürekli kapanıp açılır; ref'te tutuyoruz.
  const latest = useRef(onResult);
  latest.current = onResult;

  const [problem, setProblem] = useState<CameraProblem | null>(null);
  const [scanning, setScanning] = useState(false);
  const [cams, setCams] = useState<CameraDevice[]>([]);
  const [deviceId, setDeviceId] = useState<string | undefined>(undefined);
  const [attempt, setAttempt] = useState(0);
  const [pasted, setPasted] = useState("");

  useEffect(() => {
    let stream: MediaStream | null = null;
    let raf = 0;
    let done = false;

    (async () => {
      setProblem(null);
      setScanning(false);
      try {
        // Daha önce reddedilmişse getUserMedia'yı hiç çağırma: tarayıcı sessizce hata verir,
        // kullanıcı da neden bir şey olmadığını anlamaz.
        if ((await cameraPermission()) === "denied") throw new DOMException("", "NotAllowedError");

        stream = await openCamera({ deviceId });
        if (done) return stopStream(stream);

        const v = video.current!;
        v.srcObject = stream;
        await v.play();
        setScanning(true);
        listCameras().then(setCams, () => {}); // etiketler ancak izinden sonra dolu gelir

        const c = canvas.current!;
        const ctx = c.getContext("2d", { willReadFrequently: true })!;
        const tick = () => {
          if (done) return;
          raf = requestAnimationFrame(tick);
          if (v.readyState !== v.HAVE_ENOUGH_DATA) return;
          const scale = Math.min(1, SCAN_EDGE / Math.max(v.videoWidth, v.videoHeight));
          c.width = Math.round(v.videoWidth * scale);
          c.height = Math.round(v.videoHeight * scale);
          ctx.drawImage(v, 0, 0, c.width, c.height);
          const img = ctx.getImageData(0, 0, c.width, c.height);
          const found = jsQR(img.data, img.width, img.height, { inversionAttempts: "dontInvert" });
          if (found?.data) {
            done = true;
            cancelAnimationFrame(raf);
            latest.current(found.data);
          }
        };
        tick();
      } catch (e) {
        setProblem(cameraProblem(e));
      }
    })();

    return () => {
      done = true;
      cancelAnimationFrame(raf);
      stopStream(stream);
    };
  }, [deviceId, attempt]);

  const retry = () => setAttempt((a) => a + 1);
  const nextCam = () => {
    const i = cams.findIndex((c) => c.deviceId === deviceId);
    setDeviceId(cams[(i + 1) % cams.length]?.deviceId);
  };

  return (
    <div className="scanner">
      {problem ? (
        <div className="callout warn">
          <div>⚠️ {cameraMessage(problem)}</div>
          {problem !== "notfound" && problem !== "unsupported" && (
            <button className="btn sm" style={{ marginTop: 8 }} onClick={retry}>
              📷 Kamerayı tekrar dene
            </button>
          )}
        </div>
      ) : (
        <>
          <div className="scanner-view">
            <video ref={video} autoPlay muted playsInline />
            <div className="scanner-frame" />
            {!scanning && (
              <div className="scanner-status">
                <span className="spinner" /> Kamera açılıyor…
              </div>
            )}
          </div>
          <canvas ref={canvas} style={{ display: "none" }} />
          <div className="row">
            <span className="small muted">
              {scanning ? "QR aranıyor… ihalecinin ekranındaki kodu çerçeveye al." : "Tarayıcı kamera izni isteyecek."}
            </span>
            <div className="spacer" />
            {cams.length > 1 && (
              <button className="btn ghost sm" onClick={nextCam} title="Ön/arka kamera">
                🔄 Kamera değiştir
              </button>
            )}
          </div>
        </>
      )}

      <details className="small muted">
        <summary>Kamera çalışmıyorsa QR metnini yapıştır</summary>
        <div className="row" style={{ flexWrap: "nowrap", marginTop: 8 }}>
          <input
            style={{ flex: 1, fontFamily: "ui-monospace, monospace" }}
            placeholder="EKISLER:…"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && pasted.trim() && latest.current(pasted.trim())}
            aria-label="QR metni"
          />
          <button className="btn sm" disabled={!pasted.trim()} onClick={() => latest.current(pasted.trim())}>
            Uygula
          </button>
        </div>
      </details>
    </div>
  );
}
