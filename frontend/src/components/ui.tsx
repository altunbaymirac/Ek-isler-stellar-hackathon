import { createContext, useCallback, useContext, useState, type ReactNode } from "react";
import { expertTx } from "../lib/config.ts";

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
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div className="toasts" role="status" aria-live="polite">
        {toasts.map((t) => (
          <div key={t.id} className={`toast ${t.kind}`}>
            <span>{t.kind === "ok" ? "✓" : t.kind === "err" ? "!" : "•"}</span>
            <span>
              {t.text}
              {t.hash && (
                <>
                  {" "}
                  <a href={expertTx(t.hash)} target="_blank" rel="noreferrer">
                    İşlemi gör ↗
                  </a>
                </>
              )}
            </span>
          </div>
        ))}
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
