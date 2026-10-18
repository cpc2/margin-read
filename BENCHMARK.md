# Translation benchmark — 18 October 2026

## Controlled browser comparison

Upstream `85d964b` and this fork were loaded into separate disposable Chromium 156 profiles
using Playwright 1.64.1 on Windows, Node 24.15.0. Viewport: 1440 × 1000.
Both used the OpenAI compatible protocol, identical source DOM, French as the target,
disabled cache, and the same local mock service. The fixture contains a heading and twelve
paragraphs, 1502 source characters, inline links and emphasis, plus excluded hidden/code text.

The mock imposes a 250 ms request delay and 40 ms generation time per result. For streaming
requests, it emits each completed JSON object as it becomes available; other requests receive
the full document at the end. It is a deterministic transport experiment, not an LLM or
translation-quality benchmark. It illustrates the effect of repeated request overhead and
streaming; it does not establish a speedup for every provider or page.

Three alternating cold runs:

| Metric | Upstream | Fork |
| --- | ---: | ---: |
| Requests for all 13 blocks | 5 | 1 |
| First translation, median | 445 ms | 344 ms |
| Complete viewport, median | 1946 ms | 863 ms |
| Complete viewport, range | 1911–2465 ms | 859–888 ms |
| Correct ID mappings | 13/13 | 13/13 |
| Hidden text sent as context | Yes | No |

For this fixture: 80% fewer requests and 55.7% shorter median completion time (2.25× as fast).
The upstream compatible-provider queue serializes groups of three; the fork packs the
viewport into one bounded request and renders streamed results progressively.

All run values are in [benchmarks/controlled-runs.json](benchmarks/controlled-runs.json).
Timings are measured by a 100 ms browser polling loop, so individual first-result values
have that granularity. The fork also records internal first-render and viewport timings.

A separate warm-cache fixture check completed all 13 blocks in 11 ms of harness wall time,
with 13 cache hits and zero additional HTTP requests. This is not a cold inference measurement.

## Real OpenRouter test

Public page: [Wikipedia — Web browser](https://en.wikipedia.org/wiki/Web_browser).
Model: `liquid/lfm-2.5-2.6b:free`, retrieved from OpenRouter's live zero-price model list.
French target, strict JSON schema, streaming, 8192 output-token cap, 1800 estimated input
budget, cloud mode, session cache, 45-second test deadline. Only a free model was selected;
the benchmark rejects paid model IDs.

The final verified measurements are stored in [benchmarks/live-result.json](benchmarks/live-result.json),
with a separate [successful one-request run](benchmarks/live-one-request.json).
The page scan found 100 reading blocks and selected nine blocks intersecting the viewport.
It sent 2527 source characters in the initial request. The final run needed one targeted
retry for two IDs (37 source characters), and all nine IDs received a result.
The result included French output such as “Navigateur web” and “Logiciel utilisé pour
accéder aux sites web”; the rendered page was inspected. Original page links remained intact.

Cold successful attempts varied substantially. One completed the viewport internally in
11.0 seconds in one request, with the first translation at 7.7 seconds. The final run took
15.7 seconds including the small retry. Its warm toggle completed in 52 ms of harness time
with eight cache hits and zero additional requests; the rescanned viewport contained eight
blocks after the page updated. Another strict-schema attempt took 19.9 seconds internally.
These are provider/model latency observations, not a claim that
the extension adds that delay. Browser harness timings can be higher under CPU load.

Other experiments exposed real compatibility/availability limits:

- Disabling reasoning was rejected by the Liquid endpoint because reasoning is mandatory.
  The final adapter does not force that flag.
- Some runs omitted or duplicated two IDs; targeted retries recovered them. Reasoning can consume
  the output budget, which is why the verified test used 8192. The larger cap does not
  guarantee that a model returns every ID correctly.
- One prompt-only/JSON-object run returned source-language copies. The final prompt names
  the target in the system message; OpenRouter JSON mode now requests strict schema. A valid
  schema still does not prove correct translation, so output was inspected separately.
- Gemma and Xing free endpoints returned upstream rate limits. A Nemotron free endpoint hit
  the 45-second request deadline. The free router returned invalid translation JSON in one run.

Free inference remains the main obstacle to consistently low cold-request latency. The
controlled benchmark isolates the extension's batching improvement from that variability.
The successful free-model run is an integration check, not a statistical model evaluation.

OpenRouter documents [reasoning and output-token budgets](https://openrouter.ai/docs/guides/best-practices/reasoning-tokens)
and [routing by latency](https://openrouter.ai/docs/guides/routing/provider-selection).

## Validation

- 529 unit tests across 45 files; line coverage 96.95%, branch coverage 91.61% at the final run.
- TypeScript, lint, formatting, production build, extension checks, and whitespace diff checks.
- Real Chromium checks: streamed ID mapping, original links, hidden/code exclusion including
  boundary context, source changes while old requests are running, deferred offscreen text,
  translation after scrolling, paragraphs over 4000 characters, cancellation without late DOM updates.
- API keys are omitted from content-script settings, build output, logs, and committed fixtures.

See [FORK.md](FORK.md) for exact wire formats, installation, defaults, limitations, and reproduction commands.
