import { defaultZepAppearance, isZepAppearance, validZepAppearance } from './zep-appearance.js';
// Legacy options remain valid for saved outfits using the original generated art.
export const APPEARANCE_OPTIONS = {
  skin: ['#f2c6a5', '#dba67d', '#b97c59', '#80513d'],
  hairStyle: ['ผมสั้น', 'ผมบ๊อบ', 'ผมลอน', 'ผมรวบ'],
  hairColor: ['#35313f', '#72503c', '#b08350', '#837399'],
  shirtStyle: ['เสื้อยืด', 'เสื้อเชิ้ต', 'เสื้อคลุม'],
  shirtColor: ['#8fbfb0', '#b3a3d6', '#dfab99', '#92b5cf', '#d6bd7e', '#d4a6bf'],
  pantsColor: ['#596477', '#777184', '#8b7e70', '#465951'],
};
export function defaultAppearance(seed = '') {
  return defaultZepAppearance(seed);
}
export function validAppearance(value) {
  if (isZepAppearance(value)) return validZepAppearance(value);
  return (
    !!value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).length === Object.keys(APPEARANCE_OPTIONS).length &&
    Object.entries(APPEARANCE_OPTIONS).every(
      ([key, options]) =>
        Number.isInteger(value[key]) && value[key] >= 0 && value[key] < options.length,
    )
  );
}
export function resolveAppearance(value, seed = '') {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      value = null;
    }
  }
  return validAppearance(value) ? value : defaultAppearance(seed);
}
