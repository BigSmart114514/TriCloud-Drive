/**
 * 动态玻璃：给 [data-liquid] 元素生成「边缘折射 + 边缘高光」的 SVG 滤镜，
 * 再用 CSS 变量把它接进 backdrop-filter（见 experimental.css 末尾那条
 * [data-glass-filter] 规则）。
 *
 * 与旧版的区别（都是「没有通透感」的根因）：
 *
 *   1. 位移量。旧版 --lg-refraction 默认 118，且位移图在中段就被钳到 0/255
 *      饱和，等于边缘一圈都在按最大值拉扯背景 —— 观感是哈哈镜而不是玻璃。
 *      现在降到 24，并压低位移图的增益（gain），让位移沿边缘平滑衰减。
 *
 *   2. 高光图。旧版的 bump 图 alpha 通道是恒定的 255，而 feSpecularLighting
 *      恰好拿 alpha 当高度场 —— 高度处处相同，法线处处垂直，所谓「镜面高光」
 *      其实是一层均匀的白纱（这正是糊在表面上的奶光来源之一）。现在
 *      把 alpha 换成遮罩值：平处无高光，只有边缘斜率变化的地方才亮。
 *
 *   3. 模糊与饱和不再由这里写死进内联样式，改由 CSS 端按 --lg-blur /
 *      --lg-saturation 统一渲染；JS 只负责算出 `url(#id)` 塞进 --lg-svg。
 *      元素没算出滤镜（或浏览器不支持 url() 做 backdrop-filter）时，
 *      CSS 里各表面自己的模糊声明仍然生效 —— 不会一点模糊都没有。
 */

const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const MAP_SCALE = 0.25
/** 滤镜区域在元素四周多留的边（px）。至少要盖住最大位移量 */
const MARGIN = 32
/** 超过这个面积（CSS 像素²）就不挂位移滤镜：全屏级的表面看不到边缘折射，
 *  但滤镜开销是全屏级的。约 1600 × 1000 */
const MAX_FILTER_AREA = 1_600_000

interface GlassParams {
  /** 边缘最大位移（px） */
  refraction: number
  /** 边缘过渡带的软度（进 buildMaps 的遮罩模糊） */
  edge: number
  /** 镜面高光强度 */
  specular: number
  /** 高光收敛度，越大光带越窄 */
  exponent: number
  /** 高度场缩放，越大边缘越「立」 */
  surface: number
}

const DEFAULT_PARAMS: GlassParams = {
  refraction: 24,
  edge: 14,
  specular: 0.5,
  exponent: 36,
  surface: 5
}

let svgHost: SVGSVGElement | null = null
let resizeObserver: ResizeObserver | null = null
let bodyObserver: MutationObserver | null = null
let scanScheduled = false
let sequence = 0

/** 元素 → 已生成的滤镜。同时充当「这元素已经画过」的登记表 */
const registry = new Map<HTMLElement, SVGFilterElement>()
/** 已被 resizeObserver 观察的元素（teardown 时要逐个解除） */
const observed = new Set<HTMLElement>()
/** 待重画的元素（尺寸变化会给每个元素报一次，合并到一帧里处理） */
const pending = new Set<HTMLElement>()
let paintScheduled = false

const clamp = (value: number, min: number, max: number) => (value < min ? min : value > max ? max : value)
const round = (value: number) => Math.round(value * 100) / 100

const isEnabled = () => import.meta.client && document.documentElement.dataset.ui === 'experimental'

/**
 * 浏览器是否支持把 SVG 滤镜引用放进 backdrop-filter。
 * 不支持时（部分火狐/旧 Safari）整个方案降级为 CSS 模糊，不去污染
 * backdrop-filter 的值 —— 一个无效的 url() 会连同一行的 blur() 一起废掉。
 */
