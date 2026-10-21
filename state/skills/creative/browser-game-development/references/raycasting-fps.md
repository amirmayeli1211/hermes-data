# First-person 3D via a DDA raycaster

For a dependency-free single-file game, a raycaster gives a 3D feel at 2D cost:
one ray per screen column, O(columns × map size) per frame, no GPU, no assets.
Use this when the user asks for something Counter-Strike / Doom / Wolfenstein-like
and the deliverable must stay one self-contained `.html`.

## Map representation

Keep the map a 2D grid of characters. `.` = floor, `#` = wall. Walls are the only
solid tiles; everything else (enemies, items, the player) is a sprite. This keeps
collision, rendering, and AI on one shared grid.

## DDA per column

For each screen column `x` in `[0, W)`:

1. `cameraX = 2*x/W - 1`
2. `rayAngle = player.angle + atan(cameraX * tan(fov/2))` — fov ~60°.
3. `rx = cos(rayAngle)`, `ry = sin(rayAngle)`.
4. Step the ray with the DDA: maintain `mapX/mapY`, `deltaDistX = |1/rx|`,
   `deltaDistY = |1/ry|`, `sideDistX/sideDistY`, and `stepX/stepY` (±1). Advance
   whichever side distance is smaller; stop when the stepped cell is not `.`.
5. Perpendicular distance: if the hit was on an X side,
   `perpDist = (mapX - player.x + (1 - stepX)/2) / rx`; otherwise the Y form.
   **Use the perpendicular distance, not the Euclidean one** — it removes the
   fisheye (walls stay straight instead of bowing toward the camera edges).
6. Wall height `= screenH / perpDist * scale`; draw a vertical strip.

Handle `rx === 0` / `ry === 0` by setting the corresponding `deltaDist` to a
huge number (Infinity works) so that side never advances — a ray parallel to a
grid line must not divide by zero.

## Shading

- Shade by side: NS-facing walls one tone, EW-facing walls a darker tone. This is
  what makes corners readable.
- Shade by distance: `factor = max(0.18, 1 - dist/14)`. Cap the floor so distant
  walls stay visible rather than black.
- Fog is just more distance darkening; keep it subtle or the game reads as a
  tunnel.

## Sprite billboards (enemies, items)

1. For each sprite, compute `dx, dy` from the player and `dist = hypot(dx, dy)`.
2. `angle = atan2(dy, dx) - player.angle`, normalised to `[-π, π]`. If `|angle|`
   exceeds half the fov (plus a small margin), skip — it is off-screen.
3. `perpDist = dist * cos(angle)` (same correction as walls). If `< 0.15`, skip.
4. `screenX = W/2 + (tan(angle)/tan(fov/2)) * (W/2)`.
5. `spriteHeight = (H / perpDist) * scale`; width proportional.
6. **Sort sprites back-to-front by distance** before drawing, so nearer ones
   occlude farther ones.
7. **Per column, test against the z-buffer**: only draw a sprite column where
   `perpDist < zBuffer[col]`. Without this, sprites bleed through walls.
8. Draw sprites as vertical strips (a few rects per column is enough); a full
   textured sprite is unnecessary at this resolution.

## Collision

- Axis-separated: resolve X, then Y. Resolving both at once sticks in corners.
- Collide a small footprint box (e.g. 0.22 radius) against the grid, not the
  sprite. Sample the four corners of the footprint so the head can overlap a
  wall without feeling clipped.
- Normalise diagonal input by `1/sqrt(2)`.
- Enemies use the same collision, slower speed, and stop within ~1.6 units of the
  player (melee range) instead of overlapping.

## AI (minimal, good enough)

- State machine: `patrol` (random walk, slow) ↔ `chase` (move toward player,
  shoot on cooldown) when line-of-sight holds and within range.
- Line of sight: DDA from enemy to player; any wall cell blocks.
- Shoot on a cooldown timer (1.0–1.9 s), only if LOS still holds at fire time.
- Flash the enemy white for ~0.12 s on hit so hits read without a health bar.

## Audio

Procedural Web Audio (see SKILL.md §4). A gunshot is a short noise burst through
a lowpass filter; hits/deaths are short oscillator sweeps. Resume the context on
the first click.

## Pitfalls

- **Fisheye if you use Euclidean distance for wall height.** Always divide by
  `cos(rayAngle - player.angle)` (i.e. use perpendicular distance). Walls bow
  outward toward the screen edges otherwise.
- **Sprite bleed-through walls** if you skip the z-buffer test per column. The
  z-buffer must be the per-column wall distance, filled during the ray pass.
- **Sprites drawn in arbitrary order flicker.** Sort by distance, far-to-near,
  every frame.
- **Division by zero** when `rx` or `ry` is ~0. Set `deltaDist` to Infinity in
  that case; do not special-case the whole column.
- **A one-tile-thick wall can be stepped through** if collision uses the sprite
  centre instead of a footprint. Keep the footprint radius below half a tile.
- **Enemies that never stop** overlap the player and look broken. Stop within
  melee range and face the player.
- **Canvas resolution**: keep it modest (640×360 or lower) and scale up with CSS
  `image-rendering: pixelated`. Raycasting cost is O(columns); higher resolution
  is pure waste and softens the pixel look.
- **Mouse look needs pointer lock.** Request on click; accumulate `movementX`
  into the angle. Without lock, the cursor leaves the window and look stops.
