import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import basicSsl from "@vitejs/plugin-basic-ssl";

// Tarayıcılar kamerayı ve konumu yalnızca "güvenli kaynak"ta açar: https ya da localhost.
// Telefondan http://192.168.x.x:5173 açılırsa `navigator.mediaDevices` hiç tanımlı olmaz ve
// gün sonu QR'ı okutulamaz. `npm run dev:https` kendinden imzalı sertifikayla açar; telefonda
// bir kez "yine de devam et" demek gerekir. `.env` her iki modda da okunur.
export default defineConfig(({ mode }) => ({
  plugins: [react(), ...(mode === "https" ? [basicSsl()] : [])],
  define: { global: "globalThis" },
  server: { host: true }, // aynı Wi-Fi'daki telefondan erişilebilsin
}));
