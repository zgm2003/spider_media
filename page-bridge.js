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
  patchFetch()
  patchXhr()
  patchAudio()
  patchObjectUrl()
})()
