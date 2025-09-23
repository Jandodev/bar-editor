<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader'
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader'
import { brushRegistry } from '../lib/brushes'

type OverlayImage = {
  name: string
  url: string
  visible: boolean
  opacity: number
  isDDS?: boolean
}

type Props = {
  widthWorld: number
  lengthWorld: number
  gridW: number // number of vertices along X (width)
  gridL: number // number of vertices along Z (length)
  heights: Float32Array // row-major: z rows, x columns

  // Metal overlay (optional)
  showMetal?: boolean
  metalU8?: Uint8Array
  metalW?: number
  metalL?: number

  // Texturing + display toggles
  baseColorUrl?: string | null
  baseColorIsDDS?: boolean
  baseColorIsTGA?: boolean
  wireframe?: boolean
  showGrid?: boolean

  // Editing
  editEnabled?: boolean
  editMode?: string
  editRadius?: number
  editStrength?: number
  editPreview?: boolean

  // Shared preview position from bus
  previewPos?: { x: number; y: number; z: number }

  // Additional image overlays from folder
  overlays?: OverlayImage[]

  // Environment from mapinfo.lua (optional)
  env?: {
    ambient?: [number, number, number]
    sunColor?: [number, number, number]
    sunDir?: [number, number, number]
    skyColor?: [number, number, number]
    fogStart?: number
    fogEnd?: number
    fogColor?: [number, number, number]
  }
}

const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'fps', fps: number): void; (e: 'editHeights', h: Float32Array): void; (e: 'editCursor', pos: { x: number; y: number; z: number }): void }>()

const container = ref<HTMLDivElement | null>(null)
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let mesh: THREE.Mesh | null = null
let grid: THREE.GridHelper | null = null

// Editing helpers
const raycaster = new THREE.Raycaster()
const mouseNDC = new THREE.Vector2()
let isPainting = false
let lastPaintTs = 0

// Brush preview/debug
let brushCircle: THREE.Mesh | null = null
let hitDot: THREE.Mesh | null = null
let brushRing: THREE.Line | null = null
let brushLabel: THREE.Sprite | null = null
let brushLabelCanvas: HTMLCanvasElement | null = null
let brushSphere: THREE.LineSegments | null = null
let brushInnerSphere: THREE.LineSegments | null = null
let brushSphereMat: THREE.LineBasicMaterial | null = null
let brushInnerSphereMat: THREE.LineBasicMaterial | null = null
let lastHitY = 0
let lastHitPos: { x: number; y: number; z: number } | null = null
let normalsTimer: number | null = null
let needsNormals = false
let pixelRatioSaved: number | null = null

// Dirty region tracking for partial vertex updates during painting
let dirtyMinX = -1, dirtyMaxX = -1, dirtyMinZ = -1, dirtyMaxZ = -1
function setDirtyBoundsFromBrush(x: number, z: number, radius: number) {
  const gw = Math.max(2, props.gridW)
  const gl = Math.max(2, props.gridL)
  const halfW = props.widthWorld * 0.5
  const halfL = props.lengthWorld * 0.5
  const stepX = props.widthWorld / (gw - 1)
  const stepZ = props.lengthWorld / (gl - 1)
  const r = Math.max(1e-6, radius)
  const minX = Math.max(0, Math.floor((x - r + halfW) / stepX))
  const maxX = Math.min(gw - 1, Math.ceil((x + r + halfW) / stepX))
  const minZ = Math.max(0, Math.floor((z - r + halfL) / stepZ))
  const maxZ = Math.min(gl - 1, Math.ceil((z + r + halfL) / stepZ))
  dirtyMinX = minX; dirtyMaxX = maxX; dirtyMinZ = minZ; dirtyMaxZ = maxZ
}

