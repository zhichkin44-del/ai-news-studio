# Acceptance of stage 3 "Collection"

The radar (`npm run radar`) runs without interruption for 3 days. Then `npm run metrics -- --hours 72`: the figures are read from `docs/eval/metrics-latest.json` (written by the metrics command; the directory is not part of this repository). Thresholds are starting values and are calibrated by measurement.

| No. | Criterion | Threshold | Where to look |
|---|---|---|---|
| 1 | Every feed is alive | at least 1 fresh item (younger than 6 h) at the time of measurement; share of polls with errors below 5% | `feeds[].fresh_6h`, `feeds[].error_rate`; `problem_feeds` is empty |
| 2 | Speed | median latency (first_seen − published) at most 5 min for RSS feeds (all current feeds are RSS) | `latency.median_sec` ≤ 300; per feed: `feeds[].latency` |
| 3 | No repeats | at least 90% of records in the database have a unique link | `unique_items_share` ≥ 0.9 |
| 4 | Confirmation | hot events (score ≥ 40): at least 60% have 2+ independent sources (feeds from the same publisher count as one) | `hot_multi_source_share` ≥ 0.6 (`hot_events` is the number of hot events) |
| 5 | Completeness | database coverage of at least 80% of a manual list of the 20 main events of the day | see below |

## Caveats to the measurement

- Latency is computed without the records of each feed's first poll (`baseline`): that is accumulated history, not "arrived to us". So measurement starts from the second pass.
- If a feed has no publication date, the record is excluded from latency.
- `multi_source_share` (share of ALL events with 2+ sources) is for reference only, with no threshold: different feeds cover different stories, and rare stories do not appear elsewhere.
- `duplicates_merged_share` (share of records merged into clusters) is for reference only, with no threshold: it is needed for calibrating clustering.

## Completeness check (criterion 5)

Done manually by Rita or the owner, not by code.

1. On the measurement day, create `docs/eval/reference-top-<YYYY-MM-DD>.json`: an array of 20 objects `{"title": "<event in your own words>", "note": "<optional>"}`: the main world events of the day.
2. For each event, check whether it is in the database for that day (search `items.title` in `data/news.db` or among the events from `npm run metrics`), and mark `"covered": true/false`.
3. Coverage = covered / 20 ≥ 0.8. Analyse the missed events: either they are not in any feed (a new source is needed) or they are there but not clustered (cluster calibration).

## Result

The stage is accepted if all 5 criteria are met. If a criterion is not met, the report must name it and state what will change (feed, threshold, source).
