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

  // Type map overlay (optional)
  showType?: boolean
  typeU8?: Uint8Array
  typeW?: number
  typeL?: number

  // Grass overlay (optional)
  showGrass?: boolean
  grassU8?: Uint8Array
  grassW?: number
  grassL?: number

  // Tiles overlay (optional)
  showTiles?: boolean
  tileIndex?: Int32Array
  tileIndexW?: number
  tileIndexL?: number
 
  // Features (optional)
  showFeatures?: boolean
  featureTypes?: string[]
  features?: { type: number; x: number; y: number; z: number; rotation: number; relativeSize: number }[]

  // Texturing + display toggles
  baseColorUrl?: string | null
  baseColorIsDDS?: boolean
  baseColorIsTGA?: boolean
  wireframe?: boolean
  showGrid?: boolean

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
  screenRotationQuarter?: number
  atlasMode?: boolean
  atlasImages?: { name: string; url: string; isDDS?: boolean }[]

  // Editing
  editEnabled?: boolean
  editMode?: string
  editRadius?: number
  editStrength?: number
  editPreview?: boolean
  previewPos?: { x: number; y: number; z: number }
  editParams?: Record<string, any>
  profilerMode?: boolean
}

const props = defineProps<Props>()
const emit = defineEmits<{ (e: 'fps', fps: number): void; (e: 'editHeights', h: Float32Array): void; (e: 'editCursor', pos: { x: number; y: number; z: number }): void }>()

const container = ref<HTMLDivElement | null>(null)
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.OrthographicCamera | null = null
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
let brushSphere: THREE.Mesh | null = null
let brushInnerSphere: THREE.Mesh | null = null
let brushSphereMat: THREE.MeshBasicMaterial | null = null
let brushInnerSphereMat: THREE.MeshBasicMaterial | null = null
let brushIntersect: THREE.Line | null = null
let brushIntersectMat: THREE.LineBasicMaterial | null = null
let lastHitY = 0
// Intersection curve scheduling (avoid recomputing on every mousemove)
let lastHitPos: { x: number; y: number; z: number } | null = null
let lastCurveTs = 0
let curveScheduled = false
let lastCurveState: { x: number; y: number; z: number; r: number } | null = null

// Profiler metrics (lightweight, toggled by props.profilerMode)
const profilerModeComputed = computed(() => !!props.profilerMode)
const profFrameMs = ref(0)
const profFps = ref(0)
const profControlsMs = ref(0)
const profRenderMs = ref(0)
const profGeomUpdateMs = ref(0)
const profNormalsMs = ref(0)
const profBrushMs = ref(0)
const profRaycastMs = ref(0)
let lastAnimTs = performance.now()
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
  // Intersection-only mode: initialize curve and skip other helpers
  {
    const seg = 128
    if (!brushIntersect) {
      const g = new THREE.BufferGeometry()
      const pos = new Float32Array((seg + 1) * 3)
      g.setAttribute('position', new THREE.BufferAttribute(pos, 3))
      brushIntersectMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: true, depthWrite: false })
      brushIntersect = new THREE.Line(g, brushIntersectMat)
      brushIntersect.renderOrder = 1002
      brushIntersect.visible = false
      scene.add(brushIntersect)
    }
    if (!brushRing) {
      const segRing = 64
      const pts: THREE.Vector3[] = []
      for (let i = 0; i < segRing; i++) {
        const a = (i / segRing) * Math.PI * 2
        pts.push(new THREE.Vector3(Math.cos(a), 0, Math.sin(a)))
      }
      const gRing = new THREE.BufferGeometry().setFromPoints(pts)
      // Oriented via quaternion each update to match local ground tangent plane
      brushRing = new THREE.LineLoop(
        gRing,
        new THREE.LineBasicMaterial({
          color: 0xffffff,
          transparent: true,
          opacity: 0.6,
          depthTest: true,
          depthWrite: false,
          polygonOffset: true,
          polygonOffsetFactor: 1,
          polygonOffsetUnits: 1
        })
      )
      brushRing.renderOrder = 1003
      brushRing.visible = false
      scene.add(brushRing)
    }
    return
  }
  if (!brushCircle) {
    const geo = new THREE.CircleGeometry(1, 64)
    geo.rotateX(-Math.PI / 2)
    const mat = new THREE.MeshBasicMaterial({
      color: 0x33aaff,
      transparent: true,
      opacity: 0.3,
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
      new THREE.LineBasicMaterial({ color: 0xff3333, depthTest: false, depthWrite: false, transparent: true, opacity: 0.3 })
    )
    brushRing.renderOrder = 11
    brushRing.visible = false
    scene.add(brushRing)
  }
  // 3D wireframe spheres (match perspective view)
  if (!brushSphere) {
    const sGeo = new THREE.SphereGeometry(1, 16, 12)
    brushSphereMat = new THREE.MeshBasicMaterial({
      color: 0x33aaff,
      wireframe: true,
      transparent: true,
      opacity: 0.3,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
      depthTest: true,
    })
    brushSphere = new THREE.Mesh(sGeo, brushSphereMat)
    brushSphere.renderOrder = 1000
    brushSphere.visible = false
    scene.add(brushSphere)
    try {
      ;(window as any).barEditor = (window as any).barEditor || {}
      const dbgPrev = (window as any).barEditor.brushPreview || {}
      ;(window as any).barEditor.brushPreview = { ...dbgPrev, ortho: { ...(dbgPrev.ortho || {}), sphereMat: brushSphereMat } }
      ;(window as any).barEditor.brushPreview.setOpacity = (o: number) => {
        try {
          const b = (window as any).barEditor.brushPreview
          for (const m of [b?.three?.sphereMat, b?.three?.innerMat, b?.ortho?.sphereMat, b?.ortho?.innerMat]) {
            if (m) { m.transparent = true; m.opacity = o; m.needsUpdate = true }
          }
        } catch {}
      }
    } catch {}
  }
  if (!brushInnerSphere) {
    const sGeo2 = new THREE.SphereGeometry(1, 12, 8)
    brushInnerSphereMat = new THREE.MeshBasicMaterial({
      color: 0xff5555,
      wireframe: true,
      transparent: true,
      opacity: 0.3,
      blending: THREE.CustomBlending,
      blendSrc: THREE.SrcAlphaFactor,
      blendDst: THREE.OneMinusSrcAlphaFactor,
      blendEquation: THREE.AddEquation,
      depthWrite: false,
      depthTest: true,
    })
    brushInnerSphere = new THREE.Mesh(sGeo2, brushInnerSphereMat)
    brushInnerSphere.renderOrder = 1001
    brushInnerSphere.visible = false
    scene.add(brushInnerSphere)
    try {
      ;(window as any).barEditor = (window as any).barEditor || {}
      const prev = (window as any).barEditor.brushPreview || {}
      ;(window as any).barEditor.brushPreview = { ...prev, ortho: { ...(prev.ortho || {}), innerMat: brushInnerSphereMat } }
      ;(window as any).barEditor.brushPreview.setOpacity = (o: number) => {
        try {
          const b = (window as any).barEditor.brushPreview
          for (const m of [b?.three?.sphereMat, b?.three?.innerMat, b?.ortho?.sphereMat, b?.ortho?.innerMat]) {
            if (m) { m.transparent = true; m.opacity = o; m.needsUpdate = true }
          }
        } catch {}
      }
    } catch {}
  }
}

