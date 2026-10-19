import catalog from './zep-catalog.json' with { type: 'json' };

export const ZEP_CATALOG = catalog;
export const ZEP_SLOTS = ['skin', 'face', 'clothes', 'hair', 'mask', 'glasses'];
const allowed = Object.fromEntries(
  ZEP_SLOTS.map((slot) => [
    slot,
    new Set(catalog[slot].flatMap((shape) => shape.parts.map((part) => part.id))),
  ]),
);
export function isZepAppearance(value) {
  return value?.source === 'zep';
}
export function validZepAppearance(value) {
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    value.source === 'zep' &&
    Object.keys(value).length === ZEP_SLOTS.length + 1 &&
    ZEP_SLOTS.every(
      (slot) =>
        Number.isInteger(value[slot]) &&
        (allowed[slot].has(value[slot]) ||
          (['mask', 'glasses'].includes(slot) && value[slot] === 0)),
    )
  );
}
export function defaultZepAppearance(seed = '') {
  const n = [...seed].reduce((sum, char) => sum + char.charCodeAt(0), 0);
  return Object.fromEntries([
    ['source', 'zep'],
    ...ZEP_SLOTS.map((slot) => {
      if (slot === 'mask' || slot === 'glasses') return [slot, 0];
      const free = catalog[slot].filter((shape) => shape.acquisitionMode === 'free');
      const shapes = free.length ? free : catalog[slot];
      const shape = shapes[n % shapes.length];
      return [slot, shape.parts[n % shape.parts.length].id];
    }),
  ]);
}
