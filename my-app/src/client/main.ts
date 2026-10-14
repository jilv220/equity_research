import { Array, Duration, Effect, Match, Number, Option, Order, Record, Schema, String } from 'effect'
import { HttpClient } from 'effect/http'
import { AsyncData, Command, Http, Runtime, type Update } from 'foldkit'
import { Document, Html, HtmlBuilder } from 'foldkit/html'
import { defineMessageUnion } from 'foldkit/message'
import { UrlRequest, load, pushUrl } from 'foldkit/navigation'
import { defineTaggedUnion } from 'foldkit/schema'
import { modifyFields } from 'foldkit/struct'
import { Url, toString as urlToString } from 'foldkit/url'

import {
  ErrorBody,
  Job,
  Metric,
  ScoreResponse,
  Scorecard,
  Section,
  Summary,
  Watchlist,
  isJobActive,
} from './api'
import { AppRoute, urlToAppRoute } from './route'

// MODEL

export const WatchlistAsyncData = AsyncData.Schema(Watchlist, Schema.String)

export const Company = defineTaggedUnion({
  NotSelected: {},
  Loading: { ticker: Schema.String },
  Loaded: {
    ticker: Schema.String,
    maybeCard: Schema.Option(Scorecard),
    maybeJob: Schema.Option(Job),
    pollCount: Schema.Number,
  },
  Failed: { ticker: Schema.String, error: Schema.String },
})
export type Company = typeof Company.Type

export const Model = Schema.Struct({
  route: AppRoute,
  tickerInput: Schema.String,
  watchlist: WatchlistAsyncData.schema,
  company: Company,
  expandedMetricIds: Schema.Array(Schema.String),
  // Identifies the current score request chain; results from an older chain are ignored.
  requestId: Schema.Number,
})
export type Model = typeof Model.Type

// MESSAGE

export const Message = defineMessageUnion({
  UpdatedTickerInput: { value: Schema.String },
  SubmittedTickerForm: {},
  ClickedRefresh: {},
  ClickedMetric: { metricId: Schema.String },
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  SucceededFetchScore: { requestId: Schema.Number, pollCount: Schema.Number, response: ScoreResponse },
  FailedFetchScore: { requestId: Schema.Number, ticker: Schema.String, error: Schema.String },
  CompletedWaitBeforePoll: { requestId: Schema.Number, ticker: Schema.String, pollCount: Schema.Number },
  SucceededFetchWatchlist: { rows: Watchlist },
  FailedFetchWatchlist: { error: Schema.String },
})
export type Message = typeof Message.Type

// COMMAND

const POLL_BASE_MS = 2000
const POLL_STEP_MS = 500
const POLL_MAX_MS = 6000

const normalizeTicker = (ticker: string) =>
  ticker.trim().toUpperCase().replace(/\./g, '-')

const errorMessage = (body: unknown, status: number) =>
  Option.match(Schema.decodeUnknownOption(ErrorBody)(body), {
    onNone: () => `Request failed (${status})`,
    onSome: ({ error }) => error,
  })

export const FetchScore = Command.define('FetchScore', {
  args: {
    ticker: Schema.String,
    isRefresh: Schema.Boolean,
    requestId: Schema.Number,
    pollCount: Schema.Number,
  },
  messages: [Message.SucceededFetchScore, Message.FailedFetchScore],
  execute: ({ ticker, isRefresh, requestId, pollCount }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient
      const query = isRefresh ? '?refresh=1' : ''
      const response = yield* client.get(`/api/score/${encodeURIComponent(ticker)}${query}`)
      const body = yield* response.json

      if (response.status !== 200) {
        return Message.FailedFetchScore({ requestId, ticker, error: errorMessage(body, response.status) })
      }

      const decoded = yield* Schema.decodeUnknownEffect(ScoreResponse)(body)
      return Message.SucceededFetchScore({ requestId, pollCount, response: decoded })
    }).pipe(
      Effect.catch(() =>
        Effect.succeed(Message.FailedFetchScore({ requestId, ticker, error: "Couldn't reach the scoring API." })),
      ),
      Effect.provide(Http.layer),
    ),
})

