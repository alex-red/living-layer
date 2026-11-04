/** Which of the trackers' boxes the canvas draws: the tracking layer's, the follower's or the watcher's. */
export type FollowDraw = 'tracking' | 'follow' | 'watch' | null;

/**
 * Over the live camera the Tracking layer owns every tracker's boxes, so with it off none are drawn;
 * on a photo or the demo the follower's boxes, else the watcher's, show without it.
 */
export function followDraw(at: {
  camera: boolean;
  tracking: boolean;
  follow: boolean;
  watching: boolean;
  picture: boolean;
}): FollowDraw {
  if (at.camera) return at.tracking ? 'tracking' : null;
  if (at.follow) return 'follow';
  return at.watching && at.picture ? 'watch' : null;
}
