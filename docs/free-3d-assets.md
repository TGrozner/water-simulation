# Free 3D Asset Research

This project should stay CC0-first for vendored runtime assets. CC-BY assets are
usable only if we add a durable credits surface and track author/source/license
per file.

## Imported Now

- Kenney Nature Kit 2.1: CC0, GLB files, very small low-poly cave/rock/waterfall
  pieces. Imported subset lives in `public/assets/kenney-nature-kit/`.
  Source: https://kenney.nl/assets/nature-kit

## Best Next Sources

- Quaternius Stylized Nature / Ultimate Nature: CC0 low-poly rocks, mushrooms,
  plants, fantasy props, and cave dressing. Best match for the current stylized
  cave direction. Source: https://quaternius.com/
- OpenGameArt Free Mine Assets Pack: CC0 mine supports, rails, lamps, minecart,
  stalagmites/stalactites, stones, and goldmine props. Strongest source for the
  Deep Rock-like mining identity. Source:
  https://opengameart.org/content/free-mine-assets-pack
- Kenney Modular Dungeon Kit: CC0 GLB dungeon corridors, gates, stairs, wall
  details, and floor props. Useful for authored mission markers and mine
  structures, less natural than cave kits. Source:
  https://kenney.nl/assets/modular-dungeon-kit
- ambientCG: CC0 PBR materials, terrain, decals, HDRIs, and some models. Best
  used for wet rock, mud, mineral, normal, roughness, and decal material passes,
  not broad raw model import. Source: https://ambientcg.com/
- Poly Haven: CC0 models, textures, and HDRIs. Good for high-quality rocks and
  lighting references, but assets are often much heavier than this repo needs.
  Source: https://polyhaven.com/

## Avoid By Default

- Sketchfab: many relevant cave and mine assets are CC-BY. Use only with an
  explicit credits implementation.
- ShareTextures raw files: attractive materials, but its redistribution terms are
  not as clean for vendoring into a public repository as CC0-only sources.

## Import Policy

- Prefer GLB/glTF.
- Keep each imported batch small enough for GitHub Pages. Downscale or convert
  textures before vendoring.
- Add a `NOTICE.md` next to every imported source folder.
- Keep external assets in `public/assets/<source-pack>/` so Vite copies them
  directly and runtime paths remain simple.