export const WaitBeforePoll = Command.define('WaitBeforePoll', {
  args: { requestId: Schema.Number, ticker: Schema.String, pollCount: Schema.Number },
  messages: [Message.CompletedWaitBeforePoll],
  execute: ({ requestId, ticker, pollCount }) =>
    Effect.sleep(Duration.millis(Math.min(POLL_BASE_MS + pollCount * POLL_STEP_MS, POLL_MAX_MS))).pipe(
      Effect.as(Message.CompletedWaitBeforePoll({ requestId, ticker, pollCount })),
    ),
})

export const FetchWatchlist = Command.define('FetchWatchlist', {
  messages: [Message.SucceededFetchWatchlist, Message.FailedFetchWatchlist],
  execute: Effect.gen(function* () {
    const client = yield* HttpClient.HttpClient
    const response = yield* client.get('/api/scores')
    const rows = yield* Schema.decodeUnknownEffect(Watchlist)(yield* response.json)
    return Message.SucceededFetchWatchlist({ rows })
  }).pipe(
    Effect.catch(() => Effect.succeed(Message.FailedFetchWatchlist({ error: "Couldn't load the watchlist." }))),
    Effect.provide(Http.layer),
  ),
})

export const NavigateInternal = Command.define('NavigateInternal', {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
})

const LoadExternal = Command.define('LoadExternal', {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
})

// INIT

type UpdateReturn = Update.Return<Model, Message>

/** Starts a new score request chain for `ticker`, superseding any chain still polling. */
const startFetchScore = (model: Model, ticker: string, isRefresh: boolean, nextCompany: Company): UpdateReturn => {
  const nextRequestId = model.requestId + 1

  return {
    model: modifyFields(model, {
      company: () => nextCompany,
      requestId: () => nextRequestId,
    }),
    commands: [FetchScore({ ticker, isRefresh, requestId: nextRequestId, pollCount: 0 })],
  }
}

const enterRoute = (model: Model, route: AppRoute): UpdateReturn => {
  const routed = modifyFields(model, { route: () => route, expandedMetricIds: () => [] })

  return AppRoute.match<UpdateReturn>(route, {
    Home: () => ({ model: modifyFields(routed, { company: () => Company.NotSelected() }) }),
    NotFound: () => ({ model: modifyFields(routed, { company: () => Company.NotSelected() }) }),
    Company: ({ ticker }) => {
      const nextTicker = normalizeTicker(ticker)
      return startFetchScore(routed, nextTicker, false, Company.Loading({ ticker: nextTicker }))
    },
  })
}

export const init: Runtime.RoutingApplicationInit<Model, Message> = (url: Url) => {
  const initial: Model = {
    route: AppRoute.Home(),
    tickerInput: '',
    watchlist: WatchlistAsyncData.Loading(),
    company: Company.NotSelected(),
    expandedMetricIds: [],
    requestId: 0,
  }
  const entered = enterRoute(initial, urlToAppRoute(url))

  return { model: entered.model, commands: [FetchWatchlist(), ...(entered.commands ?? [])] }
}

// UPDATE

const currentTicker = (company: Company): Option.Option<string> =>
  Company.match<Option.Option<string>>(company, {
    NotSelected: () => Option.none(),
    Loading: ({ ticker }) => Option.some(ticker),
    Loaded: ({ ticker }) => Option.some(ticker),
    Failed: ({ ticker }) => Option.some(ticker),
  })

