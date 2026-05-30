// HEIC 디코딩 전용 Web Worker.
// libheif(WASM) 선형 메모리는 한 번 늘면 메인 스레드에서 줄지 않으므로,
// 디코딩을 이 워커에 격리하고 워커를 통째로 terminate 하면 WASM 힙 전체가 OS 로 반환된다.
// (워커 재생성으로 메모리 상한을 파일 수와 무관하게 고정)

// heic2any/libheif 는 브라우저 메인 스레드(window/document)를 가정한다.
// Worker 에는 window/document 가 없으므로 최소 shim 을 제공해 ReferenceError 를 막고,
// heic2any 가 JPEG 인코딩에 쓰는 document.createElement('canvas') 는 OffscreenCanvas 로 대체한다.
// ⚠️ heic2any 모듈 평가 전에 실행되어야 하므로 정적 import 가 아닌 동적 import 사용.
if (typeof globalThis.window === 'undefined') {
  globalThis.window = globalThis
}

if (typeof globalThis.document === 'undefined') {
  globalThis.document = {
    // heic2any 는 'canvas' 만 생성한다. OffscreenCanvas 로 만들고,
    // heic2any 가 호출하는 toBlob(cb, type, quality) 를 convertToBlob 로 어댑트한다.
    createElement(tag) {
      if (String(tag).toLowerCase() === 'canvas') {
        const canvas = new OffscreenCanvas(1, 1)
        if (typeof canvas.toBlob !== 'function') {
          canvas.toBlob = function (callback, type, quality) {
            this.convertToBlob({ type: type || 'image/png', quality })
              .then((blob) => callback(blob))
              .catch(() => callback(null))
          }
        }
        return canvas
      }
      // canvas 외 요소(예: heic2any 초기화 시 기능 감지용 <video>)는
      // 사용되지 않으므로 무해한 더미를 반환한다(throw 하지 않음).
      return {
        getContext: () => null,
        canPlayType: () => '',
        style: {},
        setAttribute() {},
        appendChild() {},
      }
    },
    // 일부 코드 경로에서 참조할 수 있는 body 더미
    body: { appendChild() {}, removeChild() {} },
  }
}

// heic2any 는 최초 요청 시 한 번만 로드(이후 캐시)
let heic2anyPromise = null
function getHeic2any() {
  if (!heic2anyPromise) {
    heic2anyPromise = import('heic2any').then((m) => m.default)
  }
  return heic2anyPromise
}

self.onmessage = async (e) => {
  const { id, blob, quality } = e.data
  try {
    const heic2any = await getHeic2any()
    const result = await heic2any({
      blob,
      toType: 'image/jpeg',
      quality,
    })
    if (Array.isArray(result)) {
      // 다중 프레임(Live Photo/버스트) → 첫 장만 사용, 프레임 수는 함께 전달
      self.postMessage({ id, ok: true, blob: result[0], frameCount: result.length })
    } else {
      self.postMessage({ id, ok: true, blob: result, frameCount: 1 })
    }
  } catch (err) {
    self.postMessage({
      id,
      ok: false,
      reason: err && err.message ? err.message : '알 수 없는 오류',
    })
  }
}
