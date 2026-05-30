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
  // HEIC 디코딩 워커(heicWorker.js)는 type:'module' 로 생성되고 내부에서
  // heic2any 를 동적 import 하므로 코드 스플리팅을 지원하는 ES 포맷으로 번들해야 한다.
  worker: {
    format: 'es',
  },
})
