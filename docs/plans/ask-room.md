# Plan: ask your room

Status: building (November 3).

A person asks the room about its history in their own words: _How many times did I drink in the last hour?_, _How long was my screen on today?_, _Did the cat nap more than yesterday?_ The answer is a number they can trust, the events it rests on, and a small chart. Until now "Ask your room" in the day dock matched keywords against a scripted day (`askRoom` in `demoDay.ts`) and never read the history the stats keep.

## Decisions

- **Spark reads the question; code counts.** The model is bad at arithmetic over a list of timestamps and its answer can't be tested. So Spark answers one **query** (`AskQuery`): which thing, which stat, which measure, over which window, compared with what. `answerAsk` works the number out from stored events, deterministically, and words the answer. This is the brush's shape: Spark reads, `readIntent` decides.
- **One query per question, from closed lists.** Measures: `count`, `duration`, `last`, `first`, `longestGap`, `longest`, `now`, `summary`. Windows: the last _n_ minutes, today, yesterday, the last _n_ days. Comparisons: none, the window before (yesterday by this time), the average of the week before. Anything else Spark can't map answers `clarify` with a short question.
- **Demo and live go through the same code.** In the demo a keyword reader (`demoAsk`) answers in Spark's shape, and a **sample week** (`demoHistory`) stands in for the store: today is the dock's scripted day, the six days before are seeded variations of it. Live reads `stat_events` and asks Spark. No other branch.
- **Honest about what it measured.** A mug's use is "picked up and put back", so an answer about drinking says so in a note. A camera stat counted over a window the camera didn't watch says how much it watched; the watcher's spans are kept (`watch_spans`) for that.
- **Billed only live, and on the person's ask.** One small Spark call (`ask`, low effort) per question, under the spend limit, recorded as a run. It isn't tracking, so it doesn't need _Let tracking call AI_.

## What a stat can answer

| Stat (value)             | count                | duration                   | longest              | longestGap              |
| ------------------------ | -------------------- | -------------------------- | -------------------- | ----------------------- |
| lastUsed (time)          | uses in the window   | —                          | —                    | longest between uses    |
| power, occupied (on/off) | times it came on     | time on                    | longest on stretch   | longest off between ons |
| activity (level 0–1)     | busy stretches began | active time (level × time) | longest busy stretch | longest idle between    |

`last` and `first` are the last or first use or switching on; `now` is the value now and since when; `summary` is one line per thing. Count and duration over a day or more come with a series (per hour for up to a day, per day beyond), which the dock draws as bars.

## Stats that look good in the demo

The sample week gives each of these a real number, a chart and a comparison:

- **Drinks** (the desk mug's uses): per hour today, the longest stretch without one, today against yesterday by this time.
- **Screen time** (the monitor's power): today against the week's average.
- **Time at the desk** (the mouse's activity): active hours per day this week, the longest focus stretch.
- **The lamp**: how long it was on today.
- **The cat**: visits to its tree and its longest nap.
- **The fridge**: when the milk was last taken out (food things keep Last used).

## Shape

- `packages/domain/src/room-ask.ts`: `askQuerySchema` (Spark's flat, strict shape), `readAsk` (checks it against the things), `answerAsk` (the numbers and the words), `demoAsk`.
- `packages/domain/src/demo-day.ts`: the sample day (moved from the web, so the server reads it too) and `demoHistory`.
- `POST /api/things/ask` `{ mode, question, at? }` → a recorded `ask` run whose output is the `RoomAnswer`. `at` asks as of that time: the dock sends the replay's minute in the demo.
- `MetaAdapter.ask`: the question, the things with their stats, the local time now.
- `watch_spans` in the store: written by `StatRunner.setWatching` and each flush.
- The dock's Ask calls the route and draws the answer, its notes, its bars and its cites (a cite moves the replay there).

## Later

- Zones and rules as history: _How long was the mug in the main zone?_ needs zone entries kept as events.
- Questions across things (_Was the lamp on while I was away?_): the query has one thing; two would need an `while` field.
- Answering from day totals beyond the 30 days events are kept.