function createBrushPreviewIfNeeded() {
  if (!scene) return
  if (!brushCircle) {
    const geo = new THREE.CircleGeometry(1, 64)
    geo.rotateX(-Math.PI / 2)
    const mat = new THREE.MeshBasicMaterial({
      color: 0x33aaff,
      transparent: true,
      opacity: 0.2,
      depthWrite: false,
      depthTest: false,
    })
    brushCircle = new THREE.Mesh(geo, mat)
    brushCircle.renderOrder = 10
    brushCircle.visible = false
    scene.add(brushCircle)
  }
  if (!hitDot) {
    const geo = new THREE.SphereGeometry(0.5, 12, 12)
    const mat = new THREE.MeshBasicMaterial({ color: 0xff3333, depthWrite: false, depthTest: false })
    hitDot = new THREE.Mesh(geo, mat)
    hitDot.renderOrder = 10
    hitDot.visible = false
    scene.add(hitDot)
  }
  if (!brushRing) {
    // Unit-radius circle line; scale to radius at update
    const seg = 128
    const pts: THREE.Vector3[] = []
    for (let i = 0; i < seg; i++) {
      const a = (i / seg) * Math.PI * 2
      pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)))
    }
    const g = new THREE.BufferGeometry().setFromPoints(pts)
    g.rotateX(-Math.PI / 2)
    brushRing = new THREE.LineLoop(
      g,
      new THREE.LineBasicMaterial({ color: 0xff3333, depthTest: false, depthWrite: false })
    )
    brushRing.renderOrder = 11
    brushRing.visible = false
    scene.add(brushRing)
  }
  if (!brushLabel) {
    brushLabelCanvas = document.createElement('canvas')
    brushLabelCanvas.width = 256
    brushLabelCanvas.height = 64
    const tex = new THREE.CanvasTexture(brushLabelCanvas)
    tex.colorSpace = THREE.SRGBColorSpace
    const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false, depthTest: false })
    brushLabel = new THREE.Sprite(mat)
    brushLabel.scale.set(20, 5, 1) // world units; adjusted when positioning
    brushLabel.renderOrder = 12
    brushLabel.visible = false
    scene.add(brushLabel)
  }
  if (!brushSphere) {
    const sGeo = new THREE.SphereGeometry(1, 16, 12)
    const wGeo = new THREE.WireframeGeometry(sGeo)
    brushSphereMat = new THREE.LineBasicMaterial({ color: 0x33aaff, transparent: true, opacity: 0.3, depthWrite: false, depthTest: false })
    brushSphere = new THREE.LineSegments(wGeo, brushSphereMat)
    brushSphere.renderOrder = 11
    brushSphere.visible = false
    scene.add(brushSphere)
  }
  if (!brushInnerSphere) {
    const sGeo2 = new THREE.SphereGeometry(1, 12, 8)
    const wGeo2 = new THREE.WireframeGeometry(sGeo2)
    brushInnerSphereMat = new THREE.LineBasicMaterial({ color: 0xff5555, transparent: true, opacity: 0.3, depthWrite: false, depthTest: false })
    brushInnerSphere = new THREE.LineSegments(wGeo2, brushInnerSphereMat)
    brushInnerSphere.renderOrder = 12
    brushInnerSphere.visible = false
    scene.add(brushInnerSphere)
  }
}

function setBrushPreviewVisible(v: boolean) {
  // Prefer 3D wireframe spheres over legacy circle/ring
  if (brushCircle) brushCircle.visible = false
  if (hitDot) hitDot.visible = v
  if (brushRing) brushRing.visible = false
  if (brushLabel) brushLabel.visible = v
  if (brushSphere) brushSphere.visible = v
  if (brushInnerSphere) brushInnerSphere.visible = v
}

function updateBrushPreview(x: number, y: number, z: number) {
  createBrushPreviewIfNeeded()
  lastHitY = y
  const r = Number(props.editRadius ?? 64)
  if (brushCircle) {
    // Hide legacy circle; sphere preview supersedes it
    brushCircle.visible = false
  }
  if (hitDot) {
    const s = Math.max(0.5, Math.min(5, r * 0.05))
    hitDot.scale.set(s, s, s)
    hitDot.position.set(x, y + 0.03, z)
    hitDot.visible = !!props.editEnabled && !!props.editPreview
  }
  if (brushRing) {
    // Hide legacy ring; sphere preview supersedes it
    brushRing.visible = false
  }
  if (brushLabel && brushLabelCanvas) {
    // Draw radius text
    const ctx = brushLabelCanvas.getContext('2d')!
    ctx.clearRect(0, 0, brushLabelCanvas.width, brushLabelCanvas.height)
    ctx.fillStyle = 'rgba(0,0,0,0.55)'
    ctx.fillRect(0, 0, brushLabelCanvas.width, brushLabelCanvas.height)
    ctx.font = 'bold 28px sans-serif'
    ctx.fillStyle = '#ff5555'
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    const text = `R: ${Math.round(r)}`
    ctx.fillText(text, brushLabelCanvas.width / 2, brushLabelCanvas.height / 2)
    ;(brushLabel.material as THREE.SpriteMaterial).map!.needsUpdate = true
    brushLabel.position.set(x + r * 0.15, y + 0.06, z + r * 0.15)
    brushLabel.visible = !!props.editEnabled && !!props.editPreview
  }
  // Wireframe spheres for full 3D footprint visualization
  if (brushSphere) {
    brushSphere.position.set(x, y, z)
    brushSphere.scale.set(r, r, r)
    brushSphere.visible = !!props.editEnabled && !!props.editPreview
    if (brushSphereMat) {
      const strength = Number(props.editStrength ?? 0)
      const sNorm = Math.max(0, Math.min(1, strength / 5))
      // Opacity and hue reflect strength (blue -> red), capped ~30%
      brushSphereMat.opacity = 0.15 + 0.15 * sNorm
      const color = new THREE.Color()
      color.setHSL(0.6 * (1 - sNorm), 1, 0.5)
      brushSphereMat.color.copy(color)
    }
  }
  if (brushInnerSphere) {
    const strength = Number(props.editStrength ?? 0)
    const sNorm = Math.max(0, Math.min(1, strength / 5))
    const innerR = Math.max(0.05, r * sNorm)
    brushInnerSphere.position.set(x, y, z)
    brushInnerSphere.scale.set(innerR, innerR, innerR)
    brushInnerSphere.visible = !!props.editEnabled && !!props.editPreview && sNorm > 0
    if (brushInnerSphereMat) {
      const color = new THREE.Color()
      color.setHSL(0.0 + 0.6 * sNorm, 1, 0.5)
      brushInnerSphereMat.color.copy(color)
      brushInnerSphereMat.opacity = 0.15 + 0.15 * sNorm
    }
  }
  lastHitPos = { x, y, z }
}

