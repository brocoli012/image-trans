// 이미지 변환 유틸리티
// - HEIC/HEIF: heic2any (libheif WASM) 로 디코딩 후 JPEG
// - 그 외(JPG/PNG/WEBP 등): Canvas 로 JPEG 인코딩
// 모든 변환은 브라우저 안에서만 수행되며 외부로 전송되지 않습니다.

export const JPEG_QUALITY = 0.9
export const MAX_FILES = 100

// 워커를 재생성(terminate 후 새로 생성)하기 전에 처리할 HEIC 장수.
// 이 값마다 WASM 선형 메모리를 통째로 회수하여 누적 증가를 막는다.
export const RECYCLE_EVERY = 12

// ---------------------------------------------------------------------------
// HEIC 디코더: heic2any(libheif WASM) 을 Web Worker 에 격리하고,
// 일정 장수마다 / 배치 종료시 / 모두 지우기시 워커를 terminate 하여 WASM 힙을 회수.
// ---------------------------------------------------------------------------
class HeicDecoder {
  constructor() {
    this.worker = null
    this.seq = 0
    this.sinceSpawn = 0
    this.pending = new Map() // id -> {resolve, reject}
    // HEIC 디코딩은 워커 1개로 직렬 처리(메모리 상한 유지). 큐로 순서 보장.
    this.chain = Promise.resolve()
  }

  _spawn() {
    // Vite 권장 방식: new URL(..., import.meta.url) + { type: 'module' }
    this.worker = new Worker(new URL('./heicWorker.js', import.meta.url), {
      type: 'module',
    })
    this.sinceSpawn = 0
    this.worker.onmessage = (e) => {
      const { id, ok, blob, frameCount, reason } = e.data
      const entry = this.pending.get(id)
      if (!entry) return
      this.pending.delete(id)
      if (ok) entry.resolve({ blob, frameCount })
      else entry.reject(new Error(reason))
    }
    this.worker.onerror = (err) => {
      // 워커가 통째로 죽으면 대기 중 요청 모두 거절
      const e = new Error(
        err && err.message ? err.message : 'HEIC 변환 워커 오류',
      )
      this.pending.forEach((entry) => entry.reject(e))
      this.pending.clear()
      this.worker = null
    }
  }

  // 워커를 종료하고 WASM 힙 전체를 OS 로 반환. 대기 요청은 거절.
  terminate() {
    if (this.worker) {
      this.worker.terminate()
      this.worker = null
    }
    if (this.pending.size) {
      const e = new Error('변환이 취소되었습니다.')
      this.pending.forEach((entry) => entry.reject(e))
      this.pending.clear()
    }
    this.chain = Promise.resolve()
  }

  // 한 장 디코딩(직렬). 일정 장수마다 워커를 재생성하여 메모리 누적 차단.
  decode(blob, quality) {
    const run = async () => {
      if (!this.worker) this._spawn()
      // 재생성 주기 도달 시 먼저 회수 후 새 워커로
      if (this.sinceSpawn >= RECYCLE_EVERY) {
        this.worker.terminate()
        this.worker = null
        this._spawn()
      }
      const id = ++this.seq
      this.sinceSpawn++
      const p = new Promise((resolve, reject) => {
        this.pending.set(id, { resolve, reject })
      })
      this.worker.postMessage({ id, blob, quality })
      return p
    }
    // 큐에 연결해 직렬 실행 (실패해도 체인은 계속)
    const result = this.chain.then(run)
    this.chain = result.then(
      () => undefined,
      () => undefined,
    )
    return result
  }
}

// 모듈 단일 인스턴스. App 에서 terminate 로 메모리 회수 가능하도록 export.
export const heicDecoder = new HeicDecoder()

// 파일이 HEIC/HEIF 인지 판별 (확장자 + MIME 모두 확인)
function isHeic(file) {
  const name = (file.name || '').toLowerCase()
  const type = (file.type || '').toLowerCase()
  return (
    type === 'image/heic' ||
    type === 'image/heif' ||
    name.endsWith('.heic') ||
    name.endsWith('.heif')
  )
}

// 원본 파일명을 .jpg 로 치환
export function toJpegName(name) {
  const base = name.replace(/\.[^.]+$/, '')
  return `${base || 'image'}.jpg`
}

// 썸네일 표시용 한 변(px). 화면 미리보기에는 이 정도면 충분하며,
// 원본 풀해상도 비트맵을 미리보기로 들고 있지 않도록 작게 줄여 보관한다.
export const THUMB_MAX = 256
export const THUMB_QUALITY = 0.7

