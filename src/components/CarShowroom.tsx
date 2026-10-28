// CarShowroom — the garage's live 3D turntable. Renders the selected car the
// way the game paints it (nightPaint from the asset pipeline) on a wet
// reflective floor with neon underglow and a mini city backdrop — the same
// "showroom" treatment as the fleet key art.
// ============================================================

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { Reflector } from 'three/addons/objects/Reflector.js'
import { nightPaint } from '../game/assets'
import type { Skin } from '../game/content'

const CAR_BASE = import.meta.env.BASE_URL + 'models/cars/'

// GLB templates are shared across mounts — switching cards is instant after
// the first load of each model.
const templateCache = new Map<string, THREE.Object3D>()
const pending = new Map<string, Promise<THREE.Object3D>>()

function loadCarTemplate(model: string): Promise<THREE.Object3D> {
  const hit = templateCache.get(model)
  if (hit) return Promise.resolve(hit)
  const pend = pending.get(model)
  if (pend) return pend
  const p = new Promise<THREE.Object3D>((resolve, reject) => {
    new GLTFLoader().load(
      `${CAR_BASE}${model}.glb`,
      (gltf) => {
        gltf.scene.traverse((o) => {
          const mesh = o as THREE.Mesh
          if (!mesh.isMesh) return
          const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
          mats.forEach((m) => {
            const std = m as THREE.MeshStandardMaterial
            if (std.map) std.map.colorSpace = THREE.SRGBColorSpace
          })
        })
        templateCache.set(model, gltf.scene)
        pending.delete(model)
        resolve(gltf.scene)
      },
      undefined,
      () => {
        pending.delete(model)
        // Fall back to the starter coupe so a missing file never blanks the shop
        if (model !== 'sedan-sports') loadCarTemplate('sedan-sports').then(resolve, reject)
        else reject(new Error('car load failed'))
      }
    )
  })
  pending.set(model, p)
  return p
}

function envCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 512
  c.height = 256
  const x = c.getContext('2d')!
  const g = x.createLinearGradient(0, 0, 0, 256)
  g.addColorStop(0, '#02030a')
  g.addColorStop(0.55, '#0a1226')
  g.addColorStop(0.72, '#131b3d')
  g.addColorStop(0.78, '#05070f')
  g.addColorStop(1, '#020307')
  x.fillStyle = g
  x.fillRect(0, 0, 512, 256)
  x.filter = 'blur(8px)'
  const blobs: Array<[string, number, number, number, number]> = [
    ['#22d3ee', 45, 150, 75, 23], ['#ff2ec4', 150, 145, 60, 20], ['#ff9a3c', 240, 152, 65, 21],
    ['#7c3aed', 330, 142, 60, 22], ['#22d3ee', 415, 150, 70, 21], ['#f8fafc', 90, 125, 30, 9],
    ['#f8fafc', 280, 122, 35, 9],
  ]
  for (const [col, bx, by, bw, bh] of blobs) {
    x.fillStyle = col
    x.fillRect(bx, by, bw, bh)
  }
  x.filter = 'blur(16px)'
  x.fillStyle = '#67e8f9'
  x.fillRect(0, 165, 512, 13)
  x.filter = 'none'
  return c
}

function facadeCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = 64
  c.height = 128
  const x = c.getContext('2d')!
  x.fillStyle = '#070a12'
  x.fillRect(0, 0, 64, 128)
  for (let r = 0; r < 16; r++)
    for (let col = 0; col < 6; col++) {
      if (Math.random() < 0.4) {
        x.fillStyle = Math.random() < 0.3 ? '#67e8f9' : '#ffd9a0'
        x.globalAlpha = 0.5 + Math.random() * 0.5
        x.fillRect(4 + col * 10, 5 + r * 7.5, 5.5, 3.5)
      }
    }
  x.globalAlpha = 1
  return c
}

function glowCanvas(): HTMLCanvasElement {
  const c = document.createElement('canvas')
  c.width = c.height = 128
  const x = c.getContext('2d')!
  const g = x.createRadialGradient(64, 64, 5, 64, 64, 62)
  g.addColorStop(0, 'rgba(255,255,255,0.95)')
  g.addColorStop(0.35, 'rgba(255,255,255,0.45)')
  g.addColorStop(1, 'rgba(255,255,255,0)')
  x.fillStyle = g
  x.fillRect(0, 0, 128, 128)
  return c
}