function setBrushPreviewVisible(v: boolean) {
  // Show only the intersection curve; hide legacy and full spheres
  if (brushCircle) brushCircle.visible = false
  if (hitDot) hitDot.visible = false
  if (brushRing) brushRing.visible = v
  if (brushSphere) brushSphere.visible = false
  if (brushInnerSphere) brushInnerSphere.visible = false
  if (brushIntersect) brushIntersect.visible = v
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
  // Intersection-only preview: create/update curve and return
  if (!brushIntersect && scene) {
    const seg = 128
    const g = new THREE.BufferGeometry()
    const arr = new Float32Array((seg + 1) * 3)
    g.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    brushIntersectMat = new THREE.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: true, depthWrite: false })
    brushIntersect = new THREE.Line(g, brushIntersectMat)
    brushIntersect.renderOrder = 1002
    brushIntersect.visible = false
    scene.add(brushIntersect)
  }
  if (brushSphere) brushSphere.visible = false
  if (brushInnerSphere) brushInnerSphere.visible = false
  if (brushRing) {
    // Orient ring to local ground tangent plane using sampled normal
    const eps = Math.max(0.5, r * 0.02)
    const hL = sampleHeightAt(x - eps, z)
    const hR = sampleHeightAt(x + eps, z)
    const hD = sampleHeightAt(x, z - eps)
    const hU = sampleHeightAt(x, z + eps)
    const dhdx = (hR - hL) / (2 * eps)
    const dhdz = (hU - hD) / (2 * eps)
    const n = new THREE.Vector3(-dhdx, 1, -dhdz).normalize() // heightfield normal
    // Base ring geometry lies in XZ (normal +Y). Rotate +Y -> n.
    const q = new THREE.Quaternion().setFromUnitVectors(new THREE.Vector3(0, 1, 0), n)
    brushRing.quaternion.copy(q)
    // Place ring at the hit point and lift slightly along normal to avoid z-fighting
    brushRing.position.set(x, y, z)
    brushRing.position.addScaledVector(n, 0.001)
    brushRing.scale.set(r, r, r)
    brushRing.visible = !!props.editEnabled && !!props.editPreview
  }
  scheduleUpdateIntersect(x, y, z, r)
  if (brushIntersect) brushIntersect.visible = !!props.editEnabled && !!props.editPreview
  lastHitPos = { x, y, z }
  return
  // Wireframe spheres for full 3D footprint visualization (disabled; using intersection curve)
  if (brushSphere) {
    brushSphere.position.set(x, y, z)
    brushSphere.scale.set(r, r, r)
    brushSphere.visible = !!props.editEnabled && !!props.editPreview
    if (brushSphereMat) {
      const strength = Number(props.editStrength ?? 0)
      const sNorm = Math.max(0, Math.min(1, strength / 5))
      const color = new THREE.Color()
      color.setHSL(0.6 * (1 - sNorm), 1, 0.5)
      brushSphereMat.color.copy(color)
      brushSphereMat.opacity = 0.3
      brushSphereMat.transparent = true
      brushSphereMat.needsUpdate = true
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
      brushInnerSphereMat.opacity = 0.3
      brushInnerSphereMat.transparent = true
      brushInnerSphereMat.needsUpdate = true
    }
  }
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
  const t0 = performance.now()
  const hits = raycaster.intersectObject(mesh, false)
  profRaycastMs.value = performance.now() - t0
  if (!hits.length) return null
  const p = hits[0].point
  return { x: p.x, y: p.y, z: p.z }
}