let svgBackdropSupport: boolean | null = null
function supportsSvgBackdropFilter(): boolean {
  if (svgBackdropSupport !== null) return svgBackdropSupport
  svgBackdropSupport =
    typeof CSS !== 'undefined' &&
    typeof CSS.supports === 'function' &&
    (CSS.supports('backdrop-filter', 'url("#lg-probe")') ||
      CSS.supports('-webkit-backdrop-filter', 'url("#lg-probe")'))
  return svgBackdropSupport
}

function ensureHost() {
  if (svgHost && document.body.contains(svgHost)) return svgHost
  svgHost = document.createElementNS(SVG_NS, 'svg')
  svgHost.setAttribute('aria-hidden', 'true')
  svgHost.setAttribute('width', '0')
  svgHost.setAttribute('height', '0')
  svgHost.style.cssText = 'position:absolute;width:0;height:0;overflow:hidden;pointer-events:none'
  document.body.appendChild(svgHost)
  return svgHost
}

function readParams(): GlassParams {
  const style = getComputedStyle(document.documentElement)
  const read = (name: string, fallback: number) => {
    const value = parseFloat(style.getPropertyValue(name))
    return Number.isFinite(value) ? value : fallback
  }
  return {
    refraction: read('--lg-refraction', DEFAULT_PARAMS.refraction),
    edge: read('--lg-edge', DEFAULT_PARAMS.edge),
    specular: read('--lg-specular', DEFAULT_PARAMS.specular),
    exponent: read('--lg-exponent', DEFAULT_PARAMS.exponent),
    surface: read('--lg-surface', DEFAULT_PARAMS.surface)
  }
}

/**
 * 用 canvas 生成两张图：
 *   - displacement：边缘处的位移向量（R/G 通道，线性渐变，中心为 128 中性）；
 *   - bump：以 alpha 通道存高度场（圆角矩形遮罩 + 边缘模糊），供 feSpecularLighting
 *     算边缘高光。**alpha 必须是遮罩本身**，恒定 alpha 会退化成一层均匀白纱。
 */
function buildMaps(width: number, height: number, radius: number, edgeSoftness: number) {
  const scale = MAP_SCALE
  const w = Math.max(4, Math.round((width + MARGIN * 2) * scale))
  const h = Math.max(4, Math.round((height + MARGIN * 2) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  ctx.clearRect(0, 0, w, h)
  ctx.filter = `blur(${Math.max(0.6, edgeSoftness * scale)}px)`
  ctx.fillStyle = '#ffffff'
  const m = MARGIN * scale
  const rw = width * scale
  const rh = height * scale
  const rr = Math.max(0, Math.min(radius * scale, Math.min(rw, rh) / 2))
  ctx.beginPath()
  if (typeof ctx.roundRect === 'function') ctx.roundRect(m, m, rw, rh, rr)
  else ctx.rect(m, m, rw, rh)
  ctx.fill()
  ctx.filter = 'none'

  const source = ctx.getImageData(0, 0, w, h).data
  const field = new Float32Array(w * h)
  for (let i = 0; i < w * h; i++) field[i] = (source[i * 4 + 3] ?? 0) / 255
  const at = (x: number, y: number) => field[y * w + x] ?? 0

  const bump = ctx.createImageData(w, h)
  for (let i = 0; i < w * h; i++) {
    const v = Math.round((field[i] ?? 0) * 255)
    bump.data[i * 4] = v
    bump.data[i * 4 + 1] = v
    bump.data[i * 4 + 2] = v
    bump.data[i * 4 + 3] = v
  }
  ctx.putImageData(bump, 0, 0)
  const bumpMap = canvas.toDataURL()

  const map = ctx.createImageData(w, h)
  // 增益压到 3.5：位移图不再整段饱和，位移量沿边缘平滑衰减
  const gain = 3.5
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = y * w + x
      const left = at(x > 0 ? x - 1 : 0, y)
      const right = at(x < w - 1 ? x + 1 : w - 1, y)
      const top = at(x, y > 0 ? y - 1 : 0)
      const bottom = at(x, y < h - 1 ? y + 1 : h - 1)
      map.data[i * 4] = clamp(128 - (right - left) * gain * 127, 0, 255)
      map.data[i * 4 + 1] = clamp(128 - (bottom - top) * gain * 127, 0, 255)
      map.data[i * 4 + 2] = 128
      map.data[i * 4 + 3] = 255
    }
  }
  ctx.putImageData(map, 0, 0)

  return { displacement: canvas.toDataURL(), bump: bumpMap }
}

