import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import JSZip from 'jszip'
import { saveAs } from 'file-saver'
import { convertBatch, heicDecoder, MAX_FILES } from './convert.js'

// 결과 객체에 매달린 썸네일 object URL 을 해제 (메모리 누수 방지)
function revokeThumb(r) {
  if (r && r.thumbUrl) URL.revokeObjectURL(r.thumbUrl)
}

const STATUS = {
  IDLE: 'idle',
  RUNNING: 'running',
  DONE: 'done',
}

function formatSize(bytes) {
  if (!bytes && bytes !== 0) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

export default function App() {
  const [files, setFiles] = useState([]) // 선택된 원본 File[]
  const [results, setResults] = useState([]) // 변환 결과 객체[]
  const [status, setStatus] = useState(STATUS.IDLE)
  const [progress, setProgress] = useState({ done: 0, total: 0, current: '' })
  const [isDragging, setIsDragging] = useState(false)
  const inputRef = useRef(null)
  // 최신 results 를 참조로 보관 → unmount 시 썸네일 URL 해제에 사용
  const resultsRef = useRef([])
  useEffect(() => {
    resultsRef.current = results
  }, [results])
  // 컴포넌트 unmount 시 남아있는 썸네일 object URL + HEIC 워커 전부 해제
  useEffect(() => {
    return () => {
      resultsRef.current.forEach(revokeThumb)
      heicDecoder.terminate()
    }
  }, [])

  // 'success' 와 'warning'(멀티프레임 일부 변환) 모두 변환에 성공한 이미지로 취급
  const successResults = useMemo(
    () => results.filter((r) => r.status === 'success' || r.status === 'warning'),
    [results],
  )
  const errorResults = useMemo(
    () => results.filter((r) => r.status === 'error'),
    [results],
  )
  const warningResults = useMemo(
    () => results.filter((r) => r.status === 'warning'),
    [results],
  )

  const addFiles = useCallback((fileList) => {
    const incoming = Array.from(fileList).filter((f) =>
      // 이미지로 보이는 것만 수용 (HEIC 는 MIME 이 비어있을 수 있어 확장자도 허용)
      f.type.startsWith('image/') || /\.(heic|heif)$/i.test(f.name),
    )
    if (incoming.length === 0) return
    setFiles((prev) => {
      const merged = [...prev, ...incoming].slice(0, MAX_FILES)
      return merged
    })
    // 새 파일을 추가하면 이전 결과는 초기화 (썸네일 URL 해제 후)
    setResults((prev) => {
      prev.forEach(revokeThumb)
      return []
    })
    setStatus(STATUS.IDLE)
  }, [])

  const onInputChange = (e) => {
    if (e.target.files) addFiles(e.target.files)
    e.target.value = '' // 같은 파일 재선택 허용
  }

  const onDrop = (e) => {
    e.preventDefault()
    setIsDragging(false)
    if (e.dataTransfer.files) addFiles(e.dataTransfer.files)
  }

  const clearAll = () => {
    results.forEach(revokeThumb)
    // 진행 중이거나 남아있는 HEIC 워커 종료 → WASM 메모리 회수
    heicDecoder.terminate()
    setFiles([])
    setResults([])
    setStatus(STATUS.IDLE)
    setProgress({ done: 0, total: 0, current: '' })
  }

  const startConvert = async () => {
    if (files.length === 0 || status === STATUS.RUNNING) return
    // 이전 결과 썸네일 URL 정리 + 직전 워커 회수
    results.forEach(revokeThumb)
    heicDecoder.terminate()
    setResults([])
    setStatus(STATUS.RUNNING)
    setProgress({ done: 0, total: files.length, current: '' })

    await convertBatch(files, {
      concurrency: 3,
      onProgress: (done, total, file) => {
        setProgress((prev) => ({
          done,
          total,
          current: file ? file.name : prev.current,
        }))
      },
      onResult: (result) => {
        setResults((prev) =>
          [...prev, result].sort((a, b) => a.index - b.index),
        )
      },
    })

    setStatus(STATUS.DONE)
    setProgress((prev) => ({ ...prev, current: '' }))
  }

  const downloadOne = (result) => {
    saveAs(result.blob, result.name)
  }

  const downloadZip = async () => {
    if (successResults.length === 0) return
    const zip = new JSZip()
    const used = new Map()
    successResults.forEach((r) => {
      // 동일 파일명 충돌 방지
      let name = r.name
      if (used.has(name)) {
        const n = used.get(name) + 1
        used.set(name, n)
        name = name.replace(/\.jpg$/i, `_${n}.jpg`)
      } else {
        used.set(name, 0)
      }
      zip.file(name, r.blob)
    })
    const blob = await zip.generateAsync({ type: 'blob' })
    saveAs(blob, '변환된_사진.zip')
  }

  const pct =
    progress.total > 0 ? Math.round((progress.done / progress.total) * 100) : 0

  return (
    <div className="app">
      <header className="header">
        <h1>📷 사진 변환기</h1>
        <p className="subtitle">아이폰 HEIC 사진을 누구나 볼 수 있는 JPEG로 바꿔드려요</p>
      </header>

      <p className="privacy">
        🔒 사진은 기기 밖으로 전송되지 않고 브라우저 안에서만 변환됩니다.
      </p>

      {/* 1단계: 사진 선택 / 드래그&드롭 */}
      <section
        className={`dropzone ${isDragging ? 'dragging' : ''}`}
        onDragOver={(e) => {
          e.preventDefault()
          setIsDragging(true)
        }}
        onDragLeave={() => setIsDragging(false)}
        onDrop={onDrop}
        onClick={() => inputRef.current && inputRef.current.click()}
        role="button"
        aria-label={`사진 파일 선택, 한 번에 최대 ${MAX_FILES}장`}
        tabIndex={0}
        onKeyDown={(e) => {
          if (e.key === 'Enter' || e.key === ' ') inputRef.current?.click()
        }}
      >
        <input
          ref={inputRef}
          type="file"
          accept="image/*,.heic,.heif"
          multiple
          hidden
          onChange={onInputChange}
        />
        <div className="dropzone-inner">
          <div className="dz-icon">🖼️</div>
          <div className="dz-title">여기를 눌러 사진을 고르세요</div>
          <div className="dz-sub">또는 사진을 이 네모 칸으로 끌어다 놓으세요</div>
          <div className="dz-hint">한 번에 최대 {MAX_FILES}장까지</div>
        </div>
      </section>

      {files.length > 0 && (
        <p className="selected-count">
          선택한 사진: <strong>{files.length}장</strong>
          {files.length >= MAX_FILES && (
            <span className="cap"> (최대 {MAX_FILES}장까지만 추가됩니다)</span>
          )}
        </p>
      )}

      {/* 2단계: 변환 시작 큰 버튼 */}
      <div className="actions">
        <button
          className="btn btn-primary btn-big"
          onClick={startConvert}
          disabled={files.length === 0 || status === STATUS.RUNNING}
        >
          {status === STATUS.RUNNING ? '변환 중…' : '✨ 변환 시작'}
        </button>
        {(files.length > 0 || results.length > 0) && (
          <button
            className="btn btn-ghost"
            onClick={clearAll}
            disabled={status === STATUS.RUNNING}
            aria-label="선택한 사진과 변환 결과 모두 지우기"
          >
            모두 지우기
          </button>
        )}
      </div>

      {/* 진행률 */}
      {status === STATUS.RUNNING && (
        <div className="progress-box" aria-live="polite">
          <div className="progress-text">
            변환 중… <strong>{progress.done}/{progress.total}</strong>
            {progress.current && (
              <span className="current"> — {progress.current}</span>
            )}
          </div>
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
        </div>
      )}

      {status === STATUS.DONE && (
        <div className="summary" aria-live="polite">
          ✅ 완료! 성공 <strong>{successResults.length}장</strong>
          {warningResults.length > 0 && (
            <span className="warn-sum">
              {' '}
              · 주의 <strong>{warningResults.length}장</strong>
            </span>
          )}
          {errorResults.length > 0 && (
            <span className="fail-sum">
              {' '}
              · 실패 <strong>{errorResults.length}장</strong>
            </span>
          )}
        </div>
      )}

      {/* 3단계: 전체 ZIP 다운로드 */}
      {successResults.length > 0 && (
        <div className="actions">
          <button className="btn btn-primary btn-big" onClick={downloadZip}>
            📦 전체 ZIP 다운로드 ({successResults.length}장)
          </button>
        </div>
      )}

      {/* 결과 목록: 썸네일 + 개별 다운로드, 실패는 빨간색 */}
      {results.length > 0 && (
        <section className="results">
          {results.map((r) =>
            r.status === 'success' || r.status === 'warning' ? (
              <div
                className={`card ${r.status === 'warning' ? 'card-warning' : ''}`}
                key={r.index}
              >
                {r.thumbUrl ? (
                  <img
                    className="thumb"
                    src={r.thumbUrl}
                    alt={`변환된 사진: ${r.name}`}
                    loading="lazy"
                  />
                ) : (
                  <div
                    className="thumb thumb-placeholder"
                    role="img"
                    aria-label={`변환된 사진: ${r.name}`}
                  >
                    🖼️
                  </div>
                )}
                <div className="card-body">
                  <div className="card-name" title={r.name}>{r.name}</div>
                  <div className="card-meta">{formatSize(r.size)}</div>
                  {r.status === 'warning' && (
                    <div className="card-warn-badge" role="status">
                      ⚠️ {r.warning}
                    </div>
                  )}
                  <button
                    className="btn btn-small"
                    onClick={() => downloadOne(r)}
                    aria-label={`${r.name} 다운로드`}
                  >
                    ⬇ 다운로드
                  </button>
                </div>
              </div>
            ) : (
              <div className="card card-error" key={r.index}>
                <div className="thumb thumb-error">⚠️</div>
                <div className="card-body">
                  <div className="card-name" title={r.originalName}>
                    {r.originalName}
                  </div>
                  <div className="card-reason">실패: {r.reason}</div>
                </div>
              </div>
            ),
          )}
        </section>
      )}

      <footer className="footer">
        <p>모든 변환은 이 브라우저 안에서만 이루어집니다 · 서버 전송 없음</p>
      </footer>
    </div>
  )
}