const loadedFromResponse = (response: ScoreResponse, pollCount: number): Company => {
  const { card, job } = response
  const failedWithoutCard = Option.isNone(card) && Option.exists(job, j => j.status === 'errored')

  if (failedWithoutCard) {
    return Company.Failed({
      ticker: response.ticker,
      error: Option.match(job, { onNone: () => 'Scoring failed', onSome: j => j.error ?? 'Scoring failed' }),
    })
  } else {
    return Company.Loaded({ ticker: response.ticker, maybeCard: card, maybeJob: job, pollCount })
  }
}

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    UpdatedTickerInput: ({ value }) => ({
      model: modifyFields(model, { tickerInput: () => value }),
    }),

    SubmittedTickerForm: () => {
      const ticker = normalizeTicker(model.tickerInput)

      if (String.isEmpty(ticker)) {
        return { model }
      } else {
        return {
          model: modifyFields(model, { tickerInput: () => '' }),
          commands: [NavigateInternal({ url: `/t/${encodeURIComponent(ticker)}` })],
        }
      }
    },

    ClickedRefresh: () =>
      Option.match(currentTicker(model.company), {
        onNone: () => ({ model }),
        onSome: ticker => startFetchScore(model, ticker, true, model.company),
      }),

    ClickedMetric: ({ metricId }) => ({
      model: modifyFields(model, {
        expandedMetricIds: ids =>
          Array.contains(ids, metricId) ? Array.filter(ids, id => id !== metricId) : Array.append(ids, metricId),
      }),
    }),

    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({ model, commands: [NavigateInternal({ url: urlToString(url) })] }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),

    ChangedUrl: ({ url }) => enterRoute(model, urlToAppRoute(url)),

    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),

    SucceededFetchScore: ({ requestId, pollCount, response }) => {
      if (requestId !== model.requestId) {
        return { model }
      }

      const nextCompany = loadedFromResponse(response, pollCount)
      const isRunning = Option.exists(response.job, isJobActive)
      const nextModel = modifyFields(model, { company: () => nextCompany })

      if (isRunning) {
        return { model: nextModel, commands: [WaitBeforePoll({ requestId, ticker: response.ticker, pollCount })] }
      } else if (pollCount > 0) {
        // A background job just finished: the watchlist has a new or updated row.
        return { model: nextModel, commands: [FetchWatchlist()] }
      } else {
        return { model: nextModel }
      }
    },

    FailedFetchScore: ({ requestId, ticker, error }) => {
      if (requestId !== model.requestId) {
        return { model }
      } else {
        return { model: modifyFields(model, { company: () => Company.Failed({ ticker, error }) }) }
      }
    },

    CompletedWaitBeforePoll: ({ requestId, ticker, pollCount }) => {
      if (requestId !== model.requestId) {
        return { model }
      } else {
        return { model, commands: [FetchScore({ ticker, isRefresh: false, requestId, pollCount: pollCount + 1 })] }
      }
    },

    SucceededFetchWatchlist: ({ rows }) => ({
      model: modifyFields(model, { watchlist: () => WatchlistAsyncData.Success({ data: rows }) }),
    }),

    FailedFetchWatchlist: ({ error }) => ({
      model: modifyFields(model, { watchlist: () => WatchlistAsyncData.Failure({ error }) }),
    }),
  })

// VIEW

const formatScore = (n: number) => globalThis.String(Math.round(n * 10) / 10)

const ratingClass = (rating: string) =>
  Option.match(Array.head(rating.split(' ')), { onNone: () => 'r-Excluded', onSome: word => `r-${word}` })

const pointsClass = (metric: Metric) =>
  Match.value(metric.points).pipe(
    Match.when(Number.isGreaterThanOrEqualTo(metric.max), () => 'p-full'),
    Match.when(Number.isGreaterThan(0), () => 'p-part'),
    Match.orElse(() => 'p-zero'),
  )

const selectedTicker = (model: Model): Option.Option<string> =>
  AppRoute.match<Option.Option<string>>(model.route, {
    Home: () => Option.none(),
    NotFound: () => Option.none(),
    Company: ({ ticker }) => Option.some(normalizeTicker(ticker)),
  })

