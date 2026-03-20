# Theme Switcher — Multiple Visual Styles

## Context

The app currently uses a single "Jurassic Park" retro neon style (MeshPhongMaterial + UnrealBloomPass + CRT scanlines). The user wants to offer multiple visual styles including a modern glass/vitrail look and a cartoon style, switchable at runtime.

## Priority

Low — Feature enhancement. Implement after functional features are stable.

## Performance Constraints

The app already lags on large clusters (dev cluster). Any new theme must not degrade baseline performance. Glass/transmission materials are 2-3x more expensive per object than Phong.

## Themes

### 1. Jurassic Park (current — default)
- `MeshPhongMaterial` for all objects
- `UnrealBloomPass` with green neon glow
- CRT scanline overlay
- Dark green horizon sky shader
- Ground: black semi-transparent plane
- **GPU cost**: Low

### 2. Cartoon / Toon
- `MeshToonMaterial` with 3-step gradient map
- Bold outlines via `OutlinePass` or inverted-hull trick (scale + backface cull)
- Flat colors, no bloom
- Bright pastel sky (light blue gradient)
- White ground with subtle grid
- No CRT scanlines
- **GPU cost**: Low (same as Phong)

### 3. Glass / Vitrail (experimental)
- `MeshPhysicalMaterial` with `transmission`, `roughness`, `thickness`, `ior`
- Pods as glass blocks with colored tint
- Workload bounding boxes as frosted glass
- Namespace platforms as brushed metal (`metalness: 0.8, roughness: 0.3`)
- HDR environment map for reflections (small equirect, embedded)
- Tone mapping: `ACESFilmicToneMapping`
- No CRT scanlines, no bloom (or subtle bloom)
- Soft shadows under pods (`PCFSoftShadowMap`)
- **GPU cost**: High — show performance warning on activation
- **Mitigations**:
  - LOD: reduce tube segments, radial segments at distance
  - Disable transmission for resources beyond depth threshold
  - Option to disable shadows

## Architecture

### Theme Registry (`cmd/frontend/core/theme.js` — new file)

```
const THEMES = {
  jurassic: { name: 'Jurassic Park', materials: JurassicMaterials, postprocess: JurassicPost, sky: JurassicSky },
  cartoon:  { name: 'Cartoon',       materials: CartoonMaterials,  postprocess: CartoonPost,  sky: CartoonSky },
  glass:    { name: 'Glass',         materials: GlassMaterials,    postprocess: GlassPost,    sky: GlassSky, experimental: true },
};
```

### Material Factory Interface

Each theme provides a material factory with the same interface:

```js
{
  platform(forbidden)     → Material  // namespace island
  pod(status)             → Material  // pod block
  nodeBlock(status)       → Material  // node cube
  nodePlatform()          → Material  // node island
  tube()                  → Material  // service tube
  workloadBox(color)      → Material  // workload bounding box
  resourceMarker(color)   → Material  // generic resource
  ground()                → Material  // ground plane
}
```

Currently these are scattered functions in `core/materials.js`. Refactor into factory objects per theme.

### Post-Processing Config

Each theme provides:
```js
{
  bloom: { enabled, strength, radius, threshold },
  outline: { enabled, color, thickness },
  toneMapping: THREE.NoToneMapping | THREE.ACESFilmicToneMapping,
  scanlines: true | false,
}
```

### Sky Config

Each theme provides a sky setup function:
```js
setupSky(scene) → { sky: Mesh, fog: FogExp2 }
```

### Theme Switcher UI

- Dropdown or radio buttons in the HUD (next to context selector)
- `localStorage` persistence of selected theme
- On switch: rebuild all materials in-place (traverse scene, replace `.material`)
- Reconfigure post-processing pipeline
- Replace sky mesh
- Show warning badge for experimental themes

## Files to Modify/Create

| File | Action |
|------|--------|
| `cmd/frontend/core/theme.js` | **New** — Theme registry, switchTheme(), current theme state |
| `cmd/frontend/core/themes/jurassic.js` | **New** — Current materials/post/sky extracted |
| `cmd/frontend/core/themes/cartoon.js` | **New** — Toon materials, outline pass, pastel sky |
| `cmd/frontend/core/themes/glass.js` | **New** — Physical materials, env map, ACES tone mapping |
| `cmd/frontend/core/materials.js` | **Refactor** — Delegate to current theme's factory |
| `cmd/frontend/core/scene.js` | **Refactor** — Post-processing setup delegated to theme |
| `cmd/frontend/index.html` | **Modify** — Add theme selector in HUD |
| `cmd/frontend/styles/base.css` | **Modify** — CRT scanlines toggled by theme class on body |
| `cmd/frontend/app.js` | **Modify** — Import theme, wire selector |

## Commit Plan

1. `refactor(frontend): extract material factories from materials.js`
   - Create material factory interface, move current materials to jurassic factory
   - No behavior change

2. `refactor(frontend): extract post-processing and sky config from scene.js`
   - Make bloom/sky configurable via theme config object
   - No behavior change

3. `feat(frontend): add theme registry and switcher UI`
   - theme.js with registry, switchTheme()
   - HUD dropdown, localStorage persistence
   - Jurassic as only theme (proves the plumbing works)

4. `feat(frontend): add cartoon/toon theme`
   - MeshToonMaterial, gradient map, outline pass
   - Pastel sky, white ground, no scanlines

5. `feat(frontend): add glass/vitrail theme (experimental)`
   - MeshPhysicalMaterial with transmission
   - HDR env map (small embedded equirect)
   - ACES tone mapping, soft shadows
   - Performance warning on activation

## Verification

- Switch between 3 themes at runtime without page reload
- All resource types render correctly in each theme
- Tooltips, menus, actions work identically across themes
- Performance: measure FPS on dev cluster for each theme
- localStorage persists theme choice across sessions

## Open Questions

- [ ] Do we need a per-pod material cache to avoid GC pressure on theme switch?
- [ ] Should glass theme use env map from a CDN or embed a tiny one (~50KB)?
- [ ] Cartoon outline: OutlinePass (post-process, expensive) vs inverted hull (cheap but imperfect)?
