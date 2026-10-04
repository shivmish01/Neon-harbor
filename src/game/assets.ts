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
// Upgraded cast (CC0, Quaternius via poly.pizza): articulated modern people with
// full walk/idle/sit animation sets — mixed into the crowd with the Kenney kit.
const CHAR2_BASE = import.meta.env.BASE_URL + 'models/chars2/'
const CHAR2_MODELS = ['animated-human', 'man', 'woman-casual']
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
  const total = CITY_MODELS.length + CAR_MODELS.length + CHAR_MODELS.length + CHAR2_MODELS.length
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
  // Upgraded cast: same skinned+clips loading, merged into the same tables so
  // every spawner (streets, stalls, idlers) draws from the full roster
  const char2Results = await Promise.allSettled(
    CHAR2_MODELS.map(
      (m) =>
        new Promise<{ scene: THREE.Object3D; clips: THREE.AnimationClip[] }>((resolve, reject) => {
          loader.load(
            `${CHAR2_BASE}${m}.glb`,
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
  char2Results.forEach((r, i) => {
    if (r.status === 'fulfilled') {
      chars[CHAR2_MODELS[i]] = r.value.scene
      charClips[CHAR2_MODELS[i]] = r.value.clips
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

/** Lazily-cached luminance copies of palette textures, shared across all car clones. */
const grayMapCache = new WeakMap<THREE.Texture, THREE.Texture>()

/** Grayscale (luminance) copy of a palette texture, used as an emissiveMap.
    Night paint then glows purely in the SKIN hue (not the multiplied — muddy —
    texture color), while dark texels (wheels/trim) automatically stay dark. */
function grayscaleMap(src: THREE.Texture): THREE.Texture {
  const hit = grayMapCache.get(src)
  if (hit) return hit
  const img = src.image as HTMLImageElement | HTMLCanvasElement | ImageBitmap
  const canvas = document.createElement('canvas')
  canvas.width = img.width
  canvas.height = img.height
  const ctx = canvas.getContext('2d')!
  ctx.drawImage(img, 0, 0)
  const data = ctx.getImageData(0, 0, canvas.width, canvas.height)
  const px = data.data
  for (let i = 0; i < px.length; i += 4) {
    const l = 0.2126 * px[i] + 0.7152 * px[i + 1] + 0.0722 * px[i + 2]
    px[i] = px[i + 1] = px[i + 2] = l
  }
  ctx.putImageData(data, 0, 0)
  const tex = new THREE.CanvasTexture(canvas)
  tex.flipY = src.flipY // glTF convention (false) must carry over
  tex.wrapS = src.wrapS
  tex.wrapT = src.wrapT
  tex.repeat.copy(src.repeat)
  tex.offset.copy(src.offset)
  tex.colorSpace = THREE.SRGBColorSpace
  tex.needsUpdate = true
  grayMapCache.set(src, tex)
  return tex
}

/** Clone a car template and optionally tint its paint (color multiplies the palette).
    Every car gets the "night paint" treatment: glossy clearcoat + a soft emissive
    self-tint so body color still reads under the night sky instead of going muddy. */
export function cloneCar(assets: GameAssets, model: string, tint?: number): THREE.Group {
  const template = assets.cars[model] ?? assets.cars['sedan']
  const inst = template.clone(true)
  const tintColor = tint !== undefined ? new THREE.Color(tint) : null
  inst.traverse((o) => {
    const mesh = o as THREE.Mesh
    if (!mesh.isMesh) return
    const nightMat = (m: THREE.Material): THREE.Material => {
      const c = (m as THREE.MeshStandardMaterial).clone()
      if (tintColor) {
        c.color.multiply(tintColor)
        // Palette-textured paint (Kenney kit): multiply-tint goes muddy after dark,
        // so re-light the car with a LUMINANCE copy of its texture as the emissive
        // map — the night glow carries the pure skin hue (shading from texel
        // brightness), instead of hue × texture color (= brown sludge).
        if (c.map) {
          c.emissiveMap = grayscaleMap(c.map)
          c.emissive.copy(tintColor)
          c.emissiveIntensity = 0.7
        } else {
          // pure skin hue as self-light — never the multiplied (muddy) color
          c.emissive.copy(tintColor)
          c.emissiveIntensity = 0.5
        }
        c.roughness = Math.min(c.roughness, 0.38)
        c.metalness = Math.max(c.metalness, 0.45)
      } else {
        // baked palettes (taxi/police): gentle self-lift so they don't vanish
        const lum = 0.2126 * c.color.r + 0.7152 * c.color.g + 0.0722 * c.color.b
        if (lum > 0.06) {
          c.emissive.copy(c.color)
          c.emissiveIntensity = 0.16
          c.roughness = Math.min(c.roughness, 0.38)
          c.metalness = Math.max(c.metalness, 0.45)
        }
      }
      return c
    }
    mesh.material = Array.isArray(mesh.material) ? mesh.material.map(nightMat) : nightMat(mesh.material)
  })
  const g = new THREE.Group()
  g.add(inst)
  return g
}
