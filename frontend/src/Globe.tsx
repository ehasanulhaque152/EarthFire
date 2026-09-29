import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { feature } from 'topojson-client'
import world from 'world-atlas/countries-110m.json'

export type Point = {
  lat: number
  lon: number
  value: number
  kind: 'MODIS' | 'VIIRS' | 'HARMONIZED'
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

export default function Globe({ points, focus }: { points: Point[]; focus: [number, number] }) {
  const holder = useRef<HTMLDivElement>(null)
  const pointsRef = useRef(points)
  pointsRef.current = points
  useEffect(() => {
    const el = holder.current!
    const scene = new THREE.Scene()
    const camera = new THREE.PerspectiveCamera(40, 1, 0.1, 100)
    camera.position.set(0, 0, 7.5)
    const renderer = new THREE.WebGLRenderer({ antialias: true, alpha: true })
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2))
    el.appendChild(renderer.domElement)
    const globe = new THREE.Group()
    scene.add(globe)
    const sphere = new THREE.Mesh(
      new THREE.SphereGeometry(R, 64, 64),
      new THREE.MeshPhongMaterial({
        color: 0x102934,
        emissive: 0x071c27,
        shininess: 18,
        specular: 0x294958,
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
      color: 0x2a5966,
      transparent: true,
      opacity: 0.24,
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
      color: 0x6ba5a9,
      transparent: true,
      opacity: 0.68,
    })
    const countries = feature(
      world as never,
      (world as unknown as { objects: { countries: never } }).objects.countries,
    ) as unknown as { features: { geometry: { type: string; coordinates: unknown } }[] }
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
    }
    const light = new THREE.DirectionalLight(0xbee8ed, 2.1)
    light.position.set(-3, 4, 5)
    scene.add(light)
    scene.add(new THREE.AmbientLight(0x8daab4, 0.72))
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
        const color = p.kind === 'MODIS' ? 0xffa04d : p.kind === 'VIIRS' ? 0x48d9de : 0xff6c50
        const size = Math.min(0.09, 0.045 + Math.log1p(p.value) * 0.01)
        const mesh = new THREE.Mesh(
          new THREE.SphereGeometry(size, 8, 8),
          new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.95 }),
        )
        mesh.position.copy(xyz(p.lat, p.lon, 2.022))
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
      lastX = 0,
      lastY = 0,
      raf = 0
    const down = (e: PointerEvent) => {
      dragging = true
      lastX = e.clientX
      lastY = e.clientY
      el.setPointerCapture(e.pointerId)
    }
    const move = (e: PointerEvent) => {
      if (!dragging) return
      globe.rotation.y += (e.clientX - lastX) * 0.005
      globe.rotation.x = Math.max(
        -1.3,
        Math.min(1.3, globe.rotation.x + (e.clientY - lastY) * 0.005),
      )
      lastX = e.clientX
      lastY = e.clientY
    }
    const up = () => {
      dragging = false
    }
    el.addEventListener('pointerdown', down)
    el.addEventListener('pointermove', move)
    el.addEventListener('pointerup', up)
    function animate() {
      if (disposed) return
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
      renderer.dispose()
      el.removeChild(renderer.domElement)
    }
  }, [])
  useEffect(() => {
    ;(holder.current as HTMLDivElement & { updateMarkers?: () => void })?.updateMarkers?.()
  }, [points])
  return (
    <div
      className="globe-canvas"
      ref={holder}
      aria-label="Interactive three dimensional globe showing fire hotspots"
    />
  )
}
