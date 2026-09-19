/**
 * İki dilli arayüz (TR / EN). Metinler çiftler halinde yerinde yazılır: `L("Yeni iş", "New job")`.
 * Anahtar tablosu yok; hangi metnin nerede olduğu kodu okuyana açık kalsın diye.
 * Dil değişince uygulama ağacı yeniden kurulur (App'te `key={lang}`), bu yüzden `L` her render'da
 * güncel dili okur.
 */
export type Lang = "tr" | "en";

const LS_LANG = "ekisler.lang";

function initial(): Lang {
  try {
    const saved = localStorage.getItem(LS_LANG);
    if (saved === "tr" || saved === "en") return saved;
  } catch {
    /* depolama yok */
  }
  if (typeof navigator !== "undefined" && navigator.language && !navigator.language.toLowerCase().startsWith("tr")) return "en";
  return "tr";
}

let current: Lang = initial();
const listeners = new Set<() => void>();

export const getLang = () => current;

export function setLang(l: Lang) {
  current = l;
  try {
    localStorage.setItem(LS_LANG, l);
  } catch {
    /* depolama yok */
  }
  if (typeof document !== "undefined") document.documentElement.lang = l;
  listeners.forEach((f) => f());
}

export function subscribeLang(f: () => void) {
  listeners.add(f);
  return () => listeners.delete(f);
}

/** Güncel dile göre metni seçer */
export const L = (tr: string, en: string) => (current === "en" ? en : tr);

/** Tarih/sayı biçimlendirme için yerel ayar */
export const locale = () => (current === "en" ? "en-GB" : "tr-TR");

if (typeof document !== "undefined") document.documentElement.lang = current;
