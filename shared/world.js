export const WORLD = {
  width: 1344,
  height: 960,
  step: 24,
  speed: 210,
  spawn: { x: 684, y: 468 },
  bounds: { x: 24, y: 24, w: 1296, h: 888 },
};
export const STATUSES = {
  available: { label: 'พร้อมคุย', color: '#3b9b73', emoji: '👋' },
  focus: { label: 'ขอโฟกัส', color: '#a789ca', emoji: '🎧' },
  away: { label: 'ไม่อยู่สักครู่', color: '#d5a24d', emoji: '☕' },
  office: { label: 'อยู่ที่ออฟฟิศ', color: '#5b8db9', emoji: '🏢' },
};
export const ROOMS = [
  {
    id: 'bloom',
    name: 'Bloom room',
    subtitle: 'ไอเดียดี ๆ เริ่มตรงนี้',
    color: '#e4d8ef',
    x: 960,
    y: 48,
    w: 336,
    h: 288,
    entry: { x: 1020, y: 300 },
    capacity: 8,
  },
  {
    id: 'orbit',
    name: 'Orbit room',
    subtitle: 'มาคุยให้เห็นภาพเดียวกัน',
    color: '#d8e7ed',
    x: 960,
    y: 576,
    w: 336,
    h: 288,
    entry: { x: 1020, y: 804 },
    capacity: 8,
  },
];
export const DESKS = [
  { id: '01', x: 528, y: 108 },
  { id: '02', x: 744, y: 108 },
  { id: '03', x: 528, y: 252 },
  { id: '04', x: 744, y: 252 },
  { id: '05', x: 528, y: 636 },
  { id: '06', x: 744, y: 636 },
  { id: '07', x: 528, y: 780 },
  { id: '08', x: 744, y: 780 },
  { id: '09', x: 96, y: 108 },
  { id: '10', x: 264, y: 108 },
];
export const PLANTS = [
  { x: 72, y: 384 },
  { x: 1272, y: 384 },
  { x: 72, y: 888 },
  { x: 888, y: 888 },
  { x: 888, y: 72 },
  { x: 456, y: 72 },
  { x: 1272, y: 912 },
  { x: 456, y: 888 },
  { x: 744, y: 504 },
];
export const DESK_SHAPE = { width: 120, height: 60, seatX: 60, seatY: 96 };
export const FURNITURE = [
  { id: 'sofa-north', x: 96, y: 576, w: 216, h: 60 },
  { id: 'sofa-south', x: 96, y: 756, w: 216, h: 60 },
  { id: 'bookshelf', x: 336, y: 624, w: 60, h: 144 },
  { id: 'coffee-table', x: 174, y: 672, w: 108, h: 42 },
  { id: 'coffee-bar', x: 192, y: 384, w: 192, h: 42 },
  { id: 'hall-planter', x: 1064, y: 404, w: 192, h: 42 },
];
const meetingWalls = ROOMS.flatMap((r) => [
  { x: r.x, y: r.y, w: r.w, h: 8 },
  { x: r.x + r.w - 8, y: r.y, w: 8, h: r.h },
  { x: r.x, y: r.y + r.h - 8, w: r.w, h: 8 },
  { x: r.x, y: r.y, w: 8, h: 168 },
  { x: r.x, y: r.y + 240, w: 8, h: 48 },
]);
export const WALLS = [
  ...meetingWalls,
  { x: 48, y: 48, w: 384, h: 8 },
  { x: 48, y: 48, w: 8, h: 288 },
  { x: 424, y: 48, w: 8, h: 288 },
  { x: 48, y: 328, w: 144, h: 8 },
  { x: 288, y: 328, w: 144, h: 8 },
];
export const OBSTACLES = [
  ...WALLS,
  ...DESKS.map((d) => ({ x: d.x, y: d.y, w: DESK_SHAPE.width, h: DESK_SHAPE.height })),
  ...ROOMS.map((r) => ({ x: r.x + 96, y: r.y + 96, w: 168, h: 84 })),
  ...PLANTS.map((p) => ({ x: p.x - 17, y: p.y - 17, w: 34, h: 34 })),
  ...FURNITURE,
];
export function canStand(x, y, radius = 11) {
  return (
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    x >= WORLD.bounds.x + radius + 1 &&
    y >= WORLD.bounds.y + radius + 1 &&
    x <= WORLD.bounds.x + WORLD.bounds.w - radius - 1 &&
    y <= WORLD.bounds.y + WORLD.bounds.h - radius - 1 &&
    !OBSTACLES.some(
      (o) =>
        x + radius > o.x && x - radius < o.x + o.w && y + radius > o.y && y - radius < o.y + o.h,
    )
  );
}
export function snapToGrid(point) {
  const center = (value) => Math.floor(value / WORLD.step) * WORLD.step + WORLD.step / 2;
  return { x: center(point.x), y: center(point.y) };
}
export function isGridPoint(point) {
  return (
    Number.isFinite(point.x) &&
    Number.isFinite(point.y) &&
    (point.x - WORLD.step / 2) % WORLD.step === 0 &&
    (point.y - WORLD.step / 2) % WORLD.step === 0
  );
}
export function movementDirection(dx, dy) {
  if (!Number.isFinite(dx) || !Number.isFinite(dy) || (!dx && !dy)) return { dx: 0, dy: 0 };
  return { dx: Math.sign(dx), dy: Math.sign(dy) };
}
export function nextGridPoint(point, dx, dy) {
  const direction = movementDirection(dx, dy);
  return { x: point.x + direction.dx * WORLD.step, y: point.y + direction.dy * WORLD.step };
}
export function canStep(from, to) {
  if (!isGridPoint(from) || !isGridPoint(to)) return false;
  const dx = Math.abs(to.x - from.x),
    dy = Math.abs(to.y - from.y);
  if ((!dx && !dy) || dx > WORLD.step || dy > WORLD.step) return false;
  if (dx && dy) {
    // Both routes around the corner must be clear; never squeeze diagonally
    // past furniture or a thin wall even when the destination cell is empty.
    const horizontal = { x: to.x, y: from.y },
      vertical = { x: from.x, y: to.y };
    if (
      !canStep(from, horizontal) ||
      !canStep(from, vertical) ||
      !canStep(horizontal, to) ||
      !canStep(vertical, to)
    )
      return false;
  }
  // Check the whole swept foot area, including thin walls between cell centers.
  for (let i = 0; i <= 6; i++)
    if (!canStand(from.x + ((to.x - from.x) * i) / 6, from.y + ((to.y - from.y) * i) / 6))
      return false;
  return true;
}
export function renderPosition(peer, serverTime) {
  if (!peer.motion) return { x: peer.x, y: peer.y };
  const { from, to, startedAt, durationMs } = peer.motion;
  const progress = Math.max(0, Math.min(1, (serverTime - startedAt) / durationMs));
  return { x: from.x + (to.x - from.x) * progress, y: from.y + (to.y - from.y) * progress };
}
export function findPath(from, target) {
  const origin = snapToGrid(from),
    destination = snapToGrid(target);
  if (!canStand(origin.x, origin.y) || !canStand(destination.x, destination.y)) return [];
  const size = WORLD.step,
    cols = WORLD.width / size,
    rows = WORLD.height / size;
  const center = (n) => n * size + size / 2;
  const cell = (p) => ({ x: Math.floor(p.x / size), y: Math.floor(p.y / size) });
  const start = cell(origin),
    goal = cell(destination),
    key = (x, y) => y * cols + x;
  const startKey = key(start.x, start.y),
    goalKey = key(goal.x, goal.y);
  const queue = [startKey],
    parents = new Map([[startKey, -1]]);
  for (let head = 0; head < queue.length && queue.length <= cols * rows; head++) {
    const current = queue[head];
    if (current === goalKey) break;
    const x = current % cols,
      y = Math.floor(current / cols);
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ]) {
      const nx = x + dx,
        ny = y + dy,
        next = key(nx, ny);
      if (
        nx < 0 ||
        ny < 0 ||
        nx >= cols ||
        ny >= rows ||
        parents.has(next) ||
        !canStep({ x: center(x), y: center(y) }, { x: center(nx), y: center(ny) })
      )
        continue;
      parents.set(next, current);
      queue.push(next);
    }
  }
  if (!parents.has(goalKey)) return [];
  const path = [];
  for (let k = goalKey; k !== startKey; k = parents.get(k))
    path.unshift({ x: center(k % cols), y: center(Math.floor(k / cols)) });
  return path;
}
export function roomById(id) {
  return ROOMS.find((r) => r.id === id);
}
export function roomAt(point) {
  return ROOMS.find(
    (r) => point.x > r.x && point.x < r.x + r.w && point.y > r.y && point.y < r.y + r.h,
  );
}
export function seatPosition(id) {
  const d = DESKS.find((s) => s.id === id);
  return d ? snapToGrid({ x: d.x + DESK_SHAPE.seatX, y: d.y + DESK_SHAPE.seatY }) : null;
}
