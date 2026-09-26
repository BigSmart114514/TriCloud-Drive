const SVG_NS = 'http://www.w3.org/2000/svg'
const XLINK_NS = 'http://www.w3.org/1999/xlink'
const MAP_SCALE = 0.25
const MARGIN = 20

interface GlassParams {
  refraction: number
  blur: number
  saturation: number
  edge: number
  specular: number
  exponent: number
  surface: number
}

const DEFAULT_PARAMS: GlassParams = {
  refraction: 118,
  blur: 3,
  saturation: 195,
  edge: 20,
  specular: 0.9,
  exponent: 40,
  surface: 10
}

let svgHost: SVGSVGElement | null = null
let resizeObserver: ResizeObserver | null = null
let sequence = 0

const registry = new Map<HTMLElement, SVGFilterElement>()

const clamp = (value: number, min: number, max: number) => (value < min ? min : value > max ? max : value)
const round = (value: number) => Math.round(value * 100) / 100

const isEnabled = () => import.meta.client && document.documentElement.dataset.ui === 'experimental'

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
    blur: read('--lg-blur', DEFAULT_PARAMS.blur),
    saturation: read('--lg-saturation', DEFAULT_PARAMS.saturation),
    edge: read('--lg-edge', DEFAULT_PARAMS.edge),
    specular: read('--lg-specular', DEFAULT_PARAMS.specular),
    exponent: read('--lg-exponent', DEFAULT_PARAMS.exponent),
    surface: read('--lg-surface', DEFAULT_PARAMS.surface)
  }
}

function buildMaps(width: number, height: number, radius: number, blur: number) {
  const scale = MAP_SCALE
  const w = Math.max(4, Math.round((width + MARGIN * 2) * scale))
  const h = Math.max(4, Math.round((height + MARGIN * 2) * scale))
  const canvas = document.createElement('canvas')
  canvas.width = w
  canvas.height = h
  const ctx = canvas.getContext('2d', { willReadFrequently: true })
  if (!ctx) return null

  ctx.clearRect(0, 0, w, h)
  ctx.filter = `blur(${Math.max(0.6, blur * scale)}px)`
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
    bump.data[i * 4 + 3] = 255
  }
  ctx.putImageData(bump, 0, 0)
  const bumpMap = canvas.toDataURL()

  const map = ctx.createImageData(w, h)
  const gain = 7
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
  el.dataset.glassFilter = id
  return filter
}

function paint(el: HTMLElement) {
  const rect = el.getBoundingClientRect()
  const width = Math.round(rect.width)
  const height = Math.round(rect.height)
  if (width < 16 || height < 16) return

  const params = readParams()
  const radius = parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0
  const maps = buildMaps(width, height, radius, params.edge)
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
  soften.setAttribute('stdDeviation', '0.25')
  soften.setAttribute('result', 'soft')

  const saturate = document.createElementNS(SVG_NS, 'feColorMatrix')
  saturate.setAttribute('in', 'soft')
  saturate.setAttribute('type', 'saturate')
  saturate.setAttribute('values', String(round(params.saturation / 100)))

  filter.append(
    makeImage(maps.displacement, 'map'),
    makeImage(maps.bump, 'bump'),
    displacement,
    lighting,
    merge,
    soften,
    saturate
  )

  const value = `url(#${filter.id}) blur(${round(params.blur)}px) saturate(${round(params.saturation)}%) brightness(1.04)`
  el.style.setProperty('backdrop-filter', value)
  el.style.setProperty('-webkit-backdrop-filter', value)
}

function collect(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[data-liquid]'))
}

function observe(el: HTMLElement) {
  if (!resizeObserver || typeof ResizeObserver === 'undefined') return
  resizeObserver.observe(el)
}

export function setupLiquidGlass() {
  if (!isEnabled()) return
  ensureHost()
  if (!resizeObserver && typeof ResizeObserver !== 'undefined') {
    resizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const el = entry.target as HTMLElement
        if (registry.has(el)) paint(el)
      }
    })
  }
  for (const el of collect()) {
    paint(el)
    observe(el)
  }
}

export function refreshLiquidGlass() {
  if (!isEnabled()) return
  for (const el of collect()) {
    paint(el)
    observe(el)
  }
}

export function teardownLiquidGlass() {
  if (!import.meta.client) return
  for (const el of registry.keys()) {
    el.style.removeProperty('backdrop-filter')
    el.style.removeProperty('-webkit-backdrop-filter')
    delete el.dataset.glassFilter
    resizeObserver?.unobserve(el)
  }
  registry.clear()
  svgHost?.remove()
  svgHost = null
}