function ensureFilter(el: HTMLElement): SVGFilterElement {
  const existing = registry.get(el)
  if (existing) return existing
  const id = `lg-glass-${++sequence}`
  const filter = document.createElementNS(SVG_NS, 'filter')
  filter.setAttribute('id', id)
  filter.setAttribute('color-interpolation-filters', 'sRGB')
  ensureHost().appendChild(filter)
  registry.set(el, filter)
  return filter
}

/** 撤掉一个元素的动态玻璃，回落到 CSS 里的普通模糊 */
function unpaint(el: HTMLElement) {
  el.style.removeProperty('--lg-svg')
  delete el.dataset.glassFilter
  const filter = registry.get(el)
  if (filter) {
    filter.remove()
    registry.delete(el)
  }
}

function paint(el: HTMLElement) {
  if (!isEnabled() || !supportsSvgBackdropFilter()) return

  const rect = el.getBoundingClientRect()
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  // 还在过渡/隐藏状态：保留现状，等 ResizeObserver 报出稳定尺寸再画
  if (width < 16 || height < 16) return
  if (width * height > MAX_FILTER_AREA) {
    unpaint(el)
    return
  }

  const params = readParams()
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
  // 细条（导航、菜单行）容不下 14px 的软边：模糊带会漫过整个元素，
  // 中心没有「中性区」，整条都在位移 —— 看着像果冻。按短边收一下。
  const edgeSoftness = clamp(params.edge, 4, Math.max(6, Math.min(width, height) * 0.24))
  const maps = buildMaps(width, height, radius, edgeSoftness)
  if (!maps) return

  const filter = ensureFilter(el)
  filter.setAttribute('filterUnits', 'userSpaceOnUse')
  filter.setAttribute('primitiveUnits', 'userSpaceOnUse')
  filter.setAttribute('x', String(-MARGIN))
  filter.setAttribute('y', String(-MARGIN))
  filter.setAttribute('width', String(width + MARGIN * 2))
  filter.setAttribute('height', String(height + MARGIN * 2))
  filter.textContent = ''

  const region = {
    x: String(-MARGIN),
    y: String(-MARGIN),
    width: String(width + MARGIN * 2),
    height: String(height + MARGIN * 2)
  }

  const makeImage = (href: string, result: string) => {
    const node = document.createElementNS(SVG_NS, 'feImage')
    node.setAttribute('href', href)
    node.setAttributeNS(XLINK_NS, 'xlink:href', href)
    node.setAttribute('x', region.x)
    node.setAttribute('y', region.y)
    node.setAttribute('width', region.width)
    node.setAttribute('height', region.height)
    node.setAttribute('preserveAspectRatio', 'none')
    node.setAttribute('result', result)
    return node
  }

  const sizeFactor = clamp(Math.min(width, height) / 320, 0.45, 1.15)
  const displacement = document.createElementNS(SVG_NS, 'feDisplacementMap')
  displacement.setAttribute('in', 'SourceGraphic')
  displacement.setAttribute('in2', 'map')
  displacement.setAttribute('scale', String(round(params.refraction * sizeFactor)))
  displacement.setAttribute('xChannelSelector', 'R')
  displacement.setAttribute('yChannelSelector', 'G')
  displacement.setAttribute('result', 'bent')

  const lighting = document.createElementNS(SVG_NS, 'feSpecularLighting')
  lighting.setAttribute('in', 'bump')
  lighting.setAttribute('surfaceScale', String(round(params.surface)))
  lighting.setAttribute('specularConstant', String(round(params.specular)))
  lighting.setAttribute('specularExponent', String(round(params.exponent)))
  lighting.setAttribute('lighting-color', '#ffffff')
  lighting.setAttribute('result', 'lit')
  const light = document.createElementNS(SVG_NS, 'feDistantLight')
  light.setAttribute('azimuth', '235')
  light.setAttribute('elevation', '55')
  lighting.appendChild(light)

  const merge = document.createElementNS(SVG_NS, 'feComposite')
  merge.setAttribute('in', 'lit')
  merge.setAttribute('in2', 'bent')
  merge.setAttribute('operator', 'arithmetic')
  merge.setAttribute('k1', '0')
  merge.setAttribute('k2', '1')
  merge.setAttribute('k3', '1')
  merge.setAttribute('k4', '0')
  merge.setAttribute('result', 'lit-bent')

  const soften = document.createElementNS(SVG_NS, 'feGaussianBlur')
  soften.setAttribute('in', 'lit-bent')
  soften.setAttribute('stdDeviation', '0.35')

  filter.append(
    makeImage(maps.displacement, 'map'),
    makeImage(maps.bump, 'bump'),
    displacement,
    lighting,
    merge,
    soften
  )

  el.dataset.glassFilter = filter.id
  el.style.setProperty('--lg-svg', `url(#${filter.id})`)
}