function screenToNDC(ev: PointerEvent, target: HTMLElement): THREE.Vector2 {
  const rect = target.getBoundingClientRect()
  mouseNDC.x = ((ev.clientX - rect.left) / rect.width) * 2 - 1
  mouseNDC.y = -((ev.clientY - rect.top) / rect.height) * 2 + 1
  return mouseNDC
}

function getBrushCenter(ev: PointerEvent): { x: number; y: number; z: number } | null {
  if (!renderer || !camera || !mesh) return null
  const ndc = screenToNDC(ev, renderer.domElement)
  raycaster.setFromCamera(ndc as any, camera as any)
  const hits = raycaster.intersectObject(mesh, false)
  if (!hits.length) return null
  const p = hits[0].point
  return { x: p.x, y: p.y, z: p.z }
}

function applyBrushAt(x: number, z: number) {
  if (!props.heights) return
  const mode = String(props.editMode ?? 'add')
  const radius = Number(props.editRadius ?? 64)
  const strength = Number(props.editStrength ?? 2)
  // Back-compat mapping: 'add' -> 'raise', 'remove' -> 'lower', other strings map directly to brush id.
  const id = mode === 'add' ? 'raise' : mode === 'remove' ? 'lower' : mode
  const brush = brushRegistry.get(id)
  if (!brush) return
  const next = brush.apply({
    heights: props.heights,
    gridW: props.gridW, gridL: props.gridL,
    widthWorld: props.widthWorld, lengthWorld: props.lengthWorld,
    centerX: x, centerZ: z,
    radiusWorld: radius,
    strength,
    hitY: lastHitY,
    mode
  })
  emit('editHeights', next)
}

function onPointerDown(ev: PointerEvent) {
  if (!props.editEnabled) return
  if (ev.button !== 0) return
  const c = getBrushCenter(ev)
  if (!c) return
  emit('editCursor', c)
  isPainting = true
  lastPaintTs = 0
  if (controls) controls.enabled = false
  if (renderer) { try { pixelRatioSaved = renderer.getPixelRatio(); renderer.setPixelRatio(1) } catch {} }
  ev.preventDefault(); ev.stopPropagation()
  updateBrushPreview(c.x, c.y, c.z)
  { const r = Number(props.editRadius ?? 64); setDirtyBoundsFromBrush(c.x, c.z, r) }
  applyBrushAt(c.x, c.z)
}

function onPointerMove(ev: PointerEvent) {
  if (!renderer) return
  const c = getBrushCenter(ev)
  if (c) { emit('editCursor', c) }
  if (c && props.editEnabled && props.editPreview) {
    updateBrushPreview(c.x, c.y, c.z)
  }
  if (!isPainting) return
  if (!c) return
  const now = performance.now()
  if (now - lastPaintTs < 16) return
  lastPaintTs = now
  ev.preventDefault(); ev.stopPropagation()
  { const r = Number(props.editRadius ?? 64); setDirtyBoundsFromBrush(c.x, c.z, r) }
  applyBrushAt(c.x, c.z)
}

function onPointerUp() {
  isPainting = false
  if (controls) controls.enabled = true
  if (renderer && pixelRatioSaved != null) {
    try { renderer.setPixelRatio(pixelRatioSaved) } catch {}
    pixelRatioSaved = null
  }
  if (mesh && needsNormals) {
    try { (mesh.geometry as THREE.BufferGeometry).computeVertexNormals() } catch {}
    needsNormals = false
  }
  // Clear dirty region after completing a stroke
  dirtyMinX = dirtyMaxX = dirtyMinZ = dirtyMaxZ = -1
}

// Lights
let ambientLight: THREE.AmbientLight | null = null
let dirLight: THREE.DirectionalLight | null = null

// Metal overlay resources
let metalMesh: THREE.Mesh | null = null
let metalMat: THREE.MeshBasicMaterial | null = null
let metalTex: THREE.DataTexture | null = null

// Image overlay resources (from folder)
type ImgLayer = { mesh: THREE.Mesh, mat: THREE.MeshBasicMaterial, tex: THREE.Texture, name: string }
let imgLayers: ImgLayer[] = []

