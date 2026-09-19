/**
 * Kamera izni ve görüntü akışı.
 *
 * Kamera iki yerde lazım: çalışan şartları onaylarken izni önceden istemek (saha anında
 * izin penceresiyle uğraşılmasın diye) ve gün sonu QR'ını okuturken gerçek görüntüyü almak.
 * Gün sonu QR'ı parayı hareket ettiren tek adım olduğu için kameranın neden açılmadığı
 * çalışana açıkça söylenmeli; bu yüzden hata türleri ayrıştırılıyor.
 */

export type CameraProblem = "insecure" | "unsupported" | "denied" | "notfound" | "busy" | "unknown";

/** İzin durumu. `unknown`: tarayıcı sormadan söylemiyor (Safari/Firefox). */
export type CameraState = "granted" | "denied" | "prompt" | "unknown" | CameraProblem;

export class CameraUnavailable extends Error {
  readonly problem: CameraProblem;
  constructor(problem: CameraProblem) {
    super(cameraMessage(problem));
    this.name = "CameraUnavailable";
    this.problem = problem;
  }
}

/**
 * Tarayıcı kamerayı hiç vermiyor mu, yoksa sayfa güvensiz bir adresten mi açıldı?
 * `getUserMedia` yalnızca güvenli kaynakta (https ya da localhost) tanımlıdır; telefondan
 * `http://192.168.x.x:5173` açılırsa `navigator.mediaDevices` hiç yoktur.
 */
export function cameraSupport(): "ok" | "insecure" | "unsupported" {
  if (typeof navigator === "undefined") return "unsupported";
  // Tip tanımları `mediaDevices`'ı hep var sayar; güvensiz kaynakta gerçekte yoktur.
  const md = (navigator as Navigator & { mediaDevices?: MediaDevices }).mediaDevices;
  if (md && typeof md.getUserMedia === "function") return "ok";
  if (typeof window !== "undefined" && window.isSecureContext === false) return "insecure";
  return "unsupported";
}

/** İzin penceresi açmadan mevcut durumu okur. Desteklenmiyorsa `unknown` döner. */
export async function cameraPermission(): Promise<CameraState> {
  const support = cameraSupport();
  if (support !== "ok") return support;
  try {
    const status = await navigator.permissions.query({ name: "camera" as PermissionName });
    return status.state as CameraState;
  } catch {
    return "unknown"; // Permissions API 'camera' adını her tarayıcıda tanımıyor
  }
}

export interface CameraDevice {
  deviceId: string;
  label: string;
}

/** Cihazdaki kameralar. Etiketler yalnızca izin verildikten sonra dolu gelir. */
export async function listCameras(): Promise<CameraDevice[]> {
  if (cameraSupport() !== "ok") return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices
    .filter((d) => d.kind === "videoinput")
    .map((d, i) => ({ deviceId: d.deviceId, label: d.label || `Kamera ${i + 1}` }));
}

/**
 * Kamerayı açar. Arka kamera `ideal` olarak istenir: `exact` deseydik yalnızca ön kamerası
 * olan dizüstülerde `OverconstrainedError` alırdık.
 */
export async function openCamera(opts: { deviceId?: string } = {}): Promise<MediaStream> {
  const support = cameraSupport();
  if (support !== "ok") throw new CameraUnavailable(support);
  const video: MediaTrackConstraints = opts.deviceId
    ? { deviceId: { exact: opts.deviceId } }
    : { facingMode: { ideal: "environment" } };
  video.width = { ideal: 1280 };
  video.height = { ideal: 720 };
  return navigator.mediaDevices.getUserMedia({ video, audio: false });
}

export function stopStream(stream: MediaStream | null | undefined) {
  stream?.getTracks().forEach((t) => t.stop());
}

/**
 * İzin penceresini önceden açar ve kamerayı hemen kapatır (ışık bir an yanıp söner).
 * Reddedilirse akışı engellemez: çalışan QR'ı daha sonra elle yapıştırabilir.
 */
export async function requestCameraAccess(): Promise<CameraState> {
  const support = cameraSupport();
  if (support !== "ok") return support;
  if ((await cameraPermission()) === "granted") return "granted";
  let stream: MediaStream | null = null;
  try {
    stream = await openCamera();
    return "granted";
  } catch (e) {
    return cameraProblem(e);
  } finally {
    stopStream(stream);
  }
}

export function cameraProblem(e: unknown): CameraProblem {
  if (e instanceof CameraUnavailable) return e.problem;
  const name = (e as { name?: string })?.name ?? "";
  switch (name) {
    case "NotAllowedError":
    case "PermissionDeniedError":
    case "SecurityError":
      return "denied";
    case "NotFoundError":
    case "DevicesNotFoundError":
    case "OverconstrainedError":
      return "notfound";
    case "NotReadableError":
    case "TrackStartError":
      return "busy";
    default:
      return "unknown";
  }
}

export function cameraMessage(p: CameraProblem): string {
  switch (p) {
    case "denied":
      return "Kamera izni verilmedi. Adres çubuğundaki 🔒 simgesinden kamerayı açıp tekrar dene.";
    case "notfound":
      return "Bu cihazda kamera bulunamadı.";
    case "busy":
      return "Kamera başka bir uygulamada açık. Onu kapatıp tekrar dene.";
    case "insecure":
      return "Sayfa güvenli olmayan bir adresten açıldı. Tarayıcılar kamerayı yalnızca https ya da localhost üzerinde açar.";
    case "unsupported":
      return "Bu tarayıcı kamera erişimini desteklemiyor.";
    default:
      return "Kamera açılamadı.";
  }
}