function collect(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-liquid]'))
}

function observe(el: HTMLElement) {
  if (!resizeObserver || observed.has(el)) return
  resizeObserver.observe(el)
  observed.add(el)
}

/** 合并同一帧里的多次重画请求（拖动窗口时 ResizeObserver 会连珠炮） */
function schedulePaint(el: HTMLElement) {
  pending.add(el)
  if (paintScheduled) return
  paintScheduled = true
  requestAnimationFrame(() => {
    paintScheduled = false
    const batch = Array.from(pending)
    pending.clear()
    for (const item of batch) {
      if (item.isConnected) paint(item)
    }
  })
}

function scheduleScan() {
  if (scanScheduled) return
  scanScheduled = true
  requestAnimationFrame(() => {
    scanScheduled = false
    refreshLiquidGlass()
  })
}

export function setupLiquidGlass() {
  if (!isEnabled()) return
  ensureHost()

  if (!resizeObserver && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        schedulePaint(entry.target as HTMLElement)
      }
    })
  }

  // 弹窗 / 菜单是挂载后才进 DOM 的，setup 那一刻还不存在。挂一个
  // childList 观察（只调度扫描，不直接绘制），新出现的玻璃自己会补上。
  if (!bodyObserver && typeof MutationObserver !== 'undefined' && document.body) {
    bodyObserver = new MutationObserver(scheduleScan)
    bodyObserver.observe(document.body, { childList: true, subtree: true })
  }

  refreshLiquidGlass()
}

/**
 * 扫描页面上所有 [data-liquid]：新出现的补画，已移除的回收。
 * 已登记的元素不重复绘制（重画要走 ResizeObserver），页面里列表刷新
 * 引发的频繁 mutation 就不会把滤镜重复算一遍。
 */
export function refreshLiquidGlass() {
  if (!isEnabled()) return
  const live = collect()
  const liveSet = new Set(live)

  for (const [el, filter] of registry) {
    if (!liveSet.has(el)) {
      filter.remove()
      registry.delete(el)
    }
  }

  for (const el of live) {
    if (!registry.has(el)) {
      paint(el)
      observe(el)
    }
  }
}

export function teardownLiquidGlass() {
  if (!import.meta.client) return
  bodyObserver?.disconnect()
  bodyObserver = null
  scanScheduled = false
  pending.clear()

  for (const el of registry.keys()) {
    el.style.removeProperty('--lg-svg')
    delete el.dataset.glassFilter
  }
  registry.clear()

  resizeObserver?.disconnect()
  resizeObserver = null
  observed.clear()

  svgHost?.remove()
  svgHost = null
}