const watchlistView = (model: Model, h: HtmlBuilder<Message>): Html => {
  const maybeSelected = selectedTicker(model)
  const emptyRow = (text: string) => h.tr([], [h.td([h.Class('empty')], [text])])

  const rows = AsyncData.matchDataSplitEmpty(model.watchlist, {
    onIdle: () => [emptyRow('Loading…')],
    onLoading: () => [emptyRow('Loading…')],
    onFailure: error => [emptyRow(error)],
    onData: (summaries: ReadonlyArray<Summary>) =>
      Array.match(summaries, {
        onEmpty: () => [emptyRow('No companies scored yet.')],
        onNonEmpty: nonEmpty =>
          Array.map(sortWatchlist(nonEmpty), (summary, index) =>
            h.tr(
              [h.Key(summary.ticker), h.Class(Option.contains(maybeSelected, summary.ticker) ? 'sel' : '')],
              [
                h.td([h.Class('rank')], [globalThis.String(index + 1)]),
                h.td(
                  [],
                  [
                    h.a(
                      [h.Href(`/t/${summary.ticker}`), h.Class('wl-link')],
                      [h.span([h.Class('t')], [summary.ticker]), h.span([h.Class('n')], [summary.name])],
                    ),
                  ],
                ),
                h.td([h.Class('s')], [summary.rating === 'Excluded' ? '—' : formatScore(summary.total)]),
              ],
            ),
          ),
      }),
  })

  return h.aside(
    [],
    [
      h.div(
        [h.Class('panel')],
        [h.h2([], ['Ranked watchlist']), h.table([h.Class('wl')], [h.tbody([], rows)])],
      ),
    ],
  )
}

/** Score descending; ties broken by TTM ROIC (ground rule 7). */
const watchlistOrder: Order.Order<Summary> = Order.combine(
  Order.mapInput(Order.flip(Order.Number), (summary: Summary) => summary.total),
  Order.mapInput(Order.flip(Order.Number), (summary: Summary) => summary.ttmRoic ?? -Infinity),
)

const sortWatchlist = (rows: ReadonlyArray<Summary>): ReadonlyArray<Summary> => Array.sort(rows, watchlistOrder)

const notice = (h: HtmlBuilder<Message>, text: string): Html => h.div([h.Class('notice')], [text])

const cardHeadView = (card: Scorecard, isRefreshing: boolean, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('card-head')],
    [
      h.div(
        [],
        [
          h.h2([], [`${card.ticker} · ${card.name}`]),
          h.div(
            [h.Class('meta')],
            [
              `SIC ${card.sic} ${card.sicDescription}`,
              h.br([]),
              `TTM to ${card.asOf} · latest FY ended ${card.latestFy} · computed ${new Date(card.computedAt).toLocaleString()}`,
            ],
          ),
          h.div(
            [h.Class('actions')],
            [
              h.button(
                [h.Type('button'), h.Class('ghost'), h.Disabled(isRefreshing), h.OnClick(Message.ClickedRefresh())],
                [isRefreshing ? 'Refreshing…' : 'Refresh from EDGAR'],
              ),
            ],
          ),
        ],
      ),
      card.excluded === undefined
        ? h.div(
            [h.Class('total')],
            [
              h.div([h.Class('big')], [formatScore(card.total), h.small([], [' / 100'])]),
              h.span([h.Class(`pill ${ratingClass(card.rating)}`)], [card.rating]),
            ],
          )
        : h.div([h.Class('total')], [h.span([h.Class('pill r-Excluded')], ['Excluded'])]),
    ],
  )

const sectionSummaryView = (section: Section, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('sec-sum')],
    [
      h.div([h.Class('lbl')], [`${section.id}. ${section.name}`]),
      h.div([h.Class('v')], [`${formatScore(section.points)} / ${section.max}`]),
      h.div(
        [h.Class('bar')],
        [h.i([h.Style({ width: `${Math.round((100 * section.points) / section.max)}%` })], [])],
      ),
    ],
  )

const sourceView = (source: string, h: HtmlBuilder<Message>): Html =>
  Option.match(Option.fromNullishOr(source.match(/https:\/\/\S+/)), {
    onNone: () => h.div([h.Class('note')], [`Source: ${source}`]),
    onSome: match => {
      const href = match[0]
      return h.div(
        [h.Class('note')],
        [
          `Source: ${source.slice(0, match.index)}`,
          h.a([h.Href(href), h.Target('_blank'), h.Rel('noopener')], [href]),
        ],
      )
    },
  })

