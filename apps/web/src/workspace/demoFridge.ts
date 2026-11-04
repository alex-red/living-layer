/**
 * The fridge's placeholder camera: photos of one real fridge, redrawn by Muse
 * Image with everyday store-brand items in place of the real ones, shown in the picture pane until a camera
 * or photo of your own is there.
 */
export const FRIDGE_VIEWS = {
  open: {
    label: 'Open',
    alt: 'The fridge with both doors open: leftovers, milk, cheese, jars and sauces on its shelves, vegetables and eggs in its drawers',
  },
  'left-door': {
    label: 'Left door',
    alt: 'The fridge’s left door: mayonnaise, mustard, hot sauces and a jar of spread in its bins',
  },
  'right-door': {
    label: 'Right door',
    alt: 'The fridge’s right door: a box, pickles, syrup, milk, dressings and lemon juice in its bins',
  },
  closed: { label: 'Closed', alt: 'The fridge closed, a blank weekly planner on its left door' },
} as const;
export type FridgeView = keyof typeof FRIDGE_VIEWS;
/** Every view's size, in pixels. */
export const FRIDGE_PHOTO = { width: 960, height: 1280 };

export function fridgeViewUrl(view: FridgeView): string {
  return `${import.meta.env.BASE_URL}demo/fridge/${view}.webp`;
}
