# Plan: the room coach

Status: built (November 3).

Every few minutes the room coach looks at what the room's stats say now and, when something is worth a word, sends a funny nudge: _You should probably drink something, it's been 20 minutes._ _Hey, you've been staring at that monitor for like 3 hours, dude._

## Decisions

- **Code works out the facts; Spark only words one.** `coachFacts` (`packages/domain/src/room-coach.ts`) reads the stats as `answerAsk` does: minutes since a drink while someone is at the desk, the screen's unbroken stretch, the screen on late at night, a light on with the screen off, the cat long on its tree, food that goes off today. Each fact carries its numbers in words and a weight (1 is due). Spark picks one of the due facts by id and writes a title and a body; `readCoachWords` refuses a fact it wasn't given. The numbers in a nudge are always the room's.
- **Cheap, and only when due.** One Spark call (`coach`: 1024 tokens, minimal effort) per look, and none when nothing is due. A fact keeps quiet for `COACH.cooldownMin` after a nudge (food for 12 hours), and no nudge comes within `COACH.gapMin` of another, so it never nags twice in a row. When Spark fails (off, over the spend limit) the offline lines word it and the check says so.
- **Opt-in live.** The live coach looks every `COACH.everyMin` minutes only while switched on (`room_coach` in settings; the switch is in the dock). While the camera isn't watching, camera stats are left out: an old sighting isn't now.
- **Easy to demo.** The demo's replay runs the coach over the sample day offline (`coachDay`), so its nudges pop up over the room as the day plays and sit on the track as cyan dots. _Check now_ looks as of the replay's minute; live, it asks Spark at once.

- **Buttons that act, in the demo for now.** Each topic has one (`COACH_ACTIONS`): _Log a sip_, _Take 5_ (the screen off for 5 minutes), _Bed, fine_, _Turn it off_ (the lamp), _What do I eat?_ (asks the room), _Respect the cat_. In the demo, `actionEvents` adds what it did to the sample day as the person's own events, so the coach's later nudges follow from it and the replay's lamp goes dark; _Snooze_ keeps the topic quiet for 30 minutes. The sample day's evening session ends at 19:10, so the lamp is left on and the coach catches it. Live, a nudge has only _Dismiss_ until the buttons switch real things.

## Shape

- `packages/domain/src/room-coach.ts`: `coachFacts`, `dueFacts`, `coachLine` (the offline lines), `coachDay`, `coachWordsSchema`, `readCoachWords`.
- `apps/server/src/coach.ts`: `RoomCoach` (the timer, the kept nudges, a look) and `GET /api/coach/:mode`, `POST /api/coach/check`, `POST /api/coach/switch`. A Spark look is recorded as a `coach` run.
- `MetaAdapter.coach`: the facts and the tone.
- The web: `state/coach.ts` (polls the live coach, the demo's day), the coach's strip in the dock and its notifications beside the Home Assistant ones (`DayDock.tsx`).

## Later

- Push a nudge to the phone through Home Assistant's notify, as the scripted nudges say they would.
- The buttons live: _Turn it off_ through Home Assistant, _Log a sip_ as the mug's Last used, a snooze kept by the server.