const metricDetailView = (metric: Metric, h: HtmlBuilder<Message>): Html => {
  const inputs = Record.toEntries(metric.inputs)

  return h.tr(
    [h.Key(`${metric.id}-detail`), h.Class('detail')],
    [
      h.td(
        [h.Colspan(4)],
        [
          h.div([h.Class('f')], [metric.formula]),
          Array.isArrayNonEmpty(inputs)
            ? h.dl([], Array.flatMap(inputs, ([label, value]) => [h.dt([], [label]), h.dd([], [value])]))
            : h.empty,
          metric.note === undefined ? h.empty : h.div([h.Class('note')], [metric.note]),
          metric.evidence === undefined ? h.empty : h.blockquote([], [metric.evidence]),
          metric.source === undefined ? h.empty : sourceView(metric.source, h),
        ],
      ),
    ],
  )
}

const metricRowsView = (metric: Metric, isExpanded: boolean, h: HtmlBuilder<Message>): ReadonlyArray<Html> => [
  h.tr(
    [h.Key(metric.id), h.Class('row'), h.OnClick(Message.ClickedMetric({ metricId: metric.id })), h.AriaExpanded(isExpanded)],
    [
      h.td([], [metric.id]),
      h.td([], [h.div([h.Class('name')], [metric.name]), h.div([h.Class('band')], [metric.band])]),
      h.td([h.Class('val')], [metric.display]),
      h.td([], [h.span([h.Class(`pts ${pointsClass(metric)}`)], [`${formatScore(metric.points)} / ${metric.max}`])]),
    ],
  ),
  ...(isExpanded ? [metricDetailView(metric, h)] : []),
]

const sectionView = (section: Section, expandedMetricIds: ReadonlyArray<string>, h: HtmlBuilder<Message>): Html =>
  h.div(
    [h.Class('section')],
    [
      h.div(
        [h.Class('sec-title')],
        [h.span([], [`${section.id}. ${section.name}`]), h.span([], [`${formatScore(section.points)} / ${section.max}`])],
      ),
      h.table(
        [h.Class('metrics')],
        [
          h.colgroup([], [h.col([h.Class('c-id')]), h.col([]), h.col([h.Class('c-val')]), h.col([h.Class('c-pts')])]),
          h.tbody(
            [],
            Array.flatMap(section.metrics, metric =>
              metricRowsView(metric, Array.contains(expandedMetricIds, metric.id), h),
            ),
          ),
        ],
      ),
    ],
  )

const scorecardView = (
  card: Scorecard,
  maybeJob: Option.Option<Job>,
  pollCount: number,
  expandedMetricIds: ReadonlyArray<string>,
  h: HtmlBuilder<Message>,
): Html => {
  const isRefreshing = Option.exists(maybeJob, isJobActive)
  const jobNotice = Option.match(maybeJob, {
    onNone: () => h.empty,
    onSome: job =>
      Match.value(job).pipe(
        Match.when(isJobActive, () => notice(h, `Updating from SEC filings in the background (${job.status})…`)),
        Match.when(
          () => job.status === 'errored' && pollCount > 0,
          () => notice(h, `Refresh failed: ${job.error ?? 'unknown error'}. Showing the last score.`),
        ),
        Match.orElse(() => h.empty),
      ),
  })

  if (card.excluded !== undefined) {
    return h.div([], [cardHeadView(card, isRefreshing, h), jobNotice, notice(h, card.excluded), h.div([h.Class('spacer')], [])])
  } else {
    const gateNotice = card.gated
      ? notice(
          h,
          `Monopoly gate applied: TTM ROIC is ${card.ttmRoic === null ? 'not computable' : `${(card.ttmRoic * 100).toFixed(1)}%`} (below 8%), so the total is capped at 50. Uncapped sum: ${formatScore(card.rawTotal)}.`,
        )
      : h.empty

    return h.div(
      [],
      [
        cardHeadView(card, isRefreshing, h),
        jobNotice,
        gateNotice,
        h.div([h.Class('sections')], Array.map(card.sections, section => sectionSummaryView(section, h))),
        ...Array.map(card.sections, section => sectionView(section, expandedMetricIds, h)),
      ],
    )
  }
}

const status = (h: HtmlBuilder<Message>, text: string, isError = false): Html =>
  h.div([h.Class(isError ? 'status err' : 'status'), h.AriaLive('polite')], [text])

