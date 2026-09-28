// Asset pipeline: loads the CC0 Kenney GLB models (city buildings, cars)
// and prepares them for fast rendering — one merged geometry per building
// model (instanced across the whole city) and clone-ready car templates.
// ============================================================

import * as THREE from 'three'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js'
import * as SkeletonUtils from 'three/addons/utils/SkeletonUtils.js'

export interface CityModel {
  geometry: THREE.BufferGeometry
  /** base footprint/height before scaling (for fitting lots) */
  size: THREE.Vector3
  minY: number
}

export interface GameAssets {
  city: Record<string, CityModel>
  cityMaterial: THREE.MeshStandardMaterial
  cars: Record<string, THREE.Object3D>
  /** animated pedestrian templates (Kenney mini characters, 32 clips each) */
  chars: Record<string, THREE.Object3D>
  charClips: Record<string, THREE.AnimationClip[]>
}

const CITY_BASE = import.meta.env.BASE_URL + 'models/city/'
const CAR_BASE = import.meta.env.BASE_URL + 'models/cars/'

// Curated model lists (packs contain more, these cover every district)
const SKYSCRAPERS = ['building-skyscraper-a', 'building-skyscraper-b', 'building-skyscraper-c', 'building-skyscraper-d', 'building-skyscraper-e']
const MIDRISE = [
  'building-a', 'building-b', 'building-c', 'building-d', 'building-e', 'building-f', 'building-g',
  'building-h', 'building-i', 'building-j', 'building-k', 'building-l', 'building-m', 'building-n',
]
const LOWRISE = ['low-detail-building-a', 'low-detail-building-b', 'low-detail-building-c', 'low-detail-building-d', 'low-detail-building-e', 'low-detail-building-f', 'low-detail-building-g', 'low-detail-building-h', 'low-detail-building-wide-a', 'low-detail-building-wide-b']
const DETAILS = ['detail-awning-wide', 'detail-awning', 'detail-overhang-wide', 'detail-overhang', 'detail-parasol-a', 'detail-parasol-b']

const CITY_MODELS = [...SKYSCRAPERS, ...MIDRISE, ...LOWRISE, ...DETAILS]

const CAR_MODELS = [
  'sedan', 'sedan-sports', 'hatchback-sports', 'taxi', 'police', 'suv', 'suv-luxury',
  'van', 'race', 'delivery', 'ambulance', 'firetruck',
]

const CHAR_BASE = import.meta.env.BASE_URL + 'models/chars/'
const CHAR_MODELS = [
  'character-male-a', 'character-male-b', 'character-male-c', 'character-male-d', 'character-male-e', 'character-male-f',
  'character-female-a', 'character-female-b', 'character-female-c', 'character-female-d', 'character-female-e', 'character-female-f',
]
export const CHAR_KEYS = CHAR_MODELS

export type CityKind = 'skyscraper' | 'midrise' | 'lowrise' | 'detail'

export function cityKind(model: string): CityKind {
  if (model.startsWith('building-skyscraper')) return 'skyscraper'
  if (model.startsWith('low-detail')) return 'lowrise'
  if (model.startsWith('detail')) return 'detail'
  return 'midrise'
}

export const CITY_BY_KIND: Record<CityKind, string[]> = {
  skyscraper: SKYSCRAPERS,
  midrise: MIDRISE,
  lowrise: LOWRISE,
  detail: DETAILS,
}

function mergeSceneGeometry(scene: THREE.Object3D): { geometry: THREE.BufferGeometry; size: THREE.Vector3; minY: number } {
  scene.updateMatrixWorld(true)
  const parts: THREE.BufferGeometry[] = []
  scene.traverse((obj) => {
    const mesh = obj as THREE.Mesh
    if (!mesh.isMesh) return
    const src = mesh.geometry
    const g = new THREE.BufferGeometry()
    g.setAttribute('position', (src.getAttribute('position') as THREE.BufferAttribute).clone())
    if (src.getAttribute('normal')) g.setAttribute('normal', (src.getAttribute('normal') as THREE.BufferAttribute).clone())
    if (src.getAttribute('uv')) g.setAttribute('uv', (src.getAttribute('uv') as THREE.BufferAttribute).clone())
    g.setIndex(src.getIndex() ? (src.getIndex() as THREE.BufferAttribute).clone() : null)
    g.applyMatrix4(mesh.matrixWorld)
    parts.push(g)
  })
  const geometry = parts.length === 1 ? parts[0] : mergeGeometries(parts, false)
  if (!geometry) throw new Error('merge failed')
  geometry.computeBoundingBox()
  const bb = geometry.boundingBox ?? new THREE.Box3()
  const size = new THREE.Vector3()
  bb.getSize(size)
  return { geometry, size, minY: bb.min.y }
}

