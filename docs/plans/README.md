# Plans

The design notes Living Layer was built from. Each one says what was planned, and its _As built_ section says where the build differs, so code comments link here for the reasons behind a choice. [architecture.md](../architecture.md) describes how things work now; where a plan and the architecture disagree, the architecture is right.

## The room

| Plan                                 | Status                                                         |
| ------------------------------------ | -------------------------------------------------------------- |
| [iso-models.md](iso-models.md)       | Built. Photo-accurate isometric models of furniture.           |
| [photo-scene.md](photo-scene.md)     | Built. A scene drafted from one photo.                         |
| [corner-camera.md](corner-camera.md) | Built. One calibrated corner camera; the isometric room first. |
| [workspace.md](workspace.md)         | Built. The scene-first workspace.                              |
| [room-coach.md](room-coach.md)       | Built. Nudges from what the room's stats say.                  |

## Things

| Plan                                       | Status                                                  |
| ------------------------------------------ | ------------------------------------------------------- |
| [fixtures.md](fixtures.md)                 | Built. Lamps, switches and other things placed by hand. |
| [things-and-stats.md](things-and-stats.md) | Built. Stats on things, kept as history.                |
| [one-thing.md](one-thing.md)               | Built. The mug is a thing like any other.               |
| [people-and-pets.md](people-and-pets.md)   | Phase 1 built; phases 2 and 3 planned.                  |
| [ask-room.md](ask-room.md)                 | Built. Asking the room about its history.               |

## The AI brush

| Plan                                     | Status                                               |
| ---------------------------------------- | ---------------------------------------------------- |
| [ai-brush.md](ai-brush.md)               | Built; live calls tested against a mocked API only.  |
| [brush-relations.md](brush-relations.md) | Built in the demo; Spark's reading not yet run live. |
| [agent-tooling.md](agent-tooling.md)     | Done. The checks and benches that speed iteration.   |

## Cameras, tracking and Home Assistant

| Plan                                   | Status                                                   |
| -------------------------------------- | -------------------------------------------------------- |
| [tracking.md](tracking.md)             | Built. Always-on tracking by the server.                 |
| [multi-tracking.md](multi-tracking.md) | Phases 0–4 built in part; phase 5 built as the GPU and Apple Vision trackers; 6 not started. |
| [streaming.md](streaming.md)           | Network cameras built; the phone's later phases on hold. |
| [mqtt.md](mqtt.md)                     | Built. Our own entities in Home Assistant over MQTT.     |
| [desktop-node.md](desktop-node.md)     | Built; not yet run on a real desktop.                    |

## Experiment logs

| Log                                        | What it tried                                               |
| ------------------------------------------ | ----------------------------------------------------------- |
| [sam-experiments.md](sam-experiments.md)   | Whether a better SAM mask places things better (it didn't). |
| [sam3d-experiment.md](sam3d-experiment.md) | SAM 3D Objects for a turned thing's shape. Experimental.    |

## Roadmap

1. **People and pets** ([plan](people-and-pets.md)). Phase 1 adds a person, a cat or a dog by name alone, drawn in the room with default looks; a seated person is merged into their seat. Later phases find them with the camera and show them in Home Assistant.
2. **Several rooms.** A home today is one room and one calibrated camera per mode (`memory.scene`, `memory.camera`). Several rooms, each with its own camera, let the lab say where everyone is (people, pets and followed things) across the home, and give each member's place a room. Needs its own plan: rooms in desk memory, a camera per room in calibration and the watcher, and the outline grouped by room.
3. **Live checks still to run.** The unattended desk loop on a real camera and lamp, MQTT against a real broker and Home Assistant through restarts, and the appearance fallback on real clips (see each plan's _As built_).