// Base color texture
let baseTex: THREE.Texture | THREE.CompressedTexture | null = null

// Fullscreen state to adjust layout height
const isFullscreen = ref(false)
const viewportStyle = computed(() => ({
  height: isFullscreen.value ? '100vh' : '100%',
}))

let animationId = 0
let framesSince = 0
let lastFpsTs = performance.now()

function onFullscreenChange() {
  isFullscreen.value = document.fullscreenElement === container.value
}

function disposeMetal() {
  if (metalMesh && scene) {
    scene.remove(metalMesh)
    metalMesh = null
  }
  if (metalMat) {
    metalMat.dispose()
    metalMat = null
  }
  if (metalTex) {
    metalTex.dispose()
    metalTex = null
  }
}

function disposeImgLayers() {
  for (const l of imgLayers) {
    if (scene && l.mesh) scene.remove(l.mesh)
    l.mat.dispose()
    l.tex.dispose()
  }
  imgLayers = []
}

function disposeBaseTex() {
  if (baseTex) {
    baseTex.dispose()
    baseTex = null
  }
}

function isDDS(url: string | null | undefined): boolean {
  return !!url && /\.dds$/i.test(url)
}
function isTGA(url: string | null | undefined): boolean {
  return !!url && /\.tga$/i.test(url)
}
function ddsSupported(): boolean {
  const gl: any = renderer?.getContext?.()
  if (!gl) return true
  // Broad set of common compressed texture extensions
  const hasS3TC =
    gl.getExtension('WEBGL_compressed_texture_s3tc') ||
    gl.getExtension('WEBKIT_WEBGL_compressed_texture_s3tc') ||
    gl.getExtension('MOZ_WEBGL_compressed_texture_s3tc') ||
    gl.getExtension('EXT_texture_compression_s3tc') ||
    gl.getExtension('WEBGL_compressed_texture_s3tc_srgb')
  const hasRGTC = gl.getExtension('EXT_texture_compression_rgtc')
  const hasBPTC = gl.getExtension('EXT_texture_compression_bptc')
  return !!(hasS3TC || hasRGTC || hasBPTC)
}

// Convert float RGB [0..1] to THREE.Color, with fallback
function toThreeColor(rgb?: [number, number, number], fallback: [number, number, number] = [1, 1, 1]): THREE.Color {
  const c = new THREE.Color()
  const v = (rgb && rgb.length >= 3) ? rgb : fallback
  c.setRGB(v[0], v[1], v[2])
  return c
}

function applyEnvSettings() {
  if (!scene) return
  const env = props.env
  if (!env) return

  if (ambientLight) {
    ambientLight.color.copy(toThreeColor(env.ambient, [1, 1, 1]))
  }
  if (dirLight) {
    dirLight.color.copy(toThreeColor(env.sunColor, [1, 1, 1]))
    if (env.sunDir && env.sunDir.length >= 3) {
      const v = new THREE.Vector3(env.sunDir[0], env.sunDir[1], env.sunDir[2]).normalize().multiplyScalar(1000)
      dirLight.position.copy(v)
    }
  }
  if (env.skyColor) {
    scene.background = toThreeColor(env.skyColor, [0.055, 0.055, 0.063])
  }
  if (env.fogColor !== undefined && env.fogStart !== undefined && env.fogEnd !== undefined) {
    if (camera) {
      const near = Math.max(0.1, (env.fogStart ?? 0.1) * camera.far)
      const far = Math.max(near + 1, (env.fogEnd ?? 1.0) * camera.far)
      scene.fog = new THREE.Fog(toThreeColor(env.fogColor, [0, 0, 0]).getHex(), near, far)
    }
  }
}