export async function loadGameAssets(onProgress: (done: number, total: number) => void): Promise<GameAssets> {
  const loader = new GLTFLoader()
  const total = CITY_MODELS.length + CAR_MODELS.length + CHAR_MODELS.length
  let done = 0
  const tick = () => onProgress(++done, total)

  const loadOne = (url: string): Promise<THREE.Object3D> =>
    new Promise((resolve, reject) => {
      loader.load(
        url,
        (gltf) => {
          tick()
          resolve(gltf.scene)
        },
        undefined,
        (err) => reject(new Error(`Failed to load ${url}: ${err instanceof Error ? err.message : String(err)}`))
      )
    })

  const city: Record<string, CityModel> = {}
  const cars: Record<string, THREE.Object3D> = {}

  // Load everything in parallel, but never reject the whole batch on one miss —
  // a missing decoration model should not kill the game.
  const cityResults = await Promise.allSettled(CITY_MODELS.map((m) => loadOne(`${CITY_BASE}${m}.glb`)))
  cityResults.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      try {
        const { geometry, size, minY } = mergeSceneGeometry(r.value)
        city[CITY_MODELS[i]] = { geometry, size, minY }
      } catch {
        /* skip malformed model */
      }
    }
  })

  const carResults = await Promise.allSettled(CAR_MODELS.map((m) => loadOne(`${CAR_BASE}${m}.glb`)))
  carResults.forEach((r, i) => {
    if (r.status === 'fulfilled') cars[CAR_MODELS[i]] = r.value
  })

  // Pedestrian characters: load the full GLTF (skinned + 32 animation clips)
  const chars: Record<string, THREE.Object3D> = {}
  const charResults = await Promise.allSettled(
    CHAR_MODELS.map(
      (m) =>
        new Promise<{ scene: THREE.Object3D; clips: THREE.AnimationClip[] }>((resolve, reject) => {
          loader.load(
            `${CHAR_BASE}${m}.glb`,
            (gltf) => {
              tick()
              resolve({ scene: gltf.scene, clips: gltf.animations })
            },
            undefined,
            (err) => reject(new Error(`char ${m}: ${err instanceof Error ? err.message : String(err)}`))
          )
        })
    )
  )
  const charClips: Record<string, THREE.AnimationClip[]> = {}
  charResults.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      chars[CHAR_MODELS[i]] = r.value.scene
      charClips[CHAR_MODELS[i]] = r.value.clips
    }
  })

  // One shared night material for the whole city: palette texture doubles as a
  // soft emissive map so windows/details read at night without extra lights.
  const tex = await new THREE.TextureLoader().loadAsync(`${CITY_BASE}Textures/colormap.png`)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.flipY = false // glTF UV convention
  const cityMaterial = new THREE.MeshStandardMaterial({
    map: tex,
    emissive: 0xffffff,
    emissiveMap: tex,
    emissiveIntensity: 0.38,
    roughness: 0.85,
    metalness: 0.12,
  })

  // Cars keep their own materials (each pack has its own palette), but make
  // sure their textures use the right color space.
  Object.values(cars).forEach((car) => {
    car.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const mats = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
      mats.forEach((m) => {
        const std = m as THREE.MeshStandardMaterial
        if (std.map) std.map.colorSpace = THREE.SRGBColorSpace
        std.metalness = Math.min(std.metalness ?? 0, 0.4)
        std.roughness = Math.max(std.roughness ?? 0.8, 0.35)
      })
    })
  })

  return { city, cityMaterial, cars, chars, charClips }
}

/** Deep-clone a skinned character template (bind-safe) with its animation clips. */
export function cloneCharacter(
  assets: GameAssets,
  key: string
): { obj: THREE.Object3D; clips: THREE.AnimationClip[] } {
  const template = assets.chars[key] ?? Object.values(assets.chars)[0]
  const clips = assets.charClips[key] ?? Object.values(assets.charClips)[0] ?? []
  return { obj: SkeletonUtils.clone(template), clips }
}

/** Clone a car template and optionally tint its paint (color multiplies the palette). */
export function cloneCar(assets: GameAssets, model: string, tint?: number): THREE.Group {
  const template = assets.cars[model] ?? assets.cars['sedan']
  const inst = template.clone(true)
  if (tint !== undefined) {
    const tintColor = new THREE.Color(tint)
    inst.traverse((o) => {
      const mesh = o as THREE.Mesh
      if (!mesh.isMesh) return
      const tintMat = (m: THREE.Material): THREE.Material => {
        const c = (m as THREE.MeshStandardMaterial).clone()
        c.color.multiply(tintColor)
        return c
      }
      mesh.material = Array.isArray(mesh.material) ? mesh.material.map(tintMat) : tintMat(mesh.material)
    })
  }
  const g = new THREE.Group()
  g.add(inst)
  return g
}
