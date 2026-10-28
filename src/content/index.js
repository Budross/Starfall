// The content bundle the engine is given. Engine modules read content only through
// this object; they never import content modules or name content IDs (Z-01).
import { WORLD, FRAGMENTS } from './world.js';
import { ITEMS, RECIPES } from './items.js';
import { EQUIPMENT, PROVISIONS } from './equipment.js';
import { RESEARCH } from './research.js';
import { VISIBILITY, WORLDGEN, OBSERVATION, JOURNAL, STORY_PATH } from './provisional.js';

export const CONTENT = Object.freeze({
  world: WORLD,
  fragments: FRAGMENTS,
  items: ITEMS,
  recipes: RECIPES,
  equipment: EQUIPMENT,
  provisions: PROVISIONS,
  research: RESEARCH,
  visibility: VISIBILITY.value,
  worldgen: WORLDGEN.value,
  observation: OBSERVATION.value,
  journal: JOURNAL.value,
  storyPath: STORY_PATH.value
});