// Bilinear sample of heightmap at world x,z
function sampleHeightAt(xw: number, zw: number): number {
  const gw = Math.max(2, (props as any).gridW as number)
  const gl = Math.max(2, (props as any).gridL as number)
  const W = (props as any).widthWorld as number
  const L = (props as any).lengthWorld as number
  const H = (props as any).heights as Float32Array
  if (!H || gw < 2 || gl < 2) return 0
  const halfW = W * 0.5
  const halfL = L * 0.5
  const u = ((xw + halfW) / Math.max(1e-6, W)) * (gw - 1)
  const v = ((zw + halfL) / Math.max(1e-6, L)) * (gl - 1)
  const x0 = Math.floor(u), z0 = Math.floor(v)
  const x1 = Math.min(gw - 1, x0 + 1), z1 = Math.min(gl - 1, z0 + 1)
  const tx = Math.max(0, Math.min(1, u - x0))
  const tz = Math.max(0, Math.min(1, v - z0))
  const i00 = z0 * gw + x0
  const i10 = z0 * gw + x1
  const i01 = z1 * gw + x0
  const i11 = z1 * gw + x1
  const h00 = H[i00] ?? 0
  const h10 = H[i10] ?? 0
  const h01 = H[i01] ?? 0
  const h11 = H[i11] ?? 0
  const hx0 = h00 * (1 - tx) + h10 * tx
  const hx1 = h01 * (1 - tx) + h11 * tx
  return hx0 * (1 - tz) + hx1 * tz
}

// Build/update intersection curve between sphere and terrain
function updateIntersectLine(cx: number, cy: number, cz: number, r: number) {
  if (!brushIntersect) return
  const geo = brushIntersect.geometry as THREE.BufferGeometry
  const seg = 48
  let pos = geo.getAttribute('position') as THREE.BufferAttribute | null
  if (!pos || pos.count !== (seg + 1)) {
    const arr = new Float32Array((seg + 1) * 3)
    geo.setAttribute('position', new THREE.BufferAttribute(arr, 3))
    pos = geo.getAttribute('position') as THREE.BufferAttribute
  }
  const arr = (pos!.array as Float32Array)
  for (let i = 0; i <= seg; i++) {
    const theta = (i / seg) * Math.PI * 2
    const ux = Math.cos(theta), uz = Math.sin(theta)
    // Search along ray for best match between terrain height and sphere surface
    let bestT = 0
    let bestErr = Infinity
    const steps = 8
    for (let s = 0; s <= steps; s++) {
      const t = (s / steps) * r
      const x = cx + ux * t
      const z = cz + uz * t
      const h = sampleHeightAt(x, z)
      const inside = r * r - t * t
      if (inside < 0) continue
      const yPlus = cy + Math.sqrt(inside)
      const yMinus = cy - Math.sqrt(inside)
      const errPlus = Math.abs(h - yPlus)
      const errMinus = Math.abs(h - yMinus)
      const err = Math.min(errPlus, errMinus)
      if (err < bestErr) {
        bestErr = err
        bestT = t
      }
    }
    const x = cx + ux * bestT
    const z = cz + uz * bestT
    const y = sampleHeightAt(x, z) + 0.02 // slight lift to avoid z-fighting
    arr[i * 3 + 0] = x
    arr[i * 3 + 1] = y
    arr[i * 3 + 2] = z
  }
  pos!.needsUpdate = true
  if (brushIntersectMat) { brushIntersectMat.opacity = 0.9; brushIntersectMat.needsUpdate = true }
}

// Throttled update: recompute curve at most ~30fps and only on meaningful changes
function scheduleUpdateIntersect(cx: number, cy: number, cz: number, r: number) {
  lastCurveState = { x: cx, y: cy, z: cz, r }
  if (curveScheduled) return
  curveScheduled = true
  requestAnimationFrame(() => {
    curveScheduled = false
    const now = performance.now()
    // 30 fps cap for curve recompute
    if (now - lastCurveTs < 33) return
    const prev = lastCurveState
    if (!prev) return
    // Skip if movement/radius change is tiny
    const moveThresh = Math.max(0.5, r * 0.01)
    if (lastHitPos) {
      const dx = prev.x - lastHitPos.x
      const dz = prev.z - lastHitPos.z
      const dr = Math.abs(prev.r - (Number(props.editRadius ?? 64)))
      if (dx * dx + dz * dz < moveThresh * moveThresh && dr < 1) {
        lastCurveTs = now
        return
      }
    }
    updateIntersectLine(prev.x, prev.y, prev.z, prev.r)
    lastCurveTs = now
  })
}

function applyBrushAt(x: number, z: number) {
  if (!props.heights) return
  const mode = String(props.editMode ?? 'add')
  const radius = Number(props.editRadius ?? 64)
  const strength = Number(props.editStrength ?? 2)
  const tBrush0 = performance.now()
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
    params: (props as any).editParams,
    mode
  })
  profBrushMs.value = performance.now() - tBrush0
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
  if (controls) (controls as any).enabled = false
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
  if (controls) (controls as any).enabled = true
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

// Type map overlay resources
let typeMesh: THREE.Mesh | null = null
let typeMat: THREE.MeshBasicMaterial | null = null
let typeTex: THREE.DataTexture | null = null

 // Grass overlay resources
let grassMesh: THREE.Mesh | null = null
let grassMat: THREE.MeshBasicMaterial | null = null
let grassTex: THREE.DataTexture | null = null

// Tile overlay resources
let tileMesh: THREE.Mesh | null = null
let tileMat: THREE.MeshBasicMaterial | null = null
let tileTex: THREE.DataTexture | null = null
 
// Features
let featuresGroup: THREE.Group | null = null

// Image overlay resources (from folder)
type ImgLayer = { mesh: THREE.Mesh, mat: THREE.MeshBasicMaterial, tex: THREE.Texture, name: string }
let imgLayers: ImgLayer[] = []

// Base color texture
let baseTex: THREE.Texture | THREE.CompressedTexture | null = null

// Atlas (textures grid) resources
type AtlasItem = {
  mesh: THREE.Mesh
  mat: THREE.MeshBasicMaterial
  tex: THREE.Texture | THREE.CompressedTexture
  label?: THREE.Sprite
}
let atlasItems: AtlasItem[] = []

