// Map camera presentation constants (S-24). Camera framing is a UI choice and stays
// independent of physical distances and Area dimensions in geography: changing an Area
// radius never changes these, and changing these never moves anything.
const BASE_LOCAL_DISTANCE = 125;
const UI_BASE = { width: 1600, height: 900 };
const UI_MAX_SCALE = 3;

export const VIEW_CONFIG = Object.freeze({
  // How far from the focused site Local View draws unparented objects.
  localRadius: 200,
  // Local View camera stand-off. The vertical field of view is fixed, so on viewports
  // narrower than square the camera backs off to keep the same horizontal framing.
  localCameraDistance: (width, height) => BASE_LOCAL_DISTANCE / Math.min(1, width / Math.max(1, height)),
  // Ship glyphs glide between their last two committed observations over this many ms
  // (one tick). Presentation only: it never extrapolates past what was observed.
  motionInterpolationMs: 500,
  // UI scale (S-35). The shell is laid out for about 1600×900 CSS px; larger windows scale the
  // whole UI up (map included) so 2K/4K screens show the same layout, never smaller than 1×.
  uiScale: (width, height) => Math.round(100 * Math.min(UI_MAX_SCALE, Math.max(1, Math.min(width / UI_BASE.width, height / UI_BASE.height)))) / 100
});