// 변환된 JPEG Blob 으로부터 작은 썸네일 Blob 을 만든다.
// 디코딩에 쓴 비트맵/object URL 은 즉시 해제하여 피크 메모리를 낮춘다.
// 실패해도(예: 디코딩 불가) 미리보기만 없을 뿐 변환 자체엔 영향 없으므로 null 반환.
function makeThumbnail(jpegBlob) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(jpegBlob)
    const img = new Image()
    img.onload = () => {
      try {
        const scale = Math.min(1, THUMB_MAX / Math.max(img.naturalWidth, img.naturalHeight))
        const w = Math.max(1, Math.round(img.naturalWidth * scale))
        const h = Math.max(1, Math.round(img.naturalHeight * scale))
        const canvas = document.createElement('canvas')
        canvas.width = w
        canvas.height = h
        const ctx = canvas.getContext('2d')
        ctx.drawImage(img, 0, 0, w, h)
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(url)
            // 소스 비트맵 해제 유도
            img.src = ''
            // 캔버스 백버퍼 축소(일부 브라우저에서 메모리 즉시 회수 유도)
            canvas.width = 0
            canvas.height = 0
            resolve(blob || null)
          },
          'image/jpeg',
          THUMB_QUALITY,
        )
      } catch {
        URL.revokeObjectURL(url)
        resolve(null)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      resolve(null)
    }
    img.src = url
  })
}

// Canvas 를 이용해 일반 이미지를 JPEG Blob 으로 인코딩
function canvasToJpeg(file) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(file)
    const img = new Image()
    img.onload = () => {
      try {
        const canvas = document.createElement('canvas')
        canvas.width = img.naturalWidth
        canvas.height = img.naturalHeight
        const ctx = canvas.getContext('2d')
        // JPEG 는 투명도가 없으므로 흰 배경을 먼저 채움
        ctx.fillStyle = '#ffffff'
        ctx.fillRect(0, 0, canvas.width, canvas.height)
        ctx.drawImage(img, 0, 0)
        canvas.toBlob(
          (blob) => {
            URL.revokeObjectURL(url)
            // 원본 풀해상도 비트맵/캔버스 백버퍼 즉시 해제 유도
            img.src = ''
            canvas.width = 0
            canvas.height = 0
            if (blob) resolve(blob)
            else reject(new Error('JPEG 인코딩에 실패했습니다.'))
          },
          'image/jpeg',
          JPEG_QUALITY,
        )
      } catch (err) {
        URL.revokeObjectURL(url)
        reject(err)
      }
    }
    img.onerror = () => {
      URL.revokeObjectURL(url)
      reject(new Error('이미지를 읽을 수 없는 형식입니다.'))
    }
    img.src = url
  })
}

// 단일 파일을 JPEG 로 변환
// 반환: { blob, frameCount } — frameCount 는 원본에 들어있던 프레임 수(멀티프레임 HEIC 감지용)
export async function convertOne(file) {
  if (isHeic(file)) {
    // HEIC 는 워커에 격리된 디코더로 처리(WASM 메모리 회수 가능)
    return heicDecoder.decode(file, JPEG_QUALITY)
  }
  // 일반 이미지는 WASM 누수가 없으므로 메인 스레드 Canvas 로 인코딩
  return { blob: await canvasToJpeg(file), frameCount: 1 }
}

// 동시성 제한을 둔 일괄 변환 실행기
// items: File[] , concurrency: 동시 처리 개수
// onProgress(doneCount, totalCount, currentFile)
// onResult(resultObj) : 한 건 완료될 때마다 호출 (성공/실패 모두)
// 반환: Promise<void> (개별 결과는 onResult 로 스트리밍)
export async function convertBatch(files, { concurrency = 3, onProgress, onResult } = {}) {
  const total = files.length
  let done = 0
  let cursor = 0

  async function worker() {
    while (cursor < total) {
      const index = cursor++
      const file = files[index]
      if (onProgress) onProgress(done, total, file)
      try {
        const { blob, frameCount } = await convertOne(file)
        // 미리보기는 풀해상도 원본/결과 비트맵이 아니라 작은 썸네일만 메모리에 보관
        const thumbBlob = await makeThumbnail(blob)
        const thumbUrl = thumbBlob ? URL.createObjectURL(thumbBlob) : null
        const result = {
          index,
          // 여러 프레임 중 한 장만 변환된 경우 '주의' 상태로 표시(실패 아님)
          status: frameCount > 1 ? 'warning' : 'success',
          originalName: file.name,
          name: toJpegName(file.name),
          blob, // 다운로드/ZIP 용 풀해상도 JPEG (object URL 은 미리 만들지 않음)
          size: blob.size,
          thumbUrl, // 화면 미리보기 전용 (작은 썸네일)
          frameCount,
          warning:
            frameCount > 1
              ? `여러 장(${frameCount}장) 중 1장만 변환됨`
              : undefined,
        }
        if (onResult) onResult(result)
      } catch (err) {
        // 실패한 파일은 격리: 전체를 멈추지 않고 사유만 기록
        if (onResult)
          onResult({
            index,
            status: 'error',
            originalName: file.name,
            name: file.name,
            reason: err && err.message ? err.message : '알 수 없는 오류',
          })
      } finally {
        done++
        if (onProgress) onProgress(done, total, null)
      }
    }
  }

  const workerCount = Math.min(concurrency, Math.max(1, total))
  try {
    await Promise.all(Array.from({ length: workerCount }, () => worker()))
  } finally {
    // 배치 종료 시 HEIC 워커를 종료하여 WASM 선형 메모리를 OS 로 반환
    heicDecoder.terminate()
  }
}
