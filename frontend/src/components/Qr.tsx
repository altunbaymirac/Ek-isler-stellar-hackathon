import jsQR from "jsqr";
import { RefreshCw, SwitchCamera, TriangleAlert, X } from "lucide-react";
import QRCode from "qrcode";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { cameraMessage, cameraPermission, cameraProblem, listCameras, openCamera, stopStream, type CameraDevice, type CameraProblem } from "../lib/camera.ts";
import { L } from "../lib/i18n.ts";

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
          <button className="btn ghost sm icon" onClick={onClose} aria-label={L("Kapat", "Close")}>
            <X size={18} />
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
    <img src={url} width={size} height={size} alt={L("Ödeme QR kodu", "Payment QR code")} style={{ display: "block", margin: "0 auto", borderRadius: 12 }} />
  ) : (
    <div style={{ width: size, height: size }} />
  );
}

/** Telefonun tam çözünürlüğünde tarama yapmak gereksiz pahalı; kareyi bu boya küçültüyoruz. */
const SCAN_EDGE = 640;

/**
 * Kamerayla QR okur (jsQR). Kamera açılmazsa nedeni söylenir ve QR metnini elle yapıştırma yolu
 * açık kalır: QR parayı aktarır, çalışan burada takılıp kalmamalı.
 * (Kamera katmanı Mehmet Emin'in `arkadas-kodu` dalından.)
 */
export function QrScanner({ onResult }: { onResult: (text: string) => void }) {
  const video = useRef<HTMLVideoElement>(null);
  const canvas = useRef<HTMLCanvasElement>(null);
  // onResult her render'da yeniden üretiliyor (iş listesi 15 sn'de bir yenileniyor). Bağımlılığa
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
        // Daha önce reddedilmişse getUserMedia'yı hiç çağırma: tarayıcı sessizce hata verir.
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
            navigator.vibrate?.(60);
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

  const nextCam = () => {
    const i = cams.findIndex((c) => c.deviceId === deviceId);
    setDeviceId(cams[(i + 1) % cams.length]?.deviceId);
  };

  return (
    <div className="scanner">
      {problem ? (
        <div className="callout warn">
          <div className="row" style={{ gap: 8, flexWrap: "nowrap", alignItems: "flex-start" }}>
            <TriangleAlert size={18} style={{ flex: "none", marginTop: 1 }} />
            <span>{cameraMessage(problem)}</span>
          </div>
          {problem !== "notfound" && problem !== "unsupported" && (
            <button className="btn sm" style={{ marginTop: 10 }} onClick={() => setAttempt((a) => a + 1)}>
              <RefreshCw size={15} /> {L("Kamerayı tekrar dene", "Try the camera again")}
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
                <span className="spinner" /> {L("Kamera açılıyor…", "Opening camera…")}
              </div>
            )}
          </div>
          <canvas ref={canvas} style={{ display: "none" }} />
          <div className="row">
            <span className="small muted">
              {scanning
                ? L("QR aranıyor… ihalecinin ekranındaki kodu çerçeveye al.", "Looking for a QR… fit the code on the contractor's screen in the frame.")
                : L("Tarayıcı kamera izni isteyecek.", "Your browser will ask for camera permission.")}
            </span>
            <div className="spacer" />
            {cams.length > 1 && (
              <button className="btn ghost sm" onClick={nextCam}>
                <SwitchCamera size={16} /> {L("Kamera değiştir", "Switch camera")}
              </button>
            )}
          </div>
        </>
      )}

      <details className="small muted" open={problem !== null}>
        <summary>{L("Kamera çalışmıyorsa QR metnini yapıştır", "Camera not working? Paste the QR text")}</summary>
        <div className="row" style={{ flexWrap: "nowrap", marginTop: 8 }}>
          <input
            style={{ flex: 1 }}
            className="mono"
            placeholder="EKISLER:…"
            value={pasted}
            onChange={(e) => setPasted(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && pasted.trim() && latest.current(pasted.trim())}
            aria-label={L("QR metni", "QR text")}
          />
          <button className="btn sm" disabled={!pasted.trim()} onClick={() => latest.current(pasted.trim())}>
            {L("Gönder", "Submit")}
          </button>
        </div>
      </details>
    </div>
  );
}
