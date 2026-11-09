import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { feature } from 'topojson-client'
import world from 'world-atlas/countries-110m.json'

export type Point = {
  lat: number
  lon: number
  value: number
  kind: 'MODIS' | 'VIIRS' | 'HARMONIZED'
  modisCount: number
  viirsCount: number
  modisFrp: number
  viirsFrp: number
  country?: string
}
const R = 2
function xyz(lat: number, lon: number, r = R) {
  const phi = ((90 - lat) * Math.PI) / 180,
    theta = ((lon + 180) * Math.PI) / 180
  return new THREE.Vector3(
    -r * Math.sin(phi) * Math.cos(theta),
    r * Math.cos(phi),
    r * Math.sin(phi) * Math.sin(theta),
  )
}
function ringCenter(ring: number[][]) {
  if (ring.length < 3) return null
  const referenceLon = ring[0][0]
  const points = ring.map(([lon, lat]) => [referenceLon + ((((lon - referenceLon) + 540) % 360) - 180), lat])
  let twiceArea = 0
  let xSum = 0
  let ySum = 0
  for (let i = 0; i < points.length; i++) {
    const [x1, y1] = points[i]
    const [x2, y2] = points[(i + 1) % points.length]
    const cross = x1 * y2 - x2 * y1
    twiceArea += cross
    xSum += (x1 + x2) * cross
    ySum += (y1 + y2) * cross
  }
  if (Math.abs(twiceArea) < 1e-8) return null
  const lon = xSum / (3 * twiceArea)
  return { lon: ((lon + 540) % 360) - 180, lat: ySum / (3 * twiceArea), area: Math.abs(twiceArea / 2) }
}

