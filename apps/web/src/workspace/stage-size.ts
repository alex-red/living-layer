interface Size {
  width: number;
  height: number;
}

/**
 * The size the stage is shaped to: the running camera's own frame once it is
 * known, else the photo's. Shaped to a photo, a camera of another shape is
 * letterboxed inside the stage, so what is drawn over it in shares of the
 * stage moves when a frame is held at the camera's size.
 */
export function stageSize(camera: boolean, cameraSize: Size | null, photo: Size): Size {
  return camera && cameraSize ? cameraSize : photo;
}
