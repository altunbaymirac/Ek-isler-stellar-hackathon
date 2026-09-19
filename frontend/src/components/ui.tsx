import { BriefcaseBusiness, Building2, Camera, Check, CircleAlert, Info, Languages, Scale, Video, Wallet, type LucideIcon } from "lucide-react";
import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { expertTx } from "../lib/config.ts";
import { L } from "../lib/i18n.ts";

type ToastKind = "info" | "ok" | "err";
interface Toast {
  id: number;
  kind: ToastKind;
  text: string;
  hash?: string;
}

const ToastCtx = createContext<(kind: ToastKind, text: string, hash?: string) => void>(() => {});

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: ToastKind, text: string, hash?: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text, hash }]);
    setTimeout(() => setToasts((t) => t.filter((x) => x.id !== id)), kind === "err" ? 9000 : 6000);
  }, []);
  const Icon = { ok: Check, err: CircleAlert, info: Info };
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => {
          const I = Icon[t.kind];
          return (
            <div key={t.id} className={`toast ${t.kind}`}>
              <I size={17} className="toast-icon" />
              <span>
                {t.text}
                {t.hash && (
                  <>
                    {" "}
                    <a href={expertTx(t.hash)} target="_blank" rel="noreferrer">
                      {L("İşlemi gör ↗", "View transaction ↗")}
                    </a>
                  </>
                )}
              </span>
            </div>
          );
        })}
      </div>
    </ToastCtx.Provider>
  );
}

export const useToast = () => useContext(ToastCtx);

/** Asenkron buton: çalışırken spinner gösterir, hatayı toast'a yazar. */
export function AsyncButton({
  onClick,
  children,
  className = "btn",
  disabled,
  title,
}: {
  onClick: () => Promise<unknown>;
  children: ReactNode;
  className?: string;
  disabled?: boolean;
  title?: string;
}) {
  const [busy, setBusy] = useState(false);
  return (
    <button
      className={className}
      disabled={disabled || busy}
      title={title}
      onClick={async () => {
        setBusy(true);
        try {
          await onClick();
        } finally {
          setBusy(false);
        }
      }}
    >
      {busy && <span className="spinner" />}
      {children}
    </button>
  );
}

const ROLE_ICONS: Record<string, LucideIcon> = {
  client: Building2,
  contractor: BriefcaseBusiness,
  w1: Languages,
  w2: Video,
  w3: Camera,
  arbiter: Scale,
  wallet: Wallet,
};

/** Rol simgesi (emoji yerine çizgi ikon) */
export function RoleIcon({ role, size = 18 }: { role: string | undefined; size?: number }) {
  const I = (role && ROLE_ICONS[role]) || Wallet;
  return <I size={size} strokeWidth={1.9} aria-hidden="true" />;
}

/** Bir adımın zincirdeki işlemine link (stellar.expert) */
export function ChainLink({ hash, label, title }: { hash: string | undefined; label?: string; title?: string }) {
  if (!hash) return null;
  return (
    <a className="chain-link" href={expertTx(hash)} target="_blank" rel="noreferrer" title={title ?? L("Bu adımın zincirdeki işlemi", "This step's on-chain transaction")}>
      <span className="chain-dot" aria-hidden="true" />
      {label ?? `tx ${hash.slice(0, 6)}`} ↗
    </a>
  );
}
