<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch, computed } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'
import { DDSLoader } from 'three/examples/jsm/loaders/DDSLoader'
import { TGALoader } from 'three/examples/jsm/loaders/TGALoader'

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
const emit = defineEmits<{ (e: 'fps', fps: number): void }>()

const container = ref<HTMLDivElement | null>(null)
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let mesh: THREE.Mesh | null = null
let grid: THREE.GridHelper | null = null

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
        console.info('DDS loaded:', url)
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
        console.info('TGA loaded:', url)
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
      console.info('Image loaded:', url)
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

// Rebuild base mesh when heights or grid sizes change
watch(
  () => [props.gridW, props.gridL, props.widthWorld, props.lengthWorld, props.heights],
  () => buildMesh(),
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