/** Create a visible placeholder texture (magenta/black checker) to indicate missing/unsupported DDS. */
function createPlaceholderTexture(size = 4): THREE.DataTexture {
  const w = size, h = size
  const data = new Uint8Array(w * h * 4)
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const i = (y * w + x) * 4
      const isMagenta = ((x ^ y) & 1) === 0
      data[i + 0] = isMagenta ? 255 : 0
      data[i + 1] = 0
      data[i + 2] = isMagenta ? 255 : 0
      data[i + 3] = 255
    }
  }
  const tex = new THREE.DataTexture(data, w, h, THREE.RGBAFormat)
  tex.colorSpace = THREE.NoColorSpace
  tex.needsUpdate = true
  return tex
}
function loadAnyTexture(
  url: string,
  onLoad: (tex: THREE.Texture | THREE.CompressedTexture) => void,
  onError: (err: unknown) => void,
  isDDSHint?: boolean,
  isTGAHint?: boolean
): THREE.Texture | THREE.CompressedTexture {
  // Defensive: bad/empty URL => return placeholder and avoid loader crashes
  if (!url || typeof url !== 'string') {
    const placeholder = createPlaceholderTexture()
    try { onLoad(placeholder) } catch {}
    return placeholder
  }
  if (isDDSHint === true || isDDS(url)) {
    if (!ddsSupported()) {
      console.warn('DDS not supported by GPU/browser; using placeholder for:', url)
      const placeholder = createPlaceholderTexture()
      // still call onLoad so the caller can attach the texture
      try { onLoad(placeholder) } catch {}
      return placeholder
    }
    return new DDSLoader().load(
      url,
      (tex: THREE.CompressedTexture) => {
        // loaded DDS
        onLoad(tex)
      },
      undefined,
      (err: unknown) => {
        console.error('DDS load error:', url, err)
        onError(err)
      }
    )
  }
  if (isTGAHint === true || isTGA(url)) {
    return new TGALoader().load(
      url,
      (tex: THREE.Texture) => {
        // loaded TGA
        onLoad(tex)
      },
      undefined,
      (err: unknown) => {
        console.error('TGA load error:', url, err)
        onError(err)
      }
    )
  }
  return new THREE.TextureLoader().load(
    url,
    (tex: THREE.Texture) => {
      // loaded image
      onLoad(tex)
    },
    undefined,
    (err: unknown) => {
      console.error('Image load error:', url, err)
      onError(err)
    }
  )
}
function applyBaseTexture(mat: THREE.MeshStandardMaterial) {
  disposeBaseTex()
  if (!props.baseColorUrl) {
    mat.map = null
    mat.needsUpdate = true
    return
  }
  // Use a tiny placeholder first; swap in real texture when it finishes loading.
  const placeholder = createPlaceholderTexture(2)
  baseTex = placeholder
  mat.map = placeholder
  mat.needsUpdate = true

  loadAnyTexture(
    props.baseColorUrl as string,
    (tex) => {
      // Configure color space + addressing
      if (isDDS(props.baseColorUrl)) {
        ;(tex as any).colorSpace = THREE.NoColorSpace
      } else {
        ;(tex as any).colorSpace = THREE.SRGBColorSpace
      }
      ;(tex as any).wrapS = (tex as any).wrapT = THREE.RepeatWrapping
      ;(tex as any).flipY = true
      // Swap in loaded texture
      if (baseTex && baseTex !== tex) {
        try { (baseTex as any).dispose?.() } catch {}
      }
      baseTex = tex as any
      mat.map = tex as any
      mat.needsUpdate = true
    },
    (err) => {
      console.warn('Failed to load base texture:', err)
    },
    props.baseColorIsDDS === true,
    props.baseColorIsTGA === true
  )
}

