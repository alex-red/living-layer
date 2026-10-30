# Plan: MQTT and our own Home Assistant entities

Status: built, see [As built](#as-built). Builds on [tracking.md](tracking.md) (built) and the [Tracking](../architecture.md#tracking) section of the architecture.

## Goal

Today Living Layer only _acts on_ Home Assistant: a rule turns a light or switch on over the REST API. Home Assistant can't see what Living Layer knows. This plan turns that around:

1. **Living Layer publishes its own entities to Home Assistant over MQTT.** For example `binary_sensor.ll_office_presence`, on or off. They show up in Home Assistant by themselves, grouped under one _Living Layer_ device, and survive restarts on both sides.
2. **The person decides which entities exist and what each one means.** Nothing is published until someone adds an entity in the lab: a name, a kind, and what its state comes from (_the mug is in the coaster zone_, _something moved on the desk in the last 5 minutes_, _the mouse is missing_).
3. **Home Assistant does the rest.** Automations, dashboards and combined conditions live in Home Assistant, where people already write them. That also covers [Combined conditions](../architecture.md#not-built-yet) without building a rule language here.

The existing REST control stays as it is. MQTT is a second, separate path, for publishing states.

## Why MQTT discovery, not the REST API

Home Assistant's REST API can set any state (`POST /api/states/binary_sensor.x`), and we already hold a token. But a state set that way has no unique id: it can't be renamed or given an area in Home Assistant's UI, it disappears when Home Assistant restarts, and nothing shows that Living Layer is offline. MQTT discovery gives real entities with a unique id, a device, an availability topic and retained states. The cost is a broker (Mosquitto, usually the Home Assistant add-on), which most Home Assistant installs that use Zigbee2MQTT or ESPHome already run.

## Names

The example `ll.office.presence` isn't a valid Home Assistant entity id: an entity id is exactly `domain.object_id`, one dot. So the person picks a **key**, and the domain comes from the kind:

| Person types      | Kind          | Entity in Home Assistant           | Topic prefix                   |
| ----------------- | ------------- | ---------------------------------- | ------------------------------ |
| `office_presence` | binary sensor | `binary_sensor.ll_office_presence` | `livinglayer/office_presence/` |
| `mug_zone`        | sensor (enum) | `sensor.ll_mug_zone`               | `livinglayer/mug_zone/`        |

- A key is `^[a-z0-9_]{1,48}$`, unique per mode. The lab offers one made from the name (`Office presence` → `office_presence`) and shows the full entity id as you type.
- The `ll_` prefix is fixed, so our entities sort together and can't collide with the person's own.
- The discovery payload sets `default_entity_id` (`binary_sensor.ll_office_presence`). The older `object_id` key was deprecated in Home Assistant 2025.10 and removed in 2026.4, so it isn't sent. Check this against the current [MQTT integration docs](https://www.home-assistant.io/integrations/mqtt/) when building.
- `unique_id` is `livinglayer_<install id>_<entity id>`, where the install id is a uuid made once and kept in `settings`, and the entity id is the entity's own uuid. Renaming the key in the lab therefore keeps the same Home Assistant entity, along with its history and the area someone gave it. Home Assistant keeps its entity id too, unless someone renames it there.

## Data model (`packages/domain/src/expose.ts`)

Kept in desk memory as `exposed`, like rules, so each mode has its own and reset keeps them (they describe the home, not one sighting).

```ts
export const EXPOSE_KINDS = ['binary_sensor', 'sensor'] as const;

export const exposeSourceSchema = z.discriminatedUnion('kind', [
  // On while the object's last SAM verdict for this zone is inside.
  z.object({ kind: z.literal('in_zone'), objectId: z.string(), zoneId: z.string() }).strict(),
  // On while any of these objects is inside the zone; as a sensor, how many are.
  z
    .object({
      kind: z.literal('any_in_zone'),
      objectIds: z.array(z.string()).min(1),
      zoneId: z.string(),
    })
    .strict(),
  // Which of the object's zones it's in, or `none`. Sensor only (enum).
  z.object({ kind: z.literal('zone_of'), objectId: z.string() }).strict(),
  // seen / moved / missing, for an object or a tracked fixture. Sensor (enum), or binary `missing`.
  z.object({ kind: z.literal('status'), thingId: z.string() }).strict(),
  // On while pixels change inside the zone; off after `holdS` seconds of stillness. No SAM.
  z
    .object({
      kind: z.literal('motion'),
      zoneId: z.string(),
      holdS: z.number().int().min(5).max(3600),
    })
    .strict(),
  // On while the server is watching the camera.
  z.object({ kind: z.literal('watching') }).strict(),
]);

export const exposedEntitySchema = z
  .object({
    id: z.string().uuid(),
    key: z.string().regex(/^[a-z0-9_]{1,48}$/),
    name: z.string().min(1).max(60), // "Office presence"
    kind: z.enum(EXPOSE_KINDS),
    source: exposeSourceSchema,
    /** Home Assistant's device_class: occupancy, presence, motion, problem, enum… */
    deviceClass: z.string().optional(),
    icon: z
      .string()
      .regex(/^mdi:[a-z0-9-]+$/)
      .optional(),
  })
  .strict();
```

- `exposeProblem(memory, entity)` says why one can't be saved: the key is taken, the kind doesn't fit the source (`zone_of` is a sensor), or the object, zone or fixture it names is gone. Deleting an object, zone or fixture leaves its entities in place but marks them `broken`, which publishes `unavailable`, so a Home Assistant automation notices instead of seeing a frozen state.
- `evaluateExposed(memory, watch, now)` is pure: from desk memory and the watcher's state it returns each entity's `{ state, attributes, available }`. It's the only place states are worked out, so the lab and MQTT always show the same thing, and tests need no broker.
- `discoveryConfig(entity, installId)` builds the retained config payload; also pure.

### Where states come from

- **Zone sources read SAM verdicts only**: the main zone's `placement` and each rule's own inside/outside story. Same principle as the lamp: a local box is a reason to look again, never a verdict. A state changes when the verdict changes, which happens on a confirmed `entered` or `left`.
- **Zones that aren't rules.** `in_zone` needs a verdict for that object and zone. Today a verdict exists only where a rule or the main zone ties them together. So step 2 adds rules with no entity (`entityId: null`, "just tell Home Assistant"), which `ruleGate` decides like any other and never switches anything. The rule editor gets a fourth target, _Home Assistant only_.
- **Stale verdicts.** `placementGate` refuses sightings older than five minutes, but a mug that sits still for an hour is still inside. While the watcher runs and the thing's region hasn't changed (layer 0), the last verdict stands. When watching is off, the state stays at the last verdict with `stale: true` in its attributes and `last_confirmed` set; it doesn't go unavailable. See the open decisions.
- **Motion is local and says so.** `motion` reuses the watcher's stillness gate (share of pixels changed by more than 24 grey levels, against 1.5%), measured inside the zone instead of around one thing. It costs nothing and calls no model. It needs the watcher on and the camera fixed; otherwise the entity is unavailable. Its attributes say `source: motion` so nobody mistakes it for a SAM verdict.

### Presence

Living Layer follows things, not people, so _office presence_ needs a choice. Three ways, cheapest first:

1. **Motion in a zone** (`motion`, above). Free, immediate, and wrong when someone sits very still or a fan moves. Good for "someone has been at the desk recently", with a hold of a few minutes.
2. **Things as evidence**: `any_in_zone` with the mouse, keyboard or chair. The mouse moving off its resting zone is a fair sign someone's working. SAM-confirmed, so trustworthy, but slow to clear.
3. **Asking SAM for `person`.** A tracked object of concept `person`, confirmed by hand like any other. Template matching follows people badly, so expect frequent re-anchors and spend. Not in this plan's first steps.

The lab's _Add entity_ offers presence as a preset of the first kind (`binary_sensor`, `device_class: occupancy`, `motion` on a zone, hold 300 s) and says in one line what it does and doesn't detect.

## MQTT side (`apps/server/src/mqtt.ts`)

- **Client:** the `mqtt` package (MQTT.js, MIT), one connection per server, shared by both modes but only live mode publishes. Demo mode never touches the network, as everywhere else: the lab shows what _would_ be published.
- **Config** (`.env`, checked in `config.ts`; never sent to the browser):

  ```
  MQTT_URL=            # mqtt://host:1883 or mqtts://host:8883, no credentials in the URL
  MQTT_USERNAME=
  MQTT_PASSWORD=
  MQTT_DISCOVERY_PREFIX=homeassistant
  MQTT_BASE_TOPIC=livinglayer
  MQTT_LIVE_ENABLED=false
  ```

- **Topics** (`<base>` = `livinglayer`):

  | Topic                                  | Retained | Payload                                                   |
  | -------------------------------------- | -------- | --------------------------------------------------------- |
  | `<base>/status`                        | yes      | `online` on connect, `offline` as the last will           |
  | `homeassistant/<kind>/ll_<key>/config` | yes      | discovery config; empty payload deletes the entity        |
  | `<base>/<key>/state`                   | yes      | `ON`/`OFF` for binary sensors, the value for sensors      |
  | `<base>/<key>/attributes`              | yes      | JSON: `observed_at`, `segment_run_id`, `stale`, `source`… |
  | `<base>/<key>/availability`            | yes      | `online` / `offline`, for broken entities and motion      |

  Each config lists both availability topics (`availability_mode: all`), so all entities go unavailable when the server stops and one goes unavailable on its own when its source breaks.

- **Device:** one `device` block, `{ identifiers: ['livinglayer_<install id>'], name: 'Living Layer', manufacturer: 'Living Layer', sw_version }`, in every config.
- **When it publishes.** `syncExposed()` runs where the watcher's `sync` already runs (every successful desk, fixture, scene or item change), on each watcher state change, and every 5 s for time-based sources (motion holds). It evaluates, diffs against what it last sent, and publishes only what changed. Configs are published on connect, when an entity is saved or its key changes (the old config topic gets an empty payload first), and again whenever Home Assistant announces `online` on `homeassistant/status`, as Home Assistant asks of discovery publishers.
- **Deleting** an entity publishes an empty retained config and clears its state topics.
- **Failures** never block a rule or the watcher. A dropped connection reconnects with backoff (MQTT.js does this); states are re-sent in full on reconnect. The lab shows the connection state.

## Routes

- `GET /api/expose/:mode`: entities, each with its current state and the entity id it becomes, plus the broker state (`off`, `connecting`, `connected`, `error`; never the URL's credentials).
- `POST /api/expose/save`: create or update one; checked with `exposedEntitySchema` and `exposeProblem`.
- `POST /api/expose/delete`.
- `GET /api/expose/:mode/events`: or reuse the watcher's event stream and add states to it, so the lab updates live. Preferred: one stream.

Same loopback host and origin checks as every other route.

## UI

- **Outline:** a _Home Assistant_ section under Fixtures, listing the exposed entities with their state as a small chip (`on`, `off`, `desk`, `unavailable`).
- **Add entity:** a name, the key and entity id it gives (`binary_sensor.ll_office_presence`, editable key), then _what it shows_ as a sentence built from pickers, like the rule editor: _On while_ [the mug] _is in_ [the coaster zone]. Presets: presence (motion), object in a zone, which zone an object is in, missing.
- **Inspector for one:** the sentence, the live state and attributes, the topics, _Copy entity id_, delete.
- **Rule editor:** the _Home Assistant only_ target, and on any rule, _Also show in Home Assistant_, which makes an `in_zone` entity for it in one click.
- **Setup tab:** broker status, and in demo mode a log of what would have been published.

## Code

| Where                           | What                                                                          |
| ------------------------------- | ----------------------------------------------------------------------------- |
| `packages/domain/src/expose.ts` | schemas, `exposeProblem`, `evaluateExposed`, `discoveryConfig`, `keyFromName` |
| `packages/domain/src/watch.ts`  | motion per zone, so `motion` sources can read it                              |
| `packages/domain/src/index.ts`  | `exposed` on `DeskMemory`; rules with `entityId: null`; `upgradeMemory`       |
| `apps/server/src/mqtt.ts`       | connection, last will, birth handling, diffing, publishing                    |
| `apps/server/src/config.ts`     | `MQTT_*`                                                                      |
| `apps/server/src/app.ts`        | `/api/expose/*`; calling `syncExposed` next to the watcher's `sync`           |
| `apps/web/src/workspace/`       | outline section, `ExposePanel.tsx`, rule editor target                        |
| `scripts/doctor.ts`             | connects to the broker and reports                                            |
| `tests/expose.test.ts`          | evaluation and discovery payloads, pure                                       |
| `tests/mqtt.test.ts`            | against a fake publisher; one test against `aedes` in process if cheap        |

## Build order

1. Domain: `exposed` in desk memory, `evaluateExposed` for `in_zone`, `zone_of`, `status`, `watching`, `discoveryConfig`. Tests only.
2. Rules with no entity (_Home Assistant only_), decided by `ruleGate`, never switching anything.
3. `mqtt.ts` and `MQTT_*` config, against a fake publisher; then against a real Mosquitto and Home Assistant by hand: add `office_presence`, see `binary_sensor.ll_office_presence` appear, flip it, restart each side.
4. Routes and the lab: outline section, add entity, inspector, demo log.
5. `motion` sources: zone motion in the watcher, the presence preset.
6. `any_in_zone` and counts.
7. `docs/architecture.md`: an MQTT section and the diagram's new arrow; _As built_ here.

## Later, not in this plan

All built since, presence locally instead of with SAM: see [The later list, as built](#the-later-list-as-built).

- **Commands from Home Assistant**: a `switch.ll_watching` to turn watching on and off, a `button.ll_check_rules`. Needs a subscribe path and the same loopback-level trust decision for the broker.
- **Controlling lights over MQTT** instead of REST, for homes without a token.
- **`device_tracker`** entities that place an object in a Home Assistant zone, and an `event` entity for entered/left.
- **SAM `person`** as a presence source.

## Open decisions

- **Stale states.** Keep the last verdict with `stale: true` when watching is off (proposed), or go unavailable? Unavailable is more honest; the last verdict is more useful in automations that only care about changes.
- **Both modes on the broker?** Proposed: only live publishes. Publishing demo under `ll_demo_*` would let someone try automations without a camera, at the cost of junk entities in their Home Assistant.
- **Entities in desk memory or their own table?** Desk memory (proposed) keeps them beside the rules and zones they name, and reset already knows to keep them.
- **Broker settings in the lab?** Proposed: `.env` only, like `HA_TOKEN`. The Setup tab shows status, not secrets.

## As built

Built in one pass, all seven steps, with the open decisions taken as proposed: stale states keep the last verdict with `stale: true`, only live publishes, entities live in desk memory, broker settings stay in `.env`. Differences from the plan:

- **Zones are named by rule.** A zone in desk memory belongs to one rule and one object, so sources name zones by rule id (the main zone as `main`), and `in_zone` needs no object. `any_in_zone` became `any_inside`: a list of zones, each with its own object.
- **States without a verdict.** A zone with no verdict yet makes its entity unavailable rather than inventing an `off`.
- **Its own event stream.** The lab reads `GET /api/expose/:mode/events`, not the watcher's stream: the exposer and the watcher stay independent, and states follow desk changes with the watcher off.
- **Deleted while down.** Published config topics are kept in `settings`, so an entity deleted while the server was down is cleared on the next sync.
- **Doctor** reports the MQTT settings but doesn't connect: it promises no network requests.
- **Not tried against a real broker.** Tested with a fake MQTT client (`tests/expose.test.ts`) and the demo watcher (`tests/watch.test.ts`); adding `office_presence` against Mosquitto and Home Assistant by hand (step 3's check) hasn't been done. In the running lab, the outline section and the new-entity form were opened and filled in, but nothing was saved there, and the entity panel, the demo publish log and the rule editor's new target haven't been tried by hand.

## The later list, as built

Built after the first pass, with one change asked for on the way: **no paid calls decide presence unless the person opts in.**

- **Presence without SAM.** Not `person` from SAM, but a local `occupied` source: the zone against how it looked empty, by feature patches (or grey levels without the model). It catches someone sitting still, which motion can't, and costs nothing. SAM confirmation is a per-entity checkbox marked billed, off by default, at most one call a minute per zone.
- **Commands from Home Assistant.** `switch` for watching and `button` for checking rules, as entity kinds a person adds like any other. They do exactly what the lab's own controls do; turning watching on from Home Assistant needs a camera already chosen in the lab, and says so in the command log otherwise. The broker is trusted as far as Home Assistant is: anyone who can publish there can flip these.
- **Lights over MQTT.** For devices that speak Zigbee2MQTT's JSON (`{"state":"ON"}` on `<topic>/set`, state reports on `<topic>`), not Home Assistant service calls, which MQTT can't make. Other payload formats aren't covered.
- **`device_tracker` and `event`.** As planned: a tracker's state is the zone's name, `home` or `not_home`; events go out once per decision, not retained.
- **Not tried for real.** As with the first pass: fake MQTT client and the demo desk only. The occupancy thresholds (12% to turn on, 6% to clear, cosine 0.8) are first guesses; the demo's mug changes 11% of the large main zone, so the test uses a zone drawn around the mug.