export default function CarShowroom({ skin, height = 300 }: { skin: Skin; height?: number }) {
  const host = useRef<HTMLDivElement>(null)
  const state = useRef<{
    renderer: THREE.WebGLRenderer
    scene: THREE.Scene
    camera: THREE.PerspectiveCamera
    stage: THREE.Group
    glow: THREE.MeshBasicMaterial
    strips: THREE.MeshBasicMaterial[]
    raf: number
    dispose: () => void
  } | null>(null)

  // Build the stage once
  useEffect(() => {
    const el = host.current
    if (!el) return
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.toneMapping = THREE.ACESFilmicToneMapping
    renderer.toneMappingExposure = 1.15
    el.appendChild(renderer.domElement)

    const scene = new THREE.Scene()
    scene.fog = new THREE.Fog(0x05070f, 22, 60)
    const camera = new THREE.PerspectiveCamera(36, 2, 0.1, 120)
    camera.position.set(4.6, 1.65, 5.4)
    camera.lookAt(0, 0.7, 0)

    const pmrem = new THREE.PMREMGenerator(renderer)
    const envTex = new THREE.CanvasTexture(envCanvas())
    envTex.mapping = THREE.EquirectangularReflectionMapping
    envTex.colorSpace = THREE.SRGBColorSpace
    scene.environment = pmrem.fromEquirectangular(envTex).texture

    scene.add(new THREE.HemisphereLight(0x33405e, 0x05070c, 0.55))
    const key = new THREE.DirectionalLight(0xbfd7ff, 1.3)
    key.position.set(6, 9, 4)
    scene.add(key)
    const rim = new THREE.DirectionalLight(0xff2ec4, 0.18)
    rim.position.set(-7, 5, -6)
    scene.add(rim)

    // Wet floor: mirror dulled by a translucent asphalt sheet
    const mirror = new Reflector(new THREE.CircleGeometry(26, 48), {
      clipBias: 0.003,
      textureWidth: 512,
      textureHeight: 512,
      color: 0x8a93a8,
    })
    mirror.rotation.x = -Math.PI / 2
    scene.add(mirror)
    const dull = new THREE.Mesh(
      new THREE.CircleGeometry(26, 48),
      new THREE.MeshStandardMaterial({ color: 0x0a0d15, transparent: true, opacity: 0.6, roughness: 0.92 })
    )
    dull.rotation.x = -Math.PI / 2
    dull.position.y = 0.005
    scene.add(dull)

    // Mini neon backdrop
    const facade = new THREE.CanvasTexture(facadeCanvas())
    const bmat = new THREE.MeshStandardMaterial({ color: 0x05070d, emissive: 0xffffff, emissiveMap: facade, emissiveIntensity: 0.9, roughness: 1 })
    for (let i = 0; i < 14; i++) {
      const a = (i / 14) * Math.PI * 2
      const h = 6 + Math.random() * 12
      const b = new THREE.Mesh(new THREE.BoxGeometry(3 + Math.random() * 3, h, 3 + Math.random() * 3), bmat)
      b.position.set(Math.cos(a) * (19 + Math.random() * 8), h / 2, Math.sin(a) * (19 + Math.random() * 8))
      scene.add(b)
    }

    // Underglow pool (recolored per skin)
    const glowMat = new THREE.MeshBasicMaterial({
      map: new THREE.CanvasTexture(glowCanvas()),
      transparent: true,
      blending: THREE.AdditiveBlending,
      depthWrite: false,
    })
    const glow = new THREE.Mesh(new THREE.PlaneGeometry(7.2, 4.8), glowMat)
    glow.rotation.x = -Math.PI / 2
    glow.position.y = 0.02
    scene.add(glow)

    const stage = new THREE.Group()
    scene.add(stage)

    const s = {
      renderer, scene, camera, stage,
      glow: glowMat,
      strips: [] as THREE.MeshBasicMaterial[],
      raf: 0,
      dispose: () => {
        cancelAnimationFrame(s.raf)
        renderer.dispose()
        pmrem.dispose()
        envTex.dispose()
        el.removeChild(renderer.domElement)
      },
    }
    state.current = s

    const resize = () => {
      const w = el.clientWidth || 600
      const h = el.clientHeight || height
      renderer.setSize(w, h, false)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    resize()
    const ro = new ResizeObserver(resize)
    ro.observe(el)

    const tick = () => {
      stage.rotation.y += 0.006
      renderer.render(scene, camera)
      s.raf = requestAnimationFrame(tick)
    }
    tick()
    return () => {
      ro.disconnect()
      s.dispose()
      state.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Swap the car + paint whenever the selected skin changes
  useEffect(() => {
    const s = state.current
    if (!s) return
    let live = true
    s.glow.color.setHex(skin.glow)
    loadCarTemplate(skin.model ?? 'sedan-sports').then((template) => {
      if (!live || !state.current) return
      while (s.stage.children.length) s.stage.remove(s.stage.children[0])
      const inst = template.clone(true)
      const tint = new THREE.Color(skin.body)
      inst.traverse((o) => {
        const mesh = o as THREE.Mesh
        if (!mesh.isMesh) return
        mesh.material = Array.isArray(mesh.material)
          ? mesh.material.map((m) => nightPaint(m, tint))
          : nightPaint(mesh.material, tint)
      })
      // Same normalization the engine uses: ~4.4m footprint, wheels on the floor
      const bb = new THREE.Box3().setFromObject(inst)
      const len = bb.max.z - bb.min.z
      const k = len > 0.01 ? 4.4 / len : 1
      inst.scale.setScalar(k)
      inst.position.y = -bb.min.y * k
      s.stage.add(inst)
    })
    return () => {
      live = false
    }
  }, [skin])

  return (
    <div
      ref={host}
      className="car-showroom"
      style={{ height }}
      aria-label={`${skin.name} 3D preview`}
    />
  )
}