function buildMetalOverlay(geom: THREE.BufferGeometry) {
  disposeMetal()

  if (!scene) return
  if (!props.showMetal) return
  if (!props.metalU8 || !props.metalW || !props.metalL) return

  const metalU8 = props.metalU8 as Uint8Array
  const mw = props.metalW!
  const ml = props.metalL!
  const pxCount = mw * ml
  if (metalU8.length < pxCount) {
    console.warn('ThreeViewport: metalU8 size does not match expected resolution', {
      have: metalU8.length,
      expected: pxCount,
    })
    return
  }

  // Build RGBA texture: red with alpha from metal density (0..255)
  const data = new Uint8Array(pxCount * 4)
  for (let i = 0; i < pxCount; i++) {
    const a = metalU8[i] ?? 0 // already 0..255
    const j = i * 4
    data[j + 0] = 255 // R
    data[j + 1] = 0   // G
    data[j + 2] = 0   // B
    data[j + 3] = a   // A
  }

  metalTex = new THREE.DataTexture(data, mw, ml, THREE.RGBAFormat, THREE.UnsignedByteType)
  metalTex.colorSpace = THREE.NoColorSpace
  // Align metal overlay with terrain: flip Y
  metalTex.center.set(0.5, 0.5)
  metalTex.flipY = true
  metalTex.generateMipmaps = false
  metalTex.minFilter = THREE.NearestFilter
  metalTex.magFilter = THREE.NearestFilter
  metalTex.wrapS = THREE.ClampToEdgeWrapping
  metalTex.wrapT = THREE.ClampToEdgeWrapping
  metalTex.needsUpdate = true

  metalMat = new THREE.MeshBasicMaterial({
    map: metalTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  metalMesh = new THREE.Mesh(geom, metalMat)
  metalMesh.renderOrder = 1
  scene.add(metalMesh)
}

function buildImageOverlays(geom: THREE.BufferGeometry) {
  disposeImgLayers()
  if (!scene || !props.overlays) return

  let order = 2
  for (const ov of props.overlays) {
    if (!ov || typeof ov !== 'object') continue
    if (!ov.visible) continue
    if (!ov.url) continue

    const dds = isDDS(ov.url)
    // Start with placeholder; replace when the real texture is loaded
    const placeholder = createPlaceholderTexture(2)

    const mat = new THREE.MeshBasicMaterial({
      map: placeholder as any,
      transparent: !dds, // DDS overlays often have no alpha; disable transparency
      opacity: Math.max(0, Math.min(1, ov.opacity ?? 1)),
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
      // For more realistic blending with base texture, try:
      // blending: THREE.MultiplyBlending,
    })

    // Kick off async load and swap in when ready
    loadAnyTexture(
      ov.url,
      (loaded) => {
        ;(loaded as any).colorSpace = dds ? THREE.NoColorSpace : THREE.SRGBColorSpace
        ;(loaded as any).wrapS = THREE.ClampToEdgeWrapping
        ;(loaded as any).wrapT = THREE.ClampToEdgeWrapping
        ;(loaded as any).flipY = true // match terrain orientation (same as metal/terrain)
        mat.map = loaded as any
        mat.needsUpdate = true
        try { placeholder.dispose() } catch {}
      },
      (err: unknown) => {
        console.warn('Failed to load overlay texture:', ov.name, err)
      },
      ov.isDDS === true,
      /\.tga$/i.test(String((ov as any)?.name ?? (ov as any)?.url ?? ''))
    )

    const mesh = new THREE.Mesh(geom, mat)
    mesh.renderOrder = order++
    scene.add(mesh)
    imgLayers.push({ mesh, mat, tex: placeholder as any, name: ov.name })
  }
}

function buildMesh() {
  if (!scene) return
  // Defensive: if geometry inputs are invalid, clear terrain/overlays and exit
  const gw = (props as any).gridW
  const gl = (props as any).gridL
  const hh = (props as any).heights as Float32Array | null | undefined
  if (!hh || !Number.isFinite(gw) || !Number.isFinite(gl) || gw < 2 || gl < 2) {
    disposeMetal()
    disposeImgLayers()
    if (mesh) {
      try { mesh.geometry.dispose() } catch {}
      try { (mesh.material as THREE.Material).dispose() } catch {}
      try { scene.remove(mesh) } catch {}
      mesh = null
    }
    if (grid) {
      try { scene.remove(grid) } catch {}
      grid = null
    }
    return
  }
  // Dispose previous
  if (mesh) {
    // Note: overlays share geometry; dispose them first to avoid double-dispose issues.
    disposeMetal()
    disposeImgLayers()

    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
    scene.remove(mesh)
    mesh = null
  }
  if (grid) {
    scene.remove(grid)
    grid = null
  }

  const { widthWorld, lengthWorld, gridW, gridL, heights } = props
  const segX = Math.max(1, gridW - 1)
  const segZ = Math.max(1, gridL - 1)

  // Plane is initially in XY, rotate to XZ so Y is up
  const geom = new THREE.PlaneGeometry(widthWorld, lengthWorld, segX, segZ)
  geom.rotateX(-Math.PI / 2)

  // Fill Y from heights
  const pos = geom.getAttribute('position') as THREE.BufferAttribute
  const vertexCount = (segX + 1) * (segZ + 1)
  if (vertexCount !== heights.length) {
    console.warn(
      `ThreeViewport: vertexCount ${vertexCount} != heights.length ${heights.length} (gridW=${gridW}, gridL=${gridL})`
    )
  }
  for (let z = 0; z < gridL; z++) {
    for (let x = 0; x < gridW; x++) {
      const idx = z * gridW + x
      const v = z * (segX + 1) + x
      pos.setY(v, heights[idx] ?? 0)
    }
  }
  pos.needsUpdate = true
  geom.computeVertexNormals()

  const mat = new THREE.MeshStandardMaterial({
    color: 0x8899aa,
    metalness: 0.0,
    roughness: 1.0,
    side: THREE.DoubleSide,
    flatShading: false,
    wireframe: !!props.wireframe,
  })

  // Apply base color texture if provided
  applyBaseTexture(mat)

  mesh = new THREE.Mesh(geom, mat)
  scene.add(mesh)

  // Metal overlay sharing this geometry
  buildMetalOverlay(geom)

  // Image overlays sharing this geometry
  buildImageOverlays(geom)

  // Grid helper for orientation
  const size = Math.max(widthWorld, lengthWorld)
  grid = new THREE.GridHelper(size, 20, 0x222222, 0x444444)
  grid.visible = props.showGrid ?? true
  scene.add(grid)
}

function init() {
  if (!container.value) return
  const w = container.value.clientWidth || 800
  const h = container.value.clientHeight || 600

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0e0e10)

  camera = new THREE.PerspectiveCamera(60, w / h, 0.1, 100000)
  camera.position.set(props.widthWorld * 0.4, Math.max(props.widthWorld, props.lengthWorld) * 0.6, props.lengthWorld * 0.6)

  renderer = new THREE.WebGLRenderer({ antialias: true })
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(w, h)
  container.value.appendChild(renderer.domElement)

  // Editing listeners
  renderer.domElement.addEventListener('pointerdown', onPointerDown, { passive: false })
  renderer.domElement.addEventListener('pointermove', onPointerMove, { passive: false })
  renderer.domElement.addEventListener('pointerup', onPointerUp, { passive: false })
  renderer.domElement.addEventListener('pointerleave', onPointerUp, { passive: false })


  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  controls.target.set(props.widthWorld * 0.5 - props.widthWorld * 0.5, 0, props.lengthWorld * 0.5 - props.lengthWorld * 0.5)

  // Lights
  ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
  scene.add(ambientLight)
  dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
  dirLight.position.set(1, 1, 1).multiplyScalar(1000)
  scene.add(dirLight)

  // Apply environment if provided
  applyEnvSettings()

  // Initial preview visibility
  createBrushPreviewIfNeeded()
  setBrushPreviewVisible(!!props.editEnabled && !!props.editPreview)

  buildMesh()

  const onResize = () => {
    if (!renderer || !camera || !container.value) return
    const w = container.value.clientWidth || 800
    const h = container.value.clientHeight || 600
    camera.aspect = w / h
    camera.updateProjectionMatrix()
    renderer.setSize(w, h)
  }
  window.addEventListener('resize', onResize)

  const animate = () => {
    animationId = requestAnimationFrame(animate)
    if (controls) controls.update()
    renderer?.render(scene!, camera!)

    // Emit FPS roughly once per second
    framesSince++
    const now = performance.now()
    if (now - lastFpsTs >= 1000) {
      const fps = Math.round((framesSince * 1000) / (now - lastFpsTs))
      emit('fps', fps)
      framesSince = 0
      lastFpsTs = now
    }
  }
  animate()
}

onMounted(() => {
  init()
  document.addEventListener('fullscreenchange', onFullscreenChange)
  onFullscreenChange()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  window.removeEventListener('resize', () => {})
  document.removeEventListener('fullscreenchange', onFullscreenChange)
  try { renderer?.domElement?.removeEventListener('pointerdown', onPointerDown) } catch {}
  try { renderer?.domElement?.removeEventListener('pointermove', onPointerMove) } catch {}
  try { renderer?.domElement?.removeEventListener('pointerup', onPointerUp) } catch {}
  try { renderer?.domElement?.removeEventListener('pointerleave', onPointerUp) } catch {}

  // Dispose brush preview
  if (scene && brushCircle) { scene.remove(brushCircle); (brushCircle.geometry as any)?.dispose?.(); (brushCircle.material as any)?.dispose?.(); brushCircle = null }
  if (scene && hitDot) { scene.remove(hitDot); (hitDot.geometry as any)?.dispose?.(); (hitDot.material as any)?.dispose?.(); hitDot = null }
  if (scene && brushSphere) { scene.remove(brushSphere); (brushSphere.geometry as any)?.dispose?.(); (brushSphere.material as any)?.dispose?.(); brushSphere = null; brushSphereMat = null }
  if (scene && brushInnerSphere) { scene.remove(brushInnerSphere); (brushInnerSphere.geometry as any)?.dispose?.(); (brushInnerSphere.material as any)?.dispose?.(); brushInnerSphere = null; brushInnerSphereMat = null }
  if (controls) {
    controls.dispose()
    controls = null
  }
  disposeMetal()
  disposeImgLayers()
  disposeBaseTex()

  // Remove lights
  if (scene && ambientLight) {
    scene.remove(ambientLight)
    ambientLight = null
  }
  if (scene && dirLight) {
    scene.remove(dirLight)
    dirLight = null
  }

  if (renderer) {
    renderer.dispose()
    renderer.forceContextLoss()
    renderer.domElement.remove()
    renderer = null
  }
  if (mesh) {
    mesh.geometry.dispose()
    ;(mesh.material as THREE.Material).dispose()
    mesh = null
  }
  scene = null
  camera = null
})

/* Rebuild on dimension changes; fast-update on heights to avoid full geometry rebuild per stroke */
watch(
  () => [props.gridW, props.gridL, props.widthWorld, props.lengthWorld, props.heights],
  () => {
    if (!mesh) { buildMesh(); return }
    const geom = (mesh.geometry as THREE.BufferGeometry)
    const pos = geom.getAttribute('position') as THREE.BufferAttribute
    const segX = Math.max(1, props.gridW - 1)
    const segZ = Math.max(1, props.gridL - 1)
    const expectedVerts = (segX + 1) * (segZ + 1)
    if (!props.heights || props.heights.length !== expectedVerts) {
      buildMesh()
      return
    }
    // Fast path: update Y only (partial update when painting)
    if (isPainting && dirtyMinX >= 0 && dirtyMinZ >= 0) {
      const minZ = Math.max(0, dirtyMinZ)
      const maxZ = Math.min(props.gridL - 1, dirtyMaxZ)
      const minX = Math.max(0, dirtyMinX)
      const maxX = Math.min(props.gridW - 1, dirtyMaxX)
      for (let z = minZ; z <= maxZ; z++) {
        for (let x = minX; x <= maxX; x++) {
          const idx = z * props.gridW + x
          const v = z * (segX + 1) + x
          pos.setY(v, props.heights[idx] ?? 0)
        }
      }
    } else {
      for (let z = 0; z < props.gridL; z++) {
        for (let x = 0; x < props.gridW; x++) {
          const idx = z * props.gridW + x
          const v = z * (segX + 1) + x
          pos.setY(v, props.heights[idx] ?? 0)
        }
      }
    }
    pos.needsUpdate = true
    if (isPainting) {
      // Defer normals until after painting ends to avoid spikes
      needsNormals = true
    } else {
      // Throttle normal recompute slightly to reduce spikes
      if (normalsTimer) {
        // already scheduled
      } else {
        normalsTimer = window.setTimeout(() => {
          try { geom.computeVertexNormals() } catch {}
          normalsTimer = null
        }, 32) as unknown as number
      }
    }
  },
  { deep: false }
)

// Update metal overlay when metal data or visibility changes
watch(
  () => [props.showMetal, props.metalU8, props.metalW, props.metalL],
  () => {
    if (!mesh) return
    buildMetalOverlay(mesh.geometry)
  },
  { deep: false }
)

// Update image overlays when overlays array changes
watch(
  () => props.overlays,
  () => {
    if (!mesh) return
    buildImageOverlays(mesh.geometry)
  },
  { deep: true }
)

// Update base map when URL changes
watch(
  () => props.baseColorUrl,
  () => {
    if (!mesh) return
    const mat = mesh.material as THREE.MeshStandardMaterial
    applyBaseTexture(mat)
  }
)

// Update wireframe toggle
watch(
  () => props.wireframe,
  () => {
    if (!mesh) return
    const mat = mesh.material as THREE.MeshStandardMaterial
    mat.wireframe = !!props.wireframe
    mat.needsUpdate = true
  }
)

 // Update grid visibility
watch(
  () => props.showGrid,
  () => {
    if (grid) grid.visible = props.showGrid ?? true
  }
)

 // Update environment when mapinfo-derived settings change
watch(
  () => props.env,
  () => {
    applyEnvSettings()
  },
  { deep: true }
)

 // Preview visibility toggles
watch(
  () => [props.editEnabled, props.editPreview],
  () => {
    createBrushPreviewIfNeeded()
    setBrushPreviewVisible(!!props.editEnabled && !!props.editPreview)
  }
)

// Sync preview position from bus
watch(
  () => props.previewPos,
  () => {
    const p = props.previewPos as any
    if (p && typeof p.x === 'number' && typeof p.y === 'number' && typeof p.z === 'number') {
      updateBrushPreview(p.x, p.y, p.z)
    }
  }
)

// Preview radius update
watch(
  () => props.editRadius,
  () => {
    const r = Number(props.editRadius ?? 64)
    if (brushCircle) brushCircle.scale.set(r, r, 1)
    if (brushRing) brushRing.scale.set(r, r, r)
    if (brushSphere) brushSphere.scale.set(r, r, r)
    if (brushInnerSphere) {
      const strength = Number(props.editStrength ?? 0)
      const sNorm = Math.max(0, Math.min(1, strength / 5))
      const innerR = Math.max(0.05, r * sNorm)
      brushInnerSphere.scale.set(innerR, innerR, innerR)
    }
  }
)

watch(
  () => props.editStrength,
  () => {
    const r = Number(props.editRadius ?? 64)
    const strength = Number(props.editStrength ?? 0)
    const sNorm = Math.max(0, Math.min(1, strength / 5))
    if (brushSphereMat) {
      const color = new THREE.Color()
      color.setHSL(0.6 * (1 - sNorm), 1, 0.5)
      brushSphereMat.opacity = 0.15 + 0.15 * sNorm
      brushSphereMat.color.copy(color)
    }
    if (brushInnerSphere) {
      const innerR = Math.max(0.05, r * sNorm)
      brushInnerSphere.scale.set(innerR, innerR, innerR)
      if (brushInnerSphereMat) {
        const color = new THREE.Color()
        color.setHSL(0.0 + 0.6 * sNorm, 1, 0.5)
        brushInnerSphereMat.opacity = 0.15 + 0.15 * sNorm
        brushInnerSphereMat.color.copy(color)
      }
    }
    if (lastHitPos && brushInnerSphere) {
      brushInnerSphere.visible = !!props.editEnabled && !!props.editPreview && sNorm > 0
    }
  }
)

// Expose a method to request fullscreen for this viewport
defineExpose({
  requestFullscreen: () => {
    const el = container.value as any
    if (el?.requestFullscreen) el.requestFullscreen()
  },
})
</script>

<template>
  <div class="viewport" :style="viewportStyle" ref="container"></div>
</template>

<style scoped>
.viewport {
  width: 100%;
  /* Height is set via inline style based on fullscreen state */
  min-height: 400px;
  outline: 1px solid #222;
  box-sizing: border-box;
}
</style>
