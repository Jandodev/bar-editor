<script setup lang="ts">
import { onMounted, onBeforeUnmount, ref, watch } from 'vue'
import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls'

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
}

const props = defineProps<Props>()

const container = ref<HTMLDivElement | null>(null)
let renderer: THREE.WebGLRenderer | null = null
let scene: THREE.Scene | null = null
let camera: THREE.PerspectiveCamera | null = null
let controls: OrbitControls | null = null
let mesh: THREE.Mesh | null = null
let grid: THREE.GridHelper | null = null

// Metal overlay resources
let overlayMesh: THREE.Mesh | null = null
let overlayMat: THREE.MeshBasicMaterial | null = null
let overlayTex: THREE.DataTexture | null = null

let animationId = 0

function disposeOverlay() {
  if (overlayMesh && scene) {
    scene.remove(overlayMesh)
    overlayMesh = null
  }
  if (overlayMat) {
    overlayMat.dispose()
    overlayMat = null
  }
  if (overlayTex) {
    overlayTex.dispose()
    overlayTex = null
  }
}

function buildOverlay(geom: THREE.BufferGeometry) {
  disposeOverlay()

  if (!scene) return
  if (!props.showMetal) return
  if (!props.metalU8 || !props.metalW || !props.metalL) return

  const { metalU8, metalW, metalL } = props
  const pxCount = metalW * metalL
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
    const a = metalU8[i] // already 0..255
    const j = i * 4
    data[j + 0] = 255 // R
    data[j + 1] = 0   // G
    data[j + 2] = 0   // B
    data[j + 3] = a   // A
  }

  overlayTex = new THREE.DataTexture(data, metalW, metalL, THREE.RGBAFormat, THREE.UnsignedByteType)
  overlayTex.colorSpace = THREE.NoColorSpace
  // Align metal overlay with terrain
  overlayTex.center.set(0.5, 0.5)
  overlayTex.flipY = true
  overlayTex.generateMipmaps = false
  overlayTex.minFilter = THREE.NearestFilter
  overlayTex.magFilter = THREE.NearestFilter
  overlayTex.wrapS = THREE.ClampToEdgeWrapping
  overlayTex.wrapT = THREE.ClampToEdgeWrapping
  overlayTex.needsUpdate = true

  overlayMat = new THREE.MeshBasicMaterial({
    map: overlayTex,
    transparent: true,
    depthWrite: false,
    // Draw slightly in front to reduce z-fighting with terrain
    polygonOffset: true,
    polygonOffsetFactor: -1,
    polygonOffsetUnits: -1,
  })

  // Share the same displaced geometry so overlay matches terrain surface
  overlayMesh = new THREE.Mesh(geom, overlayMat)
  overlayMesh.renderOrder = 1
  scene.add(overlayMesh)
}

function buildMesh() {
  if (!scene) return
  // Dispose previous
  if (mesh) {
    // Note: overlay shares geometry; dispose overlay first to avoid double-dispose issues.
    disposeOverlay()

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
  })

  mesh = new THREE.Mesh(geom, mat)
  scene.add(mesh)

  // Build metal overlay sharing this geometry
  buildOverlay(geom)

  // Grid helper for orientation
  const size = Math.max(widthWorld, lengthWorld)
  grid = new THREE.GridHelper(size, 20, 0x222222, 0x444444)
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
  const ambient = new THREE.AmbientLight(0xffffff, 0.6)
  scene.add(ambient)
  const dir = new THREE.DirectionalLight(0xffffff, 0.8)
  dir.position.set(1, 1, 1).multiplyScalar(1000)
  scene.add(dir)

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
  }
  animate()
}

onMounted(() => {
  init()
})

onBeforeUnmount(() => {
  cancelAnimationFrame(animationId)
  window.removeEventListener('resize', () => {})
  if (controls) {
    controls.dispose()
    controls = null
  }
  disposeOverlay()
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

// Rebuild only overlay when metal data or visibility changes
watch(
  () => [props.showMetal, props.metalU8, props.metalW, props.metalL],
  () => {
    if (!mesh) return
    buildOverlay(mesh.geometry)
  },
  { deep: false }
)
</script>

<template>
  <div class="viewport" ref="container"></div>
</template>

<style scoped>
.viewport {
  width: 100%;
  height: calc(100vh - 160px);
  min-height: 400px;
  outline: 1px solid #222;
  box-sizing: border-box;
}
</style>
