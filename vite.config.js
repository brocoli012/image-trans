import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// heic2any (libheif WASM 기반)은 CommonJS + 큰 번들이므로
// optimizeDeps에 포함시켜 dev/build에서 안정적으로 사전 번들되도록 함.
export default defineConfig({
  plugins: [react()],
  base: './',
  optimizeDeps: {
    include: ['heic2any'],
  },
})
