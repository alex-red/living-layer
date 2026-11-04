# Plan: the room coach

Status: built (November 3).

Every few minutes the room coach looks at what the room's stats say now and, when something is worth a word, sends a funny nudge: _You should probably drink something, it's been 20 minutes._ _Hey, you've been staring at that monitor for like 3 hours, dude._

## Decisions

- **Code works out the facts; Spark only words one.** `coachFacts` (`packages/domain/src/room-coach.ts`) reads the stats as `answerAsk` does: minutes since a drink while someone is at the desk, the screen's unbroken stretch, the screen on late at night, a light on with the screen off, the cat long on its tree, food that goes off today. Each fact carries its numbers in words and a weight (1 is due). Spark picks one of the due facts by id and writes a title and a body; `readCoachWords` refuses a fact it wasn't given. The numbers in a nudge are always the room's.
- **Cheap, and only when due.** One Spark call (`coach`: 1024 tokens, minimal effort) per look, and none when nothing is due. A fact keeps quiet for `COACH.cooldownMin` after a nudge (food for 12 hours), and no nudge comes within `COACH.gapMin` of another, so it never nags twice in a row. When Spark fails (off, over the spend limit) the offline lines word it and the check says so.
- **Opt-in live.** The live coach looks every `COACH.everyMin` minutes only while switched on (`room_coach` in settings; the switch is in the dock). While the camera isn't watching, camera stats are left out: an old sighting isn't now.
- **Easy to demo.** The demo's replay runs the coach over the sample day offline (`coachDay`), so its nudges pop up over the room as the day plays and sit on the track as cyan dots. _Check now_ looks as of the replay's minute; live, it asks Spark at once.

## Shape

- `packages/domain/src/room-coach.ts`: `coachFacts`, `dueFacts`, `coachLine` (the offline lines), `coachDay`, `coachWordsSchema`, `readCoachWords`.
- `apps/server/src/coach.ts`: `RoomCoach` (the timer, the kept nudges, a look) and `GET /api/coach/:mode`, `POST /api/coach/check`, `POST /api/coach/switch`. A Spark look is recorded as a `coach` run.
- `MetaAdapter.coach`: the facts and the tone.
- The web: `state/coach.ts` (polls the live coach, the demo's day), the coach's strip in the dock and its notifications beside the Home Assistant ones (`DayDock.tsx`).

## Later

- Push a nudge to the phone through Home Assistant's notify, as the scripted nudges say they would.
- A button that acts: _Oops_ on a lamp left on could switch it off.
