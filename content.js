/**
 * 媒体嗅探器 - 内容脚本
 * 负责页面扫描、接收主世界桥接结果、渲染页面浮层，以及页面内抓取兜底。
 */

;(function () {
  'use strict'

  if (window.__mediaSnifferInjected) return
  window.__mediaSnifferInjected = true

  const Shared = window.MediaSnifferShared
  const reported = new Set()
  let dockRoot = null
  let dockActiveTab = 'video'
  let dockMedia = []

  const DOCK_TAB_ORDER = ['video', 'image', 'audio', 'other']
  const DOCK_TAB_LABEL = { video: '视频', image: '图片', audio: '音频', other: '其他' }

  function reportMedia(url, source, extra) {
    const absUrl = Shared.toAbsoluteUrl(url, location.href)
    const contentType = extra?.contentType || ''
    if (!Shared.shouldCaptureResource(absUrl, contentType, location.href)) return

    const categoryHint = extra?.categoryHint || ''
    const category = Shared.inferCategory(absUrl, contentType, categoryHint)
    const key = `${absUrl}:${contentType}:${category}:${source}`
    if (reported.has(key)) return
    reported.add(key)

    chrome.runtime.sendMessage({
      type: Shared.MESSAGE_TYPES.MEDIA_FOUND,
      url: absUrl,
      filename: extra?.filename || Shared.extractFilename(absUrl),
      category,
      categoryHint,
      platform: Shared.getPlatformStrategy(absUrl, location.href).name,
      contentType,
      referer: location.href,
      source,
      sizeBytes: extra?.sizeBytes || '',
      biliMeta: extra?.biliMeta || '',
    })
  }

  function reportElementMedia(el, source) {
    if (!el || el.nodeType !== 1) return

    const tagName = String(el.tagName || '').toUpperCase()
    if (tagName === 'AUDIO' || tagName === 'VIDEO') {
      const categoryHint = tagName === 'AUDIO' ? 'audio' : 'video'
      if (el.src) reportMedia(el.src, source, { categoryHint })
      if (el.currentSrc && el.currentSrc !== el.src) reportMedia(el.currentSrc, source, { categoryHint })
      if (el.poster) reportMedia(el.poster, source, { categoryHint: 'image' })
      el.querySelectorAll('source').forEach((sourceNode) => {
        if (sourceNode.src) reportMedia(sourceNode.src, source, { categoryHint })
      })
    }

    if (tagName === 'IMG' && el.src) reportMedia(el.src, source, { categoryHint: 'image' })
    if (tagName === 'SOURCE') {
      if (el.src) reportMedia(el.src, source, { categoryHint: 'video' })
      if (el.srcset) {
        el.srcset.split(',').forEach((item) => {
          const candidate = item.trim().split(' ')[0]
          if (candidate) reportMedia(candidate, source, { categoryHint: 'image' })
        })
      }
    }
  }

  function scanExisting() {
    document.querySelectorAll('audio, video, img, source').forEach((el) => {
      reportElementMedia(el, 'scan')
    })
  }

  const observer = new MutationObserver((mutations) => {
    for (const mutation of mutations) {
      for (const node of mutation.addedNodes) {
        if (node.nodeType !== 1) continue
        reportElementMedia(node, 'element')
        if (node.querySelectorAll) {
          node.querySelectorAll('audio, video, img, source').forEach((child) => {
            reportElementMedia(child, 'element')
          })
        }
      }

      if (mutation.type === 'attributes') {
        reportElementMedia(mutation.target, 'element')
      }
    }
  })

  if (document.documentElement) {
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ['src', 'poster', 'srcset'],
    })
  }

  window.addEventListener(Shared.BRIDGE_EVENT_NAME, (event) => {
    const detail = event.detail || {}
    reportMedia(detail.url, detail.source || 'page-bridge', {
      categoryHint: detail.categoryHint || '',
      contentType: detail.contentType || '',
      filename: detail.filename || '',
      sizeBytes: detail.sizeBytes || '',
      biliMeta: detail.biliMeta || '',
    })
  })

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', scanExisting, { once: true })
  } else {
    scanExisting()
  }

  setTimeout(scanExisting, 2000)
  setTimeout(scanExisting, 5000)

  function injectDockStyle() {
    if (document.getElementById('media-sniffer-dock-style')) return
    const style = document.createElement('style')
    style.id = 'media-sniffer-dock-style'
    style.textContent = `
      .ms-dock{position:fixed;top:12px;right:12px;width:400px;max-height:80vh;z-index:2147483647;background:#f7f8fa;border:1px solid #dcdfe6;border-radius:10px;box-shadow:0 12px 30px rgba(0,0,0,.2);font-family:-apple-system,BlinkMacSystemFont,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#303133;display:flex;flex-direction:column}
      .ms-dock-header{display:flex;align-items:center;justify-content:space-between;padding:8px 10px;background:#409eff;color:#fff;border-radius:10px 10px 0 0}
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
      .ms-note{margin-top:4px;font-size:11px;color:#e6a23c;line-height:1.4}
      .ms-tag{display:inline-block;padding:1px 6px;border-radius:3px;font-size:10px;font-weight:600}
      .ms-tag.audio{background:#ecf5ff;color:#409eff}
      .ms-tag.video{background:#fdf6ec;color:#e6a23c}
      .ms-tag.image{background:#f0f9eb;color:#67c23a}
      .ms-tag.other{background:#f4f4f5;color:#909399}
      .ms-tag.stream{background:#fef0f0;color:#f56c6c}
      .ms-download{border:none;background:#409eff;color:#fff;border-radius:4px;padding:3px 10px;font-size:12px;cursor:pointer}
      .ms-empty{text-align:center;color:#909399;font-size:12px;padding:20px 0}
    `
    document.documentElement.appendChild(style)
  }

  function getStreamTag(item) {
    const mode = Shared.getDownloadMode(item)
    if (mode === 'manifest') return '<span class="ms-tag stream">索引</span>'
    if (mode === 'segment') return '<span class="ms-tag stream">分片</span>'
    return ''
  }

  function findDockItem(itemId) {
    return dockMedia.find((item) => item.id === itemId) || null
  }

  function ensureDock() {
    if (dockRoot || window.top !== window) return
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

    root.querySelector('#msDockClose').addEventListener('click', destroyDock)
    root.querySelector('#msDockClear').addEventListener('click', () => {
      chrome.runtime.sendMessage({ type: Shared.MESSAGE_TYPES.CLEAR_MEDIA_FOR_TAB }, () => refreshDockData())
    })
    root.addEventListener('click', (event) => {
      const tabButton = event.target.closest('.ms-tab')
      if (tabButton) {
        if (tabButton.disabled) return
        dockActiveTab = tabButton.dataset.cat
        renderDock()
        return
      }

      const thumb = event.target.closest('.ms-thumb')
      if (thumb?.dataset.url) {
        window.open(thumb.dataset.url, '_blank', 'noopener,noreferrer')
        return
      }

      const downloadButton = event.target.closest('.ms-download')
      if (!downloadButton) return
      const item = findDockItem(downloadButton.dataset.id)
      if (!item) return

      downloadButton.textContent = '下载中'
      chrome.runtime.sendMessage(
        {
          type: Shared.MESSAGE_TYPES.DOWNLOAD,
          tabId: item.tabId,
          key: item.key || '',
          frameId: item.frameId,
          url: item.url,
          filename: item.filename,
          category: Shared.normalizeCategory(item),
          contentType: item.contentType,
          referer: item.referer,
          sizeBytes: item.sizeBytes,
          requestHeaders: item.requestHeaders || {},
          responseHeaders: item.responseHeaders || {},
        },
        (resp) => {
          downloadButton.textContent = resp?.ok ? '完成' : '失败'
          if (resp?.warning) downloadButton.title = resp.warning
          setTimeout(() => {
            downloadButton.textContent = '下载'
            downloadButton.title = ''
          }, 1200)
        }
      )
    })
  }

  function destroyDock() {
    if (dockRoot) {
      dockRoot.remove()
      dockRoot = null
    }
  }

  function renderDock() {
    if (!dockRoot) return
    const visibleDockMedia = dockMedia.filter((item) => Shared.isLikelyUsefulResource(item))
    const counts = { video: 0, image: 0, audio: 0, other: 0 }
    visibleDockMedia.forEach((item) => {
      counts[Shared.normalizeCategory(item)] += 1
    })

    if (!counts[dockActiveTab]) {
      dockActiveTab = DOCK_TAB_ORDER.find((key) => counts[key] > 0) || 'video'
    }

    dockRoot.querySelector('#msDockCount').textContent = `${visibleDockMedia.length} 个`
    dockRoot.querySelector('#msDockTabs').innerHTML = DOCK_TAB_ORDER.map((key) => {
      const activeClass = key === dockActiveTab ? 'active' : ''
      const disabled = counts[key] ? '' : 'disabled'
      return `<button class="ms-tab ${activeClass}" data-cat="${key}" ${disabled}>${DOCK_TAB_LABEL[key]} (${counts[key] || 0})</button>`
    }).join('')

    const list = visibleDockMedia
      .filter((item) => Shared.normalizeCategory(item) === dockActiveTab)
      .sort((left, right) => (right.time || 0) - (left.time || 0))

    const listEl = dockRoot.querySelector('#msDockList')
    if (!list.length) {
      listEl.innerHTML = '<div class="ms-empty">当前分类暂无资源</div>'
      return
    }

    listEl.innerHTML = list.map((item) => {
      const category = Shared.normalizeCategory(item)
      const previewHtml = category === 'image'
        ? `<img class="ms-thumb" data-url="${Shared.escapeHtml(item.url || '')}" src="${Shared.escapeHtml(item.url || '')}" alt="img" />`
        : ''
      const meta = [
        item.size ? Shared.escapeHtml(item.size) : '',
        item.contentType ? Shared.escapeHtml(item.contentType) : '',
        item.platform ? Shared.escapeHtml(item.platform) : '',
        item.time ? Shared.escapeHtml(new Date(item.time).toLocaleTimeString()) : '',
      ].filter(Boolean).join(' ')
      const note = item.downloadNotice ? `<div class="ms-note">${Shared.escapeHtml(item.downloadNotice)}</div>` : ''

      return `<div class="ms-item">
        <div class="ms-row">
          <span class="ms-tag ${category}">${DOCK_TAB_LABEL[category]}</span>
          ${getStreamTag(item)}
          ${previewHtml}
          <span class="ms-name" title="${Shared.escapeHtml(item.filename || 'media')}">${Shared.escapeHtml(item.filename || 'media')}</span>
          <button class="ms-download" data-id="${Shared.escapeHtml(item.id)}">下载</button>
        </div>
        <div class="ms-meta">${meta}</div>
        ${note}
      </div>`
    }).join('')
  }

  function refreshDockData() {
    chrome.runtime.sendMessage({ type: Shared.MESSAGE_TYPES.GET_MEDIA_FOR_TAB }, (resp) => {
      if (!dockRoot || !resp) return
      dockMedia = (resp.media || []).map((item) => ({ ...item, tabId: resp.tabId }))
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
  }

  function fetchBlobAsDataUrl(url) {
    const credentialModes = Shared.isBlobUrl(url) ? ['same-origin'] : ['omit', 'include', 'same-origin']

    return credentialModes
      .reduce((promise, credentials) => {
        return promise.catch(() => {
          return fetch(url, { credentials }).then((resp) => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
            return resp.blob()
          })
        })
      }, Promise.reject(new Error('init')))
      .then((blob) => {
        return new Promise((resolve, reject) => {
          const reader = new FileReader()
          reader.onloadend = () => resolve(reader.result)
          reader.onerror = () => reject(new Error('FileReader 失败'))
          reader.readAsDataURL(blob)
        })
      })
  }

  function fetchTextResource(url) {
    const credentialModes = Shared.isBlobUrl(url) ? ['same-origin'] : ['omit', 'include', 'same-origin']

    return credentialModes
      .reduce((promise, credentials) => {
        return promise.catch(() => {
          return fetch(url, { credentials }).then((resp) => {
            if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
            return resp.text().then((text) => ({
              text,
              finalUrl: resp.url || url,
            }))
          })
        })
      }, Promise.reject(new Error('init')))
  }

  chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
    if (msg.type === Shared.MESSAGE_TYPES.TOGGLE_DOCK_PANEL) {
      toggleDockPanel()
      sendResponse({ ok: true })
      return true
    }

    if (msg.type === Shared.MESSAGE_TYPES.MEDIA_UPDATED) {
      if (dockRoot) refreshDockData()
      return false
    }

    if (msg.type === Shared.MESSAGE_TYPES.FETCH_TEXT) {
      fetchTextResource(msg.url)
        .then((result) => {
          sendResponse({ ok: true, text: result.text, finalUrl: result.finalUrl })
        })
        .catch((err) => {
          console.error('[Media Sniffer] in-page text fetch failed:', err)
          sendResponse({ ok: false, error: err.message })
        })
      return true
    }

    if (msg.type !== Shared.MESSAGE_TYPES.FETCH_BLOB) return false

    fetchBlobAsDataUrl(msg.url)
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