function disposeAtlas() {
  if (!scene) return
  for (const it of atlasItems) {
    try { scene!.remove(it.mesh) } catch {}
    try { it.mat.dispose() } catch {}
    try { (it.tex as any)?.dispose?.() } catch {}
    if (it.label) {
      try { scene!.remove(it.label) } catch {}
      try { ((it.label.material as any)?.map)?.dispose?.() } catch {}
      try { (it.label.material as any)?.dispose?.() } catch {}
    }
  }
  atlasItems = []
}

function makeLabelSprite(text: string, scale: number): THREE.Sprite {
  const canvas = document.createElement('canvas')
  canvas.width = 512
  canvas.height = 128
  const ctx = canvas.getContext('2d')!
  ctx.fillStyle = 'rgba(0,0,0,0.6)'
  ctx.fillRect(0, 0, canvas.width, canvas.height)
  ctx.font = 'bold 48px sans-serif'
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText(text, canvas.width / 2, canvas.height / 2)
  const tex = new THREE.CanvasTexture(canvas)
  tex.colorSpace = THREE.SRGBColorSpace
  const mat = new THREE.SpriteMaterial({ map: tex, transparent: true, depthWrite: false })
  const sprite = new THREE.Sprite(mat)
  // scale in world units (X/Z are world-plane dimensions)
  sprite.scale.set(scale, scale * (canvas.height / canvas.width), 1)
  return sprite
}

function buildAtlasScene() {
  if (!scene) return
  disposeAtlas()
  const imgs = Array.isArray(props.atlasImages) ? props.atlasImages! : []
  if (!imgs.length) return

  const n = imgs.length
  const cols = Math.max(1, Math.ceil(Math.sqrt(n)))
  const rows = Math.max(1, Math.ceil(n / cols))
  const tileW = Math.max(1e-3, props.widthWorld / cols)
  const tileL = Math.max(1e-3, props.lengthWorld / rows)

  const cx = props.widthWorld * 0.5
  const cz = props.lengthWorld * 0.5
  const originX = cx - props.widthWorld * 0.5
  const originZ = cz - props.lengthWorld * 0.5

  for (let i = 0; i < n; i++) {
    const img = imgs[i]
    if (!img || typeof (img as any).url !== 'string' || !(img as any).url) continue
    const col = i % cols
    const row = Math.floor(i / cols)
    const centerX = originX + (col + 0.5) * tileW
    const centerZ = originZ + (row + 0.5) * tileL

    const geom = new THREE.PlaneGeometry(tileW * 0.95, tileL * 0.95, 1, 1)
    geom.rotateX(-Math.PI / 2)

    const placeholder = createPlaceholderTexture(4)
    const mat = new THREE.MeshBasicMaterial({
      map: placeholder as any,
      transparent: true,
      depthWrite: false,
      side: THREE.DoubleSide,
    })

    loadAnyTexture(
      img.url,
      (loaded) => {
        ;(loaded as any).colorSpace = /\.dds$/i.test(img.name) ? THREE.NoColorSpace : THREE.SRGBColorSpace
        ;(loaded as any).wrapS = THREE.ClampToEdgeWrapping
        ;(loaded as any).wrapT = THREE.ClampToEdgeWrapping
        ;(loaded as any).flipY = true
        mat.map = loaded as any
        mat.needsUpdate = true
        try { placeholder.dispose() } catch {}
      },
      (err: unknown) => {
        console.warn('Atlas texture load error:', img.name, err)
      },
      /\.dds$/i.test(img.name),
      /\.tga$/i.test(img.name)
    )

    const mesh = new THREE.Mesh(geom, mat)
    mesh.position.set(centerX, 0.02, centerZ)
    scene.add(mesh)

    const labelText = (() => {
      try {
        const nm = String((img as any).name ?? '')
        if (nm) return nm.split(/[\\/]/).pop() || nm
        const u = String((img as any).url ?? '')
        return u ? (u.split(/[\\/]/).pop() || u) : 'image'
      } catch {
        return 'image'
      }
    })()
    const label = makeLabelSprite(labelText, Math.min(tileW, tileL) * 0.25)
    label.position.set(centerX, 0.05, centerZ - tileL * 0.4)
    scene.add(label)

    atlasItems.push({ mesh, mat, tex: placeholder as any, label })
  }
}

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

