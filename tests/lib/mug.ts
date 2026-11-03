/**
 * The mug, its zone and the other objects, read off a desk memory where
 * every thing is a fixture and the main zone is the rule `main`: what the
 * tests read straight off the memory before, so they still check the same.
 */
export {
  mugOf as mug,
  mugSighting as sighting,
  mugHistory as history,
  mugModel as item,
  mainZone,
  mainPlacement as placement,
  otherObjects as others,
} from '@livinglayer/domain';
