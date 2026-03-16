/**
 * 媒体嗅探器 - Content Script
 * 注入到页面中，hook 原生 API 捕获媒体资源 URL
 */

;(function () {
  'use strict'
  if (window.__mediaSnifferInjected) return
  window.__mediaSnifferInjected = true

  const MEDIA_EXT_RE = /\.(mp3|wav|flac|m4a|ogg|aac|wma|opus|mp4|webm|mkv|mov|avi|m3u8|ts|m4s|mpd|jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?|$)/i
  const AUDIO_EXT_RE = /\.(mp3|wav|flac|m4a|ogg|aac|wma|opus)(\?|$)/i
  const VIDEO_EXT_RE = /\.(mp4|webm|mkv|mov|avi|m3u8|ts|m4s|mpd)(\?|$)/i
  const IMAGE_EXT_RE = /\.(jpg|jpeg|png|gif|webp|bmp|svg|avif)(\?|$)/i

  const PLATFORM_STRATEGIES = [
    {
      name: 'aigei',
      host: /(^|\.)aigei\.com$/i,
      extraMediaExt: /\.(zip|rar)(\?|$)/i,
      extraIgnore: [],
    },
    {
      name: 'generic',
      host: /.*/,
      extraMediaExt: null,
      extraIgnore: [],
    },
  ]

  const reported = new Set()

  function getPlatformStrategy(url) {
    try {
      const host = new URL(url, location.href).hostname
      return PLATFORM_STRATEGIES.find((s) => s.host.test(host)) || PLATFORM_STRATEGIES[PLATFORM_STRATEGIES.length - 1]
    } catch (_) {
      return PLATFORM_STRATEGIES[PLATFORM_STRATEGIES.length - 1]
    }
  }

  function inferCategory(url) {
    if (AUDIO_EXT_RE.test(url)) return 'audio'
    if (VIDEO_EXT_RE.test(url)) return 'video'
    if (IMAGE_EXT_RE.test(url)) return 'image'
    return 'other'
  }

  function report(url, source) {
    if (!url || typeof url !== 'string') return
    if (!url.startsWith('http')) return
    if (url.startsWith('chrome-extension://')) return
    const strategy = getPlatformStrategy(url)
    if ((strategy.extraIgnore || []).some((p) => p.test(url))) return
    const isMediaByDefault = MEDIA_EXT_RE.test(url)
    const isMediaByStrategy = !!strategy.extraMediaExt && strategy.extraMediaExt.test(url)
    if (!isMediaByDefault && !isMediaByStrategy) return
    if (reported.has(url)) return
    reported.add(url)

    let filename = 'media'
    try {
      const name = new URL(url).pathname.split('/').pop()
      if (name && name.length > 1) filename = decodeURIComponent(name.split('?')[0])
    } catch (_) {}

    chrome.runtime.sendMessage({
      type: 'mediaFound',
      url,
      filename,
      category: inferCategory(url),
      platform: strategy.name,
      referer: location.href,
      source,
    })
  }

  const origSrcDesc = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'src')
  if (origSrcDesc && origSrcDesc.set) {
    Object.defineProperty(HTMLMediaElement.prototype, 'src', {
      get: origSrcDesc.get,
      set(val) {
        report(val, 'element')
        return origSrcDesc.set.call(this, val)
      },
      configurable: true,
      enumerable: true,
    })
  }

  const OrigAudio = window.Audio
  window.Audio = function (src) {
    if (src) report(src, 'audio-constructor')
    return new OrigAudio(src)
  }
  window.Audio.prototype = OrigAudio.prototype

  const origSourceSrcDesc = Object.getOwnPropertyDescriptor(HTMLSourceElement.prototype, 'src')
  if (origSourceSrcDesc && origSourceSrcDesc.set) {
    Object.defineProperty(HTMLSourceElement.prototype, 'src', {
      get: origSourceSrcDesc.get,
      set(val) {
        report(val, 'element')
        return origSourceSrcDesc.set.call(this, val)
      },
      configurable: true,
      enumerable: true,
    })
  }

  const origFetch = window.fetch
  window.fetch = function (input) {
    let url = ''
    if (typeof input === 'string') url = input
    else if (input instanceof Request) url = input.url
    else if (input instanceof URL) url = input.href
    if (url) report(url, 'fetch')
    return origFetch.apply(this, arguments)
  }

  const origXhrOpen = XMLHttpRequest.prototype.open
  XMLHttpRequest.prototype.open = function (method, url) {
    if (url) {
      try {
        report(new URL(url, location.href).href, 'xhr')
      } catch (_) {
        report(url, 'xhr')
      }
    }
    return origXhrOpen.apply(this, arguments)
  }

  function scanExisting() {
    document.querySelectorAll('audio, video').forEach((el) => {
      if (el.src) report(el.src, 'scan')
      if (el.currentSrc && el.currentSrc !== el.src) report(el.currentSrc, 'scan')
      el.querySelectorAll('source').forEach((s) => {
        if (s.src) report(s.src, 'scan')
      })
    })

    document.querySelectorAll('img[src], source[srcset], video[poster], a[href]').forEach((el) => {
      if (el.tagName === 'IMG' && el.src) report(el.src, 'scan')
      if (el.tagName === 'VIDEO' && el.poster) report(el.poster, 'scan')
      if (el.tagName === 'A' && el.href) report(el.href, 'scan')
      if (el.tagName === 'SOURCE') {
        if (el.src) report(el.src, 'scan')
        if (el.srcset) {
          el.srcset.split(',').forEach((item) => {
            const candidate = item.trim().split(' ')[0]
            if (candidate) {
              try {
                report(new URL(candidate, location.href).href, 'scan')
              } catch (_) {}
            }
          })
        }
      }
    })
  }

  const observer = new MutationObserver((mutations) => {
    for (const mut of mutations) {
      for (const node of mut.addedNodes) {
        if (node.nodeType !== 1) continue

        if (node.tagName === 'AUDIO' || node.tagName === 'VIDEO') {
          if (node.src) report(node.src, 'element')
          if (node.currentSrc) report(node.currentSrc, 'element')
          node.querySelectorAll('source').forEach((s) => {
            if (s.src) report(s.src, 'element')
          })
          if (node.poster) report(node.poster, 'element')
        }

        if (node.tagName === 'IMG' && node.src) report(node.src, 'element')
        if (node.tagName === 'SOURCE' && node.src) report(node.src, 'element')

        if (node.querySelectorAll) {
          node.querySelectorAll('audio, video, img, source, a[href]').forEach((el) => {
            if (el.src) report(el.src, 'element')
            if (el.currentSrc) report(el.currentSrc, 'element')
            if (el.href) report(el.href, 'element')
            if (el.poster) report(el.poster, 'element')
          })
        }
      }

      if (mut.type === 'attributes') {
        const el = mut.target
        if (!el || el.nodeType !== 1) continue
        if (mut.attributeName === 'src' && el.src) report(el.src, 'element')
        if (mut.attributeName === 'poster' && el.poster) report(el.poster, 'element')
        if (mut.attributeName === 'href' && el.href) report(el.href, 'element')
        if (mut.attributeName === 'srcset' && el.srcset) {
          el.srcset.split(',').forEach((item) => {
            const candidate = item.trim().split(' ')[0]
            if (candidate) {
              try {
                report(new URL(candidate, location.href).href, 'element')
              } catch (_) {}
            }
          })
        }
      }
    }
  })

  observer.observe(document.documentElement, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['src', 'poster', 'href', 'srcset'],
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanExisting)
  } else {
    scanExisting()
  }

  setTimeout(scanExisting, 2000)
  setTimeout(scanExisting, 5000)

  let dockRoot = null
  let dockTimer = null
  let dockActiveTab = 'video'
  let dockMedia = []

  const DOCK_TAB_ORDER = ['video', 'image', 'audio', 'other']
  const DOCK_TAB_LABEL = { video: '视频', image: '图片', audio: '音频', other: '其他' }

  function normalizeCategory(m) {
    const c = String(m.category || '').toLowerCase()
    if (c === 'audio' || c === 'video' || c === 'image') return c
    const ct = String(m.contentType || '').toLowerCase()
    if (ct.startsWith('audio/') || ct.includes('aac') || ct.includes('ogg')) return 'audio'
    if (ct.startsWith('video/') || ct.includes('mpegurl') || ct.includes('mp2t') || ct.includes('dash+xml')) return 'video'
    if (ct.startsWith('image/')) return 'image'
    const u = String(m.url || '')
    if (AUDIO_EXT_RE.test(u)) return 'audio'
    if (VIDEO_EXT_RE.test(u)) return 'video'
    if (IMAGE_EXT_RE.test(u)) return 'image'
    return 'other'
  }

  function escHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
  }

  function injectDockStyle() {
    if (document.getElementById('media-sniffer-dock-style')) return
    const style = document.createElement('style')
    style.id = 'media-sniffer-dock-style'
    style.textContent = `
      .ms-dock{position:fixed;top:12px;right:12px;width:380px;max-height:80vh;z-index:2147483647;background:#f7f8fa;border:1px solid #dcdfe6;border-radius:8px;box-shadow:0 8px 24px rgba(0,0,0,.18);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#303133;display:flex;flex-direction:column}
      .ms-dock-header{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#409eff;color:#fff;border-radius:8px 8px 0 0}
      .ms-dock-title{font-size:13px;font-weight:600}
      .ms-dock-badge{font-size:12px;background:rgba(255,255,255,.25);padding:1px 8px;border-radius:10px}
      .ms-dock-actions{display:flex;gap:6px}
      .ms-btn{border:1px solid #dcdfe6;background:#fff;color:#606266;border-radius:4px;padding:2px 8px;font-size:11px;cursor:pointer}
      .ms-btn:hover{background:#f2f3f5}
      .ms-dock-body{padding:8px 10px;display:flex;flex-direction:column;gap:8px;min-height:120px}
      .ms-site{font-size:12px;color:#909399}
      .ms-tabs{display:flex;gap:6px;overflow-x:auto}
      .ms-tab{border:1px solid #dcdfe6;background:#fff;color:#606266;border-radius:12px;padding:2px 8px;font-size:12px;cursor:pointer;white-space:nowrap}
      .ms-tab.active{background:#409eff;border-color:#409eff;color:#fff}
      .ms-tab:disabled{background:#f5f7fa;color:#c0c4cc;border-color:#ebeef5;cursor:not-allowed}
      .ms-list{overflow:auto;max-height:52vh;padding-right:2px}
      .ms-item{background:#fff;border:1px solid #ebeef5;border-radius:6px;padding:8px 10px;margin-bottom:8px}
      .ms-row{display:flex;align-items:center;gap:6px}
      .ms-thumb{width:36px;height:36px;object-fit:cover;border:1px solid #dcdfe6;border-radius:4px;cursor:zoom-in;flex-shrink:0;background:#f5f7fa}
      .ms-name{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:13px}
      .ms-meta{font-size:11px;color:#909399;margin-top:4px}
      .ms-tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600}
      .ms-tag.audio{background:#ecf5ff;color:#409eff}
      .ms-tag.video{background:#fdf6ec;color:#e6a23c}
      .ms-tag.image{background:#f0f9eb;color:#67c23a}
      .ms-tag.other{background:#f4f4f5;color:#909399}
      .ms-download{border:none;background:#409eff;color:#fff;border-radius:4px;padding:3px 10px;font-size:12px;cursor:pointer}
      .ms-empty{text-align:center;color:#909399;font-size:12px;padding:20px 0}
    `
    document.documentElement.appendChild(style)
  }

  function ensureDock() {
    if (dockRoot) return
    if (window.top !== window) return
    injectDockStyle()
    const root = document.createElement('div')
    root.className = 'ms-dock'
    root.innerHTML = `
      <div class="ms-dock-header">
        <div class="ms-dock-title">媒体嗅探器</div>
        <div class="ms-dock-actions">
          <span class="ms-dock-badge" id="msDockCount">0</span>
          <button class="ms-btn" id="msDockClear">清空</button>
          <button class="ms-btn" id="msDockClose">收起</button>
        </div>
      </div>
      <div class="ms-dock-body">
        <div class="ms-site" id="msDockSite">当前页面</div>
        <div class="ms-tabs" id="msDockTabs"></div>
        <div class="ms-list" id="msDockList"></div>
      </div>
    `
    document.documentElement.appendChild(root)
    dockRoot = root

    root.querySelector('#msDockClose').addEventListener('click', () => {
      destroyDock()
    })
    root.querySelector('#msDockClear').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: 'clearMediaForTab' }, () => refreshDockData())
    })
    root.addEventListener('click', (e) => {
      const tabBtn = e.target.closest('.ms-tab')
      if (tabBtn) {
        if (tabBtn.disabled) return
        dockActiveTab = tabBtn.dataset.cat
        renderDock()
        return
      }
      const thumb = e.target.closest('.ms-thumb')
      if (thumb) {
        const url = thumb.dataset.url
        if (url) window.open(url, '_blank', 'noopener,noreferrer')
        return
      }
      const dlBtn = e.target.closest('.ms-download')
      if (!dlBtn) return
      const idx = parseInt(dlBtn.dataset.idx, 10)
      const item = dockMedia[idx]
      if (!item) return
      dlBtn.textContent = '下载中'
      chrome.runtime.sendMessage(
        {
          type: 'download',
          url: item.url,
          filename: item.filename,
          category: normalizeCategory(item),
          contentType: item.contentType,
          referer: item.referer,
        },
        (resp) => {
          dlBtn.textContent = resp?.ok ? '完成' : '失败'
          setTimeout(() => {
            dlBtn.textContent = '下载'
          }, 1200)
        }
      )
    })
  }

  function destroyDock() {
    if (dockTimer) {
      clearInterval(dockTimer)
      dockTimer = null
    }
    if (dockRoot) {
      dockRoot.remove()
      dockRoot = null
    }
  }

  function renderDock() {
    if (!dockRoot) return
    const counts = { video: 0, image: 0, audio: 0, other: 0 }
    dockMedia.forEach((m) => {
      counts[normalizeCategory(m)] += 1
    })
    if (counts[dockActiveTab] === 0) {
      dockActiveTab = DOCK_TAB_ORDER.find((k) => counts[k] > 0) || 'video'
    }

    const tabsEl = dockRoot.querySelector('#msDockTabs')
    const listEl = dockRoot.querySelector('#msDockList')
    const countEl = dockRoot.querySelector('#msDockCount')
    countEl.textContent = `${dockMedia.length} 个`
    tabsEl.innerHTML = DOCK_TAB_ORDER.map((k) => {
      const activeClass = k === dockActiveTab ? 'active' : ''
      const disabled = (counts[k] || 0) === 0 ? 'disabled' : ''
      return `<button class="ms-tab ${activeClass}" data-cat="${k}" ${disabled}>${DOCK_TAB_LABEL[k]} (${counts[k] || 0})</button>`
    }).join('')

    const list = dockMedia
      .map((m, idx) => ({ ...m, _idx: idx, _category: normalizeCategory(m) }))
      .filter((m) => m._category === dockActiveTab)
      .sort((a, b) => (b.time || 0) - (a.time || 0))
    if (!list.length) {
      listEl.innerHTML = '<div class="ms-empty">当前分类暂无资源</div>'
      return
    }
    listEl.innerHTML = list.map((m) => {
      const sizeInfo = m.size ? `${escHtml(m.size)} ` : ''
      const typeInfo = m.contentType ? escHtml(m.contentType) : ''
      const platformInfo = m.platform ? ` ${escHtml(m.platform)}` : ''
      const timeStr = m.time ? new Date(m.time).toLocaleTimeString() : ''
      const previewHtml = m._category === 'image'
        ? `<img class="ms-thumb" data-url="${escHtml(m.url || '')}" src="${escHtml(m.url || '')}" alt="img" />`
        : ''
      return `<div class="ms-item">
        <div class="ms-row">
          <span class="ms-tag ${m._category}">${DOCK_TAB_LABEL[m._category]}</span>
          ${previewHtml}
          <span class="ms-name" title="${escHtml(m.filename || 'media')}">${escHtml(m.filename || 'media')}</span>
          <button class="ms-download" data-idx="${m._idx}">下载</button>
        </div>
        <div class="ms-meta">${sizeInfo}${typeInfo}${platformInfo} ${escHtml(timeStr)}</div>
      </div>`
    }).join('')
  }

  function refreshDockData() {
    chrome.runtime.sendMessage({ type: 'getMediaForTab' }, (resp) => {
      if (!dockRoot || !resp) return
      dockMedia = resp.media || []
      const siteEl = dockRoot.querySelector('#msDockSite')
      try {
        siteEl.textContent = resp.tabUrl ? new URL(resp.tabUrl).hostname : '当前页面'
      } catch (_) {
        siteEl.textContent = '当前页面'
      }
      renderDock()
    })
  }

  function toggleDockPanel() {
    if (window.top !== window) return
    if (dockRoot) {
      destroyDock()
      return
    }
    ensureDock()
    refreshDockData()
    dockTimer = setInterval(refreshDockData, 2000)
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === 'toggleDockPanel') {
      toggleDockPanel()
      sendResponse({ ok: true })
      return true
    }
    if (msg.type !== 'fetchBlob') return false

    const url = msg.url
    fetch(url, { credentials: 'omit' })
      .then((resp) => {
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
        return resp.blob()
      })
      .catch(() => {
        return fetch(url, { credentials: 'include' }).then((resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          return resp.blob()
        })
      })
      .catch(() => {
        return fetch(url, { credentials: 'same-origin' }).then((resp) => {
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
          return resp.blob()
        })
      })
      .then((blob) => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result)
          reader.onerror = () => reject(new Error('FileReader 失败'))
          reader.readAsDataURL(blob)
        })
      })
      .then((dataUrl) => {
        sendResponse({ ok: true, dataUrl })
      })
      .catch((err) => {
        console.error('[媒体嗅探器] 页面内 fetch 失败:', err)
        sendResponse({ ok: false, error: err.message })
      })

    return true
  })
})()
