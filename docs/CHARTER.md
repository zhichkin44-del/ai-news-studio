# Project charter: news channel system of the studio

> The charter is the first document of the project: the whole idea on one page. The course was updated on 2026-10-28 by the owner's decision; the previous version (six roles, links to sources) is cancelled.

## 1. The idea in one sentence
**An autonomous system that runs news channels without human participation**: it catches the hottest world news in Russian within the first second, selects it, writes a post with its own angle, picks an image and publishes. The system can be deployed on a server and managed through the control panel and the Zokul messenger. The first channel is "Hype around the world" (loud events: politics, wars, disasters, incidents).

## 2. How we work
- Approach: **a company of agents, starting with two staff members**; others appear when we hit a limit.
- Method: **start from the final interface**: first the final look of the channel management UI and the process description, approved by the owner; then code and staffing for the approved screens.
- Models: Anthropic models only: **Haiku 5.5 via OpenRouter** (main flow), **Sonnet 5.5 via subscription** (smart work: engineering, disputed cases).

## 3. Staff (start)
| Staff member | Responsibility | Engine |
|---|---|---|
| **Rita, information editor** | news items and sources: what to watch, what to select, how to frame it (styles), fact checks within the record, image selection | Haiku 5.5, OpenRouter |
| **Max, engineer** | code and support: pipeline, collection, storage, publishing, server, tests | Sonnet 5.5, subscription |

The lead and the reviewer is the control panel (Dracula, Sara), judged against the goal of each stage.

## 4. How the channel works
1. **Collection (code, no model):** polling of feeds and public channels every few seconds; a news item is caught as soon as it appears.
2. **Selection (Rita):** main stories, duplicates, priority; urgent items go out immediately.
3. **Post (Rita):** headline, the gist in own words, and if needed "why it matters"; styles vary (urgent, explainer, ironic, analysis). **Posts contain no links and no sources**; the internal record of each item always keeps its sources (fact checks, duplicates).
4. **Image:** a photo from the source material or a pick from open sources.
5. **Publishing:** first only after the owner's "yes" (control panel or Zokul, buttons); later automatically, but sharp and disputed items always need approval.
6. **Analytics:** what gets read, which styles and topics should grow.

## 5. Stages
| No. | Stage | Done when |
|---|---|---|
| 0 | Course, charter, two staff members, engines | agents answer via OpenRouter and the subscription; spending is visible in "Economics" |
| 1 | **Interface in its final form** + process diagram | the owner has written "approved" |
| 2 | Staff: methods and reference samples (about 20 news and style samples) | both pass the reference samples |
| 3 | Core pipeline: collection, duplicates, storage, test channel as a file | tests are green, an issue assembles by itself |
| 4 | Editor on models: selection and rewriting in styles | share of posts published without edits is measured and grows |
| 5 | Images | every post has an image |
| 6 | Publishing: a test Telegram channel, buttons in Zokul | the issue reaches the owner and is published on "yes" |
| 7 | Live interface: screens with data inside the control panel | the stage 1 screens work |
| 8 | Autonomy mode (at least 95% without edits), server, 24/7, daily spending cap | a week without interventions |

## 6. What the owner does
- Approves the interface (stage 1) and the results of each stage.
- Creates the Telegram channel and bot (stage 6) and puts the token in place personally.
- Buys the server (stage 8); puts keys on the machines personally (key entry in the control panel is not active yet).

## 7. Rules and risks
- Owner's position: a post is news, a photo and a description, **without links and sources**. The owner accepts the consequences (complaints, platform blocks).
- Sources are kept inside each record: they are used for fact checks and duplicates. Disputed and loud items need at least two sources, otherwise they are marked "not confirmed" and do not go out without the owner.
- Publishing outside, accounts, tokens and money: only the owner.
- Caps: $5 per task, $3 per day for Rita, $10 per day for Max; the overall spending cap of the studio is set in the control panel.

## 8. How success is measured
- Share of posts published without the owner's edits (target at least 95%).
- Speed: from event to post (target: minutes).
- Factual errors (target: 0).
- Subscriber growth and reach.
- Cost per day and cost per post.