const companyView = (model: Model, h: HtmlBuilder<Message>): Html =>
  Company.match<Html>(model.company, {
    NotSelected: () =>
      AppRoute.match<Html>(model.route, {
        NotFound: ({ path }) => status(h, `No page at ${path}. Enter a ticker to score a company.`),
        Home: () =>
          status(
            h,
            'Enter a ticker to score it from its 10-K, 10-Q and proxy filings on SEC EDGAR. New companies are scored in the background (about a minute); the watchlist is re-scored nightly.',
          ),
        Company: () => h.empty,
      }),
    Loading: ({ ticker }) => status(h, `Loading ${ticker}…`),
    Failed: ({ error }) => status(h, error, true),
    Loaded: ({ ticker, maybeCard, maybeJob, pollCount }) =>
      Option.match(maybeCard, {
        onSome: card => scorecardView(card, maybeJob, pollCount, model.expandedMetricIds, h),
        onNone: () =>
          status(
            h,
            `Scoring ${ticker} from SEC filings in the background (${Option.match(maybeJob, { onNone: () => 'queued', onSome: job => job.status })}). Fetching and parsing a 10-K takes about 10–60 seconds; you can leave this page.`,
          ),
      }),
  })

const METHODOLOGY: ReadonlyArray<string> = [
  'GAAP figures from 10-K, 10-Q and DEF 14A filings via SEC EDGAR XBRL. TTM = latest FY + current YTD − prior-year YTD (equal to the last four quarters).',
  'Missing history scores 0. Tax rate 21%, hurdle 12%. Banks, insurers and REITs are excluded by SIC code.',
  'Thresholds: "≥" bands include the lower bound; "≤ / >" bands (A4, B4, E3, F2, C2, C3) include the upper bound, as the table writes them.',
  'Invested capital = total debt (long-term incl. current portion, short-term borrowings, commercial paper; leases excluded) + total equity incl. NCI − cash & short-term investments. Average invested capital ≤ 0 → ROIC not meaningful → 0 points and the gate applies.',
  'A4 uses the population standard deviation. B1 scores 0 when revenue CAGR ≤ 0. EBITDA = operating income + D&A from the cash-flow statement. C3: net cash scores 5 even with negative EBITDA.',
  'E1, E2, C2 are machine-read from filing text and inline XBRL; each shows the passage it was read from. Untagged customer concentration found only in text scores 0 pending review.',
  'Monopoly gate: TTM ROIC below 8% (or not computable) caps the total at 50. Ties rank by TTM ROIC.',
  'Scores are computed by a background job and refreshed nightly (06:00 UTC) from the latest filings.',
]

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: Option.match(selectedTicker(model), {
    onNone: () => 'Monopoly Scorecard',
    onSome: ticker => `${ticker} · Monopoly Scorecard`,
  }),
  body: h.div(
    [],
    [
      h.header(
        [],
        [
          h.h1([], [h.a([h.Href('/'), h.Class('home')], ['Monopoly Scorecard']), h.span([], [' · strict, filings-only'])]),
          h.form(
            [h.OnSubmit(Message.SubmittedTickerForm())],
            [
              h.input([
                h.Type('text'),
                h.Value(model.tickerInput),
                h.Placeholder('Ticker, e.g. NVDA'),
                h.Autocomplete('off'),
                h.Spellcheck(false),
                h.AriaLabel('Ticker'),
                h.OnInput(value => Message.UpdatedTickerInput({ value })),
              ]),
              // Never disabled: a disabled default button blocks Enter-to-submit until the next render.
              h.button([h.Type('submit')], ['Score']),
            ],
          ),
        ],
      ),
      h.main(
        [],
        [
          watchlistView(model, h),
          h.section(
            [],
            [
              h.div([h.Class('panel card')], [companyView(model, h)]),
              h.details(
                [h.Class('panel method')],
                [h.summary([], ['Methodology and interpretation rules']), h.ul([], Array.map(METHODOLOGY, item => h.li([], [item])))],
              ),
            ],
          ),
        ],
      ),
    ],
  ),
})
