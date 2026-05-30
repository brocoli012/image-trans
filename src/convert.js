// 이미지 변환 유틸리티
// - HEIC/HEIF: heic2any (libheif WASM) 로 디코딩 후 JPEG
// - 그 외(JPG/PNG/WEBP 등): Canvas 로 JPEG 인코딩
// 모든 변환은 브라우저 안에서만 수행되며 외부로 전송되지 않습니다.

export const JPEG_QUALITY = 0.9
export const MAX_FILES = 100

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

// 단일 파일을 JPEG Blob 으로 변환
export async function convertOne(file) {
  if (isHeic(file)) {
    // heic2any 는 동적 import 로 불러와 초기 로딩을 가볍게 함
    const heic2any = (await import('heic2any')).default
    const result = await heic2any({
      blob: file,
      toType: 'image/jpeg',
      quality: JPEG_QUALITY,
    })
    // 결과가 배열(다중 이미지 HEIC)일 수 있음 → 첫 장 사용
    return Array.isArray(result) ? result[0] : result
  }
  return canvasToJpeg(file)
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
        const blob = await convertOne(file)
        const result = {
          index,
          status: 'success',
          originalName: file.name,
          name: toJpegName(file.name),
          blob,
          size: blob.size,
          url: URL.createObjectURL(blob),
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
  await Promise.all(Array.from({ length: workerCount }, () => worker()))
}