export default function Globe({
  points,
  focus,
  selectedPoint,
  onPointSelect,
}: {
  points: Point[]
  focus: [number, number]
  selectedPoint: Point | null
  onPointSelect: (point: Point) => void
}) {
  const holder = useRef<HTMLDivElement>(null)
  const pointsRef = useRef(points)
  const selectedPointRef = useRef(selectedPoint)
  const onPointSelectRef = useRef(onPointSelect)
  pointsRef.current = points
  selectedPointRef.current = selectedPoint
  onPointSelectRef.current = onPointSelect
  useEffect(() => {
    const el = holder.current!
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
    camera.position.set(0, 0, 6.5)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    renderer.outputColorSpace = THREE.SRGBColorSpace
    el.appendChild(renderer.domElement)
    const globe = new THREE.Group()
    scene.add(globe)
    const earthTexture = new THREE.TextureLoader().load('/textures/earth-blue-marble.jpg')
    earthTexture.colorSpace = THREE.SRGBColorSpace
    earthTexture.anisotropy = renderer.capabilities.getMaxAnisotropy()
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(R, 128, 96),
      new THREE.MeshStandardMaterial({
        map: earthTexture,
        roughness: 0.92,
        metalness: 0,
      }),
    )
    globe.add(sphere)
    const atmosphere = new THREE.Mesh(
      new THREE.SphereGeometry(2.07, 64, 64),
      new THREE.MeshBasicMaterial({
        color: 0x3ca6c5,
        transparent: true,
        opacity: 0.075,
        side: THREE.BackSide,
      }),
    )
    globe.add(atmosphere)
    const gridMaterial = new THREE.LineBasicMaterial({
      color: 0x9bc6d1,
      transparent: true,
      opacity: 0.1,
    })
    for (let lat = -60; lat <= 60; lat += 30) {
      const coordinates = []
      for (let lon = -180; lon <= 180; lon += 3) coordinates.push(xyz(lat, lon, 2.008))
      globe.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(coordinates), gridMaterial))
    }
    for (let lon = -180; lon < 180; lon += 30) {
      const coordinates = []
      for (let lat = -90; lat <= 90; lat += 3) coordinates.push(xyz(lat, lon, 2.009))
      globe.add(new THREE.Line(new THREE.BufferGeometry().setFromPoints(coordinates), gridMaterial))
    }
    const coastMaterial = new THREE.LineBasicMaterial({
      color: 0xc1d8d2,
      transparent: true,
      opacity: 0.22,
    })
    const countries = feature(
      world as never,
      (world as unknown as { objects: { countries: never } }).objects.countries,
    ) as unknown as {
      features: {
        properties?: { name?: string }
        geometry: { type: string; coordinates: unknown }
      }[]
    }
    const countryLabels: { sprite: THREE.Sprite; point: THREE.Vector3; priority: number }[] = []
    for (const country of countries.features) {
      const geometry = country.geometry
      const polygons =
        geometry.type === 'Polygon'
          ? [geometry.coordinates]
          : geometry.type === 'MultiPolygon'
            ? geometry.coordinates
            : []
      for (const polygon of polygons as number[][][][]) {
        for (const ring of polygon) {
          if (ring.length < 2) continue
          const vertices = ring.map(([lon, lat]) => xyz(lat, lon, 2.014))
          globe.add(
            new THREE.Line(new THREE.BufferGeometry().setFromPoints(vertices), coastMaterial),
          )
        }
      }
      const name = country.properties?.name
      if (name && name !== 'Antarctica') {
        let anchor: ReturnType<typeof ringCenter> = null
        for (const polygon of polygons as number[][][][]) {
          const center = polygon[0] && ringCenter(polygon[0])
          if (center && (!anchor || center.area > anchor.area)) anchor = center
        }
        if (anchor) {
          const canvas = document.createElement('canvas')
          canvas.width = 512
          canvas.height = 72
          const context = canvas.getContext('2d')!
          context.font = '600 32px Arial, sans-serif'
          context.textAlign = 'center'
          context.textBaseline = 'middle'
          const textWidth = Math.min(480, context.measureText(name).width)
          const pillWidth = textWidth + 28
          const left = (canvas.width - pillWidth) / 2
          context.beginPath()
          context.roundRect(left, 10, pillWidth, 52, 13)
          context.fillStyle = 'rgba(5, 15, 24, 0.82)'
          context.fill()
          context.strokeStyle = 'rgba(152, 205, 219, 0.6)'
          context.lineWidth = 2
          context.stroke()
          context.fillStyle = '#f3f8fa'
          context.shadowColor = '#071018'
          context.shadowBlur = 3
          context.fillText(name, canvas.width / 2, 36, 460)
          const texture = new THREE.CanvasTexture(canvas)
          texture.colorSpace = THREE.SRGBColorSpace
          const sprite = new THREE.Sprite(
            new THREE.SpriteMaterial({ map: texture, transparent: true, depthTest: true, depthWrite: false }),
          )
          sprite.position.copy(xyz(anchor.lat, anchor.lon, 2.035))
          sprite.scale.set(Math.max(0.3, (pillWidth / canvas.width) * 0.9), 0.28, 1)
          sprite.renderOrder = 2
          globe.add(sprite)
          countryLabels.push({ sprite, point: sprite.position.clone(), priority: anchor.area })
        }
      }
    }
    const light = new THREE.DirectionalLight(0xffffff, 2.5)
    light.position.set(-3, 3, 5)
    scene.add(light)
    scene.add(new THREE.AmbientLight(0xc3d4dc, 1.15))
    const rimLight = new THREE.DirectionalLight(0x4588c3, 1.25)
    rimLight.position.set(4, -1, -4)
    scene.add(rimLight)
    const starGeo = new THREE.BufferGeometry(),
      starPos = [] as number[]
    for (let i = 0; i < 550; i++) {
      const a = i * 2.39996,
        z = 1 - (2 * (i + 0.5)) / 550,
        r = Math.sqrt(1 - z * z)
      starPos.push(22 * r * Math.cos(a), 22 * z, 22 * r * Math.sin(a))
    }
    starGeo.setAttribute('position', new THREE.Float32BufferAttribute(starPos, 3))
    scene.add(
      new THREE.Points(
        starGeo,
        new THREE.PointsMaterial({
          color: 0x799aa5,
          size: 0.025,
          transparent: true,
          opacity: 0.55,
        }),
      ),
    )
    const markerGroup = new THREE.Group()
    globe.add(markerGroup)
    let disposed = false
    function updateMarkers() {
      while (markerGroup.children.length) {
        const child = markerGroup.children[0] as THREE.Mesh
        markerGroup.remove(child)
        child.geometry.dispose()
        ;(child.material as THREE.Material).dispose()
      }
      for (const p of pointsRef.current.slice(0, 1000)) {
        const isSelected =
          selectedPointRef.current?.lat === p.lat && selectedPointRef.current?.lon === p.lon
        const color = isSelected
          ? 0xffffff
          : p.kind === 'MODIS'
            ? 0xffa04d
            : p.kind === 'VIIRS'
              ? 0x48d9de
              : 0xff6c50
        const size = Math.min(0.09, 0.045 + Math.log1p(p.value) * 0.01) * (isSelected ? 1.5 : 1)
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(size, 8, 8),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
        )
        mesh.position.copy(xyz(p.lat, p.lon, 2.022))
        mesh.userData.point = p
        markerGroup.add(mesh)
      }
    }
    function resize() {
      const w = el.clientWidth,
        h = el.clientHeight
      renderer.setSize(w, h)
      camera.aspect = w / h
      camera.updateProjectionMatrix()
    }
    const observer = new ResizeObserver(resize)
    observer.observe(el)
    resize()
    let dragging = false,
      didMove = false,
      startX = 0,
      startY = 0,
      lastX = 0,
      lastY = 0,
      raf = 0
    const activePointers = new Map<number, { x: number; y: number }>()
    let pinchDistance = 0
    const raycaster = new THREE.Raycaster()
    const pointer = new THREE.Vector2()
    const pointAtPointer = (e: PointerEvent) => {
      const bounds = renderer.domElement.getBoundingClientRect()
      pointer.set(
        ((e.clientX - bounds.left) / bounds.width) * 2 - 1,
        -((e.clientY - bounds.top) / bounds.height) * 2 + 1,
      )
      raycaster.setFromCamera(pointer, camera)
      const hit = raycaster.intersectObjects(markerGroup.children, false)[0]
      return hit?.object.userData.point as Point | undefined
    }
    const down = (e: PointerEvent) => {
      activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
      if (activePointers.size === 2) {
        const [a, b] = [...activePointers.values()]
        pinchDistance = Math.hypot(a.x - b.x, a.y - b.y)
        dragging = false
        didMove = true
        el.setPointerCapture(e.pointerId)
        return
      }
      dragging = true
      didMove = false
      startX = e.clientX
      startY = e.clientY
      lastX = e.clientX
      lastY = e.clientY
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (activePointers.has(e.pointerId)) {
        activePointers.set(e.pointerId, { x: e.clientX, y: e.clientY })
        if (activePointers.size >= 2) {
          const [a, b] = [...activePointers.values()]
          const distance = Math.hypot(a.x - b.x, a.y - b.y)
          if (pinchDistance > 0) {
            camera.position.z = Math.max(
              3.1,
              Math.min(10, camera.position.z - (distance - pinchDistance) * 0.012),
            )
          }
          pinchDistance = distance
          dragging = false
          didMove = true
          return
        }
      }
      if (!dragging) {
        el.style.cursor = pointAtPointer(e) ? 'pointer' : 'grab'
        return
      }
      if (!didMove && Math.hypot(e.clientX - startX, e.clientY - startY) > 4) didMove = true
      if (!didMove) return
      globe.rotation.y += (e.clientX - lastX) * 0.005
      globe.rotation.x = Math.max(
        -1.3,
        Math.min(1.3, globe.rotation.x + (e.clientY - lastY) * 0.005),
      )
      lastX = e.clientX
      lastY = e.clientY
    }
    const up = (e: PointerEvent) => {
      activePointers.delete(e.pointerId)
      if (activePointers.size < 2) pinchDistance = 0
      if (dragging && !didMove) {
        const point = pointAtPointer(e)
        if (point) {
          const inRing = (lon: number, lat: number, ring: number[][]) => {
            let inside = false
            for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
              const [xi, yi] = ring[i]
              const [xj, yj] = ring[j]
              if ((yi > lat) !== (yj > lat) && lon < ((xj - xi) * (lat - yi)) / (yj - yi) + xi)
                inside = !inside
            }
            return inside
          }
          const country = countries.features.find((item) => {
            const geometry = item.geometry
            const polygons =
              geometry.type === 'Polygon'
                ? [geometry.coordinates]
                : geometry.type === 'MultiPolygon'
                  ? geometry.coordinates
                  : []
            return (polygons as number[][][][]).some(
              (polygon) => polygon[0] && inRing(point.lon, point.lat, polygon[0]),
            )
          })
          onPointSelectRef.current({ ...point, country: country?.properties?.name || 'Unknown' })
        }
      }
      dragging = false
      el.style.cursor = 'grab'
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    el.addEventListener('pointercancel', up)
    const zoom = (e: WheelEvent) => {
      e.preventDefault()
      camera.position.z = Math.max(3.1, Math.min(10, camera.position.z + e.deltaY * 0.004))
    }
    el.addEventListener('wheel', zoom, { passive: false })
    function animate() {
      if (disposed) return
      globe.updateMatrixWorld(true)
      const visibleLabels: { sprite: THREE.Sprite; facing: number; priority: number }[] = []
      for (const label of countryLabels) {
        const worldPoint = label.point.clone().applyMatrix4(globe.matrixWorld)
        const facing = worldPoint.z / worldPoint.length()
        if (facing > 0.12) visibleLabels.push({ ...label, facing })
      }
      visibleLabels.sort((a, b) => b.facing - a.facing || b.priority - a.priority)
      const labelLimit = camera.position.z < 4.2 ? 26 : camera.position.z < 5.4 ? 18 : 12
      const shown = new Set(visibleLabels.slice(0, labelLimit).map((label) => label.sprite))
      for (const label of countryLabels) label.sprite.visible = shown.has(label.sprite)
      renderer.render(scene, camera)
      raf = requestAnimationFrame(animate)
    }
    globe.rotation.y = -Math.PI / 2 - (focus[1] * Math.PI) / 180
    globe.rotation.x = (focus[0] * Math.PI) / 180
    updateMarkers()
    animate()
    ;(el as HTMLDivElement & { updateMarkers?: () => void }).updateMarkers = updateMarkers
    return () => {
      disposed = true
      cancelAnimationFrame(raf)
      observer.disconnect()
      el.removeEventListener('pointerdown', down)
      el.removeEventListener('pointermove', move)
      el.removeEventListener('pointerup', up)
      el.removeEventListener('pointercancel', up)
      el.removeEventListener('wheel', zoom)
      for (const { sprite } of countryLabels) {
        sprite.material.map?.dispose()
        sprite.material.dispose()
      }
      renderer.dispose()
      earthTexture.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [])
  useEffect(() => {
    ;(holder.current as HTMLDivElement & { updateMarkers?: () => void })?.updateMarkers?.()
  }, [points, selectedPoint])
  return (
    <div
      className="globe-canvas"
      ref={holder}
      aria-label="Interactive three dimensional globe with country names. Click fire hotspots for details, drag to rotate, scroll over the globe or pinch to zoom."
    />
  )
}

