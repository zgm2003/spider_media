/**
 * 媒体嗅探器 - 页面主世界桥接
 * 负责在页面真实执行环境中捕获请求和媒体线索，并转发给扩展侧。
 */

;(function () {
  'use strict'

  if (window.__mediaSnifferPageBridgeInstalled) return
  window.__mediaSnifferPageBridgeInstalled = true

  const EVENT_NAME = 'media-sniffer:bridge-found'
  const seen = new Set()
  const MAX_SEEN = 2000
  const SENSITIVE_HOST_PATTERNS = [
    /(^|\.)(bilibili\.com|bilivideo\.com|bilivideo\.cn|akamaized\.net)$/i,
    /(^|\.)(douyin\.com|douyinvod\.com|zjcdn\.com|snssdk\.com)$/i,
    /(^|\.)(youtube\.com|youtu\.be|googlevideo\.com|ytimg\.com)$/i,
    /(^|\.)(tiktok\.com|tiktokcdn\.com|musical\.ly)$/i,
    /(^|\.)(twitter\.com|x\.com|twimg\.com|video\.twimg\.com)$/i,
  ]
  const isTopFrame = window.top === window
  const bridgeMode = SENSITIVE_HOST_PATTERNS.some((pattern) => pattern.test(location.hostname)) ? 'lite' : 'full'

  function toAbsoluteUrl(url) {
    try {
      return new URL(url, location.href).href
    } catch (_) {
      return String(url || '')
    }
  }

  function emit(url, source, extra) {
    const absUrl = toAbsoluteUrl(url)
    if (!absUrl || (!/^https?:/i.test(absUrl) && !/^blob:/i.test(absUrl))) return

    const key = `${source}:${absUrl}:${extra?.categoryHint || ''}:${extra?.contentType || ''}`
    if (seen.size >= MAX_SEEN) {
      let trimCount = Math.floor(MAX_SEEN / 2)
      for (const seenKey of seen) {
        seen.delete(seenKey)
        trimCount -= 1
        if (trimCount <= 0) break
      }
    }
    if (seen.has(key)) return
    seen.add(key)

    window.dispatchEvent(
      new CustomEvent(EVENT_NAME, {
        detail: {
          url: absUrl,
          source,
          ...(extra || {}),
        },
      })
    )
  }

  function resolveCategoryHint(target, fallbackHint) {
    if (target instanceof HTMLAudioElement) return 'audio'
    if (target instanceof HTMLVideoElement) return 'video'

    const parentTag = String(target?.parentElement?.tagName || '').toUpperCase()
    if (parentTag === 'AUDIO') return 'audio'
    if (parentTag === 'VIDEO') return 'video'
    if (parentTag === 'PICTURE') return 'image'

    return fallbackHint || ''
  }

  function patchProperty(proto, propertyName, getCategoryHint) {
    const descriptor = Object.getOwnPropertyDescriptor(proto, propertyName)
    if (!descriptor || typeof descriptor.set !== 'function') return

    Object.defineProperty(proto, propertyName, {
      get: descriptor.get,
      set(value) {
        const categoryHint = typeof getCategoryHint === 'function' ? getCategoryHint(this) : getCategoryHint
        emit(value, `page-${propertyName}`, { categoryHint })
        return descriptor.set.call(this, value)
      },
      configurable: true,
      enumerable: descriptor.enumerable,
    })
  }

  function patchFetch() {
    if (typeof window.fetch !== 'function') return
    const originalFetch = window.fetch
    window.fetch = function () {
      const input = arguments[0]
      let requestUrl = ''
      if (typeof input === 'string') requestUrl = input
      else if (input instanceof URL) requestUrl = input.href
      else if (input && typeof input.url === 'string') requestUrl = input.url

      if (requestUrl) emit(requestUrl, 'page-fetch-request')

      const result = originalFetch.apply(this, arguments)
      Promise.resolve(result)
        .then((response) => {
          emit(response?.url || requestUrl, 'page-fetch-response', {
            contentType: response?.headers?.get('content-type') || '',
          })
        })
        .catch(() => {})
      return result
    }
  }

  function patchXhr() {
    const originalOpen = XMLHttpRequest.prototype.open
    const originalSend = XMLHttpRequest.prototype.send

    XMLHttpRequest.prototype.open = function (method, url) {
      const absUrl = toAbsoluteUrl(url)
      this.__mediaSnifferRequestUrl = absUrl
      emit(absUrl, 'page-xhr-open')
      return originalOpen.apply(this, arguments)
    }

    XMLHttpRequest.prototype.send = function () {
      if (!this.__mediaSnifferListenerBound) {
        this.__mediaSnifferListenerBound = true
        this.addEventListener('loadend', () => {
          const responseUrl = this.responseURL || this.__mediaSnifferRequestUrl || ''
          emit(responseUrl, 'page-xhr-response', {
            contentType: this.getResponseHeader('content-type') || '',
          })
        })
      }
      return originalSend.apply(this, arguments)
    }
  }

  function patchAudio() {
    if (typeof window.Audio !== 'function') return
    const OriginalAudio = window.Audio
    function WrappedAudio(src) {
      if (src) emit(src, 'page-audio-constructor', { categoryHint: 'audio' })
      return new OriginalAudio(src)
    }
    WrappedAudio.prototype = OriginalAudio.prototype
    window.Audio = WrappedAudio
  }

  function patchObjectUrl() {
    if (!window.URL || typeof window.URL.createObjectURL !== 'function') return
    const originalCreateObjectURL = window.URL.createObjectURL
    window.URL.createObjectURL = function () {
      const result = originalCreateObjectURL.apply(this, arguments)
      const target = arguments[0]
      const type = String(target?.type || '').toLowerCase()
      let categoryHint = ''
      if (type.startsWith('audio/')) categoryHint = 'audio'
      else if (type.startsWith('video/')) categoryHint = 'video'
      else if (type.startsWith('image/')) categoryHint = 'image'
      emit(result, 'page-create-object-url', { categoryHint, contentType: type })
      return result
    }
  }

  patchProperty(HTMLMediaElement.prototype, 'src', (target) => resolveCategoryHint(target, 'video'))
  patchProperty(HTMLSourceElement.prototype, 'src', (target) => resolveCategoryHint(target, ''))
  patchAudio()
  patchObjectUrl()

  if (isTopFrame && bridgeMode === 'full') {
    patchFetch()
    patchXhr()
  }

  /* ── B站 playinfo 拦截 ── */

  const BILI_QUALITY_LABELS = {
    6: '240P', 16: '360P', 32: '480P', 64: '720P', 74: '720P60',
    80: '1080P', 112: '1080P+', 116: '1080P60', 120: '4K', 125: 'HDR', 126: '杜比视界', 127: '8K',
  }
  const BILI_AUDIO_LABELS = { 30216: '64K', 30232: '132K', 30280: '192K', 30250: '杜比全景声', 30251: 'Hi-Res' }

  function extractBilibiliStreams(info) {
    const dash = info?.data?.dash
    if (!dash) return

    const videos = dash.video || []
    const audios = dash.audio || []
    const flac = dash.flac?.audio
    const dolby = dash.dolby?.audio

    for (const v of videos) {
      const url = v.baseUrl || v.base_url || v.backupUrl?.[0] || v.backup_url?.[0] || ''
      if (!url) continue
      const qlabel = BILI_QUALITY_LABELS[v.id] || `${v.id}`
      const res = v.width && v.height ? `${v.width}x${v.height}` : ''
      const fname = `[${qlabel}${res ? '_' + res : ''}${v.codecs ? '_' + v.codecs.split('.')[0] : ''}] video.m4s`
      emit(url, 'bilibili-dash-video', {
        categoryHint: 'video',
        contentType: v.mimeType || v.mime_type || 'video/mp4',
        filename: fname,
        sizeBytes: v.size || v.bandwidth || '',
        biliMeta: JSON.stringify({ type: 'video', quality: v.id, qlabel, codecs: v.codecs || '', width: v.width || 0, height: v.height || 0, bandwidth: v.bandwidth || 0 }),
      })
    }

    const allAudios = [...audios]
    if (flac) allAudios.push(flac)
    if (dolby) allAudios.push(...(Array.isArray(dolby) ? dolby : [dolby]))

    for (const a of allAudios) {
      const url = a.baseUrl || a.base_url || a.backupUrl?.[0] || a.backup_url?.[0] || ''
      if (!url) continue
      const qlabel = BILI_AUDIO_LABELS[a.id] || `${a.id}`
      const fname = `[${qlabel}${a.codecs ? '_' + a.codecs.split('.')[0] : ''}] audio.m4s`
      emit(url, 'bilibili-dash-audio', {
        categoryHint: 'audio',
        contentType: a.mimeType || a.mime_type || 'audio/mp4',
        filename: fname,
        sizeBytes: a.size || a.bandwidth || '',
        biliMeta: JSON.stringify({ type: 'audio', quality: a.id, qlabel, codecs: a.codecs || '', bandwidth: a.bandwidth || 0 }),
      })
    }
  }

  function tryExtractBilibili() {
    try {
      if (window.__playinfo__) extractBilibiliStreams(window.__playinfo__)
    } catch (_) {}
  }

  if (isTopFrame && /bilibili\.com/i.test(location.hostname)) {
    let _playinfo = undefined
    try {
      _playinfo = window.__playinfo__
      Object.defineProperty(window, '__playinfo__', {
        get() { return _playinfo },
        set(value) {
          _playinfo = value
          try { extractBilibiliStreams(value) } catch (_) {}
        },
        configurable: true,
        enumerable: true,
      })
    } catch (_) {}

    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', tryExtractBilibili, { once: true })
    } else {
      tryExtractBilibili()
    }
  }
})()