function disposeType() {
  if (typeMesh && scene) {
    scene.remove(typeMesh)
    typeMesh = null
  }
  if (typeMat) { typeMat.dispose(); typeMat = null }
  if (typeTex) { typeTex.dispose(); typeTex = null }
}
function disposeGrass() {
  if (grassMesh && scene) {
    scene.remove(grassMesh)
    grassMesh = null
  }
  if (grassMat) { grassMat.dispose(); grassMat = null }
  if (grassTex) { grassTex.dispose(); grassTex = null }
}
function disposeTile() {
  if (tileMesh && scene) {
    scene.remove(tileMesh)
    tileMesh = null
  }
  if (tileMat) { tileMat.dispose(); tileMat = null }
  if (tileTex) { tileTex.dispose(); tileTex = null }
}
function disposeFeatures() {
  if (featuresGroup && scene) {
    try { scene.remove(featuresGroup) } catch {}
    try {
      for (const c of featuresGroup.children) {
        const m = c as THREE.Mesh
        try { (m.geometry as any)?.dispose?.() } catch {}
        try { ((m.material as any) as THREE.Material)?.dispose?.() } catch {}
      }
    } catch {}
    featuresGroup = null
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
  // Defensive: guard against falsy/invalid URL
  if (!url || typeof url !== 'string') {
    const placeholder = createPlaceholderTexture()
    try { onLoad(placeholder) } catch {}
    return placeholder
  }
  if (isDDSHint === true || isDDS(url)) {
    if (!ddsSupported()) {
      console.warn('DDS not supported by GPU/browser; using placeholder for:', url)
      const placeholder = createPlaceholderTexture()
      try { onLoad(placeholder) } catch {}
      return placeholder
    }
    return new DDSLoader().load(
      url,
      (tex: THREE.CompressedTexture) => {
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
      (tex: THREE.Texture) => onLoad(tex),
      undefined,
      (err: unknown) => {
        console.error('TGA load error:', url, err)
        onError(err)
      }
    )
  }
  return new THREE.TextureLoader().load(
    url,
    (tex: THREE.Texture) => onLoad(tex),
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
  const placeholder = createPlaceholderTexture(2)
  baseTex = placeholder
  mat.map = placeholder
  mat.needsUpdate = true

  loadAnyTexture(
    props.baseColorUrl as string,
    (tex) => {
      if (isDDS(props.baseColorUrl)) {
        ;(tex as any).colorSpace = THREE.NoColorSpace
      } else {
        ;(tex as any).colorSpace = THREE.SRGBColorSpace
      }
      ;(tex as any).wrapS = (tex as any).wrapT = THREE.RepeatWrapping
      ;(tex as any).flipY = true
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
    console.warn('OrthoViewport: metalU8 size does not match expected resolution', {
      have: metalU8.length,
      expected: pxCount,
    })
    return
  }

  const data = new Uint8Array(pxCount * 4)
  for (let i = 0; i < pxCount; i++) {
    const a = metalU8[i] ?? 0
    const j = i * 4
    data[j + 0] = 0   // R (blue overlay to distinguish)
    data[j + 1] = 0   // G
    data[j + 2] = 255 // B
    data[j + 3] = a
  }

  metalTex = new THREE.DataTexture(data, mw, ml, THREE.RGBAFormat, THREE.UnsignedByteType)
  metalTex.colorSpace = THREE.NoColorSpace
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

function buildTypeOverlay(geom: THREE.BufferGeometry) {
  disposeType()
  if (!scene) return
  if (!props.showType) return
  if (!props.typeU8 || !props.typeW || !props.typeL) return

  const typeU8 = props.typeU8 as Uint8Array
  const tw = props.typeW!
  const tl = props.typeL!
  const pxCount = tw * tl
  if (typeU8.length < pxCount) {
    console.warn('OrthoViewport: typeU8 size does not match expected resolution', {
      have: typeU8.length,
      expected: pxCount,
    })
    return
  }

  function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const i = Math.floor(h * 6)
    const f = h * 6 - i
    const p = v * (1 - s)
    const q = v * (1 - f * s)
    const t = v * (1 - (1 - f) * s)
    let r = 0, g = 0, b = 0
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break
      case 1: r = q; g = v; b = p; break
      case 2: r = p; g = v; b = t; break
      case 3: r = p; g = q; b = v; break
      case 4: r = t; g = p; b = v; break
      case 5: r = v; g = p; b = q; break
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
  }

  const data = new Uint8Array(pxCount * 4)
  for (let i = 0; i < pxCount; i++) {
    const t = typeU8[i] ?? 0
    const [r, g, b] = hsvToRgb(((t * 37) % 256) / 256, 0.85, 1.0)
    const j = i * 4
    data[j + 0] = r
    data[j + 1] = g
    data[j + 2] = b
    data[j + 3] = 140
  }

  typeTex = new THREE.DataTexture(data, tw, tl, THREE.RGBAFormat, THREE.UnsignedByteType)
  typeTex.colorSpace = THREE.NoColorSpace
  typeTex.center.set(0.5, 0.5)
  typeTex.flipY = true
  typeTex.generateMipmaps = false
  typeTex.minFilter = THREE.NearestFilter
  typeTex.magFilter = THREE.NearestFilter
  typeTex.wrapS = THREE.ClampToEdgeWrapping
  typeTex.wrapT = THREE.ClampToEdgeWrapping
  typeTex.needsUpdate = true

  typeMat = new THREE.MeshBasicMaterial({
    map: typeTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  typeMesh = new THREE.Mesh(geom, typeMat)
  typeMesh.renderOrder = 1.2
  scene.add(typeMesh)
}

function buildGrassOverlay(geom: THREE.BufferGeometry) {
  disposeGrass()
  if (!scene) return
  if (!props.showGrass) return
  if (!props.grassU8 || !props.grassW || !props.grassL) return
 
  const grassU8 = props.grassU8 as Uint8Array
  const gw = props.grassW!
  const gl = props.grassL!
  const pxCount = gw * gl
  if (grassU8.length < pxCount) {
    console.warn('OrthoViewport: grassU8 size does not match expected resolution', {
      have: grassU8.length,
      expected: pxCount,
    })
    return
  }
 
  const data = new Uint8Array(pxCount * 4)
  for (let i = 0; i < pxCount; i++) {
    const a = grassU8[i] ?? 0
    const j = i * 4
    data[j + 0] = 0
    data[j + 1] = 255
    data[j + 2] = 0
    data[j + 3] = a
  }
 
  grassTex = new THREE.DataTexture(data, gw, gl, THREE.RGBAFormat, THREE.UnsignedByteType)
  grassTex.colorSpace = THREE.NoColorSpace
  grassTex.center.set(0.5, 0.5)
  grassTex.flipY = true
  grassTex.generateMipmaps = false
  grassTex.minFilter = THREE.NearestFilter
  grassTex.magFilter = THREE.NearestFilter
  grassTex.wrapS = THREE.ClampToEdgeWrapping
  grassTex.wrapT = THREE.ClampToEdgeWrapping
  grassTex.needsUpdate = true
 
  grassMat = new THREE.MeshBasicMaterial({
    map: grassTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })
 
  grassMesh = new THREE.Mesh(geom, grassMat)
  grassMesh.renderOrder = 1.1
  scene.add(grassMesh)
}

function buildTileOverlay(geom: THREE.BufferGeometry) {
  disposeTile()
  if (!scene) return
  if (!props.showTiles) return
  if (!props.tileIndex || !props.tileIndexW || !props.tileIndexL) return

  const ti = props.tileIndex as Int32Array
  const tw = props.tileIndexW!
  const tl = props.tileIndexL!
  const pxCount = tw * tl
  if (ti.length < pxCount) {
    console.warn('OrthoViewport: tileIndex size does not match expected resolution', {
      have: ti.length,
      expected: pxCount,
    })
    return
  }

  function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const i = Math.floor(h * 6)
    const f = h * 6 - i
    const p = v * (1 - s)
    const q = v * (1 - f * s)
    const t = v * (1 - (1 - f) * s)
    let r = 0, g = 0, b = 0
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break
      case 1: r = q; g = v; b = p; break
      case 2: r = p; g = v; b = t; break
      case 3: r = p; g = q; b = v; break
      case 4: r = t; g = p; b = v; break
      case 5: r = v; g = p; b = q; break
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
  }

  const data = new Uint8Array(pxCount * 4)
  for (let i = 0; i < pxCount; i++) {
    const idx = Math.abs(ti[i] ?? 0)
    const hue = ((idx * 97) % 256) / 256
    const [r, g, b] = hsvToRgb(hue, 0.75, 1.0)
    const j = i * 4
    data[j + 0] = r
    data[j + 1] = g
    data[j + 2] = b
    data[j + 3] = 120
  }

  tileTex = new THREE.DataTexture(data, tw, tl, THREE.RGBAFormat, THREE.UnsignedByteType)
  tileTex.colorSpace = THREE.NoColorSpace
  tileTex.center.set(0.5, 0.5)
  tileTex.flipY = true
  tileTex.generateMipmaps = false
  tileTex.minFilter = THREE.NearestFilter
  tileTex.magFilter = THREE.NearestFilter
  tileTex.wrapS = THREE.ClampToEdgeWrapping
  tileTex.wrapT = THREE.ClampToEdgeWrapping
  tileTex.needsUpdate = true

  tileMat = new THREE.MeshBasicMaterial({
    map: tileTex,
    transparent: true,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  tileMesh = new THREE.Mesh(geom, tileMat)
  tileMesh.renderOrder = 1.15
  scene.add(tileMesh)
}

function buildFeatures() {
  disposeFeatures()
  if (!scene) return
  if (!props.showFeatures) return
  const feats = Array.isArray(props.features) ? props.features! : []
  if (!feats.length) return

  featuresGroup = new THREE.Group()
  const maxDim = Math.max(props.widthWorld, props.lengthWorld)
  const baseR = Math.max(0.5, maxDim * 0.005)
  const geo = new THREE.SphereGeometry(baseR, 10, 8)
  const matCache = new Map<number, THREE.MeshBasicMaterial>()

  function hsvToRgb(h: number, s: number, v: number): [number, number, number] {
    const i = Math.floor(h * 6)
    const f = h * 6 - i
    const p = v * (1 - s)
    const q = v * (1 - f * s)
    const t = v * (1 - (1 - f) * s)
    let r = 0, g = 0, b = 0
    switch (i % 6) {
      case 0: r = v; g = t; b = p; break
      case 1: r = q; g = v; b = p; break
      case 2: r = p; g = v; b = t; break
      case 3: r = p; g = q; b = v; break
      case 4: r = t; g = p; b = v; break
      case 5: r = v; g = p; b = q; break
    }
    return [Math.round(r * 255), Math.round(g * 255), Math.round(b * 255)]
  }

  for (const f of feats) {
    const t = Number((f as any).type ?? 0)
    let mat = matCache.get(t)
    if (!mat) {
      const [r, g, b] = hsvToRgb(((t * 53) % 256) / 256, 0.8, 1.0)
      mat = new THREE.MeshBasicMaterial({
        color: new THREE.Color(r / 255, g / 255, b / 255),
        depthWrite: false,
      })
      matCache.set(t, mat)
    }
    const m = new THREE.Mesh(geo, mat)
    const xw = Number((f as any).x ?? 0) - props.widthWorld * 0.5
    const zw = Number((f as any).z ?? 0) - props.lengthWorld * 0.5
    const yw = sampleHeightAt(xw, zw) + baseR * 0.6
    m.position.set(xw, yw, zw)
    featuresGroup.add(m)
  }

  scene.add(featuresGroup)
}

function buildImageOverlays(geom: THREE.BufferGeometry) {
  disposeImgLayers()
  if (!scene || !props.overlays) return

  let order = 2
  for (const ov of props.overlays) {
    if (!ov.visible) continue
    if (!ov.url) continue

    const dds = isDDS(ov.url)
    const placeholder = createPlaceholderTexture(2)

    const mat = new THREE.MeshBasicMaterial({
      map: placeholder as any,
      transparent: !dds,
      opacity: Math.max(0, Math.min(1, ov.opacity ?? 1)),
      depthWrite: false,
      polygonOffset: true,
      polygonOffsetFactor: -1,
      polygonOffsetUnits: -1,
    })

    loadAnyTexture(
      ov.url,
      (loaded) => {
        ;(loaded as any).colorSpace = dds ? THREE.NoColorSpace : THREE.SRGBColorSpace
        ;(loaded as any).wrapS = THREE.ClampToEdgeWrapping
        ;(loaded as any).wrapT = THREE.ClampToEdgeWrapping
        ;(loaded as any).flipY = true
        mat.map = loaded as any
        mat.needsUpdate = true
        try { placeholder.dispose() } catch {}
      },
      (err: unknown) => {
        console.warn('Failed to load overlay texture:', ov?.name ?? ov?.url ?? '(unknown)', err)
      },
      ov.isDDS === true,
      /\.tga$/i.test(String((ov as any)?.name ?? (ov as any)?.url ?? ''))
    )

    const m = new THREE.Mesh(geom, mat)
    m.renderOrder = order++
    scene.add(m)
    imgLayers.push({ mesh: m, mat, tex: placeholder as any, name: ov.name })
  }
}

function buildMesh() {
  if (!scene) return

  // Atlas mode: show all textures as a grid of quads with labels
  if (props.atlasMode) {
    // Dispose terrain-related resources
    if (mesh) {
      disposeMetal()
      disposeImgLayers()
      try { mesh.geometry.dispose() } catch {}
      try { (mesh.material as THREE.Material).dispose() } catch {}
      scene.remove(mesh)
      mesh = null
    }
    if (grid) {
      scene.remove(grid)
      grid = null
    }
    buildAtlasScene()
    return
  }

  // Ensure previous atlas objects are removed when switching back
  disposeAtlas()
  if (mesh) {
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

  // Defensive: if geometry inputs are invalid, clear terrain/overlays and exit (atlas handled earlier)
  if (!heights || !Number.isFinite(gridW) || !Number.isFinite(gridL) || gridW < 2 || gridL < 2) {
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

  const segX = Math.max(1, gridW - 1)
  const segZ = Math.max(1, gridL - 1)

  const geom = new THREE.PlaneGeometry(widthWorld, lengthWorld, segX, segZ)
  geom.rotateX(-Math.PI / 2)

  const pos = geom.getAttribute('position') as THREE.BufferAttribute
  const vertexCount = (segX + 1) * (segZ + 1)
  if (vertexCount !== heights.length) {
    console.warn(
      `OrthoViewport: vertexCount ${vertexCount} != heights.length ${heights.length} (gridW=${gridW}, gridL=${gridL})`
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
    color: 0x99aabb,
    metalness: 0.0,
    roughness: 1.0,
    side: THREE.DoubleSide,
    flatShading: false,
    wireframe: !!props.wireframe,
  })

  applyBaseTexture(mat)

  mesh = new THREE.Mesh(geom, mat)
  scene.add(mesh)

  buildMetalOverlay(geom)
  buildTypeOverlay(geom)
  buildGrassOverlay(geom)
  buildTileOverlay(geom)
  buildImageOverlays(geom)
  buildFeatures()

  const size = Math.max(widthWorld, lengthWorld)
  grid = new THREE.GridHelper(size, 20, 0x222222, 0x444444)
  grid.visible = props.showGrid ?? true
  scene.add(grid)
}

function fitOrthographicFrustum(w: number, h: number) {
  if (!camera) return
  const aspect = Math.max(1e-6, w / h)
  const worldAspect = Math.max(1e-6, props.widthWorld / Math.max(1e-6, props.lengthWorld))

  let halfW: number
  let halfH: number
  if (aspect >= worldAspect) {
    // window wider than world: height limits
    halfH = props.lengthWorld / 2
    halfW = halfH * aspect
  } else {
    // window taller than world: width limits
    halfW = props.widthWorld / 2
    halfH = halfW / aspect
  }
  camera.left = -halfW
  camera.right = halfW
  camera.top = halfH
  camera.bottom = -halfH
  camera.updateProjectionMatrix()
}

function init() {
  if (!container.value) return
  const w = container.value.clientWidth || 800
  const h = container.value.clientHeight || 600

  scene = new THREE.Scene()
  scene.background = new THREE.Color(0x0e0e10)

  camera = new THREE.OrthographicCamera(-w / 2, w / 2, h / 2, -h / 2, 0.1, 100000)
  const cx = props.widthWorld * 0.5
  const cz = props.lengthWorld * 0.5
  camera.position.set(cx, Math.max(props.widthWorld, props.lengthWorld), cz)
  camera.up.set(0, 0, 1)
  camera.lookAt(new THREE.Vector3(cx, 0, cz))
  {
    const qRaw = props.screenRotationQuarter ?? 0
    const q = ((qRaw % 4) + 4) % 4
    const ups = [
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(-1, 0, 0),
    ]
    camera.up.copy(ups[q])
    camera.lookAt(new THREE.Vector3(cx, 0, cz))
  }

  renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true, premultipliedAlpha: false })
  renderer.sortObjects = true
  renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
  renderer.setSize(w, h)
  container.value.appendChild(renderer.domElement)

  // Editing listeners (non-passive so we can preventDefault to stop controls)
  renderer.domElement.addEventListener('pointerdown', onPointerDown, { passive: false })
  renderer.domElement.addEventListener('pointermove', onPointerMove, { passive: false })
  renderer.domElement.addEventListener('pointerup', onPointerUp, { passive: false })
  renderer.domElement.addEventListener('pointerleave', onPointerUp, { passive: false })

  controls = new OrbitControls(camera, renderer.domElement)
  controls.enableDamping = true
  ;(controls as any).enableRotate = false
  ;(controls as any).screenSpacePanning = true
  controls.target.set(cx, 0, cz)
  // friendlier orthographic controls
  ;(controls as any).mouseButtons = {
    LEFT: THREE.MOUSE.PAN,
    MIDDLE: THREE.MOUSE.DOLLY,
    RIGHT: THREE.MOUSE.PAN,
  }
  ;(controls as any).touches = {
    ONE: THREE.TOUCH.PAN,
    TWO: THREE.TOUCH.DOLLY_PAN,
  }

  ambientLight = new THREE.AmbientLight(0xffffff, 0.6)
  scene.add(ambientLight)
  dirLight = new THREE.DirectionalLight(0xffffff, 0.8)
  dirLight.position.set(1, 1, 1).multiplyScalar(1000)
  scene.add(dirLight)

  applyEnvSettings()

  // Initial preview visibility
  createBrushPreviewIfNeeded()
  setBrushPreviewVisible(!!props.editEnabled && !!props.editPreview)

  buildMesh()
  fitOrthographicFrustum(w, h)

  const onResize = () => {
    if (!renderer || !camera || !container.value) return
    const w = container.value.clientWidth || 800
    const h = container.value.clientHeight || 600
    fitOrthographicFrustum(w, h)
    renderer.setSize(w, h)
  }
  window.addEventListener('resize', onResize)

  const animate = () => {
    animationId = requestAnimationFrame(animate)
    const frameStart = performance.now()
    const c0 = frameStart
    if (controls) {
      const cs = performance.now()
      controls.update()
      profControlsMs.value = performance.now() - cs
    }
    const r0 = performance.now()
    renderer?.render(scene!, camera!)
    profRenderMs.value = performance.now() - r0
    const now2 = performance.now()
    profFrameMs.value = now2 - frameStart
    const dt = now2 - lastAnimTs
    if (dt > 0) {
      profFps.value = Math.round(1000 / dt)
    }
    lastAnimTs = now2

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
  if (controls) {
    controls.dispose()
    controls = null
  }
  disposeMetal()
  disposeType()
  disposeGrass()
  disposeImgLayers()
  disposeBaseTex()
  disposeFeatures()
  disposeTile()

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
  if (scene && brushIntersect) {
    try { scene.remove(brushIntersect) } catch {}
    try { (brushIntersect.geometry as any)?.dispose?.() } catch {}
    try { (brushIntersect.material as any)?.dispose?.() } catch {}
    brushIntersect = null
    brushIntersectMat = null
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
    const g0 = performance.now()
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
    profGeomUpdateMs.value = performance.now() - g0
    // Defer normals during painting; otherwise throttle recompute
    if (isPainting) {
      needsNormals = true
    } else {
      if (!normalsTimer) {
        normalsTimer = window.setTimeout(() => {
          const n0 = performance.now()
          try { geom.computeVertexNormals() } catch {}
          profNormalsMs.value = performance.now() - n0
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

// Update type overlay
watch(
  () => [props.showType, props.typeU8, props.typeW, props.typeL],
  () => {
    if (!mesh) return
    buildTypeOverlay(mesh.geometry)
  },
  { deep: false }
)

 // Update grass overlay
watch(
  () => [props.showGrass, props.grassU8, props.grassW, props.grassL],
  () => {
    if (!mesh) return
    buildGrassOverlay(mesh.geometry)
  },
  { deep: false }
)

// Update tile overlay
watch(
  () => [props.showTiles, props.tileIndex, props.tileIndexW, props.tileIndexL],
  () => {
    if (!mesh) return
    buildTileOverlay(mesh.geometry)
  },
  { deep: false }
)

// Update features markers
watch(
  () => [props.showFeatures, props.features],
  () => {
    buildFeatures()
  },
  { deep: true }
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

// Rebuild when atlas mode/images change
watch(
  () => [props.atlasMode, props.atlasImages],
  () => {
    buildMesh()
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
    if (lastHitPos) scheduleUpdateIntersect(lastHitPos.x, lastHitPos.y, lastHitPos.z, r)
  }
)

watch(
  () => props.editStrength,
  () => {
    const r = Number(props.editRadius ?? 64)
    if (lastHitPos) scheduleUpdateIntersect(lastHitPos.x, lastHitPos.y, lastHitPos.z, r)
  }
)

watch(
  () => props.screenRotationQuarter,
  () => {
    if (!camera) return
    const qRaw = props.screenRotationQuarter ?? 0
    const q = ((qRaw % 4) + 4) % 4
    const cx = props.widthWorld * 0.5
    const cz = props.lengthWorld * 0.5
    const ups = [
      new THREE.Vector3(0, 0, 1),
      new THREE.Vector3(1, 0, 0),
      new THREE.Vector3(0, 0, -1),
      new THREE.Vector3(-1, 0, 0),
    ]
    camera.up.copy(ups[q])
    camera.lookAt(new THREE.Vector3(cx, 0, cz))
  }
)

defineExpose({
  requestFullscreen: () => {
    const el = container.value as any
    if (el?.requestFullscreen) el.requestFullscreen()
  },
})
</script>

<template>
  <div class="viewport" :style="viewportStyle" ref="container">
    <div v-if="profilerModeComputed" class="prof-overlay">
      <div class="prof-row"><b>FPS:</b> <span>{{ profFps }}</span></div>
      <div class="prof-row"><b>Frame ms:</b> <span>{{ profFrameMs.toFixed(2) }}</span></div>
      <div class="prof-row"><b>Controls ms:</b> <span>{{ profControlsMs.toFixed(2) }}</span></div>
      <div class="prof-row"><b>Render ms:</b> <span>{{ profRenderMs.toFixed(2) }}</span></div>
      <div class="prof-row"><b>Geom update ms:</b> <span>{{ profGeomUpdateMs.toFixed(2) }}</span></div>
      <div class="prof-row"><b>Normals ms:</b> <span>{{ profNormalsMs.toFixed(2) }}</span></div>
      <div class="prof-row"><b>Brush ms:</b> <span>{{ profBrushMs.toFixed(2) }}</span></div>
      <div class="prof-row"><b>Raycast ms:</b> <span>{{ profRaycastMs.toFixed(2) }}</span></div>
    </div>
  </div>
</template>

<style scoped>
.viewport {
  width: 100%;
  min-height: 400px;
  outline: 1px solid #222;
  box-sizing: border-box;
}
.prof-overlay {
  position: absolute;
  top: 8px;
  left: 8px;
  background: rgba(12, 14, 18, 0.85);
  border: 1px solid #2a2f3a;
  padding: 8px 10px;
  border-radius: 6px;
  font-size: 12px;
  color: #dfe5f2;
  pointer-events: none;
  min-width: 160px;
}
.prof-row {
  display: flex;
  justify-content: space-between;
  gap: 10px;
  line-height: 1.35;
}
</style>
